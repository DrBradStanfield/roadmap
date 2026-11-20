// @vitest-environment jsdom
/** US-23 AC6c on the web: the screening cards, questions, upload gate and reminders read one age, at the UTC month. The whole
 *  HealthTool over the real store on jsdom, the clock frozen, the zone set per test (own `forks` child). Synthetic records only. */
process.env.TZ = 'UTC';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { HealthInputs, Suggestion } from '@roadmap/health-core/types';
import { isScreeningEligible } from '@roadmap/health-core/types';
import { computeReminderSchedule } from '@roadmap/health-core/reminder-schedule';
import { flushRoadmapStore, saveScreening } from '../lib/roadmap-data';
import { recordOnDisk, seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null })); vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
const seen = vi.hoisted(() => ({ suggestions: [] as Suggestion[], uploadAge: undefined as number | undefined })); // the cards; the upload gate's age
vi.mock('./UploadModal', () => ({ UploadModal: (p: { age?: number }) => { seen.uploadAge = p.age; return null; } }));
vi.mock('./ResultsPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ResultsPanel')>();
  return { ...real, usePlanView: (o: Parameters<typeof real.usePlanView>[0]) => { seen.suggestions = o.results?.suggestions ?? []; return real.usePlanView(o); } };
});

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();
afterEach(() => { vi.useRealTimers(); process.env.TZ = 'UTC'; seen.suggestions = []; seen.uploadAge = undefined; });

/** The page at `now` in `tz`: the cards whose id starts with `card`, whether `asked` finds the
 *  questions and a card drawn beside them (US-62 AC20), the upload gate, and the schedule's item. */
async function pageAt(tz: string, now: string, profile: Partial<HealthInputs>, answers: string[][], probe: Probe) {
  process.env.TZ = tz;
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
  await seedGuest({ heightCm: 170, unitSystem: 'si', ...profile }, [['weight', 70]]);
  for (const [k, v] of answers) await saveScreening(k, v);
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.mh-sections')).not.toBeNull());
  await waitFor(() => expect(seen.suggestions.length).toBeGreaterThan(0));
  const asked = probe.asked(view.container);
  const due = probe.reminder ? computeReminderSchedule(await recordOnDisk(), new Date(now)).some((i) => i.category === probe.reminder) : null;
  return {
    cards: seen.suggestions.filter((s) => s.id.startsWith(probe.card)).map((s) => s.id),
    questions: !!asked,
    cardBeside: !!asked?.closest('.section-card')?.querySelector('.mh-row-suggestion'),
    upload: isScreeningEligible(probe.upload, seen.uploadAge, profile.sex),
    reminder: due,
  };
}
type Probe = { card: string; asked: (root: HTMLElement) => Element | undefined | null; upload: string; reminder?: string };

/** A woman born in 1976, a normal DEXA scan in 2019: the DEXA card, the Bone Density questions, the reminder. */
const DEXA: [Partial<HealthInputs>, string[][], Probe] = [{ sex: 'female', birthYear: 1976 },
  [['dexa_screening', 'dexa_scan'], ['dexa_last_date', '2019-01'], ['dexa_result', 'normal']],
  { card: 'screening-dexa', upload: 'dexa', reminder: 'screening_dexa',
    asked: (root) => [...root.querySelectorAll('h4.mh-group-label')].find((h) => h.textContent === 'Bone Density') }];
/** A man born in 1991, no answers: the colorectal start card and its method question (no reminder checked). */
const COLORECTAL: [Partial<HealthInputs>, string[][], Probe] = [{ sex: 'male', birthYear: 1991 }, [],
  { card: 'screening-colorectal', upload: 'colorectal', asked: (root) => root.querySelector('select#colorectal-method') }];
const on = (card: string, reminder: boolean | null) => ({ cards: [card], questions: true, cardBeside: true, upload: true, reminder });
const off = (reminder: boolean | null) => ({ cards: [], questions: false, cardBeside: false, upload: false, reminder });

describe('the web\'s screening cards, questions, upload gate and reminders read one age (US-23 AC6c)', () => {
  it.each([
    ['New York, 30 Nov 20:00, born Dec 1976: 50 at the UTC month, all apply', 'America/New_York', '2026-12-01T01:00:00Z', 12, DEXA, on('screening-dexa-overdue', true)],
    ['Auckland, 1 Oct 01:00, born Oct 1976: 49 at the UTC month, none applies yet', 'Pacific/Auckland', '2026-09-30T12:00:00Z', 10, DEXA, off(false)],
    ['the cancer questions too: New York, born Dec 1991, 35 at the UTC month', 'America/New_York', '2026-12-01T01:00:00Z', 12, COLORECTAL, on('screening-colorectal', null)],
    ['Auckland, born Oct 1991, still 34 at the UTC month', 'Pacific/Auckland', '2026-09-30T12:00:00Z', 10, COLORECTAL, off(null)],
  ] as const)('%s', async (_name, tz, now, birthMonth, [profile, answers, probe], expected) => {
    expect(await pageAt(tz, now, { ...profile, birthMonth }, answers, probe)).toEqual(expected);
  });
});
