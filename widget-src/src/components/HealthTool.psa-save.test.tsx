// @vitest-environment jsdom
/**
 * US-06 AC15: a PSA typed into the prostate section is saved as a PSA
 * measurement, dated by the full day picked beside it (dd/mm/yyyy, as every
 * blood test is dated; Brad 2026-11-03), today until another day is picked. It saves the way a
 * first-time weight does: when the field is left (500 ms later), on the
 * "Save PSA" tick or Enter, and on page departure, also while focus is still in
 * its row. Leaving the number for the date picker beside it does not save yet,
 * so a date picked second still counts.
 * Before, the form showed all of this and saved nothing (regression from
 * cf1097cc). The whole HealthTool renders over the real RoadmapStore on
 * jsdom's localStorage; synthetic data only.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { localDay } from '@roadmap/health-core/merge';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { toOldShape } from '@roadmap/health-core/blood-tests';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveScreening } from '../lib/roadmap-data';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
// Every write the page asks of the store, to count them (the store still writes).
const writes = vi.hoisted(() => [] as string[]);
vi.mock('../lib/roadmap-data', async importOriginal => {
  const real = await importOriginal<typeof import('../lib/roadmap-data')>();
  return {
    ...real,
    addMeasurement: (...args: Parameters<typeof real.addMeasurement>) => {
      writes.push(args[0]);
      return real.addMeasurement(...args);
    },
  };
});
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

const MAN = { sex: 'male' as const, heightCm: 178, birthYear: 1960, birthMonth: 1, unitSystem: 'si' as const };
/** The page once the PSA row shows. */
async function shownWithPsa(view: ReturnType<typeof render>) {
  await waitFor(() => expect(view.container.querySelector('#psa-input')).not.toBeNull());
  const row = view.container.querySelector<HTMLElement>('.psa-inline-row')!;
  return {
    view,
    psa: () => view.container.querySelector<HTMLInputElement>('#psa-input')!,
    day: row.querySelector<HTMLInputElement>('input[type="date"]')!,
    note: () => view.container.querySelector('.psa-inline-row')!.parentElement!.textContent ?? '',
  };
}

/**
 * A man born 1960, height on record, one saved HbA1c (so the whole form
 * shows), who said he will screen, plus any PSA rows given as [value, day].
 */
async function page(psaRows: Array<[number, string]> = []) {
  await seedGuest(MAN, [['hba1c', 40]]);
  await saveScreening('prostate_discussion', 'will_screen');
  for (const [value, day] of psaRows) await addMeasurement('psa', value, `${day}T00:00:00.000Z`);
  await flushRoadmapStore();
  return shownWithPsa(render(<HealthTool />));
}

/**
 * The same man with nothing but his profile: the weight is the onboarding's
 * box beside the height (US-62 AC13). Typed there, it is the last answer, so
 * the whole form opens and the box stays while typed in; then he says he
 * will screen, and the PSA row shows.
 */
async function pageWithWeight(value: string) {
  await seedGuest(MAN);
  const view = render(<HealthTool />);
  const weight = await waitFor(() => { const w = view.container.querySelector<HTMLInputElement>('#weightKg'); expect(w).not.toBeNull(); return w!; });
  type(weight, value);
  fireEvent.change(await waitFor(() => { const s = view.container.querySelector('#prostate-discussion'); expect(s).not.toBeNull(); return s!; }), { target: { value: 'will_screen' } });
  return { ...await shownWithPsa(view), weight };
}

// A PSA is a core blood test, stored as a core lab row since US-66; read here as the measurement it was.
async function onDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  return toOldShape((await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile);
}
const active = async (metric: string) =>
  (await onDisk()).measurements.filter(m => m.metricType === metric && m.status === 'active')
    .map(m => [m.value, m.recordedAt.slice(0, 10)]);

const all = async (metric: string) =>
  (await onDisk()).measurements.filter(m => m.metricType === metric).map(m => [m.value, m.recordedAt.slice(0, 10), m.status]);

// The bytes on disk now, read synchronously: no flushRoadmapStore() to rescue a save still in flight.
const rawActive = (metric: string) => toOldShape(new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME).body as RoadmapFile)
  .measurements.filter(m => m.metricType === metric && m.status === 'active').map(m => [m.value, m.recordedAt.slice(0, 10)]);

function depart(event: 'beforeunload' | 'pagehide' | 'visibilitychange') {
  act(() => {
    if (event !== 'visibilitychange') window.dispatchEvent(new Event(event));
    else {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event(event));
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
  });
}

const pause = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

