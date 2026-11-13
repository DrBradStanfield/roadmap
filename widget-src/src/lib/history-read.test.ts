/**
 * The history read's table (US-21 AC3b, AC3c): every state against every event,
 * the state that follows. Then every order the three reads can land in.
 */
import { describe, expect, it } from 'vitest';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { ApiLabValue, ApiMedicationHistory } from './api-types';
import { initialHistoryRead, transition, type HistoryRead, type HistoryReadEvent } from './history-read';

// Synthetic rows.
const VITALS = [
  { id: 'l1', metricType: 'ldl', value: 3, recordedAt: '2026-08-01' },
  { id: 'w1', metricType: 'weight', value: 80, recordedAt: '2026-08-01' },
] as ApiMeasurement[];
const LABS = [{ id: 'z1', metricName: 'Zonulin', value: 40, unit: 'ng/mL', recordedAt: '2026-08-01' }] as ApiLabValue[];
const MEDS = [{ id: 'h1', medicationKey: 'statin', changeType: 'started', recordedAt: '2026-09-07' }] as ApiMedicationHistory[];

const E = {
  vitalsRead: { type: 'vitalsRead', rows: VITALS },
  vitalsFailed: { type: 'vitalsFailed' },
  labsRead: { type: 'labsRead', rows: LABS },
  medsRead: { type: 'medsRead', rows: MEDS },
  toggledMetric: { type: 'toggledMetric', metric: 'ldl' },
  toggledLab: { type: 'toggledLab', key: 'zonulin' },
} satisfies Record<string, HistoryReadEvent>;

const loading: Extract<HistoryRead, { phase: 'loading' }> = { phase: 'loading', metric: null };
const twoIn = { ...loading, labVals: LABS, medHistory: MEDS }; // only the vitals read is out
const ready: HistoryRead = {
  phase: 'ready', measurements: VITALS, labVals: LABS, medHistory: MEDS,
  selectedMetrics: new Set(['ldl', 'weight']), selectedLabMetrics: new Set(['zonulin']),
};
const failed: HistoryRead = { phase: 'failed' };

describe('history-read transition table (US-21 AC3b, AC3c)', () => {
  it.each<[string, HistoryRead, keyof typeof E, HistoryRead]>([
    ['loading', loading, 'vitalsRead', { ...loading, measurements: VITALS }],
    ['loading', loading, 'vitalsFailed', failed],
    ['loading', loading, 'labsRead', { ...loading, labVals: LABS }],
    ['loading', loading, 'medsRead', { ...loading, medHistory: MEDS }],
    ['loading', loading, 'toggledMetric', loading],
    ['loading', loading, 'toggledLab', loading],
    ['two in', twoIn, 'vitalsRead', ready],
    ['two in', twoIn, 'vitalsFailed', failed],
    ['ready', ready, 'vitalsRead', ready],
    ['ready', ready, 'vitalsFailed', ready],
    ['ready', ready, 'labsRead', ready],
    ['ready', ready, 'medsRead', ready],
    ['ready', ready, 'toggledMetric', { ...ready, selectedMetrics: new Set(['weight']) }],
    ['ready', ready, 'toggledLab', { ...ready, selectedLabMetrics: new Set() }],
    ['failed', failed, 'vitalsRead', failed],
    ['failed', failed, 'vitalsFailed', failed],
    ['failed', failed, 'labsRead', failed],
    ['failed', failed, 'medsRead', failed],
    ['failed', failed, 'toggledMetric', failed],
    ['failed', failed, 'toggledLab', failed],
  ])('%s + %s', (_name, state, event, next) => {
    expect(transition(state, E[event])).toEqual(next);
  });

  it('a late read never resets a tick the person changed', () => {
    const changed = transition(ready, E.toggledLab);
    expect(transition(changed, E.labsRead)).toBe(changed);
  });

  it('a toggle on, then off, comes back to where it was', () => {
    expect(transition(transition(ready, E.toggledMetric), E.toggledMetric)).toEqual(ready);
  });
});

describe('the ticks on open, whatever order the reads land in (US-21 AC3c)', () => {
  const reads: HistoryReadEvent[] = [E.vitalsRead, E.labsRead, E.medsRead];
  const orders = reads.flatMap(a => reads.filter(b => b !== a).map(b => [a, b, reads.find(c => c !== a && c !== b)!]));

  it.each(orders.map(order => [order.map(e => e.type).join(', '), order] as const))('%s', (_name, order) => {
    const state = order.reduce(transition, initialHistoryRead(null));
    expect(state).toEqual(ready);
  });

  it.each(orders.map(order => [order.map(e => e.type).join(', '), order] as const))('opened on weight: %s', (_name, order) => {
    const state = order.reduce(transition, initialHistoryRead('weight'));
    expect(state).toMatchObject({ phase: 'ready', selectedMetrics: new Set(['weight']), selectedLabMetrics: new Set(['zonulin']) });
  });

  it('opened on a vital with no rows: every vital is ticked', () => {
    const state = reads.reduce(transition, initialHistoryRead('hba1c'));
    expect(state).toMatchObject({ phase: 'ready', selectedMetrics: new Set(['ldl', 'weight']) });
  });

  it('every read empty: ready, nothing ticked', () => {
    const empty: HistoryReadEvent[] = [{ type: 'vitalsRead', rows: [] }, { type: 'labsRead', rows: [] }, { type: 'medsRead', rows: [] }];
    expect(empty.reduce(transition, loading)).toEqual({
      phase: 'ready', measurements: [], labVals: [], medHistory: [], selectedMetrics: new Set(), selectedLabMetrics: new Set(),
    });
  });
});
