// @vitest-environment jsdom
/**
 * The two jumps between phone tabs that the page makes itself (US-20 AC6):
 * US-16 AC2 — a chat edit lands on My data, with the filled cell scrolled into
 * view and focused, not wherever the tab was last left.
 * US-22 — a weight typed on My data jumps to My plan's email box.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ProposedEdit } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';

const chat = vi.hoisted(() => ({ proposeEdit: null as null | ((edits: ProposedEdit[]) => void) }));
vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({
  ChatEmbed: ({ onProposeEdit }: { onProposeEdit: (edits: ProposedEdit[]) => void }) => {
    chat.proposeEdit = onProposeEdit;
    return null;
  },
}));
import { HealthTool } from './HealthTool';

const stops: Array<() => void> = [];
let scrolledIntoView: Element[] = [];

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  chat.proposeEdit = null;
  scrolledIntoView = [];
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  vi.stubGlobal('scrollTo', vi.fn());
  Element.prototype.scrollIntoView = function (this: Element) { scrolledIntoView.push(this); };
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const tab = (view: ReturnType<typeof render>, name: string) => within(view.getByRole('tablist')).getByRole('tab', { name });

describe('US-16 AC2 on a phone: a chat edit lands on My data, on the cell it filled', () => {
  it('a chat edit closes an open value page that held typed input, and says it was not saved (US-62 AC11)', async () => {
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await addMeasurement('ldl', 3.0, '2026-09-01');
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    const ldlRow = await waitFor(() => [...view.container.querySelectorAll<HTMLButtonElement>('.md-row')].find(b => b.textContent!.startsWith('LDL'))!);
    fireEvent.click(ldlRow);
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    fireEvent.change(within(page).getByLabelText(/Value/), { target: { value: '2.2' } });
    act(() => chat.proposeEdit!([{ kind: 'field', field: 'ldlC', displayValue: 3.2, unitSystem: 'si', date: null }]));
    await waitFor(() => expect(view.container.querySelector('.md-page')).toBeNull());
    await waitFor(() => expect(view.container.querySelector('.md-panel-messages')!.textContent).toBe('Your typed value was not saved.'));
  });

  it('a blood test: My data shows, and the matrix cell holding the value is in view and focused', async () => {
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {});
    await addMeasurement('weight', 82, '2026-09-01');
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    await waitFor(() => expect(view.container.querySelector('.bt-timeline-title')).not.toBeNull());
    fireEvent.click(tab(view, 'Chat'));
    scrolledIntoView = [];

    act(() => chat.proposeEdit!([{ kind: 'field', field: 'ldlC', displayValue: 3.2, unitSystem: 'si', date: null }]));

    await waitFor(() => expect(document.activeElement?.classList.contains('bt-input-active')).toBe(true));
    const cell = document.activeElement as HTMLInputElement;
    expect(tab(view, 'My data').getAttribute('aria-selected')).toBe('true');
    expect(cell.value).toBe('3.2');
    expect(cell.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
    // US-62 AC11: the grids sit hidden under the phone's rows; the chat edit opens them.
    expect(cell.closest<HTMLElement>('.md-table')?.hidden).toBe(false);
    expect(scrolledIntoView).toContain(cell);
  });

  it('a plain field (no vitals matrix yet): the field is in view and focused', async () => {
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {});
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    fireEvent.click(tab(view, 'Chat'));

    act(() => chat.proposeEdit!([{ kind: 'field', field: 'weightKg', displayValue: 82, unitSystem: 'si', date: null }]));

    await waitFor(() => expect(document.activeElement?.id).toBe('weightKg'));
    expect(tab(view, 'My data').getAttribute('aria-selected')).toBe('true');
    expect(scrolledIntoView).toContain(document.activeElement);
  });

  it('a medication-only edit stays on Chat', async () => {
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {});
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    await waitFor(() => expect(chat.proposeEdit).toBeTruthy());
    fireEvent.click(tab(view, 'Chat'));
    act(() => chat.proposeEdit!([{ kind: 'medication', medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' }]));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(tab(view, 'Chat').getAttribute('aria-selected')).toBe('true');
  });
});

describe('US-22 on a phone: a typed weight jumps to My plan\'s email box', () => {
  it('My plan shows and the email box takes focus', async () => {
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 5, unitSystem: 'si' }, {});
    await flushRoadmapStore();
    const view = render(<HealthTool />);
    const weight = await waitFor(() => {
      const el = view.container.querySelector<HTMLInputElement>('#weightKg');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.change(weight, { target: { value: '182' } });

    await waitFor(() => expect(tab(view, 'My plan').getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(document.activeElement?.id).toBe('guestEmail'), { timeout: 2000 });
    expect(document.activeElement?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
  });
});
