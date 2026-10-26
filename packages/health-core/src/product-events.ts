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
  // US-12 AC10: one per upload run, how many files ended each way. Metadata is
  // the UPLOAD_OUTCOME_KEYS counts below and nothing else: never a file name.
  'upload_outcome',
  'cloud_connect_started',
  'cloud_connect_success',
  'cloud_connect_refused',
  // US-09 AC22: Cancel or Deny at Google or Dropbox (`error=access_denied`).
  // Metadata `{ provider }` only.
  'cloud_connect_cancelled',
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
  // US-15 AC17: the "Show how I approached this" toggle was opened. Name only,
  // fired once per answer (the client throttle then keeps one per tab session).
  'chat_thinking_opened',
  // US-49: a logged-in customer confirmed a subscription change card in the
  // chat and the store accepted it. Recorded by the server's confirm route
  // (SERVER_ONLY), so it counts on every bundle that shows the card. Name
  // only: never the action, the subscription or the customer.
  'subscription_action_confirmed',
  // US-34: the open page re-read the record and something had changed under it
  // (another tab, another device, or an AI connector). Metadata: `backend`
  // only, `local` (another tab of this browser) or `cloud` — never what changed.
  'remote_change_applied',
  // US-21 additional blood tests: phase-1 surfacing + phase-2 manual add.
  'lab_rows_viewed',
  'lab_row_added',
  // US-21 phase 3: a lab row was refused for its unit, so nothing was written.
  // Metadata is the catalogue KEY and the unit spelling — never the value.
  'lab_unit_refused',
  // US-35 AC17: a core blood test value was refused at the upload save, so
  // nothing was written. Metadata is a MEASUREMENT_REFUSAL_REASONS word, plus
  // the METRIC_TYPES id only where MEASUREMENT_REFUSALS_WITH_METRIC allows it —
  // never the value, never a printed name.
  // Not `lab_unit_refused`: that counter lists spellings to teach the catalogue.
  'measurement_refused',
  // US-22 plan-ready email. Server-originated (no browser visitor): recorded
  // with the nil-UUID sentinel, see SERVER_VISITOR_ID in product-events.server.
  'report_email_sent',
  'report_email_bounced',
  'report_email_complained',
  'report_email_clicked',
  // US-23 AC10: a reminder email's button, counted apart from the plan-ready
  // one by the same server redirect. Server-originated, no metadata.
  'reminder_email_clicked',
  // US-22 AC13: a guest arrived from an email and this browser held no plan,
  // so the landing notice showed. Name only. Recovery is the same visitor then
  // firing results_viewed or cloud_connect_success.
  'email_landing_empty',
  // US-22 AC14: on that notice, the reader pressed Copy link to open the tool
  // in the browser that holds the plan. Name only; the recovery happens under
  // another visitor id, so this counts intent, never success.
  'email_landing_link_copied',
  // US-18 AC6: the browser refused the save-as-PDF window (window.open gave
  // null, as mail and social apps' own browsers often do). Name only.
  'pdf_window_blocked',
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
  // US-05 AC2: the Lp(a) field's unit was changed. Metadata is the two unit
  // labels, `{ unit, from }` (LPA_UNITS) — never the value in the field.
  'lpa_unit_selected',
  // US-05 AC3: the Lp(a) check was answered, sent once the answer took effect.
  // Metadata `{ answer }`, one of LPA_CHECK_ANSWERS, never a value.
  'lpa_check_answered',
  // US-15 AC33: the chat ran the plan code on values stated in the message
  // (run_roadmap). Server-originated. Metadata `{ count, rejected }`: how many
  // stated values the plan used and how many it refused. Never a value or a field.
  'chat_run_roadmap',
  // US-16 AC2: the chat proposed saving a sex or height, and the user saw,
  // saved or declined it. Metadata `{ field, choice }` (CHAT_PROFILE_FIELDS,
  // CHAT_PROFILE_CHOICES): the field's name, never its value.
  'chat_profile_edit',
] as const;

/** The `chat_profile_edit` counter's words (US-16 AC2): which profile field, and what the user did. */
export const CHAT_PROFILE_FIELDS = ['sex', 'heightCm'] as const;
export const CHAT_PROFILE_CHOICES = ['shown', 'saved', 'declined'] as const;

/** US-35 AC17: why the record refused a core value. `MeasurementRefusal.reason`
 *  (record-edits.ts) is typed from this list, so the two cannot drift. */
export const MEASUREMENT_REFUSAL_REASONS = ['unknown-metric', 'invalid-value', 'out-of-range'] as const;

