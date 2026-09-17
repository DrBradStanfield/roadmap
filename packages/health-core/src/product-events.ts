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
  'medication_history_viewed',
  'upload_started',
  'upload_extract_failed',
  'upload_saved',
  'cloud_connect_started',
  'cloud_connect_success',
  'correction_made',
  // US-17 default-on reminders: optin fires SERVER-side when a new row lands
  // (every lane, since 2026-09-10 — only the server knows it landed, and abuse
  // enrolments count rather than hide), optout client-side on disable. The
  // RATIO is the honest measure of the opt-out model — sustained optout > ~30%
  // of optins means the default-on call was wrong.
  'reminder_optin',
  'reminder_optout',
  // Fired by the reminder cron on each successful send (server-originated,
  // nil-UUID sentinel; metadata = provider + due-item count only) — sends
  // were invisible until the first real one (2026-08-28) surfaced the gap.
  'reminder_sent',
  'chat_opened',
  // US-34: the open page re-read the record and something had changed under it
  // (another device, or an AI connector). Name only — never what changed.
  'remote_change_applied',
  // US-21 additional blood tests: phase-1 surfacing + phase-2 manual add.
  'lab_rows_viewed',
  'lab_row_added',
  // US-22 plan-ready email. Server-originated (no browser visitor): recorded
  // with the nil-UUID sentinel, see SERVER_VISITOR_ID in product-events.server.
  'report_email_sent',
  'report_email_bounced',
  'report_email_complained',
  'report_email_clicked',
  // US-32 hosted connector. Value-free counters: which tool, which assistant,
  // whether it worked (mcp_tool_call), and one row per completed connection
  // (mcp_connect). Never a value, never an identifier, never a connection key.
  'mcp_tool_call',
  'mcp_connect',
  // US-32 AC34, the OAuth front door's own funnel. `mcp_connect` counts
  // successes only, so for two weeks a refused ChatGPT reviewer left no trace
  // anywhere we could query. These four make every exit countable: the consent
  // page rendering, a refusal on the authorize GET, the consent press, and any
  // later exit that never reaches a code. Metadata is the same closed words —
  // never a URL, a client id, a `state` or a query value.
  'mcp_authorize_shown',
  'mcp_authorize_refused',
  'mcp_consent_posted',
  'mcp_connect_failed',
  // US-35 import_documents: which route people use (Dropbox folder, a file
  // dragged into ChatGPT, or a Drive user refused), which phase, and how many
  // files as a bucket; US-36 adds the `assistant` route and US-37 the `nudge`
  // phase plus `fromNudge` on an extract. Never a file name, never a value.
  'mcp_import',
  // US-38: the open-source hub link in the tool (metadata: placement, header
  // or footer). The usage signal for the entry-point story.
  'guide_opened',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/**
 * Events only the SERVER originates (recorded under the nil-UUID sentinel —
 * see SERVER_VISITOR_ID in product-events.server.ts). The client event route
 * rejects these: a browser POST claiming one would be indistinguishable from
 * the real cron/webhook counter (adversarial review, 2026-08-30).
 */
export const SERVER_ONLY_EVENT_NAMES = [
  'reminder_optin',
  'reminder_sent',
  'report_email_sent',
  'report_email_bounced',
  'report_email_complained',
  'report_email_clicked',
  'mcp_tool_call',
  'mcp_connect',
  'mcp_authorize_shown',
  'mcp_authorize_refused',
  'mcp_consent_posted',
  'mcp_connect_failed',
  'mcp_import',
] as const satisfies readonly ProductEventName[];

/**
 * The hosted connector's tool names, as a counter may name them. They live in
 * this leaf, not in `mcp-tools.ts`: the events layer must not drag the tool
 * layer (and the whole clinical engine under it) into a server route. A test
 * in mcp-tools.test.ts asserts the two lists are the same.
 */
