import { describe, it, expect } from 'vitest';
import type { ApiMeasurement, UnitSystem } from '@roadmap/health-core';
import { buildColumns, bpPairReady, blurLeavesCell, vitalsBackfillsToTasks, routeVitalsEdit, mergeBpDraft } from './StartingInfoVitals';

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

// Reported bug: in the Blood Pressure cell, entering systolic then entering
// diastolic wiped the systolic (and vice-versa) — the two inputs clobbered each
// other's state. The fix is that each onChange merges ONLY its own field into
// the existing pair, never replacing the whole value. `mergeBpDraft` is that
// merge, extracted so the "one field never blanks the other" invariant is
// directly testable (the setter in the component is `setDraft(d => ({ ...d,
// ...mergeBpDraft(...) }))`).
describe('mergeBpDraft — sys and dia never clobber each other', () => {
  it('setting diastolic preserves an already-typed systolic', () => {
    const afterSys = mergeBpDraft({ sys: '', dia: '' }, 'sys', '118');
    expect(afterSys).toEqual({ sys: '118', dia: '' });
    const afterDia = mergeBpDraft(afterSys, 'dia', '78');
    expect(afterDia).toEqual({ sys: '118', dia: '78' });
  });

  it('re-entering systolic preserves the diastolic', () => {
    const start = { sys: '118', dia: '78' };
    const next = mergeBpDraft(start, 'sys', '120');
    expect(next).toEqual({ sys: '120', dia: '78' });
  });

  it('clearing one field leaves the other intact', () => {
    const next = mergeBpDraft({ sys: '120', dia: '80' }, 'sys', '');
    expect(next).toEqual({ sys: '', dia: '80' });
  });

  it('does not mutate the previous pair (returns a new object)', () => {
    const prev = { sys: '120', dia: '80' };
    const next = mergeBpDraft(prev, 'dia', '85');
    expect(prev).toEqual({ sys: '120', dia: '80' }); // untouched
    expect(next).not.toBe(prev);
  });
});

// The systolic and diastolic inputs share one matrix cell. A blur from
// systolic → diastolic (focus staying inside the cell) must NOT trigger a
// save — only a blur that leaves the whole BP cell should. This is what keeps
// the draft from clearing under the user mid-edit.
describe('blurLeavesCell', () => {
  function fakeCell(children: unknown[]) {
    return { contains: (n: unknown) => children.includes(n) } as unknown as HTMLElement;
  }

  it('returns false when focus moves to a sibling inside the same cell', () => {
    const sib = {};
    const cell = fakeCell([sib]);
    expect(blurLeavesCell(sib as unknown as HTMLElement, cell)).toBe(false);
  });

  it('returns true when focus leaves the cell (relatedTarget outside)', () => {
    const outside = {};
    const cell = fakeCell([]);
    expect(blurLeavesCell(outside as unknown as HTMLElement, cell)).toBe(true);
  });

  it('returns true when focus is lost entirely (relatedTarget null)', () => {
    const cell = fakeCell([]);
    expect(blurLeavesCell(null, cell)).toBe(true);
  });

  it('returns true defensively when the cell ref is missing', () => {
    expect(blurLeavesCell(null, null)).toBe(true);
  });
});