function type(field: HTMLInputElement, value: string) {
  act(() => field.focus());
  fireEvent.change(field, { target: { value } });
}

function pick(day: HTMLInputElement, value: string) {
  fireEvent.change(day, { target: { value } });
}

describe('a PSA typed into the prostate section is saved (US-06 AC15)', () => {
  it('date picked, value typed, field left: saved under the picked day, and still there after a reload', async () => {
    const { view, psa, day } = await page();
    pick(day, '2025-01-14');
    type(psa(), '6.5');
    act(() => psa().blur());
    await pause(700); // past the 500 ms field save

    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-01-14']]));
    // What was saved leaves the field, and the saved value shows under it.
    await waitFor(() => expect(psa().value).toBe(''));
    expect(view.container.querySelector('.psa-inline-row')!.parentElement!.textContent).toContain('6.5 ng/mL');

    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    expect(await active('psa')).toEqual([[6.5, '2025-01-14']]);
  });

  it('value typed first, then the date: moving into the picker does not save, leaving the row does, under the picked day', async () => {
    const { view, psa, day } = await page();
    type(psa(), '6.5');
    act(() => day.focus()); // from the number to the date beside it
    await pause(700);
    expect(await active('psa')).toEqual([]);

    pick(day, '2025-03-20');
    act(() => day.blur()); // out of the row
    await pause(700);
    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-03-20']]));
    view.unmount();
  });

  it('the "Save PSA" tick saves at once; an untouched date box shows today and dates it today', async () => {
    const { view, psa, day } = await page();
    expect(day.value).toBe(localDay(new Date()));
    type(psa(), '4.2');
    const tick = view.container.querySelector<HTMLButtonElement>('button[aria-label="Save PSA"]');
    expect(tick).not.toBeNull();
    act(() => tick!.click());
    await waitFor(async () => expect(await active('psa')).toEqual([[4.2, localDay(new Date())]]));
    view.unmount();
  });

  it('Enter in the PSA field saves at once, under the picked day', async () => {
    const { view, psa, day } = await page();
    pick(day, '2025-06-09');
    type(psa(), '3.3');
    fireEvent.keyDown(psa(), { key: 'Enter' });
    await waitFor(async () => expect(await active('psa')).toEqual([[3.3, '2025-06-09']]));
    view.unmount();
  });

  it('page departure inside the 500 ms wait still saves it, under the picked day', async () => {
    const { view, psa, day } = await page();
    pick(day, '2024-11-27');
    type(psa(), '5');
    act(() => psa().blur());
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    await waitFor(async () => expect(await active('psa')).toEqual([[5, '2024-11-27']]));
    view.unmount();
  });

  it.each(['pagehide', 'beforeunload'])('value typed, then the day picked, then the tab closed (%s) with focus still on the date: saved under the picked day', async event => {
    const { view, psa, day } = await page();
    type(psa(), '6.5');
    act(() => day.focus());
    pick(day, '2025-02-11');
    act(() => { window.dispatchEvent(new Event(event)); }); // no blur first: browsers fire none
    view.unmount(); // the page goes away: no 500 ms timer runs after this
    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-02-11']]));
  });

  it('beforeunload then pagehide, focus still in the PSA box: one PSA write, one PSA row', async () => {
    const { view, psa, day } = await page();
    pick(day, '2025-04-30');
    type(psa(), '2.8');
    writes.length = 0;
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
    view.unmount();
    await pause(700);
    await waitFor(async () => expect(await all('psa')).toEqual([[2.8, '2025-04-30', 'active']]));
    expect(writes.filter(metric => metric === 'psa')).toEqual(['psa']); // one write reaches the store
  });

  it('a box the browser cannot read saves nothing when left, as for every number box (US-02 AC7)', async () => {
    const { view, psa } = await page();
    type(psa(), '6.5');
    Object.defineProperty(psa(), 'validity', { configurable: true, value: { ...psa().validity, badInput: true } });
    fireEvent.change(psa(), { target: { value: '' } }); // what a browser hands over for "6,,5"
    act(() => psa().blur());
    await pause(700);
    expect(await active('psa')).toEqual([]);

    act(() => psa().focus()); // and the tab closed while it still has focus
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    await pause(700);
    expect(await active('psa')).toEqual([]);
    view.unmount();
  });

  // Since H71 (2026-11-13) the weight box is the one first-time vitals field: waist and blood pressure save on their value pages.
  it('control: a weight typed into its box and left is saved under today, whatever day the PSA date shows, and no PSA row appears', async () => {
    const { view, day, weight } = await pageWithWeight('82');
    pick(day, '2025-01-14');
    act(() => weight.blur());
    await pause(700);
    const today = localDay(new Date());
    await waitFor(async () => expect(await active('weight')).toEqual([[82, today]]));
    expect(await active('psa')).toEqual([]);
    view.unmount();
  });

  it('a day after today is not saved: the value stays and the row says "Choose a day up to today."', async () => {
    const { view, psa, day, note } = await page();
    pick(day, '2099-01-01');
    type(psa(), '6.5');
    act(() => psa().blur());
    await pause(700);
    expect(await active('psa')).toEqual([]);
    expect(psa().value).toBe('6.5');
    expect(note()).toContain('Choose a day up to today.');
    view.unmount();
  });
});

