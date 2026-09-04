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
  // US-35 import_documents: which route people use (Dropbox folder, a file
  // dragged into ChatGPT, or a Drive user refused), which phase, and how many
  // files as a bucket. Never a file name, never a value.
  'mcp_import',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/**
 * Events only the SERVER originates (recorded under the nil-UUID sentinel —
 * see SERVER_VISITOR_ID in product-events.server.ts). The client event route
 * rejects these: a browser POST claiming one would be indistinguishable from
 * the real cron/webhook counter (adversarial review, 2026-08-30).
 */
export const SERVER_ONLY_EVENT_NAMES = [
  'reminder_sent',
  'report_email_sent',
  'report_email_bounced',
  'report_email_complained',
  'report_email_clicked',
  'mcp_tool_call',
  'mcp_connect',
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
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** The `mcp_import` counter's three closed vocabularies (US-35 usage signal). */
export const MCP_IMPORT_ROUTES = ['dropbox', 'chatgpt_file', 'drive_refused'] as const;
export const MCP_IMPORT_PHASES = ['extract', 'commit'] as const;
export const MCP_IMPORT_FILE_BUCKETS = ['0', '1', '2-5', '6-20'] as const;
export type McpImportRoute = (typeof MCP_IMPORT_ROUTES)[number];
export type McpImportFileBucket = (typeof MCP_IMPORT_FILE_BUCKETS)[number];

/** A file count as the counter names it: coarse enough to identify nobody. */
export function importFilesBucket(files: number): McpImportFileBucket {
  if (files <= 0) return '0';
  if (files === 1) return '1';
  return files <= 5 ? '2-5' : '6-20';
}
