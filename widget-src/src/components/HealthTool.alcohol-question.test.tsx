// @vitest-environment jsdom
/**
 * US-60 AC3, AC4 on the web: the "Reduce alcohol intake" card's Dismiss asks
 * "Do you drink alcohol?"; the answer saves to the profile through the form's
 * own write path, and Starting Info's Alcohol row changes or clears it.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';

// Only off-device boundaries are mocked; the plan, form, autosave and store are real.
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
import { HealthTool } from './HealthTool';

const stops: Array<() => void> = [];
const saved = () => new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile;
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1800); });
const persist = async () => { await tick(); await act(async () => { await flushRoadmapStore(); }); };

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-31T10:00:00Z'));
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Synthetic test: no network'); }));
  vi.mocked(trackProductEvent).mockClear();
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function(this: RoadmapStore) {
    const stop = start.call(this); stops.push(stop); return stop;
  });
  await initRoadmapStore(new LocalStorageAdapter());
  // BMI 31.6: the plan shows "Reduce alcohol intake".
  await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 5, unitSystem: 'si', weightKg: 100 }, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
  await flushRoadmapStore();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const alcoholCard = (root: HTMLElement) =>
  [...root.querySelectorAll('.suggestion-title')].find((t) => t.textContent === 'Reduce alcohol intake');
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="alcohol-dialog-title"]');
const dismiss = async (root: HTMLElement) => {
  const card = await waitFor(() => { const c = alcoholCard(root); expect(c).toBeDefined(); return c!; });
  const button = card.closest('.suggestion-subsection, .suggestion-card')!.querySelector<HTMLButtonElement>('.suggestion-dismiss')!;
  fireEvent.click(button);
  expect(dialog()).not.toBeNull();
  expect(within(dialog()!).getByText('Do you drink alcohol?')).toBeTruthy();
};

it('US-60 AC3: "I don\'t drink" takes the card off the plan and saves the answer; the event carries no answer', async () => {
  const view = render(<HealthTool />);
  await dismiss(view.container);
  // Only this card has a Dismiss.
  expect(view.container.querySelectorAll('.suggestion-dismiss')).toHaveLength(1);
  fireEvent.click(within(dialog()!).getByText("I don't drink"));
  expect(dialog()).toBeNull();
  // US-16 AC2a: the answer is in the form on the click, with no deferred
  // write that could land in a record erased meanwhile; the card leaves at once.
  expect(alcoholCard(view.container)).toBeUndefined();
  await persist();
  expect(saved().profile.alcohol).toBe('none');
  expect(view.container.querySelector<HTMLSelectElement>('#alcohol')?.value).toBe('none');
  expect(vi.mocked(trackProductEvent)).toHaveBeenCalledWith('alcohol_question_answered');
  for (const call of vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'alcohol_question_answered')) {
    expect(call).toHaveLength(1);
  }
});

it('US-60 AC3 (C4): "I drink" saves the answer and the card stays with no Dismiss; Cancel saves nothing', async () => {
  const view = render(<HealthTool />);
  await dismiss(view.container);
  fireEvent.click(within(dialog()!).getByText('Cancel'));
  expect(dialog()).toBeNull();
  await persist();
  expect(saved().profile).not.toHaveProperty('alcohol');
  expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('alcohol_question_answered');

  await dismiss(view.container);
  fireEvent.click(within(dialog()!).getByText('I drink'));
  await persist();
  expect(saved().profile.alcohol).toBe('drinks');
  expect(alcoholCard(view.container)).toBeDefined();
  // Answered: the card no longer asks again.
  expect(view.container.querySelectorAll('.suggestion-dismiss')).toHaveLength(0);
});

it('US-60 AC4 (M2): Starting Info\'s Alcohol row sets the answer with no usage event, and "Not answered" clears it with a stamp and brings the card back', async () => {
  const view = render(<HealthTool />);
  const select = await waitFor(() => { const s = view.container.querySelector<HTMLSelectElement>('#alcohol'); expect(s).not.toBeNull(); return s!; });
  expect(select.value).toBe('');
  expect([...select.options].map((o) => o.text)).toEqual(['Not answered', "I don't drink", 'I drink']);
  fireEvent.change(select, { target: { value: 'none' } });
  await persist();
  expect(saved().profile.alcohol).toBe('none');
  expect(alcoholCard(view.container)).toBeUndefined();

  fireEvent.change(select, { target: { value: '' } });
  await persist();
  expect(saved().profile.alcohol).toBeNull();
  expect(saved().profile.fieldStamps?.alcohol).toBeDefined();
  await waitFor(() => expect(alcoholCard(view.container)).toBeDefined());
  // The signal counts the card's question only (US-60 usage signal).
  expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('alcohol_question_answered');

  // A fresh load reads the cleared answer as not answered.
  view.unmount();
  await act(async () => { await initRoadmapStore(new LocalStorageAdapter()); });
  const reloaded = render(<HealthTool />);
  await waitFor(() => expect(reloaded.container.querySelector<HTMLSelectElement>('#alcohol')?.value).toBe(''));
});

it('US-60 AC3 (C2): in a grouped Nutrition card the Dismiss sits on the alcohol section, and "I don\'t drink" also drops "limit alcohol" from the triglycerides card', async () => {
  await saveChangedMeasurements({ triglycerides: 2.0 }, {});
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await dismiss(view.container);
  expect(alcoholCard(view.container)!.closest('.suggestion-subsection')).not.toBeNull();
  const trigText = () => [...view.container.querySelectorAll('.suggestion-desc')].find((d) => d.textContent?.startsWith('Blood triglycerides'))?.textContent;
  expect(trigText()).toContain('limit alcohol');
  fireEvent.click(within(dialog()!).getByText("I don't drink"));
  await persist();
  expect(alcoholCard(view.container)).toBeUndefined();
  expect(trigText()).toBe('Blood triglycerides are very diet-sensitive—improvements can be seen within 2-3 weeks. Key measures: reduce sugar intake, and reduce total fat and calorie intake.');
});
