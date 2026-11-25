/**
 * How long a cloud provider gets to answer, one number per kind of call, and
 * the one helper that enforces it by aborting the request (A1-6). Every
 * adapter reads its bound from here: web, the iPhone engine and the hosted
 * MCP share these numbers. Open questions on the calls that do not use it
 * yet: docs/drafts/a1-6-transfer-deadline-design.md.
 */
export const TRANSFER_DEADLINE_MS = {
  /** Any call, body included, unless a kind below says otherwise. Long enough
   *  for a slow phone on a slow network, short enough that a hosted tool call
   *  fails rather than hangs. */
  call: 30_000,
  /** A document read or upload: a 10 MB original on a slow uplink must not be
   *  cut at 30 s (US-09 AC13e, AC39). */
  document: 300_000,
  /** A token refresh: every read and save waits on it (US-09 AC13h). */
  tokenRefresh: 5_000,
  /** The account-email read app load waits on before the schedule push (US-17 AC12). */
  accountEmail: 10_000,
} as const;

/** Drive's document upload: judged on the provider's silence, not the user's
 *  uplink, so the bound grows 1 s per 10 KB from `call`, up to `document`. */
export function documentUploadMs(bytes: number): number {
  return Math.min(TRANSFER_DEADLINE_MS.document, TRANSFER_DEADLINE_MS.call + Math.round(bytes / 10_000) * 1_000);
}

/**
 * `AbortSignal.timeout(ms)` where the browser has it, else the same bound on
 * the global timer. Safari 14/15 has no `AbortSignal.timeout`, and the widget
 * ships untranspiled to it: called bare, it throws before the request is made
 * (US-09 AC13g). Call `clear` once the call and its body read are over; it
 * frees the fallback timer.
 */
export function timeoutDeadline(ms: number): { signal: AbortSignal; clear(): void } {
  if (typeof AbortSignal.timeout === 'function') return { signal: AbortSignal.timeout(ms), clear: () => undefined };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The deadline has passed', 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
