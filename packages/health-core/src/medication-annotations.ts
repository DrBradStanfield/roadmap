/**
 * Recorded medication changes on a value chart (US-06 AC4; the iPhone's metric
 * pages, US-25 AC9b): which changes mark which metric's chart, and the words
 * each one carries. One source for the web's HistoryPanel and the iPhone
 * engine's `historyJson`, so an over-the-air engine can change the phone's.
 */
import type { FileMedication } from './roadmap-file';
import { isTakingDrug } from './history-change';
import { isEscalationKey } from './validation';

/** The chart metrics each medication affects. */
const MED_CHART_MAP: Record<string, string[]> = {
  statin: ['ldl', 'apob', 'total_cholesterol'],
  ezetimibe: ['ldl', 'apob', 'total_cholesterol'],
  bempedoic_acid: ['ldl', 'apob', 'total_cholesterol'],
  pcsk9i: ['ldl', 'apob', 'total_cholesterol'],
  glp1: ['hba1c', 'weight', 'triglycerides'],
  sglt2i: ['hba1c', 'weight'],
  metformin: ['hba1c'],
};

/** One recorded medication change, as the history view reads it. */
export interface MedicationChange {
  id: string;
  medicationKey: string;
  drugName: string;
  doseValue: number | null;
  doseUnit: string | null;
  changeType: string;
  /** When the change was recorded, not a claimed treatment date. */
  recordedAt: string;
}

/** A file's `medicationHistory` as the history view reads it, oldest first: rows without a
 *  change type, a drug name or a real time are kept in the file but not shown. */
export function medicationChanges(rows: FileMedication[]): MedicationChange[] {
  // An escalation row an earlier build wrote is an answer, not a medication
  // change (US-06 AC11): the file keeps it, the history view does not show it.
  return rows
    .filter(h => Object.prototype.hasOwnProperty.call(ACTIONS, h.changeType ?? '')
      && typeof h.medicationKey === 'string' && !isEscalationKey(h.medicationKey) && typeof h.drugName === 'string'
      && Number.isFinite(Date.parse(h.updatedAt)))
    .map(h => ({
      id: h.id, medicationKey: h.medicationKey, drugName: h.drugName,
      doseValue: h.doseValue, doseUnit: h.doseUnit,
      changeType: h.changeType!, recordedAt: h.updatedAt,
    }))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
}

export interface ChartAnnotation {
  id: string;
  /** Epoch ms on the caller's time axis. */
  date: number;
  label: string;
}

const ACTIONS: Record<string, string> = {
  started: 'Recorded start:',
  stopped: 'Recorded stop:',
  dose_changed: 'Recorded dose change:',
  switched: 'Recorded switch to:',
};

/** Project recorded events only; never infer a treatment timeline from merged order.
 *  `time` places a recorded time on the caller's axis (the web plots a day slot at local midnight). */
export function medicationAnnotations(history: MedicationChange[], time: (recordedAt: string) => number = Date.parse): Record<string, ChartAnnotation[]> {
  const map: Record<string, ChartAnnotation[]> = {};
  for (const h of history) {
    const metrics = MED_CHART_MAP[h.medicationKey];
    const action = ACTIONS[h.changeType];
    const date = time(h.recordedAt);
    if (!Array.isArray(metrics) || typeof action !== 'string' || !Number.isFinite(date)) continue;
    // Stops saved as 'none' do not retain the old drug. Name the category
    // instead of guessing which merged row preceded it. A name that is not a
    // string (a hand-edited file) is unknown, so it names the category too.
    const name = typeof h.drugName !== 'string' || !isTakingDrug(h.drugName) || h.drugName === 'yes' ? h.medicationKey : h.drugName;
    const displayName = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
    const hasDose = Number.isFinite(h.doseValue) && (h.doseValue as number) > 0 && typeof h.doseUnit === 'string' && h.doseUnit !== '';
    const dose = h.changeType !== 'stopped' && hasDose ? ` ${h.doseValue}${h.doseUnit}` : '';
    const ann = { id: h.id, date, label: `${action} ${displayName}${dose}` };
    for (const metric of metrics) (map[metric] ??= []).push(ann);
  }
  return map;
}
