import * as Sentry from '@sentry/react-router';
import { z } from 'zod';
// Deep relative import (not '@roadmap/health-core'): the Docker build runs
// `npm ci` before COPY, so the workspace symlink never exists in the image —
// same reason chat.server.ts / email.server.ts import health-core this way.
import { GUIDE_PLACEMENTS, MCP_IMPORT_FILE_BUCKETS, MCP_IMPORT_PHASES, MCP_IMPORT_ROUTES, MCP_REFUSAL_REASONS, MCP_TOOL_NAMES, PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { MCP_CLIENT_LABELS } from './mcp-clients.server';
import { supabaseAdmin } from './supabase.server';

// Metadata is a closed allow-list: no free text, no health values, everything
// else rejected by .strict(). Enforced at recordProductEvent, the single door
// into the table, so a new caller inherits it. This list is the BROWSER's,
// applied at parseProductEvent; the server's is the same plus `reason` (see
// serverMetadataSchema), which SERVER_ONLY_EVENT_NAMES keeps out of a browser.
const metadataSchema = z
  .object({
    provider: z.enum(['google-drive', 'dropbox', 'github', 'webdav', 'local', 'typed']).optional(),
    count: z.number().int().min(0).max(1000).optional(),
    tool: z.enum(MCP_TOOL_NAMES).optional(),
    client: z.enum(MCP_CLIENT_LABELS).optional(),
    outcome: z.enum(['ok', 'refused', 'error']).optional(),
    route: z.enum(MCP_IMPORT_ROUTES).optional(),
    phase: z.enum(MCP_IMPORT_PHASES).optional(),
    files: z.enum(MCP_IMPORT_FILE_BUCKETS).optional(),
    /** US-37: this extract followed a read's folder nudge — the retirement query. */
    fromNudge: z.literal(true).optional(),
    /** US-38: which guide-link surface was clicked. */
    placement: z.enum(GUIDE_PLACEMENTS).optional(),
  })
  .strict();

/**
 * US-32 AC29's refusal word, on the server list only: it can ride on
 * `mcp_tool_call`, which SERVER_ONLY_EVENT_NAMES already keeps out of the
 * browser, so parseProductEvent goes on rejecting it. The vocabulary's real
 * owner is `countToolCall` (`mcp.server.ts`), the single producer, which maps
 * an unrecognised word to `other` and keeps the row. This is the backstop
 * under it, not a second opinion.
 *
 * `.optional()` is part of the shape, not an oversight: four server counters
 * send no metadata at all (the US-22 email funnel), and saying so here is what
 * keeps the check below a single expression.
 */
const serverMetadataSchema = metadataSchema
  .extend({ reason: z.enum(MCP_REFUSAL_REASONS).optional() })
  .optional();

export const productEventSchema = z.object({
  eventName: z.enum(PRODUCT_EVENT_NAMES),
  visitorId: z.string().uuid(),
  metadata: metadataSchema.optional(),
});

/** The same event, with the server's slightly wider metadata list. */
const serverEventSchema = productEventSchema.extend({ metadata: serverMetadataSchema });

export type ProductEventInput = z.infer<typeof productEventSchema>;
type ServerProductEvent = z.infer<typeof serverEventSchema>;

/**
 * Sentinel visitor for events the SERVER originates, where no browser visitor
 * exists: a plan-ready email send, a Resend bounce/complaint webhook, an email
 * link click (US-22). Deliberately NOT the recipient's address or any hash of
 * it — product_events stays anonymous counters, so these events answer "how
 * many bounced", never "who bounced".
 */
export const SERVER_VISITOR_ID = '00000000-0000-0000-0000-000000000000';

/** Fire-and-forget server-side counter. Never throws — callers are hot paths. */
export async function recordServerEvent(
  eventName: ServerProductEvent['eventName'],
  metadata?: ServerProductEvent['metadata'],
): Promise<void> {
  try {
    await recordProductEvent({ eventName, visitorId: SERVER_VISITOR_ID, metadata });
  } catch {
    /* counters must never break the operation they measure */
  }
}

const SERVER_ONLY = new Set<string>(SERVER_ONLY_EVENT_NAMES);

export function parseProductEvent(body: unknown): ProductEventInput | null {
  const parsed = productEventSchema.safeParse(body);
  if (!parsed.success) return null;
  // Server-originated counters can't arrive from a browser: a forged
  // reminder_sent / report_email_* (or the nil sentinel as visitorId) would
  // be indistinguishable from the real cron/webhook rows.
  if (SERVER_ONLY.has(parsed.data.eventName) || parsed.data.visitorId === SERVER_VISITOR_ID) return null;
  return parsed.data;
}

/**
 * Strips the keys that miss the allow-list and keeps the rest, so one bad word
 * costs its own key and not the row's whole identity. Nulling the object
 * wholesale would leave `mcp_tool_call` counting a total that no `GROUP BY`
 * can reach, and product-health reads exactly those breakdowns.
 */
function cleanMetadata(metadata: Record<string, unknown>): { clean?: object; dropped: string[] } {
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (serverMetadataSchema.safeParse({ [key]: value }).success) clean[key] = value;
    else dropped.push(key);
  }
  return { clean: Object.keys(clean).length ? clean : undefined, dropped };
}

/**
 * The one door into the table, so the one place the shape is enforced. It sat
 * above this — in parseProductEvent for the browser, nowhere at all for the
 * server — and the second caller arrived without it. A bad event NAME or
 * visitor is a programming error and the row is refused; bad metadata KEYS are
 * stripped while the event still records, because the counter is the thing
 * being measured. The warning names the event and the dropped KEYS, never a
 * value, and only ever words this file already declares.
 */
export async function recordProductEvent(event: ServerProductEvent): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const shell = productEventSchema.omit({ metadata: true }).safeParse(event);
  if (!shell.success) {
    Sentry.captureMessage('product_events: event refused', {
      level: 'warning',
      tags: { feature: 'product_events' },
      extra: { eventName: String(event.eventName).slice(0, 64) },
    });
    return false;
  }
  const raw = event.metadata;
  const { clean, dropped } = raw ? cleanMetadata(raw) : { clean: undefined, dropped: [] };
  if (dropped.length) {
    Sentry.captureMessage('product_events: server metadata keys dropped', {
      level: 'warning',
      tags: { feature: 'product_events' },
      extra: { eventName: shell.data.eventName, keys: dropped.slice(0, 12) },
    });
  }
  const { error } = await supabaseAdmin.from('product_events').insert({
    event_name: shell.data.eventName,
    visitor_id: shell.data.visitorId,
    metadata: clean ?? null,
  });
  if (error) {
    console.error('Failed to record product event:', error.message);
    return false;
  }
  return true;
}

// Fire-and-forget mirror of the feedback email — the email to Brad remains the
// primary delivery; a DB error here must never block or fail the submission.
export async function recordFeedbackSubmission(
  email: string,
  message: string,
  customerId: string | null,
): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin.from('feedback_submissions').insert({
    email,
    message,
    customer_id: customerId,
  });
  if (error) {
    console.error('Failed to record feedback submission:', error.message);
    return false;
  }
  return true;
}
