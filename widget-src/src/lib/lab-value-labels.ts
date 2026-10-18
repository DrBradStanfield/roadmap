import { METRIC_LABELS, labUnitRefusalNote, labUnitTaken, resolveLabCatalogEntry, type LabUnitRefusal, type MeasurementRefusal } from '@roadmap/health-core';

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
 *  US-35 AC17): the test named, never the number or the store's message. */
export function measurementRefusalLine({ metricType, reason }: MeasurementRefusal): string {
  const label = Object.prototype.hasOwnProperty.call(METRIC_LABELS, metricType) ? METRIC_LABELS[metricType] : metricType;
  return reason === 'unknown-metric'
    ? `${label}: not a test the record knows, so it was not saved.`
    : `${label}: the number was not saved. It is outside the range the record accepts.`;
}
