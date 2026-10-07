import * as Sentry from '@sentry/react-router';
import { z } from 'zod';
// Deep relative import (not '@roadmap/health-core'): the Docker build runs
// `npm ci` before COPY, so the workspace symlink never exists in the image —
// same reason chat.server.ts / email.server.ts import health-core this way.
import { EVENT_REASONS, GUIDE_PLACEMENTS, isLabKeyWord, isLabUnitWord, MCP_IMPORT_FILE_BUCKETS, MCP_IMPORT_PHASES, MCP_IMPORT_ROUTES, MCP_TOOL_NAMES, PRODUCT_EVENT_NAMES, REMOTE_CHANGE_BACKENDS, SERVER_ONLY_EVENT_NAMES, type McpOAuthReason, type McpRefusalReason, type ProductEventName } from '../../packages/health-core/src/product-events';
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
    /** US-34: the tier a remote change came in on — another tab, or a cloud. */
    backend: z.enum(REMOTE_CHANGE_BACKENDS).optional(),
    /**
     * US-21 phase 3: the catalogue key and the unit spelling a refused lab row
     * carried — the signal that says which spelling to add next. The words are
     * judged by health-core's own predicates, the same ones the producer uses,
     * so a unit that is really a number (the shape a health VALUE arrives in)
     * never reaches the column, and EVENT_KEY_OWNERS keeps both off every
     * other event.
     */
    key: z.string().refine(isLabKeyWord).optional(),
    unit: z.string().refine(isLabUnitWord).optional(),
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
 * The word itself is parsed as a plain string and judged against its own
 * EVENT below, because the two vocabularies share this one key.
 */
const serverMetadataSchema = metadataSchema.extend({
  reason: z.string().optional(),
  /** US-32 AC38: a connection made through the reviewer sign-in. Server-only, owned by `mcp_connect`. */
  via: z.enum(['reviewer']).optional(),
  /** US-36 AC9: which half of a two-phase write a tool call was. Server-only, owned by `mcp_tool_call`. */
  step: z.enum(['propose', 'confirm']).optional(),
});

/** The event a metadata key belongs to, where the key has no vocabulary of its
 *  own to be judged against (`reason` has EVENT_REASONS). Without this a
 *  `unit` could ride on any counter. */
const EVENT_KEY_OWNERS: Record<string, readonly string[]> = {
  key: ['lab_unit_refused'],
  unit: ['lab_unit_refused'],
  via: ['mcp_connect'],
  step: ['mcp_tool_call'],
};

/**
 * Metadata held against the EVENT that carries it — the pairing both schemas
 * check, because neither a `reason` nor a `unit` means anything on its own. A
 * tool-refusal word on an OAuth row would validate and then split every query
 * in two, and a `key` on any other counter would be a column nothing reads.
 * Only words this file already declares are ever named in an issue.
 */
function checkEventKeys(
  event: { eventName: string; metadata?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  const metadata = event.metadata;
  if (!metadata) return;
  for (const [key, owners] of Object.entries(EVENT_KEY_OWNERS)) {
    if (metadata[key] !== undefined && !owners.includes(event.eventName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['metadata', key], message: 'key is not one this event may carry' });
    }
  }
  const reason = metadata.reason;
  if (reason === undefined) return;
  const allowed: readonly string[] = EVENT_REASONS[event.eventName as keyof typeof EVENT_REASONS] ?? [];
  if (!allowed.includes(reason as string)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['metadata', 'reason'], message: 'reason is not one this event may carry' });
  }
}

/** Event name and visitor alone: what `recordProductEvent` refuses a row on,
 *  and the base both metadata lists extend. */
const eventShellSchema = z.object({
  eventName: z.enum(PRODUCT_EVENT_NAMES),
  visitorId: z.string().uuid(),
});

export const productEventSchema = eventShellSchema
  .extend({ metadata: metadataSchema.optional() })
  .superRefine(checkEventKeys);

/** The same event, with the server's slightly wider metadata list — one
 *  column, two vocabularies for `reason`. */
const serverEventSchema = eventShellSchema
  .extend({ metadata: serverMetadataSchema.optional() })
  .superRefine(checkEventKeys);

export type ProductEventInput = z.infer<typeof productEventSchema>;
/** The schema parses `reason` as a string; a PRODUCER may only write a word. */
type ServerEventMetadata = z.infer<typeof serverMetadataSchema> & { reason?: McpRefusalReason | McpOAuthReason };
type ServerProductEvent = { eventName: ProductEventName; visitorId: string; metadata?: ServerEventMetadata };

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
function cleanMetadata(event: ServerProductEvent & { metadata: object }): { clean?: object; dropped: string[] } {
  const metadata = event.metadata as Record<string, unknown>;
  // The whole object, in one parse: nearly every row is already clean, and the
  // walk below exists only for the row that is not.
  if (serverEventSchema.safeParse(event).success) {
    return { clean: Object.keys(metadata).length ? metadata : undefined, dropped: [] };
  }
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    // The EVENT, one key at a time: `reason` is judged against its own event.
    if (serverEventSchema.safeParse({ ...event, metadata: { [key]: value } }).success) clean[key] = value;
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
  const shell = eventShellSchema.safeParse(event);
  if (!shell.success) {
    Sentry.captureMessage('product_events: event refused', {
      level: 'warning',
      tags: { feature: 'product_events' },
      extra: { eventName: String(event.eventName).slice(0, 64) },
    });
    return false;
  }
  // `raw` is only an object worth walking when it IS one: a null or a string
  // slipped past the types would otherwise report an empty `dropped` list and
  // read as "nothing was wrong" in the one message meant to say otherwise.
  const raw = event.metadata;
  const { clean, dropped } = raw && typeof raw === 'object'
    ? cleanMetadata({ ...shell.data, metadata: raw })
    : { clean: undefined, dropped: raw == null ? [] : ['<not an object>'] };
  if (dropped.length) {
    Sentry.captureMessage('product_events: server metadata keys dropped', {
      level: 'warning',
      tags: { feature: 'product_events' },
      extra: { eventName: shell.data.eventName, keys: dropped.slice(0, 12) },  // names only; the values are what we refused
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
