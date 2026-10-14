/**
 * Test-only: the two blocklists for agent-facing approval wording (US-36, OPEN
 * 2026-10-14). ChatGPT flagged our tool text as "Tool documentation attempts to
 * prescribe classifier behavior and approval handling" (live 2026-10-12), so
 * tool DOCUMENTATION (every `tools/list` field, both INSTRUCTIONS) DESCRIBES the
 * two-call protocol and never directs the model about the user's yes. Tool
 * RESULTS (answers, refusals, hints, `next`) may direct ("show … and wait for
 * their reply"; round 2), so they are held only to the retired phrases (round
 * 4, R5). Both lists target approval wording only: an ordinary imperative ("Do
 * not include diagnoses") is fine. So are the plan's "in your own words" ("own
 * words" counts only as the user's or theirs), the "Follow it." on the plan's
 * `instruction` and the folder `hint`, and the proposal's neutral note that a
 * reply naming the change is clearer than "yes" alone. "ask them to" counts
 * only before answer, reply, confirm, approve or say: the feedback link ("Ask
 * them to read the title and body first") and the storage hint ("ask them to
 * try again") are not about approval.
 *
 * They catch the phrases on every published surface and produced answer:
 * `initialize` and `tools/list` on the hosted and stdio servers, every answer
 * the hosted-guards, hosted and import suites produce, the report_feedback
 * proposal, and, statically, every `MCP_TOOLS` field and the hosted
 * INSTRUCTIONS (documentation), every `IMPORT_REFUSALS` value and every
 * `importHint` (results). An answer no suite produces is not seen.
 */
/** The retired phrases: the user's own words or yes, verbatim, quoted, a client's safety check or classifier, and bare-yes coaching. */
const RETIRED =
  String.raw`(user.s|their) own (yes|words|confirmation)|verbatim|quoted|their words|the user.s yes|safety check|classifier|ask them to (answer|reply|confirm|approve|say)`;

/** Tool results: answers, refusals, hints and `next`. They may say what to show the user and to wait for the reply. */
export const RESULT_BLOCKLIST = new RegExp(RETIRED, 'i');

/**
 * Tool documentation: every `tools/list` field and both INSTRUCTIONS. The retired phrases, and no directive about
 * when to call or what to show. Round 5, R5: "await", "wait until", "end the turn" and "show the user" join, since
 * the stdio INSTRUCTIONS said "then show the user the candidates". A result may say all four.
 */
export const DOC_BLOCKLIST = new RegExp(
  String.raw`${RETIRED}|WAIT for|\bawait\b|wait until|end your turn|end the turn|show the user|before they confirm|until you confirm|Do not call before|only after`,
  'i',
);

/** A JSON-RPC answer's list: a `tools/call` answer is a tool result; every other method publishes documentation. */
export const blocklistFor = (method: string): RegExp => (method === 'tools/call' ? RESULT_BLOCKLIST : DOC_BLOCKLIST);

/**
 * The order the text states (US-36, 2026-10-14): the write follows the user's
 * reply to the preview. The import commits have no time window (US-36 AC5), so
 * these words, beside APPROVAL_MEANS ("…reply to the preview…"), are their
 * ordering guard. Case-blind, so the extract's continuation line ("After the
 * user’s reply, this receipt’s commit comes first") counts too.
 */
export const AFTER_THE_REPLY = /after (the user’s|their) reply|in their reply to the candidates/i;

/** A test or suite as the runner holds it: `suite` is the parent, absent at the top of the file. */
interface RunnerTask { type: string; name: string; suite?: RunnerTask; tasks?: RunnerTask[] }

/**
 * The `-t` pattern of this run, which vitest keeps in the worker's state (checked on 4.1.11): a RegExp or a
 * string. Null for a whole run, and for any other shape, so a pattern this cannot read runs the count floor,
 * which fails loudly on a filtered run rather than passing silently.
 */
function namePattern(): RegExp | string | null {
  const pattern = (globalThis as { __vitest_worker__?: { config?: { testNamePattern?: unknown } } }).__vitest_worker__?.config?.testNamePattern;
  return typeof pattern === 'string' || pattern instanceof RegExp ? pattern : null;
}

/**
 * True when a `-t` filter left any test in this file out. The suites that collect every answer for the blocklist
 * check their minimum count only on a whole-file run, so a filtered run still passes (the adversary's R5,
 * 2026-10-14). It reads the filter, not each test's mode: a test parked with `it.skip` or `skipIf` has the same
 * "skip" mode as one the filter left out, and would otherwise switch the count off on every run (R6, round 2).
 * A test's full name is its suites' names and its own, joined by spaces, as the runner matches it. `pattern`
 * defaults to the live run's; pass `null` for "no filter", which a caller must say explicitly, since an omitted
 * argument reads the live pattern (round 3, R5). A run narrowed by line number or `.only` is not seen here, and
 * need not be: the count test is outside that narrowing too, so the runner skips it and never asks.
 */
export function isPartialRun(file: RunnerTask | undefined, pattern: RegExp | string | null = namePattern()): boolean {
  if (!file) return true;
  if (pattern == null) return false;
  const filter = new RegExp(pattern);
  const fullName = (task: RunnerTask): string => (task.suite ? `${fullName(task.suite)} ` : '') + task.name;
  const walk = (task: RunnerTask): boolean => (task.type === 'test' ? !filter.test(fullName(task)) : (task.tasks ?? []).some(walk));
  return walk(file);
}
