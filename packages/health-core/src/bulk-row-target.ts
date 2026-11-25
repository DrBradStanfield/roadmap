/**
 * Where one bulk row lands, and what became of it: the write
 * (`bulkAppendValues`) and the import review (`import-review.ts`) both read
 * them here, so a review's slot and outcome are the write's.
 */
import { bloodTestKeyOf } from './blood-tests';
import { labNameForUnit } from './lab-catalog-shares';
import type { MetricType } from './units';

/** The parts of a `BulkRow` this reads (a type, so no import cycle with record-edits). */
type TargetedRow =
  | { kind: 'measurement'; metricType: string; source: string }
  | { kind: 'lab'; metricName: string; unit: string; source: string };

/**
 * Brad D5 (US-66 AC6): an extra value named like a core test is that core
 * value, converted. An imported creatinine never, since it may be urine
 * (US-12 AC11); one the person typed is their blood value. A count's name in
 * a unit its share takes is the share's key (US-21 AC28). `slot` is the
 * `slotKey` kind the row is placed under.
 */
export function bulkRowTarget(row: TargetedRow): { named: MetricType | null; asLab: boolean; metric: string; slot: 'measurement' | 'lab' } {
  const named = row.kind === 'lab' ? bloodTestKeyOf(row.metricName) : null;
  const asLab = row.kind === 'lab' && (!named || (named === 'creatinine' && row.source !== 'manual'));
  const metric = row.kind === 'measurement' ? row.metricType : asLab ? labNameForUnit(row.metricName, row.unit) : named!;
  return { named, asLab, metric, slot: asLab ? 'lab' : 'measurement' };
}

export type BulkRowOutcome = 'written' | 'skipped' | 'refused';

/** Each row's outcome in a bulk write (US-13 AC13), read off the write's
 *  counts: `settle` as the next row starts, and once after the last. */
export function outcomeLog(counts: () => { saved: number; skipped: number }): { outcomes: BulkRowOutcome[]; settle: () => void } {
  const outcomes: BulkRowOutcome[] = [];
  let before = { saved: 0, skipped: 0 };
  return {
    outcomes,
    settle: () => {
      const now = counts();
      outcomes.push(now.saved > before.saved ? 'written' : now.skipped > before.skipped ? 'skipped' : 'refused');
      before = now;
    },
  };
}
