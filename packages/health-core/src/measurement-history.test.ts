import { describe, it, expect } from 'vitest';
import {
  buildMeasurementHistory,
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
