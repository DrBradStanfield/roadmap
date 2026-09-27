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
import { render, waitFor } from '@testing-library/react';
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