export const MCP_TOOL_NAMES = [
  'read_record',
  'get_plan',
  'add_measurement',
  'add_lab_values',
  'correct_value',
  'update_profile',
  'report_feedback',
  'import_documents',
  'file_results',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** The `mcp_import` counter's three closed vocabularies (US-35 usage signal). */
export const MCP_IMPORT_ROUTES = ['dropbox', 'drive_refused', 'assistant'] as const;
/** The `guide_opened` counter's surfaces (US-38): the column header, or its mobile foot. */
export const GUIDE_PLACEMENTS = ['header', 'footer'] as const;
/** `nudge`: a read found folder files not in the record and said so (US-37). */
export const MCP_IMPORT_PHASES = ['extract', 'commit', 'nudge'] as const;
export const MCP_IMPORT_FILE_BUCKETS = ['0', '1', '2-5', '6-20'] as const;
export type McpImportRoute = (typeof MCP_IMPORT_ROUTES)[number];
export type McpImportFileBucket = (typeof MCP_IMPORT_FILE_BUCKETS)[number];

/**
 * Why a refused call was refused (US-32 AC29). Closed, so a counter can never
 * become a log: no value, date, row id, unit or file name can reach it, and an
 * unrecognised word is dropped rather than passed through.
 *
 * The first eleven are the record layer's own `EditRejectionReason`, which
 * already decides them and until now threw them away. `mcp-tools.ts` holds a
 * typed rejection conversion that keeps the two in step. The rest are the tool layer's
 * and the hosted surface's own refusals. This file imports nothing, so the
 * eleven are written out rather than derived.
 */
export const MCP_REFUSAL_REASONS = [
  'unknown-metric',
  'core-metric',
  'invalid-value',
  'unknown-unit',
  'out-of-range',
  'invalid-date',
  'future-date',
  'slot-occupied',
  'not-found',
  'not-active',
  'value-changed',
  /** Arguments that did not fit the tool's schema. */
  'malformed',
  /** A correction older than the 90-day rule. */
  'too-old',
  /** The connection's hourly write allowance is spent. */
  'allowance',
  /** A two-phase confirm that was missing, early, replayed or from elsewhere. */
  'confirm',
  /** A report carrying something that reads as a health value. */
  'health-value',
  /** A report carrying an email address, a phone number or a link with a query string. */
  'contact',
  /** No record, or one this version cannot read. */
  'no-record',
  /** An import refusal, whose own reason is on the `mcp_import` row. */
  'import',
  /** Refused for a reason this vocabulary does not name yet. */
  'other',
] as const;

export type McpRefusalReason = (typeof MCP_REFUSAL_REASONS)[number];

/**
 * Why an OAuth connection ended where it did (US-32 AC34). Closed for the same
 * reason the list above is: the words a refusal knows are a `redirect_uri`, a
 * `client_id` and a `state`, and every one of them is caller-chosen text. Only
 * the NAME of the check that failed reaches a row.
 *
 * The first six are `checkAuthorize`'s own branches, which it now returns
 * rather than the route re-deriving them from an English description.
 */
export const MCP_OAUTH_REASONS = [
  /** The redirect the client asked for is not one it published, or not allow-listed. */
  'redirect-uri',
  /** Anything but `response_type=code`. */
  'response-type',
  /** PKCE missing or not S256. */
  'pkce',
  /** A `code_challenge` that is not 43–128 unreserved characters. */
  'code-challenge',
  /** A `state` longer than the cookie budget, which we bound rather than truncate. */
  'state-too-long',
  /** RFC 8707 `resource` naming a server that is not us. */
  'resource',
  /** No client document we would accept — the refusal OpenAI's reviewer met. */
  'unknown-client',
  /** The per-IP authorize brake. */
  'rate-limited',
  /** No storage provider is configured on this deployment. */
  'no-provider',
  /** The sealed state was dead, expired or absent when the user pressed Connect. */
  'state-expired',
  /** The provider the sealed state names is not offered any more. */
  'provider-unavailable',
  /** The callback arrived without the `__Host-mcp-state` cookie. */
  'no-cookie',
  /** The provider echoed a `state` that is not the nonce we minted. */
  'nonce-mismatch',
  /** The user said no at the provider, or it sent back no code. */
  'provider-denied',
  /** The provider would not trade its code for a refresh token. */
  'exchange-failed',
] as const;

export type McpOAuthReason = (typeof MCP_OAUTH_REASONS)[number];

/**
 * Which events may carry which `reason` words. The two vocabularies share one
 * `reason` column, and nothing before this said WHICH list an event draws
 * from: a tool-refusal word on an OAuth row, or the reverse, would have
 * validated and then split a query in two. The pairing is checked where the
 * row is written (`product-events.server.ts`); events absent here carry no
 * reason at all.
 */
export const EVENT_REASONS = {
  mcp_tool_call: MCP_REFUSAL_REASONS,
  mcp_authorize_refused: MCP_OAUTH_REASONS,
  mcp_connect_failed: MCP_OAUTH_REASONS,
} as const satisfies Partial<Record<ProductEventName, readonly string[]>>;

/** A word only counts if the vocabulary above names it. */
export function isRefusalReason(value: unknown): value is McpRefusalReason {
  return typeof value === 'string' && (MCP_REFUSAL_REASONS as readonly string[]).includes(value);
}

/** A file count as the counter names it: coarse enough to identify nobody. */
export function importFilesBucket(files: number): McpImportFileBucket {
  if (files <= 0) return '0';
  if (files === 1) return '1';
  return files <= 5 ? '2-5' : '6-20';
}
