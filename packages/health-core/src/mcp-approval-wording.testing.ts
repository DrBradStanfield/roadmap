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
 * It catches the retired phrases on every published surface and produced
 * answer: `initialize` and `tools/list` on the hosted and stdio servers, every
 * answer the hosted-guards, hosted and import suites produce, the
 * report_feedback proposal, and, statically, every `MCP_TOOLS` field, every
 * `IMPORT_REFUSALS` value, every `importHint` and the hosted INSTRUCTIONS. An
 * answer no suite produces is not seen. Tool results may still say what to
 * show the user (round 2, 2026-10-14): the warning fires on tool
 * documentation, read before any call.
 */
export const APPROVAL_DIRECTIVE =
  /(user.s|their) own (yes|words|confirmation)|verbatim|safety check|classifier|WAIT for|end your turn|before they confirm|until you confirm|Do not call before|quoted|their words|the user.s yes|only after|ask them to (answer|reply|confirm|approve|say)/i;

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

/** The `-t` pattern of this run, which vitest keeps in the worker's state (checked on 4.1.11); undefined for a whole run. */
function namePattern(): RegExp | undefined {
  const pattern = (globalThis as { __vitest_worker__?: { config?: { testNamePattern?: RegExp | string } } }).__vitest_worker__?.config?.testNamePattern;
  return pattern === undefined ? undefined : new RegExp(pattern);
}

/**
 * True when a `-t` filter left any test in this file out. The suites that collect every answer for the blocklist
 * check their minimum count only on a whole-file run, so a filtered run still passes (the adversary's R5,
 * 2026-10-14). It reads the filter, not each test's mode: a test parked with `it.skip` or `skipIf` has the same
 * "skip" mode as one the filter left out, and would otherwise switch the count off on every run (R6, round 2).
 * A test's full name is its suites' names and its own, joined by spaces, as the runner matches it. A run narrowed
 * by line number or `.only` is not seen here; the count then fails, loudly, rather than passing silently.
 */
export function isPartialRun(file: RunnerTask | undefined, pattern = namePattern()): boolean {
  if (!file) return true;
  if (!pattern) return false;
  const fullName = (task: RunnerTask): string => (task.suite ? `${fullName(task.suite)} ` : '') + task.name;
  const walk = (task: RunnerTask): boolean => (task.type === 'test' ? !pattern.test(fullName(task)) : (task.tasks ?? []).some(walk));
  return walk(file);
}
