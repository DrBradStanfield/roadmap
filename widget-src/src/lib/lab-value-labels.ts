import { METRIC_LABELS, UNIT_DEFS, labUnitRefusalNote, labUnitTaken, resolveLabCatalogEntry, type LabUnitRefusal, type MeasurementRefusal, type MetricType, type UnitSystem } from '@roadmap/health-core';

/** A lab test's name for display: its catalogue label, else the snake_case name title-cased. */
export function labValueLabel(metricName: string): string {
  return resolveLabCatalogEntry(metricName)?.label
    ?? metricName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * What a person reads when the record refused a lab value's unit: the unit a
 * catalogued test is stored in, or, for a unit it does take, that the number was
 * refused, and a note on what to look for instead, where there is one (US-21 AC15). Never the store's
 * message, which is the copy an assistant reads.
 */
export function labUnitRefusalLine(key: string, unit: string, fault?: LabUnitRefusal['fault']): string {
  const entry = resolveLabCatalogEntry(key);
  const note = labUnitRefusalNote(entry, unit, fault);
  if (fault === 'scale') return `${labValueLabel(key)}: ${note}.`;
  const takes = entry ? ` This test takes ${entry.unit}.` : '';
  const lead = labUnitTaken(entry, unit)
    ? `${labValueLabel(key)}: the number was not saved.`
    : !unit.trim()
      ? `${labValueLabel(key)}: no unit was printed, so it was not saved.${takes}`
      : `${labValueLabel(key)}: unit not recognised (${unit}). It was not saved.${takes}`;
  return note ? `${lead} ${note}.` : lead;
}

/** The same line for a blood test value the record refused (US-12 AC6,
 *  US-35 AC17): the test named, and for a value out of range the end of the
 *  range it missed, in the units the user reads (Brad, 2026-10-20). Never the
 *  number or the store's message. */
export function measurementRefusalLine({ metricType, reason, bound }: MeasurementRefusal, system: UnitSystem): string {
  const label = Object.prototype.hasOwnProperty.call(METRIC_LABELS, metricType) ? METRIC_LABELS[metricType] : metricType;
  if (reason === 'unknown-metric') return `${label}: not a test the record knows, so it was not saved.`;
  if (reason === 'invalid-value') return `${label}: the value was not a number the record can store, so it was not saved.`;
  const unit = UNIT_DEFS[metricType as MetricType];
  const [side, end] = bound === 'below' ? ['below', 'lowest'] : ['above', 'highest'];
  const limit = unit.validationRange[system][bound === 'below' ? 'min' : 'max'].toLocaleString('en-US');
  return `${label} not saved: ${side} ${limit} ${unit.label[system]}, the ${end} value this tool accepts. Check the report, then enter it again.`;
}