describe('after a save the date box goes back to today (US-06 AC15)', () => {
  it('a PSA saved on a picked day: the box shows today again, and no "Replaces" for the value just saved', async () => {
    const { view, psa, day, note } = await page();
    pick(day, '2025-03-20');
    type(psa(), '6.5');
    act(() => psa().blur());
    await pause(700);
    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-03-20']]));
    await waitFor(() => expect(day.value).toBe(localDay(new Date())));
    expect(note()).not.toContain('Replaces');
    expect(note()).toContain('6.5 ng/mL');
    view.unmount();
  });

  it('control: a refused day (after today) keeps the picked day, so the user can fix it', async () => {
    const { view, psa, day } = await page();
    pick(day, '2099-01-01');
    type(psa(), '6.5');
    act(() => psa().blur());
    await pause(700);
    expect(day.value).toBe('2099-01-01');
    view.unmount();
  });
});

describe('a second PSA on a day that already holds one (US-06 AC15, Brad 2026-11-03)', () => {
  it('a value typed for that day says "Replaces 6.5 ng/mL", and saving corrects the held row', async () => {
    const { view, psa, day, note } = await page([[6.5, '2025-01-14']]);
    expect(note()).not.toContain('Replaces');
    pick(day, '2025-01-14');
    expect(note()).not.toContain('Replaces'); // nothing typed yet, so nothing to replace it
    type(psa(), '3.2');
    await waitFor(() => expect(note()).toContain('Replaces 6.5 ng/mL'));
    act(() => psa().blur());
    await pause(700);
    // Both rows stay, in no set order on disk: the old one flipped, the new one active.
    await waitFor(async () => expect(await all('psa')).toEqual(expect.arrayContaining([
      [6.5, '2025-01-14', 'entered-in-error'], [3.2, '2025-01-14', 'active'],
    ])));
    expect(await all('psa')).toHaveLength(2);
    view.unmount();
  });

  it('control: another day in the same month adds a second reading, no "Replaces"', async () => {
    const { view, psa, day, note } = await page([[6.5, '2025-01-14']]);
    pick(day, '2025-01-28');
    type(psa(), '3.2');
    expect(note()).not.toContain('Replaces');
    act(() => psa().blur());
    await pause(700);
    // Order on disk is not the point: both readings are active, each on its own day.
    await waitFor(async () => expect((await active('psa')).sort((x, y) => String(x[1]).localeCompare(String(y[1])))).toEqual([[6.5, '2025-01-14'], [3.2, '2025-01-28']]));
    view.unmount();
  });
});

describe('a PSA saves only once its row is committed (US-06 AC15, Codex R2)', () => {
  it('a weight left first, then a PSA typed with focus still in its row: the weight\'s save does not take the PSA under today', async () => {
    const { view, psa, day, weight } = await pageWithWeight('82');
    act(() => weight.blur()); // the weight's 500 ms save starts
    type(psa(), '6.5'); // focus now in the PSA row, its day not yet chosen
    await pause(700);
    await waitFor(async () => expect(await active('weight')).toEqual([[82, localDay(new Date())]]));
    expect(await active('psa')).toEqual([]);
    expect(psa().value).toBe('6.5');

    act(() => day.focus()); // from the number to the date: still in the row
    pick(day, '2025-03-20');
    act(() => day.blur()); // out of the row: now it saves, under the day chosen
    await pause(700);
    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-03-20']]));
    view.unmount();
  });
});

