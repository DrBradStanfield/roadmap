import { describe, it, expect } from 'vitest';
import {
  buildMeasurementHistory,
  latestActivePerMetric,
  latestFromHistory,
  HISTORY_CAP_PER_METRIC,
} from './measurement-history';

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

    // Same day, one date-only: the datetime is the later string, so it wins.
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
