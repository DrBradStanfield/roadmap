// Widen a `yyyy-mm-dd` to UTC midnight ISO datetime, the form a measurement's
// `recordedAt` is stored in. A picked date (HealthTool) and the no-date
// default (roadmap-store addMeasurement) both pass through here, so the two
// land on the same (metric, day) slot.
export function ensureIsoDatetime(value: string): string;
export function ensureIsoDatetime(value: string | undefined): string | undefined;
export function ensureIsoDatetime(value: string | undefined): string | undefined {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}
