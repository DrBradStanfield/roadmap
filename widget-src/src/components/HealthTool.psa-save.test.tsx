// @vitest-environment jsdom
/**
 * US-06 AC15: a PSA typed into the prostate section is saved as a PSA
 * measurement, dated by the month and year picked beside it (the 1st of that
 * month), or today when the picker was not touched. It saves the way a
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
import { localDay, ROADMAP_FILE_NAME, toOldShape, type RoadmapFile } from '@roadmap/health-core';
import { flushRoadmapStore, initRoadmapStore, saveScreening } from '../lib/roadmap-data';
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

/**
 * A man born 1960, height on record, one saved HbA1c (so the whole form shows
 * while the weight is still a first-time field), who said he will screen.
 */
async function page() {
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1960, birthMonth: 1, unitSystem: 'si' }, [['hba1c', 40]]);
  await saveScreening('prostate_discussion', 'will_screen');
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('#psa-input')).not.toBeNull());
  await waitFor(() => expect(view.container.querySelector('#weightKg')).not.toBeNull());
  const row = view.container.querySelector<HTMLElement>('.psa-inline-row')!;
  return {
    view,
    psa: () => view.container.querySelector<HTMLInputElement>('#psa-input')!,
    year: row.querySelector<HTMLSelectElement>('select[aria-label="Year"]')!,
    month: row.querySelector<HTMLSelectElement>('select[aria-label="Month"]')!,
  };
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

const pause = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

function type(field: HTMLInputElement, value: string) {
  act(() => field.focus());
  fireEvent.change(field, { target: { value } });
}

function pick(year: HTMLSelectElement, month: HTMLSelectElement, y: string, m: string) {
  fireEvent.change(year, { target: { value: y } });
  fireEvent.change(month, { target: { value: m } });
}

describe('a PSA typed into the prostate section is saved (US-06 AC15)', () => {
  it('date picked, value typed, field left: saved under the 1st of the picked month, and still there after a reload', async () => {
    const { view, psa, year, month } = await page();
    pick(year, month, '2025', '01');
    type(psa(), '6.5');
    act(() => psa().blur());
    await pause(700); // past the 500 ms field save

    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-01-01']]));
    // What was saved leaves the field, and the saved value shows under it.
    await waitFor(() => expect(psa().value).toBe(''));
    expect(view.container.querySelector('.psa-inline-row')!.parentElement!.textContent).toContain('6.5 ng/mL');

    view.unmount();
    await initRoadmapStore(new LocalStorageAdapter());
    expect(await active('psa')).toEqual([[6.5, '2025-01-01']]);
  });

  it('value typed first, then the date: moving into the picker does not save, leaving the row does, under the picked month', async () => {
    const { view, psa, year, month } = await page();
    type(psa(), '6.5');
    act(() => month.focus()); // from the number to the picker beside it
    await pause(700);
    expect(await active('psa')).toEqual([]);

    pick(year, month, '2025', '03');
    act(() => month.blur()); // out of the row
    await pause(700);
    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-03-01']]));
    view.unmount();
  });

  it('the "Save PSA" tick saves at once; an untouched picker dates it today', async () => {
    const { view, psa } = await page();
    type(psa(), '4.2');
    const tick = view.container.querySelector<HTMLButtonElement>('button[aria-label="Save PSA"]');
    expect(tick).not.toBeNull();
    act(() => tick!.click());
    await waitFor(async () => expect(await active('psa')).toEqual([[4.2, localDay(new Date())]]));
    view.unmount();
  });

  it('Enter in the PSA field saves at once, under the picked month', async () => {
    const { view, psa, year, month } = await page();
    pick(year, month, '2025', '06');
    type(psa(), '3.3');
    fireEvent.keyDown(psa(), { key: 'Enter' });
    await waitFor(async () => expect(await active('psa')).toEqual([[3.3, '2025-06-01']]));
    view.unmount();
  });

  it('page departure inside the 500 ms wait still saves it, under the picked month', async () => {
    const { view, psa, year, month } = await page();
    pick(year, month, '2024', '11');
    type(psa(), '5');
    act(() => psa().blur());
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    await waitFor(async () => expect(await active('psa')).toEqual([[5, '2024-11-01']]));
    view.unmount();
  });

  it.each(['pagehide', 'beforeunload'])('value typed, then the month picked, then the tab closed (%s) with focus still on the picker: saved under the picked month', async event => {
    const { view, psa, year, month } = await page();
    type(psa(), '6.5');
    act(() => month.focus());
    pick(year, month, '2025', '02');
    act(() => { window.dispatchEvent(new Event(event)); }); // no blur first: browsers fire none
    view.unmount(); // the page goes away: no 500 ms timer runs after this
    await waitFor(async () => expect(await active('psa')).toEqual([[6.5, '2025-02-01']]));
  });

  it('beforeunload then pagehide, focus still in the PSA box: one PSA write, one PSA row', async () => {
    const { view, psa, year, month } = await page();
    pick(year, month, '2025', '04');
    type(psa(), '2.8');
    writes.length = 0;
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('pagehide'));
    });
    view.unmount();
    await pause(700);
    await waitFor(async () => expect(await all('psa')).toEqual([[2.8, '2025-04-01', 'active']]));
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

  it('control: a weight, a waist and a blood pressure typed into their first-time fields and left are saved under today, whatever month the PSA picker shows, and no PSA row appears', async () => {
    const { view, year, month } = await page();
    pick(year, month, '2025', '01');
    const box = (id: string) => view.container.querySelector<HTMLInputElement>(`#${id}`)!;
    for (const [id, value] of [['weightKg', '82'], ['waistCm', '90'], ['systolicBp', '128'], ['diastolicBp', '82']]) {
      type(box(id), value);
      act(() => box(id).blur());
    }
    await pause(700);
    const today = localDay(new Date());
    await waitFor(async () => expect(await active('weight')).toEqual([[82, today]]));
    expect(await active('waist')).toEqual([[90, today]]);
    expect(await active('systolic_bp')).toEqual([[128, today]]);
    expect(await active('diastolic_bp')).toEqual([[82, today]]);
    expect(await active('psa')).toEqual([]);
    view.unmount();
  });
});
