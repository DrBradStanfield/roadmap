// @vitest-environment jsdom
/**
 * US-60 AC3, AC4 on the web: the "Reduce alcohol intake" card's Dismiss asks
 * "Do you drink alcohol?"; the answer saves to the profile through the form's
 * own write path, and Starting Info's Alcohol toggle changes or clears it.
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

// About you's Alcohol toggle (US-60 AC4): the label of its checked answer, '' when none.
const alcoholRow = (root: HTMLElement) => root.querySelector<HTMLElement>('#alcohol[role="group"]');
const alcoholAnswer = (root: HTMLElement) => alcoholRow(root)?.querySelector('[aria-pressed="true"]')?.textContent ?? '';
const alcoholCard = (root: HTMLElement) =>
  [...root.querySelectorAll('.suggestion-title')].find((t) => t.textContent === 'Reduce alcohol intake');
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="alcohol-dialog-title"]');
const dismiss = async (root: HTMLElement, prompt = 'Do you drink alcohol?') => {
  const card = await waitFor(() => { const c = alcoholCard(root); expect(c).toBeDefined(); return c!; });
  const button = card.closest('.suggestion-subsection, .suggestion-card')!.querySelector<HTMLButtonElement>('.suggestion-dismiss')!;
  fireEvent.click(button);
  expect(dialog()).not.toBeNull();
  expect(within(dialog()!).getByRole('heading').textContent).toBe(prompt);
};
const still = (section: string) => `This stays on your plan because the advice applies to anyone who drinks. You can change your answer in ${section}.`;

it('US-60 AC3: "I don\'t drink" takes the card off the plan and saves the answer; the event carries no answer', async () => {
  const view = render(<HealthTool />);
  await dismiss(view.container);
  // Only this card has a Dismiss.
  expect(view.container.querySelectorAll('.suggestion-dismiss')).toHaveLength(1);
  fireEvent.click(within(dialog()!).getByText("I don't drink"));
  expect(dialog()).toBeNull();
  // The answer is in the form on the click, so the card leaves at once; it saves
  // through the profile autosave and its erase guard (US-16 AC2a).
  expect(alcoholCard(view.container)).toBeUndefined();
  await persist();
  expect(saved().profile.alcohol).toBe('none');
  expect(alcoholAnswer(view.container)).toBe("I don't drink");
  expect(vi.mocked(trackProductEvent)).toHaveBeenCalledWith('alcohol_question_answered');
  for (const call of vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'alcohol_question_answered')) {
    expect(call).toHaveLength(1);
  }
});

it('US-60 AC3 (C4): "I drink" saves the answer and the card stays; Cancel saves nothing', async () => {
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
});

it('US-60 AC3 (Brad 2026-11-01): a drinker\'s Dismiss asks "Do you still drink alcohol?"; "I still drink" saves nothing and says why the card stays', async () => {
  await saveChangedMeasurements({ alcohol: 'drinks' }, {});
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(alcoholAnswer(view.container)).toBe('I drink'));
  expect(view.container.querySelectorAll('.suggestion-dismiss')).toHaveLength(1);
  await dismiss(view.container, 'Do you still drink alcohol?');
  expect([...dialog()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(["I've stopped", 'I still drink', 'Cancel']);
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  // The saved file, stamps and all, before the tap: "I still drink" writes nothing.
  const before = saved();
  expect(before.profile.alcohol).toBe('drinks');
  expect(before.profile.fieldStamps?.alcohol).toBeDefined();
  fireEvent.click(within(dialog()!).getByText('I still drink'));
  // One line, in the dialog's place, never a browser alert. On desktop the
  // profile section is titled "Starting Info", so the line names that.
  expect(dialog()!.textContent).toBe(`${still('Starting Info')}OK`);
  expect(alert).not.toHaveBeenCalled();
  fireEvent.click(within(dialog()!).getByText('OK'));
  expect(dialog()).toBeNull();
  // Past the autosave's debounce nothing has landed, meta included...
  await tick();
  expect(saved()).toEqual(before);
  // ...and nothing was pending: after a flush only meta moves, as any flush
  // moves it (lamport, updatedAt), and the alcohol stamp is untouched.
  await act(async () => { await flushRoadmapStore(); });
  expect({ ...saved(), meta: null }).toEqual({ ...before, meta: null });
  expect(saved().profile.fieldStamps?.alcohol).toEqual(before.profile.fieldStamps?.alcohol);
  expect(alcoholCard(view.container)).toBeDefined();
  expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('alcohol_question_answered');
});

it('US-60 AC3 (Brad 2026-11-01): on a phone with sex and height in, the "I still drink" line names About you, the title shown there', async () => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
  }));
  await saveChangedMeasurements({ alcohol: 'drinks' }, {});
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(alcoholAnswer(view.container)).toBe('I drink'));
  const titles = [...view.container.querySelectorAll('.health-section-title')].map((h) => h.textContent!.replace('\u25B8', '').trim());
  expect(titles).toContain('About you');
  expect(titles).not.toContain('Starting Info');
  await dismiss(view.container, 'Do you still drink alcohol?');
  fireEvent.click(within(dialog()!).getByText('I still drink'));
  expect(dialog()!.textContent).toBe(`${still('About you')}OK`);
});

it('US-60 AC3 (Brad 2026-11-01): a drinker\'s "I\'ve stopped" saves \'none\' through the profile autosave and the card leaves; the event carries no answer', async () => {
  await saveChangedMeasurements({ alcohol: 'drinks' }, {});
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(alcoholAnswer(view.container)).toBe('I drink'));
  await dismiss(view.container, 'Do you still drink alcohol?');
  fireEvent.click(within(dialog()!).getByText("I've stopped"));
  expect(dialog()).toBeNull();
  expect(alcoholCard(view.container)).toBeUndefined();
  await persist();
  expect(saved().profile.alcohol).toBe('none');
  expect(vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'alcohol_question_answered')).toEqual([['alcohol_question_answered']]);
});

it('US-60 AC4 (M2): Starting Info\'s Alcohol toggle sets each answer with no usage event, and tapping the chosen one clears it with a stamp and brings the card back', async () => {
  const view = render(<HealthTool />);
  const row = await waitFor(() => { const r = alcoholRow(view.container); expect(r).not.toBeNull(); return r!; });
  expect(row.getAttribute('aria-label')).toBe('Alcohol');
  const radios = within(row).getAllByRole('button');
  expect(radios.map((b) => b.textContent)).toEqual(["I don't drink", 'I drink']);
  // Unanswered: neither is checked, and the row asks for no attention (optional).
  expect(radios.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
  expect(row.closest('.health-field')!.classList.contains('field-attention')).toBe(false);
  expect(row.closest('.health-field')!.querySelector('.field-why')?.textContent).toBe('Used to decide whether advice on alcohol applies to you.');

  fireEvent.click(within(row).getByText('I drink'));
  await persist();
  expect(saved().profile.alcohol).toBe('drinks');
  expect(radios.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  expect(alcoholCard(view.container)).toBeDefined();

  fireEvent.click(within(row).getByText("I don't drink"));
  await persist();
  expect(saved().profile.alcohol).toBe('none');
  expect(radios.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  expect(radios[0].classList.contains('sex-toggle-btn--active')).toBe(true);
  expect(alcoholCard(view.container)).toBeUndefined();

  // Tapping the chosen answer clears it (M2): a stamped null, the card returns.
  fireEvent.click(within(row).getByText("I don't drink"));
  await persist();
  expect(saved().profile.alcohol).toBeNull();
  expect(saved().profile.fieldStamps?.alcohol).toBeDefined();
  expect(radios.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
  await waitFor(() => expect(alcoholCard(view.container)).toBeDefined());
  // The signal counts the card's question only (US-60 usage signal).
  expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('alcohol_question_answered');

  // A fresh load reads the cleared answer as not answered.
  view.unmount();
  await act(async () => { await initRoadmapStore(new LocalStorageAdapter()); });
  const reloaded = render(<HealthTool />);
  await waitFor(() => expect(alcoholRow(reloaded.container)).not.toBeNull());
  expect(alcoholAnswer(reloaded.container)).toBe('');
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
