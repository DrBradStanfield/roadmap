import { METRIC_LABELS } from '@roadmap/health-core/mappings';
import { UNIT_DEFS, roundBoundInward, type MetricType } from '@roadmap/health-core/units';
import type { MeasurementRefusal } from '@roadmap/health-core/record-edits';
import { measurementRefusalText } from '@roadmap/health-core/upload-text';
import { cellDecimalPlaces, cellFromSI, cellLabel, type CellUnit } from './blood-test-cell';

/** The same line for a blood test value the record refused (US-12 AC6,
 *  US-35 AC17): the test named, and for a value out of range the end of the
 *  range it missed, in the unit the cell shows (Brad, 2026-10-20). That end is
 *  the SI bound the record enforced, converted and rounded inward, so the
 *  value is always past the number shown (adversary F1). Never the number or
 *  the store's message. */
export function measurementRefusalLine(refusal: MeasurementRefusal, unit: CellUnit): string {
  // The lines that name no unit live in health-core, so the upload's done screen says them too.
  const text = measurementRefusalText(refusal);
  if (text !== null) return text;
  const { metricType, bound } = refusal;
  const label = Object.prototype.hasOwnProperty.call(METRIC_LABELS, metricType) ? METRIC_LABELS[metricType] : metricType;
  const metric = metricType as MetricType;
  const edge = bound === 'below' ? 'min' : 'max';
  const range = UNIT_DEFS[metric].validationRange.si;
  const limit = `${roundBoundInward(cellFromSI(metric, range[edge], unit), cellDecimalPlaces(metric, unit), edge).toLocaleString('en-US')} ${cellLabel(metric, unit)}`;
  // A floor the value may not equal (US-03 AC7): 0 is not "below 0".
  const clause = bound === 'below'
    ? range.minExclusive ? `the value must be above ${limit}` : `below ${limit}, the lowest value this tool accepts`
    : `above ${limit}, the highest value this tool accepts`;
  return `${label} not saved: ${clause}. Check the report, then enter it again.`;
}
