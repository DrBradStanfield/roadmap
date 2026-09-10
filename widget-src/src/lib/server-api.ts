/** Shopify services only. Health records are read and written by roadmap-data. */
import type { GUIDE_PLACEMENTS, ProductEventName } from '@roadmap/health-core';
import { safeGetItem, safeSetItem } from './storage';
import { SHOPIFY_SURFACE } from './build-flags';
import { Sentry } from './sentry';

export const PROXY_PATH = '/apps/health-tool-1';

/**
 * Helper to wrap API calls with consistent error handling.
 * Logs warning, reports to Sentry, and returns fallback value.
 */
async function apiCall<T>(
  operation: () => Promise<T>,
  errorMessage: string,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.warn(errorMessage, error);
    Sentry.captureException(error);
    return fallback;
  }
}

/**
 * Safely parse a JSON response, returning null if the content-type isn't JSON.
 * Shopify's app proxy can return HTML (maintenance/error pages) with a 200 status.
 * Calling response.json() on HTML throws a SyntaxError — this guard prevents that.
 * Genuine malformed JSON (with correct content-type) still throws for Sentry reporting.
 */
export async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  return response.json() as Promise<T>;
}

/**
 * Send feedback via the feedback API endpoint. Shopify surface only — the
 * Pages build has no Brad server, so it reports failure without a fetch.
 */
export async function sendFeedback(
  email: string,
  message: string,
): Promise<boolean> {
  if (!SHOPIFY_SURFACE) return false;
  return apiCall(
    async () => {
      const response = await fetch(`${PROXY_PATH}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, message, website: '' }),
      });
      if (!response.ok) return false;
      const result = await parseJsonResponse<{ success: boolean }>(response);
      return result?.success ?? false;
    },
    'Error sending feedback',
    false,
  );
}

// ---------------------------------------------------------------------------
// A/B Testing
// ---------------------------------------------------------------------------

let cachedVisitorId: string | null = null;

export function getVisitorId(): string {
  if (cachedVisitorId) return cachedVisitorId;
  const KEY = 'hr_vid';
  const stored = safeGetItem(KEY);
  if (stored) { cachedVisitorId = stored; return stored; }
  const id = crypto.randomUUID?.() ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b, i) => {
        if (i === 6) b = (b & 0x0f) | 0x40;  // version 4
        if (i === 8) b = (b & 0x3f) | 0x80;  // variant 1
        return b.toString(16).padStart(2, '0');
      })
      .join('')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  safeSetItem(KEY, id);
  cachedVisitorId = id;
  return id;
}

// Key format shared with inline script in app-block.liquid: { tests: { testId: variantId, ... } }
// Backwards compat: also reads old single-test format { t: testId, v: variantId }
export function getABAssignments(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem('hr_ab') || '{}');
    if (raw.tests) return raw.tests;
    if (raw.t && raw.v) return { [raw.t]: raw.v };
  } catch { /* no assignment */ }
  return {};
}

function trackABEvent(eventType: 'impression' | 'conversion'): void {
  if (!SHOPIFY_SURFACE) return;
  const assignments = getABAssignments();
  const visitorId = getVisitorId();
  for (const [testId, variantId] of Object.entries(assignments)) {
    // Skip redundant impression calls — server deduplicates, but this avoids the network roundtrip
    if (eventType === 'impression') {
      const sentKey = `hr_ab_imp_${testId}`;
      if (safeGetItem(sentKey)) continue;
      safeSetItem(sentKey, '1');
    }
    apiCall(
      () => fetch(`${PROXY_PATH}/api/ab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [eventType]: { testId, variantId, visitorId } }),
      }),
      `AB ${eventType} tracking failed`,
      null,
    );
  }
}

export function trackABImpression(): void { trackABEvent('impression'); }
export function trackABConversion(): void { trackABEvent('conversion'); }

// ---------------------------------------------------------------------------
// Product funnel events (anonymous behavioral counters — usage-audit 2026-08)
// ---------------------------------------------------------------------------

export interface ProductEventMetadata {
  provider?: 'google-drive' | 'dropbox' | 'github' | 'webdav' | 'local' | 'typed';
  count?: number;
  placement?: (typeof GUIDE_PLACEMENTS)[number];
}

/**
 * Fire-and-forget anonymous funnel event. Event names are the shared
 * PRODUCT_EVENT_NAMES enum in health-core; the server rejects anything else.
 *
 * - Only fires on the Shopify surface: the Pages/self-host build has no Brad
 *   server, so this must no-op there (VITE_SHOPIFY_SURFACE gate).
 * - Throttled to once per event name per tab session (sessionStorage), so
 *   re-renders and repeat actions don't spam the endpoint.
 * - Never attach health values or free text — metadata is a closed allow-list.
 */
export function trackProductEvent(
  eventName: ProductEventName,
  metadata?: ProductEventMetadata,
): void {
  if (!SHOPIFY_SURFACE) return;
  try {
    const sentKey = `hr_pe_${eventName}`;
    if (sessionStorage.getItem(sentKey)) return;
    sessionStorage.setItem(sentKey, '1');
  } catch { /* sessionStorage unavailable — still send once */ }
  const visitorId = getVisitorId();
  apiCall(
    () => fetch(`${PROXY_PATH}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventName, visitorId, ...(metadata ? { metadata } : {}) }),
      // Several call sites navigate/reload right after firing (cloud connect,
      // save flows) — keepalive lets the request survive the page teardown.
      keepalive: true,
    }),
    'Product event tracking failed',
    null,
  );
}
