/**
 * US-06 AC14: the plan's PSA cards and the yearly PSA reminder read the newest
 * saved PSA measurement, its value and its day. PSA has been a measurement
 * since February 2026 (lab uploads, the assistant and the iPhone save a dated
 * `psa` row), but the "Elevated PSA" card (PSA > 4.0 ng/mL), the PSA-due card
 * and the `screening_prostate` reminder (12 months, `will_screen`) read only
 * the old screening answers `prostate_psa_value` / `prostate_last_date`, which
 * nothing writes any more. Those answers stay the fallback; the newer by date
 * wins, and a row in the same month as the answer wins (the answer has no day).
 * Synthetic records only.
 */
import { describe, expect, it } from 'vitest';
import { computePlan } from './plan';
import { computeReminderSchedule } from './reminder-schedule';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';

const NOW = new Date('2026-06-15T12:00:00Z');

type Row = [value: number, day: string, status?: 'active' | 'entered-in-error'];

/** A man born 1960 (66 in June 2026) who said he will have PSA screening. */
function record(rows: Row[], answers: Record<string, unknown> = {}): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'psa_plan', now: '2024-01-01T00:00:00Z' });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 178, birthYear: 1960, birthMonth: 1 },
    screenings: { ...f.screenings, prostateDiscussion: 'will_screen', ...answers } as RoadmapFile['screenings'],
    measurements: rows.map(([value, day, status = 'active'], i) => createMeasurement({
      id: `psa_${i}`, metricType: 'psa', value, recordedAt: `${day}T08:00:00Z`, createdAt: `${day}T09:00:00Z`, status,
    })),
  };
}

function prostate(file: RoadmapFile) {
  const plan = computePlan(file, NOW);
  const cards = plan.results.suggestions.filter((s) => s.id.startsWith('screening-prostate'));
  return {
    cards: cards.map((s) => `${s.title}: ${s.description}`),
    due: plan.due.filter((i) => i.category === 'screening_prostate').map((i) => i.dueAt),
    // The schedule the web and the iPhone push, read straight from the file.
    pushed: computeReminderSchedule(file, NOW).filter((i) => i.category === 'screening_prostate').map((i) => i.dueAt),
  };
}

const ELEVATED = (v: string) =>
  `Elevated PSA: Your PSA of ${v} ng/mL is above the typical reference range (\u22644.0). Discuss with your doctor \u2014 elevated PSA can have multiple causes.`;

describe('the plan reads the saved PSA measurement (US-06 AC14)', () => {
  it('a saved PSA of 6.5 from September 2025 shows "Elevated PSA", the PSA-due card and a reminder 12 months on', () => {
    const p = prostate(record([[6.5, '2025-09-03']]));
    expect(p.cards).toEqual([
      'PSA test up to date: Next PSA test due Sep 2026.',
      ELEVATED('6.5'),
    ]);
    expect(p.due).toEqual(['2026-09-01']);
    expect(p.pushed).toEqual(['2026-09-01']);
  });

  it('the newest active row is the one read: a later 2.1 clears the card, an entered-in-error row counts for nothing', () => {
    const p = prostate(record([[6.5, '2024-03-01'], [2.1, '2025-01-20'], [9.9, '2025-05-01', 'entered-in-error']]));
    expect(p.cards).toEqual(['PSA test overdue: Your next PSA test was due Jan 2026. Please schedule your test.']);
    expect(p.due).toEqual(['2026-01-01']);
    expect(p.pushed).toEqual(['2026-01-01']);
  });

  it('control: with no PSA row the old answers still drive the cards and the reminder', () => {
    const p = prostate(record([], { prostatePsaValue: '6.5', prostateLastDate: '2025-01' }));
    expect(p.cards).toEqual([
      'PSA test overdue: Your next PSA test was due Jan 2026. Please schedule your test.',
      ELEVATED('6.5'),
    ]);
    expect(p.pushed).toEqual(['2026-01-01']);
  });

  it('control: no PSA row and no answers, no PSA card and no reminder (the plan does not invent a test)', () => {
    const p = prostate(record([]));
    expect(p.cards).toEqual([]);
    expect(p.pushed).toEqual([]);
  });
});

describe('a saved PSA and the old answers: the newer by date wins (US-06 AC14)', () => {
  it('a row newer than the answer wins, value and day together', () => {
    const p = prostate(record([[6.5, '2025-09-03']], { prostatePsaValue: '2.0', prostateLastDate: '2025-02' }));
    expect(p.cards).toContain(ELEVATED('6.5'));
    expect(p.pushed).toEqual(['2026-09-01']);
  });

  it('an answer from a later month than the row wins, value and day together', () => {
    const p = prostate(record([[6.5, '2025-03-10']], { prostatePsaValue: '2.0', prostateLastDate: '2025-11' }));
    expect(p.cards).toEqual(['PSA test up to date: Next PSA test due Nov 2026.']);
    expect(p.pushed).toEqual(['2026-11-01']);
  });

  it('an answer with a full day later than the row, in the same month, wins', () => {
    const p = prostate(record([[6.5, '2025-03-10']], { prostatePsaValue: '2.0', prostateLastDate: '2025-03-20' }));
    expect(p.cards).not.toContain(ELEVATED('6.5'));
  });

  it('the same day: the row wins', () => {
    const p = prostate(record([[6.5, '2025-03-10']], { prostatePsaValue: '2.0', prostateLastDate: '2025-03-10' }));
    expect(p.cards).toContain(ELEVATED('6.5'));
  });

  it('the same month: the row wins, since the answer gives no day', () => {
    const p = prostate(record([[6.5, '2025-03-10']], { prostatePsaValue: '2.0', prostateLastDate: '2025-03' }));
    expect(p.cards).toContain(ELEVATED('6.5'));
    expect(p.pushed).toEqual(['2026-03-01']);
  });

  it('an old value with no date gives way to a dated row', () => {
    const p = prostate(record([[3.0, '2025-09-03']], { prostatePsaValue: '6.5' }));
    expect(p.cards).toEqual(['PSA test up to date: Next PSA test due Sep 2026.']);
    expect(p.pushed).toEqual(['2026-09-01']);
  });
});

describe('a PSA row the plan cannot use leaves the old answers standing (US-06 AC14)', () => {
  const answers = { prostatePsaValue: '6.5', prostateLastDate: '2025-01' };
  const fallback = ['PSA test overdue: Your next PSA test was due Jan 2026. Please schedule your test.', ELEVATED('6.5')];

  it.each([
    ['above the PSA range (10000 ng/mL)', 10000.5, '2025-09-03'],
    ['below 0', -0.5, '2025-09-03'],
    ['on a day that does not exist', 3.0, '2025-02-30'],
    ['dated in a future month', 3.0, '2099-01-01'],
  ])('a row %s', (_what, value, day) => {
    const p = prostate(record([[value, day]], answers));
    expect(p.cards).toEqual(fallback);
    expect(p.pushed).toEqual(['2026-01-01']);
  });

  it('the range ends are usable: 0 and 10000 ng/mL', () => {
    expect(prostate(record([[0, '2025-09-03']], answers)).cards).toEqual(['PSA test up to date: Next PSA test due Sep 2026.']);
    expect(prostate(record([[10000, '2025-09-03']], answers)).cards).toContain(ELEVATED('10000.0'));
  });
});