describe('departure puts the save on disk before the page goes (US-06 AC15, Brad 2026-11-03: weight, waist or BP save on tab close)', () => {
  it.each(['beforeunload', 'pagehide'] as const)('%s with focus still in the PSA row: the PSA is on disk at once', async event => {
    const { view, psa, day } = await page();
    type(psa(), '6.5');
    pick(day, '2025-02-11');
    act(() => day.focus());
    depart(event);
    expect(rawActive('psa')).toEqual([[6.5, '2025-02-11']]);
    view.unmount();
  });

  it.each(['beforeunload', 'pagehide', 'visibilitychange'] as const)('%s inside the 500 ms wait after a weight was left: the weight is on disk at once', async event => {
    const { view, weight } = await pageWithWeight('82');
    act(() => weight.blur());
    depart(event);
    expect(rawActive('weight')).toEqual([[82, localDay(new Date())]]);
    view.unmount();
  });

  // Lead A5-n1 (US-06 AC15): once the timer has fired, a departure no longer
  // stages the save. This guards the timer-to-write path only:
  // flushPendingProfileSave, then fromForm, then the write, all in microtasks,
  // so the write lands before a departure in the next task. It does not cover
  // a slow earlier save on the chain: a real save cannot be held open here.
  it("the weight's timer fired and the tab closed in the next task: the weight is on disk", async () => {
    const { view, weight } = await pageWithWeight('82');
    act(() => weight.blur()); // its 500 ms timer starts
    // Set after the save's timer, for the same 500 ms: it runs in the task right after the timer fires.
    await act(async () => { await new Promise<void>(r => setTimeout(() => { window.dispatchEvent(new Event('pagehide')); r(); }, 500)); });
    expect(rawActive('weight')).toEqual([[82, localDay(new Date())]]);
    view.unmount();
  });

  it('control: departure with nothing left or committed writes nothing', async () => {
    const { view } = await page();
    const before = new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME);
    depart('pagehide');
    expect(new LocalStorageAdapter().readSync(ROADMAP_FILE_NAME)).toEqual(before);
    view.unmount();
  });
});

describe('"Replaces" shows only while a value is typed (US-06 AC15, Codex R6)', () => {
  it('a PSA saved under the untouched date (today): no "Replaces" for the value just saved', async () => {
    const { view, psa, note } = await page();
    type(psa(), '4.2');
    act(() => psa().blur()); // the date box untouched: today
    await pause(700);
    await waitFor(async () => expect(await active('psa')).toEqual([[4.2, localDay(new Date())]]));
    await waitFor(() => expect(psa().value).toBe(''));
    expect(note()).not.toContain('Replaces');
    expect(note()).toContain('4.2 ng/mL');
    type(psa(), '4.4'); // a second value for today does replace it
    await waitFor(() => expect(note()).toContain('Replaces 4.2 ng/mL'));
    view.unmount();
  });
});

describe('a PSA prints on its side of 4.0 (US-06 AC18, Brad 2026-11-03; turned round 2026-11-12)', () => {
  it('a saved 3.96 reads 3.96 under the field and in "Replaces", not 4.0', async () => {
    const { view, psa, day, note } = await page([[3.96, '2025-01-14']]);
    await waitFor(() => expect(note()).toContain('3.96 ng/mL ·'));
    pick(day, '2025-01-14');
    type(psa(), '3.2');
    await waitFor(() => expect(note()).toContain('Replaces 3.96 ng/mL'));
    view.unmount();
  });

  it('control: 6.53 keeps one decimal', async () => {
    const { view, note } = await page([[6.53, '2025-01-14']]);
    await waitFor(() => expect(note()).toContain('6.5 ng/mL ·'));
    view.unmount();
  });
});

describe('the line under the PSA field names the newest usable PSA (US-06 AC14, adversary re-check R4)', () => {
  it('a newer PSA dated after today: the line shows the 6.5 the plan reads', async () => {
    const { view, note } = await page([[6.5, '2025-09-03'], [3.0, '2099-01-01']]);
    await waitFor(() => expect(note()).toContain('6.5 ng/mL'));
    expect(note()).not.toContain('3.0 ng/mL');
    view.unmount();
  });
});

describe('hiding the tab waits for the date (US-06 AC15, Brad 2026-11-03: "Wait for the date")', () => {
  it('hidden with focus still in the PSA row, no date picked: nothing saved; then the page closes: saved', async () => {
    const { view, psa } = await page();
    type(psa(), '6.5');
    depart('visibilitychange');
    expect(rawActive('psa')).toEqual([]);
    expect(document.activeElement).toBe(psa()); // the row is left as it was
    depart('pagehide');
    expect(rawActive('psa')).toEqual([[6.5, localDay(new Date())]]);
    view.unmount();
  });

  it('hidden after the PSA row was left (committed, its save waiting): on disk at once', async () => {
    const { view, psa, day } = await page();
    type(psa(), '6.5');
    act(() => day.focus());
    pick(day, '2025-02-11');
    act(() => day.blur());
    depart('visibilitychange');
    expect(rawActive('psa')).toEqual([[6.5, '2025-02-11']]);
    view.unmount();
  });
});

