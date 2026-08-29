/**
 * Product funnel events — the single source of truth for event names, shared by
 * the widget's trackProductEvent() (client) and api.events (server Zod enum).
 *
 * These are anonymous behavioral counters only: event name + visitor UUID.
 * NEVER attach health values, free text, or identifying data to an event —
 * the allowed metadata shape is enforced server-side in product-events.server.ts.
 */
export const PRODUCT_EVENT_NAMES = [
  'results_viewed',
  'upload_started',
  'upload_extract_failed',
  'upload_saved',
  'cloud_connect_started',
  'cloud_connect_success',
  'correction_made',
  // US-17 default-on reminders: optin fires on enrolment (auto or manual),
  // optout on disable. The RATIO is the honest measure of the opt-out model —
  // sustained optout > ~30% of optins means the default-on call was wrong.
  'reminder_optin',
  'reminder_optout',
  // Fired by the reminder cron on each successful send (server-originated,
  // nil-UUID sentinel; metadata = provider + due-item count only) — sends
  // were invisible until the first real one (2026-08-28) surfaced the gap.
  'reminder_sent',
  'chat_opened',
  // US-21 additional blood tests: phase-1 surfacing + phase-2 manual add.
  'lab_rows_viewed',
  'lab_row_added',
  // US-22 plan-ready email. Server-originated (no browser visitor): recorded
  // with the nil-UUID sentinel, see SERVER_VISITOR_ID in product-events.server.
  'report_email_sent',
  'report_email_bounced',
  'report_email_complained',
  'report_email_clicked',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];
