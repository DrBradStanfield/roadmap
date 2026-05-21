// `recordedAt` widening helper.
//
// The server validates `recordedAt` as a full ISO datetime (Zod `.datetime()`),
// but several client paths construct dates as `yyyy-mm-dd` (e.g. the
// BloodTestTimeline matrix's batch date, or any date picker that emits a date
// without a time). Without widening, those POSTs come back 400 with
// `Invalid datetime` — and the matrix silently clears the draft. Brad's
// Lp(a)=10 click-away bug.
//
// Widen any `yyyy-mm-dd` to UTC midnight of that day; pass through anything
// already ISO (or `undefined`/empty).
export function ensureIsoDatetime(value: string | undefined): string | undefined {
  if (!value) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}
