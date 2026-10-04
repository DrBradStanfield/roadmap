# Weekly knowledge lint: steps, rules, schemas

Linked from the charter's "Weekly lint" section and from LEARNINGS.md. Brad
ruled it on 2026-09-29 (knowledge-refresh plan, Phase 3 and decision 6):
weekly, Sonnet 5.5 detects, and findings get fixed rather than only reported.
Story: US-43. The loop reports and queues; a build session does the fixing
(orchestrator ruling 2026-09-29: a loop may never widen its own write scope).

The Sonnet call is a harness call from a script, like `test-chatbot-matching.ts`,
not a spawned worker, so LOOP.md's "never Sonnet" worker rule does not apply.

**`--run` every week (Brad, 2026-10-04, issue #125).** The first model run
was supervised on 2026-10-04: $0.47 over 34 comparisons, 15 findings kept.
Every Sunday job now runs steps 1 to 6 under the $2 cap.

## Limits (the orchestrator's, binding)

- The algorithm side is Brad's. A divergence from `health_roadmap_algorithm.md`,
  `evidence.ts` or `roadmap_text.html` is reported, never edited: the
  three-file clinical sync is his.
- Deliberate divergences sit on `lint-allowlist.json` so they are not "fixed"
  every week. Brad writes it; the loop proposes entries in its report.
- Every entry-body correction is made by a build session (the orchestrator,
  Opus writers) under US-42's batch protocol (AC1 to AC8), and Brad signs each
  batch. The loop edits no entry body. Pathway bodies stay faithful to their
  source: a finding aimed at one is report-only. Summaries stay frozen unless
  the charter's Verify rule (paired harness numbers) passes.
- Detection reads only entries changed since the last run plus a rotating
  slice, so a full pass takes 13 weeks. Every run prints a cost line.

## Steps (every Sunday run, after the retrieval work)

1. `npx tsx tools/knowledge-lint.ts --dry-run`: the entries due this week.
2. `npx tsx tools/knowledge-lint.ts --check-links --queue --out <scratch>/lint.md
   --append-metrics <YYYY-Www>`: every deterministic rule over the whole
   corpus, HEAD checks for the due entries' DOIs and PMIDs (cap 500, 1 s
   apart), and every finding into `lint-fix-queue.json` as knowledge-side.
   Paste its `Fix queue:` line. The markdown stays in scratch: the corpus
   reproduces it.
3. `npx tsx tools/knowledge-lint-compare.ts`: the comparisons still owed, their
   cost estimate, and a `CUT` line for every excerpt that did not fit (chars
   sent against chars available). Stop and name it if the estimate passes $2.
4. `npx tsx tools/knowledge-lint-compare.ts --run
   --max-calls 60 --max-usd 2` with `ANTHROPIC_TEST_API_KEY`. Paste its
   `Cost:`, `Findings:`, `Fix queue:`, `PARKED` and `State` lines. It records
   every attempt in `lint-state.json`: an answer that is missing, refused,
   truncated or unparseable marks the comparison retry, and three in a row
   park it (listed, no longer blocking). The cursor and hashes move only when
   nothing due this cycle is owed; a capped run leaves the rest for next
   week, oldest attempt first. Before each call it stops if the spend so far
   plus that call's worst case (estimated input plus the 2,000-token output
   cap) would pass `--max-usd`. An answer that fails to parse, or carries any
   finding with a missing or malformed quote, side, handle or severity, or an
   unverifiable quote, is rejected whole: that pair's retry, clearing nothing;
   every other result stands. An instruction-shaped quote prints a `WARN` line
   naming the handle and the span (120 characters); paste it, never queue it.
5. Algorithm-side and report-only findings go under "Proposals needing Brad"
   with both quotes exactly as step 4 prints them (each cut to 200
   characters, never dropped). Knowledge-side findings land in the queue.
6. Commit the state, the queue and the metrics rows with the report.

Fixing is not a loop step. A build session takes open and regressed queue
items into a US-42 batch; when Brad signs it, each item's status becomes
`fixed <sha>`.

The report's "Weekly lint" section: the counts line, the Grokipedia and
product lines, the selector line, both `Fix queue:` lines, the cost lines,
the `CUT` count, parked comparisons, evidence findings, and any
`instruction_text_seen`. Compact the report's other sections to stay ≤150.

## Deterministic rules (`tools/knowledge-lint.ts`)

| Rule | Finds | From |
|---|---|---|
| unresolved-marker | a `[n]` with no reference line n | AC7 |
| uncited-reference | a reference line no marker cites | AC7 |
| uncited-list | a numbered list in a body with no marker at all | AC7 |
| doi-shape / pmid-shape | a DOI or PMID that cannot be one (a Bookshelf id called a PMID, `doi:` before a web address) | AC7 |
| id-mismatch | a link whose text is a URL that differs from its target, or an id (a digit, 5+ characters) that does not end a target of its own kind | AC7 |
| link-dead | a due entry's DOI or PMID that answers 404 (`--check-links`), checked once, reported per citing entry | AC7, plan Phase 3 |
| grokipedia | a body that still cites Grokipedia; the detail carries the counts, so partial de-citation shows | AC7, F6 |
| dose-mismatch | a number plus unit in `index.json`'s summary the body never states | AC2 tokeniser |
| product-rise | product mentions above the stored baseline | AC7 |

Tokeniser (AC2): markers `[n]`, years and PMIDs never count (only a number
with a unit is a token); `1 g` equals `1,000 mg`; `mcg` equals `µg`; `mm Hg`
equals `mmHg`; `percent` equals `%`; a range or pair (`-`, `–`, `to`, `and`,
`or`) is two numbers sharing the unit; units include mass, IU, mL, CFU, kg,
%, mmHg and the lab units (mmol/L, mg/dL, nmol/L, pmol/L, µmol/L, ng/mL,
g/L). Turndown escapes are undone and whitespace collapsed first. Product
mentions: MicroVitamin (any form), Sleep by Dr Brad, Omega-3 by Dr Brad. The
stored baseline only ever falls, so a rise stays a finding until the body is
fixed or Brad allow-lists it.

