// The history lightbox's three reads, as one named state (US-21 AC3b, AC3c).
// HistoryPanel sends the events; nothing else changes the state.
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import type { ApiLabValue, ApiMedicationHistory } from './api-types';
import { groupLabHistory } from './lab-rows';

/**
 * - loading: a read is still out. Each read's rows wait here as they land; `metric` is
 *   the vital the lightbox was opened on (the prop, or ?metric=).
 * - ready: all three have landed. The ticks are taken once, here, so the order
 *   the reads land in never changes them, and only the person changes them after.
 * - failed: the vitals read failed. The heading alone; later reads change nothing.
 */
export type HistoryRead =
  | { phase: 'loading'; metric: string | null; measurements?: ApiMeasurement[]; labVals?: ApiLabValue[]; medHistory?: ApiMedicationHistory[] }
  | {
    phase: 'ready'; measurements: ApiMeasurement[]; labVals: ApiLabValue[]; medHistory: ApiMedicationHistory[];
    selectedMetrics: Set<string>; selectedLabMetrics: Set<string>;
  }
  | { phase: 'failed' };

/** A failed lab or medication read lands as no rows (US-21 AC3b). */
export type HistoryReadEvent =
  | { type: 'vitalsRead'; rows: ApiMeasurement[] }
  | { type: 'vitalsFailed' }
  | { type: 'labsRead'; rows: ApiLabValue[] }
  | { type: 'medsRead'; rows: ApiMedicationHistory[] }
  | { type: 'toggledMetric'; metric: string }
  | { type: 'toggledLab'; key: string };

export const initialHistoryRead = (metric: string | null): HistoryRead => ({ phase: 'loading', metric });

const toggled = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
};

/** Every read in: tick the vital opened on if it has rows, else every vital; every lab test. */
function settle(state: Extract<HistoryRead, { phase: 'loading' }>): HistoryRead {
  const { metric, measurements, labVals, medHistory } = state;
  // The panel waits for all three, so each read must always settle, resolve or reject.
  // Today all three are sync store reads. A truly async loader needs a reject or timeout path.
  if (!measurements || !labVals || !medHistory) return state;
  const types = [...new Set(measurements.map(row => row.metricType))];
  return {
    phase: 'ready', measurements, labVals, medHistory,
    selectedMetrics: new Set(metric && types.includes(metric) ? [metric] : types),
    selectedLabMetrics: new Set(groupLabHistory(labVals).keys),
  };
}

export function transition(state: HistoryRead, event: HistoryReadEvent): HistoryRead {
  switch (state.phase) {
    case 'loading':
      switch (event.type) {
        case 'vitalsRead': return settle({ ...state, measurements: event.rows });
        case 'labsRead': return settle({ ...state, labVals: event.rows });
        case 'medsRead': return settle({ ...state, medHistory: event.rows });
        case 'vitalsFailed': return { phase: 'failed' };
        default: return state;
      }
    case 'ready':
      switch (event.type) {
        case 'toggledMetric': return { ...state, selectedMetrics: toggled(state.selectedMetrics, event.metric) };
        case 'toggledLab': return { ...state, selectedLabMetrics: toggled(state.selectedLabMetrics, event.key) };
        default: return state;
      }
    case 'failed':
      return state;
  }
}
