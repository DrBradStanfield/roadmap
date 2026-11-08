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
import { readScreening, ROADMAP_FILE_NAME, type RoadmapFile } from '@roadmap/health-core';
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

/** The years a date picker offers. */
const years = (container: HTMLElement, key: string) =>
  [...container.querySelector<HTMLSelectElement>(`#${key}-year`)!.options].map(o => o.value).filter(Boolean).map(Number);

describe('US-06: a scheduled follow-up picks a date from this month on', () => {
  const thisYear = new Date().getFullYear();

  it.each([
    ['scheduled', (ys: number[]) => expect(Math.min(...ys)).toBe(thisYear)],
    ['completed', (ys: number[]) => expect(Math.max(...ys)).toBe(thisYear)],
  ])('the DEXA treatment review, %s', async (status, check) => {
    const view = await pageWith([
      ['dexa_screening', 'dexa_scan'], ['dexa_last_date', '2025-01'],
      ['dexa_result', 'osteoporosis'], ['dexa_followup_status', status],
    ], '#dexa_followup_date-year');
    const ys = years(view.container, 'dexa_followup_date');
    check(ys);
    if (status === 'scheduled') expect(ys).toContain(thisYear + 1);
  });

  it('the colorectal follow-up, scheduled, as before', async () => {
    const view = await pageWith([
      ['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2025-01'],
      ['colorectal_result', 'abnormal'], ['colorectal_followup_status', 'scheduled'],
    ], '#colorectal_followup_date-year');
    expect(Math.min(...years(view.container, 'colorectal_followup_date'))).toBe(thisYear);
  });
});

// US-06 AC16: a screening's month and year show what the record holds. The
// picker kept its own copy of a date once it was touched, so after "Not yet
// started" cleared the date and the method was picked again, it still showed
// the old month and year while the record held none.
describe('US-06 AC16: a screening date picker shows the saved date, not an old pick', () => {
  const picked = (container: HTMLElement, key: string) =>
    [container.querySelector<HTMLSelectElement>(`#${key}-year`)!.value, container.querySelector<HTMLSelectElement>(`#${key}-month`)!.value];
  /** The record's answer for a screening key ('' when none), after the list save has run. */
  async function saved(key: string): Promise<string> {
    await act(async () => { await new Promise(r => setTimeout(r, 1200)); await flushRoadmapStore(); });
    const body = (await new LocalStorageAdapter().read(ROADMAP_FILE_NAME)).body as RoadmapFile;
    return readScreening(body.screenings, key);
  }

  it('a date picked, the method set to "Not yet started" and back: the picker is empty, as the record is', async () => {
    const view = await pageWith([['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2024-03']], '#colorectal_last_date-year');
    const c = view.container;
    fireEvent.change(c.querySelector('#colorectal_last_date-year')!, { target: { value: '2023' } });
    expect(picked(c, 'colorectal_last_date')).toEqual(['2023', '03']);
    expect(await saved('colorectal_last_date')).toBe('2023-03');
    fireEvent.change(c.querySelector('#colorectal-method')!, { target: { value: 'not_yet_started' } });
    expect(c.querySelector('#colorectal_last_date-year')).toBeNull();
    fireEvent.change(c.querySelector('#colorectal-method')!, { target: { value: 'colonoscopy_10yr' } });
    expect(await saved('colorectal_last_date')).toBe('');
    expect(picked(c, 'colorectal_last_date')).toEqual(['', '']);
  });

  it('a date half picked (the month cleared) still shows as picked until it is finished', async () => {
    const view = await pageWith([['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2024-03']], '#colorectal_last_date-year');
    const c = view.container;
    fireEvent.change(c.querySelector('#colorectal_last_date-month')!, { target: { value: '' } });
    expect(picked(c, 'colorectal_last_date')).toEqual(['2024', '']);
    fireEvent.change(c.querySelector('#colorectal_last_date-year')!, { target: { value: '2022' } });
    expect(picked(c, 'colorectal_last_date')).toEqual(['2022', '']);
    fireEvent.change(c.querySelector('#colorectal_last_date-month')!, { target: { value: '07' } });
    expect(picked(c, 'colorectal_last_date')).toEqual(['2022', '07']);
    expect(await saved('colorectal_last_date')).toBe('2022-07');
    fireEvent.change(c.querySelector('#colorectal_last_date-year')!, { target: { value: '' } }); // the year cleared, the month kept
    expect(picked(c, 'colorectal_last_date')).toEqual(['', '07']);
  });

  it('both pickers cleared, then another device saves a date: the pickers show it', async () => {
    const view = await pageWith([['colorectal_method', 'colonoscopy_10yr'], ['colorectal_last_date', '2024-03']], '#colorectal_last_date-year');
    const c = view.container;
    fireEvent.change(c.querySelector('#colorectal_last_date-month')!, { target: { value: '' } });
    fireEvent.change(c.querySelector('#colorectal_last_date-year')!, { target: { value: '' } }); // both blank: the date is cleared
    expect(await saved('colorectal_last_date')).toBe('');
    await saveScreening('colorectal_last_date', '2021-05'); // another device
    await flushRoadmapStore();
    await act(async () => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    expect(await saved('colorectal_last_date')).toBe('2021-05');
    expect(picked(c, 'colorectal_last_date')).toEqual(['2021', '05']);
  });
});
