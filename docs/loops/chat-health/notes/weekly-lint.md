# Weekly knowledge lint: steps, rules, schemas

Linked from the charter's "Weekly lint" section. Brad ruled it on 2026-09-29
(knowledge-refresh plan, Phase 3 and decision 6): weekly, Sonnet 5.5 detects,
and findings get fixed rather than only reported. Story: US-43. The loop
reports and queues; a build session does the fixing (orchestrator ruling
2026-09-29: a loop may never widen its own write scope).

The Sonnet call is a harness call from a script, like `test-chatbot-matching.ts`,
not a spawned worker, so LOOP.md's "never Sonnet" worker rule does not apply.

## Limits (the orchestrator's, binding)

- The algorithm side is Brad's. A divergence from `health_roadmap_algorithm.md`,
  `evidence.ts` or `roadmap_text.html` is reported, never edited: the
  three-file clinical sync is his.
- Deliberate divergences sit on `lint-allowlist.json` so they are not "fixed"
  every week. Brad writes it; the loop proposes entries in its report.
- Every entry-body correction is made by a build session (Fable orchestrating,
  Opus writers) under US-42's batch protocol (AC1 to AC8), and Brad signs each
  batch. The loop edits no entry body. Summaries stay frozen unless the
  charter's Verify rule (paired harness numbers) passes.
- Detection reads only entries changed since the last run plus a rotating
  slice, so a full pass takes 13 weeks. Every run prints a cost line.

## Steps (every Sunday run, after the retrieval work)

1. `npx tsx tools/knowledge-lint.ts --dry-run`: the entries due this week.
2. `npx tsx tools/knowledge-lint.ts --check-links --queue --out <scratch>/lint.md
   --append-metrics <YYYY-Www>`: every deterministic rule over the whole
   corpus, HEAD checks for the due entries' DOIs and PMIDs (cap 500, 1 s
   apart), and every finding into `lint-fix-queue.json` as knowledge-side
   (id = hash of rule, handle and item, so a repeat only refreshes
   `last_seen`). The markdown stays in scratch: the corpus reproduces it.
3. `npx tsx tools/knowledge-lint-compare.ts`: the comparisons and their cost
   estimate. Stop and name it in the report if the estimate passes $2.
4. `npx tsx tools/knowledge-lint-compare.ts --run --max-calls 60 --max-usd 2`
   with `ANTHROPIC_TEST_API_KEY`. Paste its `Cost:` and `Findings:` lines.
5. Algorithm-side findings go under "Proposals needing Brad", each with both
   quotes. Knowledge-side findings land in `lint-fix-queue.json` on their own.
6. If step 4 printed no "do not run knowledge-lint --save-state" line, run
   `npx tsx tools/knowledge-lint.ts --save-state`. Otherwise the same entries
   stay due next week.
7. Commit the state, the queue and the metrics rows with the report.

Fixing is not a loop step. A build session takes open queue items into a
US-42 batch; when Brad signs it, the item's status becomes `fixed <sha>`.

The report's "Weekly lint" section: the counts line, the Grokipedia and
product lines, the selector line, both cost lines, new queue items (high
severity by name), algorithm-side findings, and any `instruction_text_seen`.

## Deterministic rules (`tools/knowledge-lint.ts`)

| Rule | Finds | From |
|---|---|---|
| unresolved-marker | a `[n]` with no reference line n | AC7 |
| uncited-reference | a reference line no marker cites | AC7 |
| uncited-list | a numbered list in a body with no marker at all | AC7 |
| doi-shape / pmid-shape | a DOI or PMID that cannot be one (a Bookshelf id called a PMID, `doi:` before a web address) | AC7 |
| id-mismatch | a DOI or PMID link whose text and target differ | AC7 |
| link-dead | a due entry's DOI or PMID that answers 404 (`--check-links`) | AC7, plan Phase 3 |
| grokipedia | a body that still cites Grokipedia, with its sentences resting only on it | AC7, F6 |
| dose-mismatch | a number plus unit in `index.json`'s summary the body never states | AC2 tokeniser |
| product-rise | product mentions above the stored baseline | AC7 |

