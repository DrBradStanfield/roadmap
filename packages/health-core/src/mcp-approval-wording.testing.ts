/**
 * Test-only: the one blocklist for agent-facing approval wording (US-36, OPEN
 * 2026-10-14). ChatGPT flagged our tool text as "Tool documentation attempts to
 * prescribe classifier behavior and approval handling" (live 2026-10-12), so
 * what the model reads DESCRIBES the two-call protocol and never directs it
 * about the user's yes. It targets approval and confirmation directives only:
 * an ordinary imperative ("Do not include diagnoses") is fine. So are the
 * plan's "in your own words" ("own words" counts only as the user's or theirs)
 * and the "Follow it." on the plan's `instruction` and the folder `hint`.
 *
 * Run against everything a surface publishes or answers: `initialize` and
 * `tools/list` on the hosted and stdio servers, every answer the hosted-guards,
 * hosted and import suites produce, and the report_feedback proposal.
 */
export const APPROVAL_DIRECTIVE =
  /(user.s|their) own (yes|words|confirmation)|verbatim|bare .?yes|safety check|classifier|WAIT for|end your turn|before they confirm|until you confirm|Do not call before/i;
