import { describe, it, expect } from 'vitest';
import {
  buildMeasurementHistory,
  compareReadings,
  latestActivePerMetric,
  latestFromHistory,
  newestUsablePsa,
  HISTORY_CAP_PER_METRIC,
  isCalendarDay,
} from './measurement-history';

describe('isCalendarDay — one real-calendar-day check for every reader', () => {
  it('takes a YYYY-MM-DD that exists, leap days included', () => {
    for (const day of ['2026-02-28', '2024-02-29', '2026-12-31', '2026-01-01']) expect(isCalendarDay(day), day).toBe(true);
  });
  it('refuses a day the calendar lacks, which Date.parse would roll forward, and any other shape', () => {
    for (const day of ['2026-02-30', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-2-3', '2026-02-03T00:00:00Z', '', 'soon']) {
      expect(isCalendarDay(day), day).toBe(false);
    }
  });
});

describe('buildMeasurementHistory', () => {
  it('groups by metricType and sorts chronologically', () => {
    const out = buildMeasurementHistory([
      { metricType: 'ldl', value: 2.0, recordedAt: '2026-01-10T08:00:00Z' },
      { metricType: 'ldl', value: 1.2, recordedAt: '2026-05-12' },
      { metricType: 'ldl', value: 1.8, recordedAt: '2026-03-01' },
      { metricType: 'weight', value: 80, recordedAt: '2026-02-02' },
    ]);
    expect(out.ldl.map((p) => p.value)).toEqual([2.0, 1.8, 1.2]);
    expect(out.ldl[2]).toEqual({ date: '2026-05-12', value: 1.2 });
    expect(out.weight).toEqual([{ date: '2026-02-02', value: 80 }]);
  });

  it('drops records without a valid YYYY-MM-DD date', () => {
    const out = buildMeasurementHistory([
      { metricType: 'ldl', value: 1.5, recordedAt: undefined },
      { metricType: 'ldl', value: 1.6, recordedAt: '' },
      { metricType: 'ldl', value: 1.7, recordedAt: 'May 2026' },
      { metricType: 'ldl', value: 1.8, recordedAt: '2026-05-12' },
    ]);
    expect(out.ldl).toEqual([{ date: '2026-05-12', value: 1.8 }]);
  });

  it('keeps only the NEWEST cap points per metric', () => {
    const records = Array.from({ length: HISTORY_CAP_PER_METRIC + 6 }, (_, i) => ({
      metricType: 'weight',
      value: 70 + i,
      recordedAt: `2025-01-${String(i + 1).padStart(2, '0')}`,
    }));
    const out = buildMeasurementHistory(records);
    expect(out.weight).toHaveLength(HISTORY_CAP_PER_METRIC);
    expect(out.weight[out.weight.length - 1].value).toBe(70 + HISTORY_CAP_PER_METRIC + 5);
    expect(out.weight[0].value).toBe(76);
  });

  it('returns an empty map for no usable records', () => {
    expect(buildMeasurementHistory([])).toEqual({});
  });
});

describe('latestFromHistory', () => {
  it('maps each metric to its HealthInputs field with the newest value', () => {
    const latest = latestFromHistory({
      ldl: [
        { date: '2026-01-10', value: 2.0 },
        { date: '2026-05-12', value: 1.2 },
      ],
      systolic_bp: [{ date: '2026-04-01', value: 128 }],
    });
    expect(latest).toEqual({ ldlC: 1.2, systolicBp: 128 });
  });

  it('skips unmapped metrics and empty series', () => {
    const latest = latestFromHistory({
      not_a_metric: [{ date: '2026-01-01', value: 1 }],
      ldl: [],
    });
    expect(latest).toEqual({});
  });
});

describe('latestActivePerMetric (US-07 AC4)', () => {
  const row = (
    id: string,
    metricType: string,
    recordedAt: string,
    extra: { createdAt?: string; status?: string; value?: number } = {},
  ) => ({ id, metricType, recordedAt, value: 0, ...extra });

  it('keeps the most recent reading per metric', () => {
    const out = latestActivePerMetric([
      row('a', 'ldl', '2024-01-10', { value: 3.5 }),
      row('b', 'ldl', '2026-08-10', { value: 1.8 }),
      row('c', 'weight', '2026-02-02', { value: 80 }),
    ]);
    expect(out.map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(out.find((r) => r.metricType === 'ldl')!.value).toBe(1.8);
  });

  it('a backfilled older reading never wins, whatever the array order', () => {
    const newest = row('new', 'ldl', '2026-08-10', { value: 1.8, createdAt: '2026-08-10T09:00:00Z' });
    const backfilled = row('old', 'ldl', '2024-01-10', { value: 3.5, createdAt: '2026-08-20T09:00:00Z' });
    expect(latestActivePerMetric([newest, backfilled])).toEqual([newest]);
    expect(latestActivePerMetric([backfilled, newest])).toEqual([newest]);
  });

  it('skips entered-in-error rows and falls back to the newest active one', () => {
    const out = latestActivePerMetric([
      row('a', 'ldl', '2024-01-10', { value: 3.5 }),
      row('b', 'ldl', '2026-08-10', { value: 1.8, status: 'entered-in-error' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });

  it('drops a metric whose every row is entered-in-error', () => {
    expect(latestActivePerMetric([row('a', 'ldl', '2026-08-10', { status: 'entered-in-error' })])).toEqual([]);
  });

  // US-07 AC4, Brad 2026-11-09 ("fine, do it"): day first, then time. Each reading counts on
  // its own stored day (the first 10 characters of recordedAt); within a day the later instant wins.
  it('a later stored day wins: Tokyo 06:00+09:00 on Nov 2 beats London 22:00+00:00 on Nov 1', () => {
    const london = row('london', 'weight', '2026-11-01T22:00:00.000+00:00', { value: 80 });
    const tokyo = row('tokyo', 'weight', '2026-11-02T06:00:00.000+09:00', { value: 81 });
    expect(latestActivePerMetric([london, tokyo])).toEqual([tokyo]);
    expect(latestActivePerMetric([tokyo, london])).toEqual([tokyo]);
  });

  it('within one day, the later instant wins, not the later text', () => {
    const seoul = row('seoul', 'weight', '2026-11-01T10:00:00+09:00'); // 01:00Z
    const london = row('london', 'weight', '2026-11-01T05:00:00+00:00'); // 05:00Z
    expect(latestActivePerMetric([seoul, london])).toEqual([london]);
    expect(latestActivePerMetric([london, seoul])).toEqual([london]);
  });

  it('treats Z and +00:00 spellings of one instant as a tie, so createdAt then id decide', () => {
    const z = row('z', 'weight', '2026-11-01T22:00:00.000Z', { createdAt: '2026-11-01T22:00:02Z' });
    const plus = row('plus', 'weight', '2026-11-01T22:00:00.000+00:00', { createdAt: '2026-11-01T22:00:01Z' });
    expect(latestActivePerMetric([plus, z])).toEqual([z]);
    expect(latestActivePerMetric([z, plus])).toEqual([z]);
    const za = row('za', 'weight', '2026-11-01T22:00:00.000Z');
    const pa = row('pa', 'weight', '2026-11-01T22:00:00.000+00:00');
    expect(latestActivePerMetric([za, pa])).toEqual([za]);
    expect(latestActivePerMetric([pa, za])).toEqual([za]);
  });

  it('ranks a same-day stamp that does not parse below every one that does', () => {
    const bad = row('bad', 'weight', '2026-11-01Tjunk');
    const good = row('good', 'weight', '2026-11-01T10:00:00Z');
    expect(latestActivePerMetric([good, bad])).toEqual([good]);
    expect(latestActivePerMetric([bad, good])).toEqual([good]);
    // Two that do not parse compare by text.
    const junkA = row('a', 'weight', '2026-11-01Taaa');
    const junkB = row('b', 'weight', '2026-11-01Tbbb');
    expect(latestActivePerMetric([junkB, junkA])).toEqual([junkB]);
  });

  it('is a total order: the review three-stamp cycle has one winner in every input order', () => {
    const a = row('A', 'weight', '2026-11-02T06:00:00+09:00');
    const c = row('C', 'weight', '2026-11-01T22:00:00Z');
    const b = row('B', 'weight', '2026-11-01t22:00:00 UTC'); // does not parse
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    for (const o of orders) expect(latestActivePerMetric(o).map((r) => r.id)).toEqual(['A']);
    for (const o of orders) expect([...o].sort(compareReadings).map((r) => r.id)).toEqual(['B', 'C', 'A']);
  });

  it('tiebreaks equal recordedAt on createdAt, then on id', () => {
    const byCreated = latestActivePerMetric([
      row('a', 'ldl', '2026-08-10', { value: 3.5, createdAt: '2026-08-10T08:00:00Z' }),
      row('b', 'ldl', '2026-08-10', { value: 1.8, createdAt: '2026-08-10T09:00:00Z' }),
    ]);
    expect(byCreated[0].id).toBe('b');

    // No createdAt anywhere → id decides, so both devices converge on one winner.
    const byId = latestActivePerMetric([
      row('zz', 'ldl', '2026-08-10', { value: 1.8 }),
      row('aa', 'ldl', '2026-08-10', { value: 3.5 }),
    ]);
    expect(byId[0].id).toBe('zz');

    // A row WITH createdAt beats one without (missing sorts as '').
    const missing = latestActivePerMetric([
      row('zz', 'ldl', '2026-08-10', { value: 3.5 }),
      row('aa', 'ldl', '2026-08-10', { value: 1.8, createdAt: '2026-08-10T09:00:00Z' }),
    ]);
    expect(missing[0].id).toBe('aa');
  });

  it('compares date-only and datetime recordedAt correctly', () => {
    const out = latestActivePerMetric([
      row('a', 'ldl', '2026-08-10T23:00:00.000Z', { value: 1.8 }),
      row('b', 'ldl', '2026-08-09', { value: 3.5 }),
    ]);
    expect(out[0].id).toBe('a');

    // Same day, one date-only: the date-only row is that day at 00:00 UTC, so 07:00Z wins.
    const sameDay = latestActivePerMetric([
      row('a', 'ldl', '2026-08-10', { value: 3.5 }),
      row('b', 'ldl', '2026-08-10T07:00:00.000Z', { value: 1.8 }),
    ]);
    expect(sameDay[0].id).toBe('b');
  });

  it('returns an empty array for no rows', () => {
    expect(latestActivePerMetric([])).toEqual([]);
  });
});

// US-07 AC4 + US-06 AC14: the plan (latestActivePerMetric, newestUsablePsa) and the chat
// (buildMeasurementHistory then latestFromHistory) read the same latest value on a record
// mixing timed and day-only rows (adversary R1, Codex R3).
describe('plan and chat agree on the latest reading (US-07 AC4)', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const m = (id: string, metricType: string, value: number, recordedAt: string) => ({ id, metricType, value, recordedAt, status: 'active' });

  it('PSA 6.0 on the evening of Nov 1 (-05:00) and 1.0 typed for Nov 2: both read 1.0', () => {
    const rows = [m('timed', 'psa', 6.0, '2026-11-01T20:00:00-05:00'), m('typed', 'psa', 1.0, '2026-11-02')];
    for (const order of [rows, [...rows].reverse()]) {
      expect(newestUsablePsa(order, now)?.value).toBe(1.0);
      expect(latestFromHistory(buildMeasurementHistory(order, undefined, now)).psa).toBe(1.0);
    }
  });

  it('BP 150/95 on the evening of Nov 1 (-08:00) and 125/80 typed for Nov 2: both read 125/80', () => {
    const rows = [
      m('s1', 'systolic_bp', 150, '2026-11-01T17:00:00-08:00'), m('d1', 'diastolic_bp', 95, '2026-11-01T17:00:00-08:00'),
      m('s2', 'systolic_bp', 125, '2026-11-02'), m('d2', 'diastolic_bp', 80, '2026-11-02'),
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const plan = Object.fromEntries(latestActivePerMetric(order).map((r) => [r.metricType, r.value]));
      expect(plan).toEqual({ systolic_bp: 125, diastolic_bp: 80 });
      const chat = latestFromHistory(buildMeasurementHistory(order, undefined, now));
      expect([chat.systolicBp, chat.diastolicBp]).toEqual([125, 80]);
    }
  });
});
