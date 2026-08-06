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
  'reminder_optin',
  'chat_opened',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];
