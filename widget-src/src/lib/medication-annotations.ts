import type { ApiMedicationHistory } from './api-types';
import { chartTimestamp } from './constants';
import { isTakingDrug } from '@roadmap/health-core';

// Map medication keys to the chart metrics they affect
const MED_CHART_MAP: Record<string, string[]> = {
  statin: ['ldl', 'apob', 'total_cholesterol'],
  ezetimibe: ['ldl', 'apob', 'total_cholesterol'],
  bempedoic_acid: ['ldl', 'apob', 'total_cholesterol'],
  pcsk9i: ['ldl', 'apob', 'total_cholesterol'],
  statin_escalation: ['ldl', 'apob', 'total_cholesterol'],
  glp1: ['hba1c', 'weight', 'triglycerides'],
  glp1_escalation: ['hba1c', 'weight', 'triglycerides'],
  sglt2i: ['hba1c', 'weight'],
  metformin: ['hba1c'],
};

export interface ChartAnnotation {
  date: number;
  label: string;
}

export const MED_ANNOTATION_COLOR = '#6366f1';

const ACTIONS: Record<string, string> = {
  started: 'Recorded start:',
  stopped: 'Recorded stop:',
  dose_changed: 'Recorded dose change:',
  switched: 'Recorded switch to:',
};

/**
 * Pins closer than ~4% of the axis span would overdraw each other's label, so
 * they share one line whose label lists every entry number (1-based, list
 * order). Each pin chains off the cluster's latest pin, so an evenly spaced
 * run stays one cluster.
 */
export function pinClusters(annotations: ChartAnnotation[], span: number): Array<{ date: number; numbers: number[] }> {
  const clusters: Array<{ date: number; last: number; numbers: number[] }> = [];
  for (const pin of annotations.map((a, i) => ({ date: a.date, n: i + 1 })).sort((p, q) => p.date - q.date)) {
    const last = clusters.at(-1);
    if (last && pin.date - last.last <= span * 0.04) { last.numbers.push(pin.n); last.last = pin.date; }
    else clusters.push({ date: pin.date, last: pin.date, numbers: [pin.n] });
  }
  return clusters.map(({ date, numbers }) => ({ date, numbers }));
}

/** Project recorded events only; never infer a treatment timeline from merged order. */
export function medicationAnnotations(history: ApiMedicationHistory[]): Record<string, ChartAnnotation[]> {
  const map: Record<string, ChartAnnotation[]> = {};
  for (const h of history) {
    const metrics = MED_CHART_MAP[h.medicationKey];
    const action = ACTIONS[h.changeType];
    const date = chartTimestamp(h.recordedAt);
    if (!Array.isArray(metrics) || typeof action !== 'string' || !Number.isFinite(date)) continue;
    // Stops saved as 'none' do not retain the old drug. Name the category
    // instead of guessing which merged row preceded it.
    const name = !isTakingDrug(h.drugName) || h.drugName === 'yes' ? h.medicationKey : h.drugName;
    const displayName = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
    const hasDose = Number.isFinite(h.doseValue) && (h.doseValue as number) > 0 && typeof h.doseUnit === 'string' && h.doseUnit !== '';
    const dose = h.changeType !== 'stopped' && hasDose ? ` ${h.doseValue}${h.doseUnit}` : '';
    const ann = { date, label: `${action} ${displayName}${dose}` };
    for (const metric of metrics) (map[metric] ??= []).push(ann);
  }
  return map;
}
