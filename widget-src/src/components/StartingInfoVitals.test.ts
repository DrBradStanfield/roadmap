import { describe, it, expect } from 'vitest';
import { toCanonicalValue, type ApiMeasurement, type UnitSystem } from '@roadmap/health-core';
import { buildColumns, bpPairReady, vitalsCellsOf, routeVitalsEdit } from './StartingInfoVitals';

// `buildColumns` is the one genuinely new pure helper introduced when the
// vitals section was unified onto the blood-test matrix's column grid: it
// folds the flat vitals history into one column per distinct date (sparse),
// pairs systolic+diastolic into the same column, and sorts oldest → newest.

function m(metricType: string, value: number, date: string, id = `${metricType}-${date}`): ApiMeasurement {
  return {
    id, metricType, value,
    recordedAt: `${date}T09:00:00.000Z`,
    createdAt: `${date}T09:00:00.000Z`,
    source: 'manual', status: 'active', correctsId: null, externalId: null,
  };
}

// A chatbot vitals edit (weight / waist / BP) must land in the matrix CELL —
// pre-filled + flashed — when the vitals matrix is the active rendering
// (returning users), but fall back to setting the plain form field (no flash)
// for fresh users who still see the legacy inline inputs. The matrix only
// registers its prefill ref while mounted, so "ref present" is the signal.
describe('routeVitalsEdit', () => {
  it('routes to the matrix cell (flash) when the matrix is mounted', () => {
    expect(routeVitalsEdit(true)).toBe('matrix');
  });
  it('routes to the plain form field (no flash) when the matrix is not mounted', () => {
    expect(routeVitalsEdit(false)).toBe('field');
  });
});

describe('buildColumns', () => {
  it('returns one column per distinct date, sorted oldest → newest', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01'),
      m('weight', 88, '2024-03-01'),
      m('weight', 85, '2024-12-15'),
    ]);
    expect(cols.map(c => c.date)).toEqual(['2024-03-01', '2024-12-15', '2025-06-01']);
    expect(cols.map(c => c.weight)).toEqual([88, 85, 80]);
  });

  it('pairs systolic + diastolic recorded on the same date into one column', () => {
    const cols = buildColumns([
      m('systolic_bp', 138, '2024-03-01'),
      m('diastolic_bp', 88, '2024-03-01'),
    ]);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ date: '2024-03-01', sys: 138, dia: 88 });
  });

  it('keeps cells sparse — a date with only a weight has undefined waist/bp', () => {
    const cols = buildColumns([
      m('weight', 85, '2024-12-15'),
      m('weight', 88, '2024-03-01'),
      m('waist', 98, '2024-03-01'),
    ]);
    const visit = cols.find(c => c.date === '2024-03-01')!;
    const weighIn = cols.find(c => c.date === '2024-12-15')!;
    expect(visit).toMatchObject({ weight: 88, waist: 98 });
    expect(weighIn.weight).toBe(85);
    expect(weighIn.waist).toBeUndefined();
    expect(weighIn.sys).toBeUndefined();
  });

  it('groups all four vitals measured at one visit into a single column', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01'),
      m('waist', 89, '2025-06-01'),
      m('systolic_bp', 122, '2025-06-01'),
      m('diastolic_bp', 79, '2025-06-01'),
    ]);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ weight: 80, waist: 89, sys: 122, dia: 79 });
  });

  it('carries the row id for each value (needed for click-to-correct)', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01', 'w1'),
      m('waist', 89, '2025-06-01', 'wa1'),
    ]);
    expect(cols[0].weightId).toBe('w1');
    expect(cols[0].waistId).toBe('wa1');
  });

  it('collapses to a date-keyed column even when only the day differs by time', () => {
    const cols = buildColumns([
      m('weight', 80, '2025-06-01'),
      { ...m('waist', 89, '2025-06-01'), recordedAt: '2025-06-01T18:30:00.000Z' },
    ]);
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ weight: 80, waist: 89 });
  });

  it('returns an empty array for no measurements', () => {
    expect(buildColumns([])).toEqual([]);
  });
});

