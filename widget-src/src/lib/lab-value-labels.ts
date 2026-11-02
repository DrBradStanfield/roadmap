import { METRIC_LABELS, PRESSURE_ORDER, UNIT_DEFS, roundBoundInward, type MeasurementRefusal, type MetricType } from '@roadmap/health-core';
import { cellDecimalPlaces, cellFromSI, cellLabel, type CellUnit } from './blood-test-cell';

/** The same line for a blood test value the record refused (US-12 AC6,
 *  US-35 AC17): the test named, and for a value out of range the end of the
 *  range it missed, in the unit the cell shows (Brad, 2026-10-20). That end is
 *  the SI bound the record enforced, converted and rounded inward, so the
 *  value is always past the number shown (adversary F1). Never the number or
 *  the store's message. */
export function measurementRefusalLine({ metricType, reason, message, bound }: MeasurementRefusal, unit: CellUnit): string {
  const label = Object.prototype.hasOwnProperty.call(METRIC_LABELS, metricType) ? METRIC_LABELS[metricType] : metricType;
  if (reason === 'unknown-metric') return `${label}: not a test the record knows, so it was not saved.`;
  if (reason === 'invalid-value') return `${label}: the value was not a number the record can store, so it was not saved.`;
  // A blood pressure the wrong way up (US-02 AC8): no end of a range was missed.
  if (message === PRESSURE_ORDER) return `Blood pressure not saved: ${PRESSURE_ORDER[0].toLowerCase()}${PRESSURE_ORDER.slice(1)} Check the report, then enter it again.`;
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