Tokeniser (AC2): markers `[n]`, years and PMIDs never count (only a number
with a unit is a token); `1 g` equals `1,000 mg`; `mcg` equals `µg`; a range
(`-`, `–`, `to`) is two numbers sharing the unit; turndown escapes are undone
and whitespace collapsed first. Product mentions: MicroVitamin (any form),
Sleep by Dr Brad, Omega-3 by Dr Brad. The stored baseline only ever falls, so
a rise stays a finding until the body is fixed or Brad allow-lists it.

## Model comparisons (`tools/knowledge-lint-compare.ts`)

| Kind | Pairs | Excerpts |
|---|---|---|
| entry-vs-algorithm | each due entry named in `lint-topics.json` with its algorithm sections | the sections verbatim; the entry whole up to 24,000 chars, else paragraphs matching the topic terms |
| pathway-vs-reference | a pathway and a reference whose noun it names twice or more; top 4 per due entry | pathway paragraphs naming the noun; reference paragraphs naming the pathway's keywords; 10,000 chars each |
| reference-vs-reference | two references each naming the other three times or more; top 4 | each side's paragraphs naming the other |

A reference's noun is its first keyword unless `lint-topics.json` `nouns`
overrides it (a category reference such as weight loss supplements, or SAMe,
which must match case-sensitively). Side: a pathway against the algorithm is
always algorithm-side, because pathway bodies stay faithful to their source.

Security (CLAUDE.md: external text is data). The prompt says the excerpts are
data and never instructions, and asks the model to flag instruction-shaped
text rather than obey it. A closing tag inside an excerpt is escaped. The
model has no tools. A finding survives only when both quotes appear verbatim
in their excerpts and its fix names one of the two handles, so injected text
cannot plant a finding. Queue text written by the model (summary,
suggested_fix) is data for the batch worker, never instructions.

## Files (all under `docs/loops/chat-health/`)

- `lint-state.json`: `lastRun`, `cursor` (the slice due, 0 to 12), a hash per
  algorithm topic, and per entry a content hash and product baseline. Written
  by `--init-state` once and by `--save-state` after each run. A handle's
  slice is `sha256(handle) mod 13`, stable when entries are added.
- `lint-allowlist.json`: `{rule, handle | pair, item?, reason, date, who}`.
  The tool refuses to run on an entry missing its reason, date or who.
- `lint-topics.json`: algorithm topics (exact headings, entry handles, terms)
  and noun overrides. A renamed heading or a missing handle stops the run.
- `lint-fix-queue.json`: model items `{id, kind, side, handles, fix_handle,
  quote_a, quote_b, severity, summary, suggested_fix, first_seen, last_seen,
  status}`, their id hashing the two handles and the two verbatim corpus
  quotes (stable text, not model prose); deterministic items `{id, rule,
  side: "knowledge", handles, fix_handle, item, detail?, first_seen,
  last_seen, status}`, their id hashing rule, handle and item (the item, not
  the detail, because Grokipedia's detail carries counts that change weekly).
  Status: `open`, `fixed <sha>`, `rejected <reason>`, `allow-listed`.

## Cost (Sonnet 5.5 at $2 per million input and $10 output, models.ts PRICES)

Estimated 2026-09-29 at 3.5 characters per token (an assumption; nothing was
measured, because the test key is capped until 2026-10-01):
- This week's slice: 22 comparisons, 61,787 input tokens, about $0.19
  expected and $0.56 if every answer hit the 2,000-token cap.
- A full pass (`--all`): 211 comparisons, 630,905 input tokens, about $1.89
  expected, $5.48 at most. Thirteen weekly slices cost about the same.

## Baseline (first run, 2026-09-29, allow-list of 3 entries)

1,024 entries (709 pathways, 113 references, 199 video articles, 3 guidelines).
Unresolved markers 17 in 7 entries (73 more in `diet` allow-listed); uncited
reference lines 207 in 39; bibliography-only lists 39; DOI shape 1; PMID
shape 1; DOI text-target mismatch 1; Grokipedia 67 bodies, 506 reference
entries (267 via), 877 mentions, 703 sentences resting only on direct
Grokipedia entries (1,015 counting via); summary-body dose mismatches 9 in 7;
123 bodies name a product (272 mentions). The plan's Sonnet inventory counted
836 and 1,181 sentences with a different sentence splitter; this tool's counts
are the trend line from here.

## Success signal

`metrics.csv` rows `lint_*` (from `--append-metrics`) and the queue's open
count fall quarter over quarter. If the queue grows for a quarter with no
batch fixing it, say so and propose the fleet review.