// Blood pressure is an ATOMIC two-field value (systolic AND diastolic). The
// vitals matrix auto-saves vital drafts on blur with a 500ms debounce. Before
// the fix, leaving the systolic field (e.g. clicking into diastolic) could
// schedule a save that fired mid-edit and committed a half-entered or stale
// BP pair, then cleared the draft — the user saw their typed value vanish and
// a wrong value land. `bpPairReady` is the gate that keeps a save from
// committing unless BOTH fields hold a valid in-range number.
describe('bpPairReady', () => {
  it('is false when either field is empty (no half-pair commit)', () => {
    expect(bpPairReady('120', '')).toBe(false);
    expect(bpPairReady('', '80')).toBe(false);
    expect(bpPairReady('', '')).toBe(false);
  });

  it('is false while a field is mid-typed below its valid range', () => {
    // User has typed "8" toward "80" — must NOT commit yet.
    expect(bpPairReady('120', '8')).toBe(false);
    // Systolic still being typed.
    expect(bpPairReady('5', '80')).toBe(false);
  });

  it('is true only when both sys + dia are valid in-range numbers', () => {
    expect(bpPairReady('120', '80')).toBe(true);
    expect(bpPairReady('135', '85')).toBe(true);
  });

  it('rejects out-of-physiological-range values', () => {
    expect(bpPairReady('300', '80')).toBe(false); // sys too high
    expect(bpPairReady('120', '200')).toBe(false); // dia too high
    expect(bpPairReady('40', '80')).toBe(false); // sys too low
  });
});

// Each typed column (the draft's, or a saved column's empty cells) becomes
// the cells a commit saves on its day: weight and waist in SI, a BP pair as
// one cell (mmHg, stored as typed). A cell that cannot be saved as it stands
// is kept, its values null: it stays in the draft with its error (US-03 AC5).
describe('vitalsCellsOf', () => {
  const si: (m: 'weight' | 'waist') => UnitSystem = () => 'si';

  it('makes no cells for an empty column', () => {
    expect(vitalsCellsOf({}, si)).toEqual([]);
    expect(vitalsCellsOf({ weight: '', sys: '', dia: '' }, si)).toEqual([]);
  });

  it('turns a weight into one cell, in SI', () => {
    expect(vitalsCellsOf({ weight: '82' }, si)).toEqual([{ keys: ['weight'], values: { weight: 82 } }]);
  });

  it('keeps what was typed: 90.4 cm is saved as 90.4', () => {
    expect(vitalsCellsOf({ waist: '90.4' }, si)).toEqual([{ keys: ['waist'], values: { waist: 90.4 } }]);
  });

  it('converts conventional units (lbs → kg, in → cm)', () => {
    const cells = vitalsCellsOf({ weight: '180', waist: '36' }, () => 'conventional');
    expect(cells.find((c) => c.keys[0] === 'weight')!.values!.weight).toBeCloseTo(toCanonicalValue('weight', 180, 'conventional'), 9);
    expect(cells.find((c) => c.keys[0] === 'waist')!.values!.waist).toBeCloseTo(toCanonicalValue('waist', 36, 'conventional'), 9);
  });

  it('keeps a value out of range as a cell that cannot be saved', () => {
    expect(vitalsCellsOf({ weight: '5' }, si)).toEqual([{ keys: ['weight'], values: null }]);
  });

  it('turns a complete BP pair into one cell: systolic and diastolic together', () => {
    expect(vitalsCellsOf({ sys: '128', dia: '82' }, si)).toEqual([
      { keys: ['sys', 'dia'], values: { systolic_bp: 128, diastolic_bp: 82 } },
    ]);
  });

  it('never saves half a BP pair, or one mid-typed', () => {
    expect(vitalsCellsOf({ sys: '128' }, si)).toEqual([{ keys: ['sys', 'dia'], values: null }]);
    expect(vitalsCellsOf({ dia: '82' }, si)).toEqual([{ keys: ['sys', 'dia'], values: null }]);
    expect(vitalsCellsOf({ sys: '128', dia: '8' }, si)).toEqual([{ keys: ['sys', 'dia'], values: null }]);
  });

  it('keeps a weight and a BP pair in one column as two cells', () => {
    expect(vitalsCellsOf({ weight: '82', sys: '128', dia: '82' }, si)).toEqual([
      { keys: ['weight'], values: { weight: 82 } },
      { keys: ['sys', 'dia'], values: { systolic_bp: 128, diastolic_bp: 82 } },
    ]);
  });
});
