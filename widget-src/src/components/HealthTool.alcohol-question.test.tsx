// @vitest-environment jsdom
/**
 * US-60 AC3, AC4 on the web: the "Reduce alcohol intake" card's Dismiss asks
 * "Do you drink alcohol?"; the answer saves to the profile through the form's
 * own write path. After the onboarding, About you's rows hold an Alcohol row
 * to change or clear it; during the onboarding there is none (Brad 2026-11-02).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
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
import { openSettings } from '../testing/settings';
import { trackLiveRefresh, stopLiveRefresh } from '../testing/health-tool-harness';

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
  trackLiveRefresh();
  await initRoadmapStore(new LocalStorageAdapter());
  // BMI 31.6: the plan shows "Reduce alcohol intake".
  await saveChangedMeasurements({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 5, unitSystem: 'si', weightKg: 100 }, {});
  await flushRoadmapStore();
});
afterEach(async () => {
  cleanup();
  stopLiveRefresh();
  await flushRoadmapStore();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

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
  expect(view.container.querySelectorAll('.suggestion-dismiss')).toHaveLength(1);
  await dismiss(view.container, 'Do you still drink alcohol?');
  expect([...dialog()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(["I've stopped", 'I still drink', 'Cancel']);
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  // The saved file, stamps and all, before the tap: "I still drink" writes nothing.
  const before = saved();
  expect(before.profile.alcohol).toBe('drinks');
  expect(before.profile.fieldStamps?.alcohol).toBeDefined();
  fireEvent.click(within(dialog()!).getByText('I still drink'));
  // One line, in the dialog's place, never a browser alert. A complete record's
  // profile section is titled "About you" on desktop too (US-62 AC12, Brad
  // 2026-11-02), so the line names that.
  expect(dialog()!.textContent).toBe(`${still('About you')}OK`);
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
  await waitFor(() => openSettings(view.container)); // About you sits in Settings (US-62 AC24)
  const titles = [...view.container.querySelectorAll('.health-section-title')].map((h) => h.textContent!.replace('\u25B8', '').trim());
  expect(titles).toContain('About you');
  expect(titles).not.toContain('Starting info');
  await dismiss(view.container, 'Do you still drink alcohol?');
  fireEvent.click(within(dialog()!).getByText('I still drink'));
  expect(dialog()!.textContent).toBe(`${still('About you')}OK`);
});

it('US-60 AC3 (Brad 2026-11-01): a drinker\'s "I\'ve stopped" saves \'none\' through the profile autosave and the card leaves; the event carries no answer', async () => {
  await saveChangedMeasurements({ alcohol: 'drinks' }, {});
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await dismiss(view.container, 'Do you still drink alcohol?');
  fireEvent.click(within(dialog()!).getByText("I've stopped"));
  expect(dialog()).toBeNull();
  expect(alcoholCard(view.container)).toBeUndefined();
  await persist();
  expect(saved().profile.alcohol).toBe('none');
  expect(vi.mocked(trackProductEvent).mock.calls.filter(([name]) => name === 'alcohol_question_answered')).toEqual([['alcohol_question_answered']]);
});

const stub = (phone: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({
  matches: q.includes('max-width') ? phone : !phone, media: q, addEventListener() {}, removeEventListener() {},
}));

it('US-60 AC4 (Brad 2026-11-02): mid-onboarding there is no Alcohol row, and "I still drink" names no section, on desktop and a phone', async () => {
  // No birth date yet: the onboarding is not done, so Starting Info shows its boxes. A saved
  // blood test opens the whole form (opensFullForm), where the plan's cards show (US-62 AC25).
  localStorage.clear();
  await initRoadmapStore(new LocalStorageAdapter());
  await saveChangedMeasurements({ sex: 'male', heightCm: 178, unitSystem: 'si', weightKg: 100, alcohol: 'drinks', hba1c: 35 }, {});
  await flushRoadmapStore();
  for (const phone of [false, true]) {
    stub(phone);
    const view = render(<HealthTool />);
    await waitFor(() => expect(alcoholCard(view.container)).toBeDefined());
    expect(view.container.querySelector('#alcohol')).toBeNull();
    expect(within(view.container.querySelector<HTMLElement>('.about-card')!).queryByText(/alcohol/i)).toBeNull(); // Starting Info asks nothing of it
    await dismiss(view.container, 'Do you still drink alcohol?');
    fireEvent.click(within(dialog()!).getByText('I still drink'));
    expect(dialog()!.textContent).toBe('This stays on your plan because the advice applies to anyone who drinks.OK');
    fireEvent.click(within(dialog()!).getByText('OK'));
    view.unmount();
  }
});

it('US-60 AC4 with US-62 AC12: once the birth date finishes the onboarding and its card is left, About you is low with its Alcohol row, and "I still drink" names it, on desktop and a phone', async () => {
  for (const phone of [false, true]) {
    localStorage.clear();
    await initRoadmapStore(new LocalStorageAdapter());
    await saveChangedMeasurements({ sex: 'male', heightCm: 178, unitSystem: 'si', weightKg: 100, alcohol: 'drinks', hba1c: 35 }, {});
    await flushRoadmapStore();
    stub(phone);
    const view = render(<HealthTool />);
    await waitFor(() => expect(alcoholCard(view.container)).toBeDefined());
    fireEvent.change(view.container.querySelector('#birthMonth')!, { target: { value: '5' } });
    const year = view.container.querySelector<HTMLInputElement>('#birthYear')!;
    act(() => year.focus());
    fireEvent.change(year, { target: { value: '1980' } });
    expect(view.container.querySelector('.md-about-you')).toBeNull(); // still typing
    act(() => year.blur());
    // About you goes to Settings once the onboarding is done (US-62 AC24, AC25).
    await waitFor(() => expect(view.container.querySelector('.mh-page .about-card')).toBeNull()); // a phone's Account keeps Settings mounted
    openSettings(view.container);
    const about = await waitFor(() => { const a = view.container.querySelector<HTMLElement>('.md-about-you'); expect(a).not.toBeNull(); return a!; });
    expect(within(about).getByText('Alcohol')).toBeTruthy();
    await dismiss(view.container, 'Do you still drink alcohol?');
    fireEvent.click(within(dialog()!).getByText('I still drink'));
    expect(dialog()!.textContent).toBe(`${still('About you')}OK`);
    fireEvent.click(within(dialog()!).getByText('OK'));
    view.unmount();
  }
});

it('US-60 AC4, AC4b (Brad 2026-11-02): About you\'s rows hold an Alcohol row that sets and clears the answer, on desktop and a phone', async () => {
  for (const phone of [false, true]) {
    stub(phone);
    const view = render(<HealthTool />);
    await waitFor(() => expect(alcoholCard(view.container)).toBeDefined());
    openSettings(view.container); // About you sits in Settings (US-62 AC24)
    const row = view.container.querySelector<HTMLButtonElement>('#about-alcohol')!;
    expect(row.closest('.about-rows')).not.toBeNull();
    expect(row.textContent).toBe('AlcoholNot answered');
    expect(view.container.querySelector('#alcohol')).toBeNull();
    fireEvent.click(row);
    const group = within(view.container.querySelector<HTMLElement>('.mh-settings')!).getByRole('group', { name: 'Alcohol' }); // a phone's Account tab (US-62 AC34)
    expect(group.id).toBe('alcohol');
    const button = (name: string) => within(group).getByRole('button', { name });
    expect([button("I don't drink"), button('I drink')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(view.container.querySelector('[data-about="alcohol"] .field-why')!.textContent).toBe('Used to decide whether advice on alcohol applies to you.');
    expect(view.container.querySelector('[data-about="alcohol"] .field-hint-attention')).toBeNull();

    fireEvent.click(button("I don't drink"));
    expect(button("I don't drink").getAttribute('aria-pressed')).toBe('true');
    expect(alcoholCard(view.container)).toBeUndefined();
    await persist();
    expect(saved().profile.alcohol).toBe('none');

    // Tapping the chosen answer clears it: Not answered, and the card returns.
    fireEvent.click(button("I don't drink"));
    expect(button("I don't drink").getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(alcoholCard(view.container)).toBeDefined());
    await persist();
    expect(saved().profile.alcohol).toBeNull(); // a cleared field saves as null (LWW)
    fireEvent.click(within(view.container.querySelector<HTMLElement>('[data-about="alcohol"]')!).getByRole('button', { name: 'Done' }));
    expect(view.container.querySelector('#about-alcohol')!.textContent).toBe('AlcoholNot answered');
    expect(vi.mocked(trackProductEvent)).not.toHaveBeenCalledWith('alcohol_question_answered');
    view.unmount();
  }
});

// Since US-62 AC18 the triglycerides advice sits under Cholesterol and the alcohol card under
// Weight & diabetes, so the two no longer share a grouped card; the answer still reaches both.
it('US-60 AC3 (C2): the Dismiss sits on the alcohol card, and "I don\'t drink" also drops "limit alcohol" from the triglycerides card', async () => {
  await saveChangedMeasurements({ triglycerides: 2.0 }, {});
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await dismiss(view.container);
  expect(alcoholCard(view.container)!.closest('[data-topic]')?.getAttribute('data-topic')).toBe('weight');
  const trigText = () => [...view.container.querySelectorAll('.suggestion-desc')].find((d) => d.textContent?.startsWith('Blood triglycerides'))?.textContent;
  expect(trigText()).toContain('limit alcohol');
  fireEvent.click(within(dialog()!).getByText("I don't drink"));
  await persist();
  expect(alcoholCard(view.container)).toBeUndefined();
  expect(trigText()).toBe('Blood triglycerides are very diet-sensitive—improvements can be seen within 2-3 weeks. Key measures: reduce sugar intake, and reduce total fat and calorie intake.');
});

// US-60 AC3a: the dialog is modal (aria-modal) for the keyboard too.
const dismissButton = async (root: HTMLElement) => {
  const card = await waitFor(() => { const c = alcoholCard(root); expect(c).toBeDefined(); return c!; });
  return card.closest('.suggestion-subsection, .suggestion-card')!.querySelector<HTMLButtonElement>('.suggestion-dismiss')!;
};
/** Tab as a browser does it: the page's keydown handlers first; unless one prevents it,
 *  the focus moves to the next (or previous) focusable element, wrapping round. */
