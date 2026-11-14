/**
 * Where one bulk row lands: as a lab row or as a core or vital value, and
 * under which metric. The write (`bulkAppendValues`) and the import review
 * (`import-review.ts`) both read it here, so a review's slot is the write's.
 */
import { bloodTestKeyOf } from './blood-tests';
import type { MetricType } from './units';

/** The parts of a `BulkRow` this reads (a type, so no import cycle with record-edits). */
type TargetedRow =
  | { kind: 'measurement'; metricType: string; source: string }
  | { kind: 'lab'; metricName: string; source: string };

/**
 * Brad D5 (US-66 AC6): an extra value named like a core test is that core
 * value, converted. An imported creatinine never, since it may be urine
 * (US-12 AC11); one the person typed is their blood value. `slot` is the
 * `slotKey` kind the row is placed under.
 */
export function bulkRowTarget(row: TargetedRow): { named: MetricType | null; asLab: boolean; metric: string; slot: 'measurement' | 'lab' } {
  const named = row.kind === 'lab' ? bloodTestKeyOf(row.metricName) : null;
  const asLab = row.kind === 'lab' && (!named || (named === 'creatinine' && row.source !== 'manual'));
  const metric = row.kind === 'measurement' ? row.metricType : asLab ? row.metricName : named!;
  return { named, asLab, metric, slot: asLab ? 'lab' : 'measurement' };
}
