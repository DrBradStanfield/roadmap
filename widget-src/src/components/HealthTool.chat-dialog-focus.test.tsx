// @vitest-environment jsdom
/**
 * US-15 AC12a on the tool page's floating chat (a desktop under 1200px wide), through the real
 * HealthTool and ChatSection; the chat's network calls are stubbed. Synthetic record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toOldShape } from '@roadmap/health-core/blood-tests';
import { recordOnDisk, seedGuest, settle, showTables, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { typeInto } from '../testing/matrix-gestures';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (original) => ({ ...(await original<typeof import('../lib/server-api')>()), trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn() }));
vi.mock('../lib/chat-api', () => ({ getChatGate: () => null, listConversations: vi.fn(async () => ({ conversations: [] })), loadConversation: vi.fn(async () => []),
  sendMessage: vi.fn(() => new Promise(() => {})), deleteConversation: vi.fn() }));
vi.mock('../lib/chat-sync', () => ({ postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test' }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));

import { HealthTool } from './HealthTool';

const fab = () => document.querySelector<HTMLButtonElement>('button.chat-fab');
const dialog = () => screen.queryByRole('dialog', { name: 'Health by Dr Brad Chat' });
type Heard = (e: { matches: boolean }) => void;
const heardBy = new Map<Heard, string>();
let wide = false;
const matches = (q: string) => wide && q.startsWith('(min');
const setWide = (to: boolean) => act(async () => { wide = to; heardBy.forEach((q, heard) => heard({ matches: matches(q) })); });

useHealthToolLifecycle();
beforeEach(() => {
  // A narrow desktop: no chat column and no phone tabs, so the floating chat is the chat. `setWide` crosses 1200px.
  wide = false;
  vi.stubGlobal('matchMedia', (q: string) => ({ get matches() { return matches(q); }, media: q,
    addEventListener: (_: string, heard: Heard) => heardBy.set(heard, q), removeEventListener: (_: string, heard: Heard) => heardBy.delete(heard) }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
});

async function openFloatingChat() {
  await waitFor(() => expect(fab()).not.toBeNull());
  fab()!.focus();
  await act(async () => { fireEvent.click(fab()!); });
  expect(dialog()).not.toBeNull();
}

describe('US-15 AC12a: the tool page floating chat', () => {
  it('takes the focus on opening, closes on Escape, and Escape and Close give the focus to the Open chat button', async () => {
    await seedGuest({ heightCm: 170, sex: 'female', birthYear: 1980, birthMonth: 3 }, [['weight', 70]]);
    render(<HealthTool />);
    await openFloatingChat();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Discuss your health' }));
    expect(dialog()!.contains(document.activeElement)).toBe(true);

    await act(async () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });
    expect(dialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(fab()));

    await openFloatingChat();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close chat' })); });
    await waitFor(() => expect(document.activeElement).toBe(fab()));
  });

  it('brought back by a width change while a weight is being typed in a grid, it takes no focus and the draft is not saved (US-03 AC5)', async () => {
    await seedGuest({ heightCm: 178, sex: 'male', birthYear: 1980, birthMonth: 1, unitSystem: 'si' }, [['weight', 82]]);
    const view = render(<HealthTool />);
    await openFloatingChat();
    await setWide(true);
    expect(dialog()).toBeNull();
    showTables(view.container);
    const cell = await waitFor(() => [...view.container.querySelectorAll('.bt-vitals-card .bt-row')]
      .find((row) => row.querySelector('.bt-name-label')?.textContent === 'Weight')!.querySelector<HTMLInputElement>('.bt-cell-draft input')!);
    typeInto(cell, '84');
    await setWide(false);
    await settle(); // time for a save to land
    expect(dialog()).not.toBeNull();
    expect(toOldShape(await recordOnDisk()).measurements.filter((m) => m.metricType === 'weight').map((m) => m.value)).toEqual([82]);
    expect(document.activeElement).toBe(cell);
  });
});
