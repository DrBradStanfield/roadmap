// Widen a `yyyy-mm-dd` to UTC midnight ISO datetime. The server validates
// `recordedAt` with Zod `.datetime()` which rejects date-only strings — and
// the matrix's auto-save silently clears the draft on any 4xx, so a missing
// widen here looks like "the value disappeared" to the user.
export function ensureIsoDatetime(value: string): string;
export function ensureIsoDatetime(value: string | undefined): string | undefined;
export function ensureIsoDatetime(value: string | undefined): string | undefined {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}
