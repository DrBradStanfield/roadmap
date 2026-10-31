/** Shopify services only. Health records are read and written by roadmap-data. */
import type { GUIDE_PLACEMENTS, LPA_CHECK_ANSWERS, LpaUnit, MeasurementRefusal, MetricType, ProductEventName, REMOTE_CHANGE_BACKENDS } from '@roadmap/health-core';
import { PER_ACTION_EVENT_NAMES, type CHAT_PROFILE_CHOICES, type ONBOARDING_STEPS, type SIGNIN_PLACEMENTS, type CHAT_PROFILE_FIELDS, type UploadOutcomeKey } from '@roadmap/health-core/product-events';
import type { UsProduct } from '@roadmap/health-core/us-products';
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

export interface ProductEventMetadata extends Partial<Record<UploadOutcomeKey, number>> {
  provider?: 'google-drive' | 'dropbox' | 'github' | 'webdav' | 'local' | 'typed';
  count?: number;
  placement?: (typeof GUIDE_PLACEMENTS)[number] | (typeof SIGNIN_PLACEMENTS)[number];
  /** `onboarding_step` (US-62 AC1): the question's name, never its answer. */
  step?: (typeof ONBOARDING_STEPS)[number];
  backend?: (typeof REMOTE_CHANGE_BACKENDS)[number];
  /** `lab_unit_refused` (US-21 phase 3): the catalogue key of the test and the
   *  unit spelling the record would not take. Never a value. */
  key?: string;
  unit?: string;
  /** `lpa_unit_selected` (US-05 AC2): the unit shown before the change; `unit` is the one chosen. */
  from?: LpaUnit;
  /** `lpa_check_answered` (US-05 AC3): the answer, a label only. */
  answer?: (typeof LPA_CHECK_ANSWERS)[number];
  /** `measurement_refused` (US-35 AC17): the core metric id and why. Never a value. */
  metric?: MetricType;
  refusal?: MeasurementRefusal['reason'];
  /** `chat_profile_edit` (US-16 AC2): the profile field's name and what the user did. Never a value. */
  field?: (typeof CHAT_PROFILE_FIELDS)[number];
  choice?: (typeof CHAT_PROFILE_CHOICES)[number];
  /** `us_product_shown` / `us_product_link_clicked` (US-61 AC8): the product alone, never the card. */
  product?: UsProduct;
}

/**
 * Fire-and-forget anonymous funnel event. Event names are the shared
 * PRODUCT_EVENT_NAMES enum in health-core; the server rejects anything else.
 *
 * - Only fires on the Shopify surface: the Pages/self-host build has no Brad
 *   server, so this must no-op there (VITE_SHOPIFY_SURFACE gate).
 * - Throttled to once per event name per tab session (sessionStorage), so
 *   re-renders and repeat actions don't spam the endpoint, except
 *   PER_ACTION_EVENT_NAMES, where each occurrence is the count.
 * - Never attach health values or free text — metadata is a closed allow-list.
 */
export function trackProductEvent(
  eventName: ProductEventName,
  metadata?: ProductEventMetadata,
  /** Part of this tab's throttle key only, never sent: the metric of an
   *  out-of-range refusal, which the row may not carry (US-35 AC17). */
  localDetail?: string,
): void {
  if (!SHOPIFY_SURFACE) return;
  if (!(PER_ACTION_EVENT_NAMES as readonly string[]).includes(eventName)) {
    try {
      // Counted per (test, spelling), and a refused value per (metric, word):
      // collapsing them would hide all but the first — the very list each signal builds.
      const detail = metadata?.key ? `_${metadata.key}_${metadata.unit}`
        : metadata?.refusal ? `_${metadata.metric ?? localDetail}_${metadata.refusal}`
        : metadata?.choice ? `_${metadata.field}_${metadata.choice}`
        // US-61 AC8: once per product, so one product seen does not swallow the other.
        : metadata?.product ? `_${metadata.product}`
        // US-62 AC2: once per step and per placement, so the first does not swallow the rest.
        : metadata?.step ? `_${metadata.step}`
        : metadata?.placement ? `_${metadata.placement}`
        // Per provider, so a tab that tries Dropbox then Drive counts both (US-09 AC22).
        : eventName.startsWith('cloud_connect_') && metadata?.provider ? `_${metadata.provider}` : '';
      const sentKey = `hr_pe_${eventName}${detail}`;
      if (sessionStorage.getItem(sentKey)) return;
      sessionStorage.setItem(sentKey, '1');
    } catch { /* sessionStorage unavailable — still send once */ }
  }
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