/** The one reason `measurement_refused` may name its metric for (Brad,
 *  2026-10-20). An `out-of-range` row with a metric would tell analytics that
 *  this visitor's value for that test is past a clinical bound, and an
 *  unknown metric's name is free text. */
export const MEASUREMENT_REFUSALS_WITH_METRIC: readonly (typeof MEASUREMENT_REFUSAL_REASONS)[number][] = ['invalid-value'];

/** US-05 AC3: the Lp(a) check's answers. The report's unit, when the answer
 *  wrote a correction, or `keep`: the report matches neither number, or its
 *  correction would save the value already stored. */
export const LPA_CHECK_ANSWERS = ['mg/dL', 'nmol/L', 'mg/L', 'keep'] as const;

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
  'reminder_email_clicked',
  'mcp_tool_call',
  'mcp_connect',
  'mcp_authorize_shown',
  'mcp_authorize_refused',
  'mcp_consent_posted',
  'mcp_connect_failed',
  'mcp_import',
  'chat_run_roadmap',
  'subscription_action_confirmed',
] as const satisfies readonly ProductEventName[];

/**
 * Events the browser sends on every occurrence, not once per tab: each one is
 * a distinct user action whose count is the signal (US-12 AC10, one per upload
 * run). The events route's per-visitor and per-IP limits still bound them.
 */
export const PER_ACTION_EVENT_NAMES = ['upload_outcome'] as const satisfies readonly ProductEventName[];

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

/** The hosted server's knowledge tools (US-41 AC12), counted only while their switch is on. Not in `MCP_TOOLS`. */
export const MCP_KNOWLEDGE_TOOL_NAMES = ['search_knowledge', 'get_article'] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number] | (typeof MCP_KNOWLEDGE_TOOL_NAMES)[number];

/** The `mcp_import` counter's three closed vocabularies (US-35 usage signal). */
export const MCP_IMPORT_ROUTES = ['dropbox', 'drive_refused', 'assistant'] as const;
/** The `guide_opened` counter's surfaces (US-38): the column header, or its mobile foot. */
export const GUIDE_PLACEMENTS = ['header', 'footer'] as const;
/** The `upload_outcome` counter's integer counts (US-12 AC10): files seen, then
 *  how each ended. `truncated` overlaps the rest and `valuesDropped` counts value
 *  rows the parse refused, not files; the others sum to `picked`. `refused` and
 *  `tooLong` are files Claude declined or stopped short on (US-15 AC34). `docx`
 *  counts the picked .docx files, a kind that overlaps the rest; `picturesOnly`
 *  is a .docx of pictures and no text (US-12 AC13). `undatedPrevious` counts
 *  value rows read from an undated previous column, not files (AC14).
 *  `unitsGuessed` counts values whose unit was guessed (AC16) and `unitsRefused`
 *  creatinine rows refused rather than guessed (AC15): values, not files. */
export const UPLOAD_OUTCOME_KEYS = ['picked', 'withValues', 'documentOnly', 'noValues', 'openFailed', 'tooLarge', 'truncated', 'serverError', 'limitError', 'refused', 'tooLong', 'valuesDropped', 'docx', 'picturesOnly', 'undatedPrevious', 'unitsGuessed', 'unitsRefused'] as const;
export type UploadOutcomeKey = (typeof UPLOAD_OUTCOME_KEYS)[number];
/** The most one count may say; the server refuses more, so the client clamps. */
export const UPLOAD_OUTCOME_MAX = 1000;
/** The `remote_change_applied` counter's tiers (US-34): another tab, or a cloud. */
export const REMOTE_CHANGE_BACKENDS = ['local', 'cloud'] as const;
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
  // `/token` answers `invalid_grant` on every dead grant, deliberately: a
  // specific error tells an attacker which check they failed. The COUNTER may
  // say, because nobody outside reads it — these are the words for the last
  // door, where a connection that got a code still never becomes a token.
  // One word for both malformed bodies on purpose: neither has a grant to name,
  // and the pair below shares `token-client` the same way, across both grants.
  /** The body was not form-encoded, or was over the 64 KB cap. */
  'token-bad-request',
  /** Neither `authorization_code` nor `refresh_token`. */
  'token-grant-type',
  /** The authorization code was dead, expired or tampered with. */
  'token-dead-code',
  /** A grant redeemed by a client that is not the one it was minted for. */
  'token-client',
  /** The `redirect_uri` does not match the one the code was minted with. */
  'token-redirect',
  /** The `code_verifier` does not answer the PKCE challenge. */
  'token-pkce',
  /** A code redeemed twice — on this machine, which is all stateless can see. */
  'token-replayed',
  /** The refresh token was dead, expired or tampered with. */
  'token-dead-refresh',
  // US-32 AC38, OpenAI's reviewer sign-in on our own consent page.
  /** A wrong reviewer username or password. */
  'reviewer-credentials',
  /** A reviewer sign-in refused by the failures-only limiter. */
  'reviewer-rate-limited',
  /** A reviewer grant whose secrets were unset or rotated since it was minted. */
  'reviewer-generation',
] as const;

