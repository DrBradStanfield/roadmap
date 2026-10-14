/**
 * Test-only: the one blocklist for agent-facing approval wording (US-36, OPEN
 * 2026-10-14). ChatGPT flagged our tool text as "Tool documentation attempts to
 * prescribe classifier behavior and approval handling" (live 2026-10-12), so
 * what the model reads DESCRIBES the two-call protocol and never directs it
 * about the user's yes. It targets approval and confirmation directives only:
 * an ordinary imperative ("Do not include diagnoses") is fine. So are the
 * plan's "in your own words" ("own words" counts only as the user's or theirs),
 * the "Follow it." on the plan's `instruction` and the folder `hint`, and the
 * proposal's neutral note that a reply naming the change is clearer than "yes"
 * alone. "ask them to" counts only before answer, reply, confirm, approve or
 * say: the feedback link ("Ask them to read the title and body first") and the
 * storage hint ("ask them to try again") are not about approval.
 *
 * Run against everything a surface publishes or answers: `initialize` and
 * `tools/list` on the hosted and stdio servers, every answer the hosted-guards,
 * hosted and import suites produce, the report_feedback proposal, and,
 * statically, every `MCP_TOOLS` field, every `IMPORT_REFUSALS` value, every
 * `importHint` and the hosted INSTRUCTIONS.
 */
export const APPROVAL_DIRECTIVE =
  /(user.s|their) own (yes|words|confirmation)|verbatim|safety check|classifier|WAIT for|end your turn|before they confirm|until you confirm|Do not call before|quoted|their words|the user.s yes|only after|ask them to (answer|reply|confirm|approve|say)/i;

/**
 * The order the text states (US-36, 2026-10-14): the write follows the user's
 * reply to the preview. The import commits have no time window (US-36 AC5), so
 * these words, beside APPROVAL_MEANS ("…reply to the preview…"), are their
 * ordering guard.
 */
export const AFTER_THE_REPLY = /after (the user’s|their) reply|in their reply to the candidates/;

/** A test or suite as the runner holds it: `mode` is "skip" for a test a `-t` filter left out. */
interface RunnerTask { type: string; mode: string; tasks?: RunnerTask[] }

/**
 * True when the runner left any test in this file out, as a `-t` filter does. The suites that
 * collect every answer for the blocklist check their minimum count only on a whole-file run,
 * so a filtered run still passes (the adversary's R5, 2026-10-14).
 */
export function isPartialRun(file: RunnerTask | undefined): boolean {
  const walk = (task: RunnerTask): boolean => (task.type === 'test' ? task.mode === 'skip' : (task.tasks ?? []).some(walk));
  return !file || walk(file);
}
