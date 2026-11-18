// @vitest-environment jsdom
/**
 * US-15 AC12a on the tool page's floating chat (a desktop under 1200px wide):
 * "Open chat" moves the focus to the dialog's title, Escape closes the dialog, and
 * Escape or Close gives the focus to the "Open chat" button that comes back. The
 * real HealthTool and ChatSection render; the chat's network calls are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (original) => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({
  getChatGate: () => null, listConversations: vi.fn(async () => ({ conversations: [] })), loadConversation: vi.fn(async () => []),
  sendMessage: vi.fn(() => new Promise(() => {})), deleteConversation: vi.fn(),
}));
vi.mock('../lib/chat-sync', () => ({ postSync: vi.fn(), postInputSync: vi.fn(), subscribeSync: () => () => {}, generateInstanceId: () => 'test' }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));

import { HealthTool } from './HealthTool';

const fab = () => document.querySelector<HTMLButtonElement>('button.chat-fab');
const dialog = () => screen.queryByRole('dialog', { name: 'Health by Dr Brad Chat' });

useHealthToolLifecycle();
beforeEach(() => {
  // A narrow desktop: no chat column and no phone tabs, so the floating chat is the chat.
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
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
});