export type McpOAuthReason = (typeof MCP_OAUTH_REASONS)[number];

/**
 * Which branch of a refusal fired (US-32 AC48): one closed word per reason,
 * named only where the code already knows the branch. Three organic refusals
 * in 2026-10 could not be diagnosed from `reason` alone. Never a URL, host,
 * client id or any other caller-chosen text.
 */
export const MCP_OAUTH_DETAILS = {
  /** `resource` names another host, or this host with another path. */
  resource: ['other-host', 'other-path'],
  /** No `redirect_uri`; a host none of the client's redirects uses; or a
   *  known host differing in anything else, loopback when the registered
   *  redirect on that host is a loopback one. */
  'redirect-uri': ['missing', 'unknown-host', 'known-host-other-path', 'loopback-other-path'],
  /** Neither a DCR id nor an https URL; a DCR id that fails its HMAC or
   *  metadata; a CIMD URL refused before fetching; a fetch that failed; a
   *  document that is not ours to accept; one whose redirects we refuse. */
  'unknown-client': ['malformed', 'dcr-invalid', 'cimd-refused-url', 'cimd-fetch-failed', 'cimd-invalid', 'cimd-redirect-refused'],
  /** Nothing was sent, or what was sent would not unseal (expired or tampered). */
  'no-cookie': ['missing', 'unseal-failed'],
  'token-dead-code': ['missing', 'unseal-failed'],
  'token-dead-refresh': ['missing', 'unseal-failed'],
} as const satisfies Partial<Record<McpOAuthReason, readonly string[]>>;

export type McpOAuthDetail<R extends keyof typeof MCP_OAUTH_DETAILS = keyof typeof MCP_OAUTH_DETAILS> =
  (typeof MCP_OAUTH_DETAILS)[R][number];

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

/**
 * The two words a `lab_unit_refused` row may carry (US-21 phase 3), checked
 * where the row is written. A catalogue key is a lower-case word; a unit is a
 * short printed spelling, and it must not BE or HOLD a value. Both halves of
 * the check fail closed (US-21 AC11).
 *
 * Digits are structural. The only digits are ASCII and the superscripts (no
 * "１４１", "Ⅴ" or "½"), and once the few constructions units are spelled with
 * are cut out, no digit may remain. Those are a power of ten (10^9, 10E9,
 * 10*3, ×10⁹, 10(3), 10^(9)), eGFR's /1.73 m², a cubic millimetre (mm3, mm³), /100 WBC and
 * /24h. A number units use is no licence elsewhere: "10 mmol/L", "6%",
 * "mmol/L12", "3·6 mmol/L" and "¹⁴¹ mmol/L" are refused. A power of ten takes
 * only the exponents units use (3, 4, 5, 6, 9, 12), so "x10^47/L" is refused
 * too, and a "*" left once 10*3 is cut is a flag, not a unit.
 *
 * Words are an allowlist of unit atoms, because a result is a value too
 * ("mmol/L H" on a potassium row says it was high; "Reactive" is the result)
 * and no list of flag words in every language is ever complete. Once the
 * constructions are cut, every run of letters, in any case, must be one of
 * UNIT_ATOMS, and the unit must hold at least one atom, a '%' or a
 * construction. A letter standing alone as a token (split on spaces, brackets
 * and , ; : . - * ! ? ·) is refused even when it is an atom: "mmol/L L" and
 * "mmol/L-H" are flags, while "U/L" and "g/dL" are one token each. So is a
 * token made only of dashes ("-", "mmol/L --"). "Unit(s)" reads as "Units".
 * Anything else is dropped rather than stored: a counter must never become a
 * log of somebody's results.
 */