// Empty weight/waist cells in past date columns are click-to-input: typing a
// value backfills a NEW measurement at that date. `vitalsBackfillsToTasks`
// folds the `${date}|${metric}` → typed map into one SI value map per date,
// dropping empty / invalid / non-weight-waist entries. Each task is a pure
// INSERT (an empty cell has no row to correct).
describe('vitalsBackfillsToTasks', () => {
  const si: (m: 'weight' | 'waist') => UnitSystem = () => 'si';
  // Convenience builders for the {simple, bp} backfill state.
  const simpleBf = (simple: Record<string, string>) => ({ simple, bp: {} });
  const bpBf = (bp: Record<string, { sys: string; dia: string }>) => ({ simple: {}, bp });

  it('returns no tasks for an empty backfill map', () => {
    expect(vitalsBackfillsToTasks({ simple: {}, bp: {} }, si)).toEqual([]);
  });

  it('drops empty-string typed values', () => {
    expect(vitalsBackfillsToTasks(simpleBf({ '2024-03-01|weight': '' }), si)).toEqual([]);
  });

  it('converts a weight (SI kg) to one task at its date', () => {
    const tasks = vitalsBackfillsToTasks(simpleBf({ '2024-03-01|weight': '82' }), si);
    expect(tasks).toEqual([{ date: '2024-03-01', values: { weight: 82 } }]);
  });

  it('converts conventional units (lbs → kg, in → cm) on commit', () => {
    const conv: (m: 'weight' | 'waist') => UnitSystem = () => 'conventional';
    const tasks = vitalsBackfillsToTasks(
      simpleBf({ '2024-03-01|weight': '180', '2024-03-01|waist': '36' }),
      conv,
    );
    const t = tasks.find(t => t.date === '2024-03-01')!;
    expect(t.values.weight).toBeCloseTo(180 / 2.20462, 2);
    expect(t.values.waist).toBeCloseTo(36 * 2.54, 2);
  });

  it('groups weight + waist backfilled at the same date into one task', () => {
    const tasks = vitalsBackfillsToTasks(
      simpleBf({ '2024-03-01|weight': '82', '2024-03-01|waist': '90' }),
      si,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ date: '2024-03-01', values: { weight: 82, waist: 90 } });
  });

  it('produces one task per distinct date', () => {
    const tasks = vitalsBackfillsToTasks(
      simpleBf({ '2024-03-01|weight': '82', '2025-01-10|weight': '79' }),
      si,
    );
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.date).sort()).toEqual(['2024-03-01', '2025-01-10']);
  });

  it('drops invalid / out-of-range typed values', () => {
    // weight 5 kg is below the metric's plausible range → dropped.
    expect(vitalsBackfillsToTasks(simpleBf({ '2024-03-01|weight': '5' }), si)).toEqual([]);
    // non-numeric → dropped.
    expect(vitalsBackfillsToTasks(simpleBf({ '2024-03-01|weight': 'abc' }), si)).toEqual([]);
  });

  // ── BP backfill (paired systolic_bp + diastolic_bp at a past date) ──────

  it('commits a complete BP pair as paired systolic_bp + diastolic_bp at its date', () => {
    const tasks = vitalsBackfillsToTasks(bpBf({ '2024-03-01': { sys: '128', dia: '82' } }), si);
    expect(tasks).toHaveLength(1);
    // mmHg has no SI conversion — stored as-is.
    expect(tasks[0]).toEqual({ date: '2024-03-01', values: { systolic_bp: 128, diastolic_bp: 82 } });
  });

  it('does NOT commit a half-entered BP pair (one field blank)', () => {
    expect(vitalsBackfillsToTasks(bpBf({ '2024-03-01': { sys: '128', dia: '' } }), si)).toEqual([]);
    expect(vitalsBackfillsToTasks(bpBf({ '2024-03-01': { sys: '', dia: '82' } }), si)).toEqual([]);
  });

  it('does NOT commit a mid-typed out-of-range BP pair', () => {
    // dia "8" on the way to "80" — must not land.
    expect(vitalsBackfillsToTasks(bpBf({ '2024-03-01': { sys: '128', dia: '8' } }), si)).toEqual([]);
  });

  it('merges a BP backfill and a weight backfill at the same date into one task', () => {
    const tasks = vitalsBackfillsToTasks(
      {
        simple: { '2024-03-01|weight': '82' },
        bp: { '2024-03-01': { sys: '128', dia: '82' } },
      },
      si,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({
      date: '2024-03-01',
      values: { weight: 82, systolic_bp: 128, diastolic_bp: 82 },
    });
  });
});
