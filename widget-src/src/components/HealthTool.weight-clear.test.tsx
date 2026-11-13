// @vitest-environment jsdom
/**
 * US-62 AC38 (lead H69): a saved weight cleared in the onboarding's weight box
 * stays empty when the box is left, and one line under the height and weight
 * row says the plan still uses the saved reading, with a link to the weight's
 * value page. Nothing is written; a reload shows the saved value again.
 *
 * The whole widget renders over a real RoadmapStore on localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { localDay } from '@roadmap/health-core/merge';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, flushRoadmapStore, initRoadmapStore, saveChangedMeasurements } from '../lib/roadmap-data';
import { formatShortDate } from '../lib/constants';

vi.mock('../lib/build-flags', () => ({ LOCAL_FIRST: true, SHOPIFY_SURFACE: true }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async original => ({
  ...(await original<typeof import('../lib/server-api')>()),
  trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', async original => ({
  ...(await original<typeof import('../lib/chat-api')>()),
  listConversations: () => Promise.resolve(null), getChatGate: () => null,
}));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
import { HealthTool } from './HealthTool';

const stops: Array<() => void> = [];

beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/api/events')) return new Response('{"success":true}');
    throw new Error('Synthetic test: no network');
  }));
  Element.prototype.scrollIntoView ??= () => {};
  const start = RoadmapStore.prototype.startLiveRefresh;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: RoadmapStore) {
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

async function recordOnDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  return (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
}
const weightRows = async () => (await recordOnDisk()).measurements
  .filter((m) => m.metricType === 'weight').map((m) => [m.value, m.recordedAt.slice(0, 10), m.status]);

/** The onboarding with a height and a saved weight: the weight box holds it. */
async function openWithWeight(day: string): Promise<{ view: RenderResult; box: HTMLInputElement }> {
  await saveChangedMeasurements({ heightCm: 170 }, {});
  await addMeasurement('weight', 90, day);
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  const box = await waitFor(() => { const b = view.container.querySelector<HTMLInputElement>('#weightKg'); expect(b?.value).toBe('90'); return b!; });
  return { view, box };
}
/** Select all, delete, then leave the box. */
function clearAndLeave(box: HTMLInputElement) {
  act(() => { box.focus(); });
  fireEvent.change(box, { target: { value: '' } });
  act(() => { box.blur(); });
}
const stillLine = (view: RenderResult) => view.container.querySelector<HTMLElement>('.weight-still-counts');
const leave = () => act(async () => { await new Promise((r) => setTimeout(r, 700)); }); // past the 500 ms save

describe('US-62 AC38: a saved weight cleared in its box stays cleared, and the plan still uses it', () => {
  it('an older reading: the box stays empty, one line under the row names it, and its link opens the weight page', async () => {
    const { view, box } = await openWithWeight('2024-03-03');
    const before = await weightRows();
    clearAndLeave(box);
    await leave();

    expect(box.value).toBe('');
    const line = stillLine(view);
    expect(line?.textContent).toBe(`Your plan still uses 90 kg from ${formatShortDate('2024-03-03')}. Type a new weight, or correct this one in your weight history.`);
    // Under the whole height and weight row, not inside the weight's column.
    expect(line!.previousElementSibling?.classList.contains('sex-height-row')).toBe(true);
    expect(box.getAttribute('aria-describedby')).toBe(line!.id);
    // The "Saved" date line does not show over an empty box.
    expect(box.closest('.health-field')!.querySelector('.previous-reference')).toBeNull();
    // Nothing written: the same one active row.
    expect(await weightRows()).toEqual(before);
    expect(before).toEqual([[90, '2024-03-03', 'active']]);

    // Only "weight history" is a link, and it opens the weight's value page.
    const link = within(line!).getByRole('link');
    expect(link.textContent).toBe('weight history');
    fireEvent.click(link);
    await waitFor(() => expect(within(view.container.querySelector('.mh-page-host .md-page') as HTMLElement).getByRole('heading', { name: 'Weight' })).toBeTruthy());
  });

  it('a number typed in hides the line and brings back the Previous line', async () => {
    const { view, box } = await openWithWeight('2024-03-03');
    clearAndLeave(box);
    expect(stillLine(view)).toBeTruthy();
    act(() => { box.focus(); });
    fireEvent.change(box, { target: { value: '88' } });
    expect(stillLine(view)).toBeNull();
    expect(box.hasAttribute('aria-describedby')).toBe(false);
    expect(box.closest('.health-field')!.querySelector('.previous-reference')?.textContent).toBe(`Previous: 90 kg · ${formatShortDate('2024-03-03')}`);
  });

  it('a reading from today: the line says today\'s, and a typed number shows Replaces', async () => {
    const { view, box } = await openWithWeight(localDay(new Date()));
    clearAndLeave(box);
    await leave();
    expect(box.value).toBe('');
    expect(stillLine(view)?.textContent).toBe('Your plan still uses today\'s 90 kg. Type a new weight, or correct it in your weight history.');
    act(() => { box.focus(); });
    fireEvent.change(box, { target: { value: '88' } });
    expect(stillLine(view)).toBeNull();
    expect(box.closest('.health-field')!.querySelector('.previous-reference')?.textContent).toBe('Replaces 90 kg');
  });

  it('a reload shows the saved value in the box again, with no line', async () => {
    const { view, box } = await openWithWeight('2024-03-03');
    clearAndLeave(box);
    await leave();
    view.unmount();
    const again = render(<HealthTool />);
    await waitFor(() => expect(again.container.querySelector<HTMLInputElement>('#weightKg')?.value).toBe('90'));
    expect(stillLine(again)).toBeNull();
    expect(await weightRows()).toEqual([[90, '2024-03-03', 'active']]);
  });
});