const LAB_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const LAB_UNIT_PATTERN = /^[\p{L}0-9⁰¹²³⁴⁵⁶⁷⁸⁹⁻µ×°%^*/().·\- ]{1,24}$/u;
const UNIT_CONSTRUCTIONS = /10(?:[\^*eE][+-]?(?:12|[34569])(?!\d)|[\^*]?\((?:12|[34569])\)|⁻?(?:¹²|[³⁴⁵⁶⁹])(?![⁰¹²³⁴⁵⁶⁷⁸⁹]))|\/1\.73(?: ?m[2²])?|mm[3³]|\/100|\/24 ?h/g;
/** The same cut for the word checks, taking the "x" of "x10^9" with it. */
const MULTIPLIED_CONSTRUCTIONS = new RegExp(`[xX×]?(?:${UNIT_CONSTRUCTIONS.source})`, 'g');

/** Every word a unit may be built of, lower case. Gathered from the catalogue
 *  and UNIT_DEFS spellings (a test holds them to it) and the count, time and
 *  pressure words labs print in English, Polish, German, Spanish, Portuguese
 *  and French. Never a flag or a result word. */
const UNIT_ATOMS = new Set([
  // Amount, mass, volume, equivalents, katals, osmoles.
  'mol', 'mmol', 'µmol', 'umol', 'nmol', 'pmol', 'fmol',
  'g', 'gm', 'kg', 'mg', 'µg', 'ug', 'mcg', 'ng', 'pg', 'fg',
  'l', 'dl', 'ml', 'µl', 'ul', 'mcl', 'fl', 'nl',
  'eq', 'meq', 'kat', 'ukat', 'µkat', 'nkat', 'osm', 'mosm', 'osmol', 'mosmol',
  // Enzyme and international units, English and Romance spellings.
  'u', 'iu', 'miu', 'µiu', 'uiu', 'microiu', 'mciu', 'kiu', 'ku', 'mu', 'µu', 'uu', 'ui', 'mui', 'µui', 'au', 'unit', 'units',
  // Counts and what is counted.
  'cells', 'cell', 'cel', 'células', 'celulas', 'cellules', 'komórek', 'komorek', 'zellen', 'leu', 'wbc', 'rbc', 'lymphs',
  'tys', 'mln', 'mio', 'tsd', 'thou', 'thousand', 'million', 'mil', 'k', 'giga', 'tera', 't', 'gpt', 'tpt',
  'cumm', 'cmm', 'cu', 'c', 'mm', 'hpf', 'lpf', 'feu', 'ddu',
  'ratio', 'index', 'fraction', 'titre', 'titer',
  // What a ratio is per: "mg/g creat" (US-21 AC17).
  'creat', 'creatinine',
  // Time, pressure, length and weight.
  'min', 'sec', 'seg', 's', 'h', 'hr', 'hrs', 'hour', 'hours', 'day', 'd',
  'mmhg', 'kpa', 'pa', 'm', 'cm', 'in', 'ft', 'lb', 'lbs',
]);

export function isLabUnitWord(value: unknown): value is string {
  if (typeof value !== 'string' || !LAB_UNIT_PATTERN.test(value)) return false;
  if (/[0-9⁰¹²³⁴⁵⁶⁷⁸⁹*]/.test(value.replace(UNIT_CONSTRUCTIONS, ' '))) return false;
  // '#' marks a cut construction; LAB_UNIT_PATTERN lets none in. "/24 h" keeps
  // its h, so "g/24hr" reads as g # hr.
  const words = value.replace(/(\p{L})\(s\)/gu, '$1s').replace(MULTIPLIED_CONSTRUCTIONS, (cut) => (cut.endsWith('h') ? '#h' : '#'));
  const runs = words.match(/\p{L}+/gu) ?? [];
  return runs.every((run) => UNIT_ATOMS.has(run.toLowerCase().replace(/μ/g, 'µ')))
    && !words.split(/[\s()]+/).some((token) => /^[-+]|[-+]$/.test(token))
    && !words.split(/[\s(),;:.\-+*!?·]+/).some((token) => /^\p{L}$/u.test(token))
    && (runs.length > 0 || /[%#]/.test(words));
}

/** The `unit` a `lab_unit_refused` row carries when none was printed (US-21
 *  AC22): a closed word, so a blank reads apart from a spelling the check
 *  above refused, which the row leaves out. */
export const LAB_UNIT_BLANK = '(blank)';

/** The unit a `lab_unit_refused` row carries: the spelling when it is a unit
 *  word, LAB_UNIT_BLANK when none was printed, else none. */
export function labUnitForEvent(unit: unknown): string | undefined {
  if (unit == null || (typeof unit === 'string' && !unit.trim())) return LAB_UNIT_BLANK;
  return isLabUnitWord(unit) ? unit : undefined;
}

export function isLabKeyWord(value: unknown): value is string {
  return typeof value === 'string' && LAB_KEY_PATTERN.test(value);
}

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
