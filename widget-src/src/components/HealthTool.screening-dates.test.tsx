// @vitest-environment jsdom
/**
 * US-06: a follow-up marked "Scheduled" asks when it is scheduled, so its
 * date picker offers this month and later, never only past dates. The cancer
 * screenings did this already; the DEXA treatment review did not (final
 * review, 2026-09-28).
 *
 * The whole widget renders over a real RoadmapStore on jsdom's localStorage.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { readScreening } from '@roadmap/health-core/input-form';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import type { RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';
import { flushRoadmapStore, saveScreening } from '../lib/roadmap-data';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

/** A 66-year-old woman with a weight on record: every screening shows. */
async function pageWith(screenings: Array<[string, string]>, selector: string) {
  await seedGuest({ sex: 'female', heightCm: 165, birthYear: 1960, birthMonth: 1 }, [['weight', 70]]);
  for (const [key, value] of screenings) await saveScreening(key, value);
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector(selector)).not.toBeNull());
  return view;
}

/** The years a date picker's months fall in. */
const years = (container: HTMLElement, key: string) =>
  [...new Set([...container.querySelector<HTMLSelectElement>(`select#${key}`)!.options].map(o => o.value).filter(Boolean).map(v => Number(v.slice(0, 4))))];

describe('US-06: a scheduled follow-up picks a date from this month on', () => {
  const thisYear = new Date().getFullYear();

  it.each([
    ['scheduled', (ys: number[]) => expect(Math.min(...ys)).toBe(thisYear)],
    ['completed', (ys: number[]) => expect(Math.max(...ys)).toBe(thisYear)],
  ])('the DEXA treatment review, %s', async (status, check) => {
    const view = await pageWith([
      ['dexa_screening', 'dexa_scan'], ['dexa_last_date', '2025-01'],
      ['dexa_result', 'osteoporosis'], ['dexa_followup_status', status],
    ], 'select#dexa_followup_date');
    const ys = years(view.container, 'dexa_followup_date');
    check(ys);
    if (status === 'scheduled') expect(ys).toContain(thisYear + 1);
  });

  it('the colorectal follow-up, scheduled, as before', async () => {
    const view = await pageWith([
      ['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2025-01'],
      ['colorectal_result', 'abnormal'], ['colorectal_followup_status', 'scheduled'],
    ], 'select#colorectal_followup_date');
    expect(Math.min(...years(view.container, 'colorectal_followup_date'))).toBe(thisYear);
  });
});

// US-06 AC16: a screening's month and year show what the record holds. The
// picker kept its own copy of a date once it was touched, so after "Not yet
// started" cleared the date and the method was picked again, it still showed
// the old month and year while the record held none. Since the whole-month
// select (one choice, one complete month) it keeps no copy at all.
describe('US-06 AC16: a screening date picker shows the saved date, not an old pick', () => {
  const date = (container: HTMLElement, key: string) => container.querySelector<HTMLSelectElement>(`select#${key}`);
  const picked = (container: HTMLElement, key: string) => date(container, key)!.value;
  /** The record's answer for a screening key ('' when none), after the list save has run. */
  async function saved(key: string): Promise<string> {
    await act(async () => { await new Promise(r => setTimeout(r, 1200)); await flushRoadmapStore(); });
    const body = (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
    return readScreening(body.screenings, key);
  }

  it('a date picked, the method set to "Not yet started" and back: the picker is empty, as the record is', async () => {
    const view = await pageWith([['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2024-03']], 'select#colorectal_last_date');
    const c = view.container;
    fireEvent.change(date(c, 'colorectal_last_date')!, { target: { value: '2023-03' } });
    expect(picked(c, 'colorectal_last_date')).toBe('2023-03');
    expect(await saved('colorectal_last_date')).toBe('2023-03');
    fireEvent.change(c.querySelector('#colorectal-method')!, { target: { value: 'not_yet_started' } });
    expect(date(c, 'colorectal_last_date')).toBeNull();
    fireEvent.change(c.querySelector('#colorectal-method')!, { target: { value: 'colonoscopy_10yr' } });
    expect(await saved('colorectal_last_date')).toBe('');
    expect(picked(c, 'colorectal_last_date')).toBe('');
  });

  it('every choice is a whole month: "Month and year" clears it, and the next choice saves as picked', async () => {
    const view = await pageWith([['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2024-03']], 'select#colorectal_last_date');
    const c = view.container;
    fireEvent.change(date(c, 'colorectal_last_date')!, { target: { value: '' } });
    expect(picked(c, 'colorectal_last_date')).toBe('');
    expect(await saved('colorectal_last_date')).toBe('');
    fireEvent.change(date(c, 'colorectal_last_date')!, { target: { value: '2022-07' } });
    expect(picked(c, 'colorectal_last_date')).toBe('2022-07');
    expect(await saved('colorectal_last_date')).toBe('2022-07');
  });

  it('the date cleared, then another device saves a date: the picker shows it', async () => {
    const view = await pageWith([['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2024-03']], 'select#colorectal_last_date');
    const c = view.container;
    fireEvent.change(date(c, 'colorectal_last_date')!, { target: { value: '' } }); // "Month and year": the date is cleared
    expect(await saved('colorectal_last_date')).toBe('');
    await saveScreening('colorectal_last_date', '2021-05'); // another device
    await flushRoadmapStore();
    await act(async () => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    expect(await saved('colorectal_last_date')).toBe('2021-05');
    expect(picked(c, 'colorectal_last_date')).toBe('2021-05');
  });
});