## Model comparisons (`tools/knowledge-lint-compare.ts`)

| Kind | Pairs | Excerpts |
|---|---|---|
| entry-vs-algorithm | each due entry named in `lint-topics.json` with its algorithm sections | the sections verbatim; the entry whole up to 24,000 chars, else paragraphs matching the topic terms |
| pathway-vs-reference | a pathway and a reference whose noun it names twice or more; top 4 per due entry | pathway paragraphs naming the noun; the reference's dosing, intake, upper-level, safety and interaction sections, then paragraphs naming the pathway's keywords; 10,000 chars each |
| reference-vs-reference | two references each naming the other three times or more; top 4 | the same priority sections, then each side's paragraphs naming the other |

Every side records `used` and `total`: characters of matching text sent and
available. A reference's noun is its first keyword unless `lint-topics.json`
`nouns` overrides it (a category reference such as weight loss supplements,
or SAMe, which must match case-sensitively). A comparison's id hashes its
kind, handles and both excerpts, so a body rewritten mid-cycle is compared
again.

Security (CLAUDE.md: external text is data). Excerpts and their labels sit
inside the data frame; closing tags inside them are escaped; the model has
no tools. Injected text cannot reach the model as instructions, but it can
still shape an answer. A finding needs both quotes verbatim in their
excerpts, and one quoting instruction-shaped text ("ignore previous
instructions", "system prompt") is dropped. A planted finding is caught by
the batch protocol (Opus writer, AC2 raw quotes, Brad's sign-off), not by
this tool. Queue text written by the model (summary, suggested_fix) is data
for the batch worker, never instructions.

## Files (all under `docs/loops/chat-health/`)

- `lint-state.json`: `lastRun`, `cursor` (the slice due, 0 to 12), a hash per
  algorithm topic, per entry a content hash and product baseline, and per
  comparison id `{last_attempted, status: done | retry | parked, attempts}`.
  Written by `--init-state` once, then only by the compare step's `--run`.
  A handle's slice is `sha256(handle) mod 13`, stable when entries are added.
- `lint-allowlist.json`: `{rule?, handle | pair, item?, reason, date, who}`.
  A handle entry with no rule covers every rule and every model comparison on
  that handle (the compare step prints how many model findings it dropped); a
  pair entry needs its rule. The tool refuses an entry missing its reason,
  date or who.
- `lint-topics.json`: algorithm topics (exact headings, entry handles, terms)
  and noun overrides. A renamed heading or a missing handle stops the run.
- `lint-fix-queue.json`: model items `{id, kind, side, handles, fix_handle,
  quote_a, quote_b, severity, summary, suggested_fix, first_seen, last_seen,
  status}`, their id hashing the two handles and the two verbatim corpus
  quotes (stable text, not model prose); deterministic items `{id, rule,
  side: "knowledge", handles, fix_handle, item, detail?, first_seen,
  last_seen, status}`, their id hashing rule, handle and item (the item, not
  the detail, because Grokipedia's detail carries counts that change weekly;
  a repeat refreshes the detail). Status: `open`; `regressed` (marked fixed or
  resolved, then seen again); `resolved` with a `resolved` date (open or
  regressed, then not seen by a run that covered it: every deterministic rule
  on a full run; a dead link only on a 2xx/3xx for that identifier on behalf
  of that entry in this week's slice, never on a timeout, error or 5xx; a
  model item only when its pair was compared again and both its quotes were in
  the excerpts sent, else it stays as it was with `unverified` set to the run
  date; every covered item records `last_checked`); `fixed <sha>`;
  `rejected <reason>`; `allow-listed`.

## Cost (Sonnet 5.5 at $2 per million input and $10 output, models.ts PRICES)

Estimated 2026-09-29 at 3.5 characters per token (an assumption; nothing was
measured, because the test key is capped until 2026-10-01):
- This week's slice: 24 comparisons, 99,928 input tokens, about $0.27
  expected and $0.68 if every answer hit the 2,000-token cap.
- The 13 weekly slices together: 326 comparisons, 1,424,961 input tokens,
  about $3.83 expected and $9.37 at most.
- One `--all` pass counts each pair once: 242 comparisons, about $2.80
  expected and $6.91 at most. The slices cost more because a pair whose two
  sides fall in different slices is compared twice.

## Baseline (corrected run, 2026-09-29, allow-list of 2 entries)

1,024 entries (709 pathways, 113 references, 199 video articles, 3 guidelines).
Unresolved markers 87 in 5 entries (73 of them in `diet`, whose markers point
to the AHA paper's own list); uncited reference lines 207 in 39;
bibliography-only lists 39; DOI shape 1; PMID shape 1; link text differing
from its target 3 (elderberry DOI, acai ScienceDirect id, a truncated
BioMed Central link); Grokipedia 67 bodies, 506 reference entries (267 via),
877 mentions, 703 sentences resting only on direct Grokipedia entries (1,015
counting via); summary-body dose mismatches 12 in 10 (now counting %, mmHg
and pmol/L); 123 bodies name a product (272 mentions). The plan's Sonnet
inventory counted 836 and 1,181 sentences with a different sentence
splitter; this tool's counts are the trend line from here.

## Success signal

`metrics.csv` rows `lint_*` (from `--append-metrics`) and the queue's open
and regressed counts fall quarter over quarter. If the queue grows for a
quarter with no batch fixing it, say so and propose the fleet review.