const pressTab = (shift = false) => {
  const from = document.activeElement as HTMLElement;
  if (!fireEvent.keyDown(from, { key: 'Tab', shiftKey: shift })) return;
  const all = [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
  const at = all.indexOf(from);
  all[(at + (shift ? all.length - 1 : 1)) % all.length].focus();
};
const focused = () => document.activeElement?.textContent;

it('US-60 AC3a: Tab and Shift+Tab go round the dialog\'s buttons and never reach the page behind it', async () => {
  const view = render(<HealthTool />);
  await dismiss(view.container);
  expect(focused()).toBe("I don't drink");
  pressTab(true);
  expect(focused()).toBe('Cancel');
  pressTab();
  expect(focused()).toBe("I don't drink");
  pressTab();
  expect(focused()).toBe('I drink');
  pressTab();
  expect(focused()).toBe('Cancel');
  pressTab();
  expect(focused()).toBe("I don't drink");
  expect(dialog()!.contains(document.activeElement)).toBe(true);
  // Only Tab is taken: another key leaves the focus where it is.
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(focused()).toBe("I don't drink");
  // The focus off every button (a click on the dialog's text): Tab starts again at the first.
  (document.activeElement as HTMLElement).blur();
  pressTab();
  expect(focused()).toBe("I don't drink");
});

it('US-60 AC3a: Cancel, Escape, a click on the backdrop and "I drink" give the focus back to Dismiss', async () => {
  const view = render(<HealthTool />);
  await dismiss(view.container);
  fireEvent.click(within(dialog()!).getByText('Cancel'));
  expect(document.activeElement).toBe(await dismissButton(view.container));

  await dismiss(view.container);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(await dismissButton(view.container));

  await dismiss(view.container);
  fireEvent.click(dialog()!.parentElement!);
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(await dismissButton(view.container));

  await dismiss(view.container);
  fireEvent.click(within(dialog()!).getByText('I drink'));
  await persist();
  expect(saved().profile.alcohol).toBe('drinks');
  expect(document.activeElement).toBe(await dismissButton(view.container));
});

it('US-60 AC3a: after "I still drink", the line\'s OK keeps the focus while shown and gives it back to Dismiss', async () => {
  await saveChangedMeasurements({ alcohol: 'drinks' }, {});
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await dismiss(view.container, 'Do you still drink alcohol?');
  fireEvent.click(within(dialog()!).getByText('I still drink'));
  expect(focused()).toBe('OK');
  pressTab();
  expect(focused()).toBe('OK');
  pressTab(true);
  expect(focused()).toBe('OK');
  fireEvent.click(within(dialog()!).getByText('OK'));
  expect(document.activeElement).toBe(await dismissButton(view.container));
});
