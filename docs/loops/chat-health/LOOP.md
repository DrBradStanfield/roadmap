# Chat-health loop — charter (chatbot retrieval quality)

Inherits everything in [../LOOP.md](../LOOP.md) (the constitution) — read it
FIRST; this file holds only this loop's deltas. Schedule: Sundays ~10:23am NZ
(cron `23 22 * * 6` UTC — the fleet runs at the weekend so its plan usage
falls outside Brad's working week; Brad ruling 2026-08-12). Registry: [../REGISTRY.md](../REGISTRY.md).
Sibling: [product-health](../product-health/LOOP.md) covers how people *use the tool*;
you cover one thing only — **does the chatbot retrieve the right knowledge, and answer
well from it.** Read its latest report for context, then stay in your lane.

## Mission

Make chatbot retrieval measurably better every run, and never worse: find
real failures in production traffic, fix the ones that are safely fixable,
prove each fix with the harness, and record what you learned so the next run
starts smarter.

## Success signal (what proves this loop earns its cost)

Router match-rate improvements with before/after harness numbers, and a
falling classifier-catchable share of empty-handle turns run over run (the
headline metric). If fixes stop landing or reports go unacted for a quarter,
say so in the retro and propose the fleet review.

## The one rule that governs everything here

**Measure before, measure after, revert on regression.** On 2026-08-07 a
session rewrote 52 pathway summaries — twice, in two different styles, both
well-executed, both "obviously right" — and scored **93.8%** against the
originals' **96.3%**; a third arm appending curated `keywords` to the index
scored **88.9%** at 2.3× the tokens. No content or prompt change ships from
this loop on reasoning alone: if you cannot measure it, you propose it.

## Ground truth (established by measurement — challenge only with evidence)

1. **The router sees ONE string per entry: `[type] handle: summary`.** The
   `keywords` frontmatter is read by nothing at runtime. Discoverability =
   editing the **summary**. (Verified: an `ncah` keyword fix changed no
   behaviour at all.)
2. **Summaries truncate at 150 chars** (`ROUTER_SUMMARY_MAX_CHARS` in
   `chat-router.server.ts`). Anything past that is invisible to the router.
3. **Longer is not better.** 150 → 96.3%; 250 → 92.6%; uncapped 269 → 92.6%.
4. **Blanket rewrites lose; targeted fixes win.** The auto-derived originals
   beat every hand-rewrite, but fixing *individual entries with an identified
   failure* took the supplement category 81.3% → 100%. Fix what's provably
   broken; leave the rest alone.
5. **Format uniformity matters.** 83% of pathway summaries open "Clinical
   pathway for…"; rewriting a subset in a different voice made those entries
   *harder* to find. Change style everywhere or nowhere.
6. **The classifier and router stay serial.** The classifier decides whether
   the router fires; run concurrently, the router fires every turn and the
   saving is gone (`chat-architecture.md` § "Do not re-parallelise").

## Orient (read yourself, not via workers)

1. This charter + `LEARNINGS.md` + `metrics.csv` here.
2. The two most recent reports in this folder.
3. `docs/chat-overview.html` "Current state at a glance" (claude_business):
   build sessions only; from the cloud runner it is a standing named gap.

## Gather (fan out workers; every unreachable source is a NAMED gap)

- **Supabase** (env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_PRODUCT_HEALTH_KEY` — the shared read-only role; verified
  2026-08-10 it SELECTs `chat_match_events`, `chat_messages`,
  `chat_conversations` and writes are refused. REST: `apikey:
  $SUPABASE_ANON_KEY` + `Authorization: Bearer $SUPABASE_PRODUCT_HEALTH_KEY`;
  check presence by NAME, never print values):
  - **Empty-handle turns** — the primary signal: `chat_match_events` rows
    since the last run where `router_skipped = false` and `matched_handles`
    is empty (each cost ~1.6s and ~$0.004 and returned nothing).
  - **Router errors** (`router_error IS NOT NULL`) and **fallbacks**
    (`chat_match_events.is_fallback = true`, with `failure_mode`, on every
    surface since 2026-09-10; `chat_messages.is_fallback` still holds the
    stored surfaces' history before that).
  - **Latency**: `router_latency_ms` median/p90 + `router_cache_hit` rate.
    Baseline 2026-08-07: median 1,615ms, p90 3,063ms, hit-rate 39%.
  - **Per-platform volume**: `chat_match_events.router_context->>'platform'`
    (`widget`/`shopify`/`discord`/`youtube`; `shopify` = the blog chat
    bubble; REST filter `router_context->>platform=eq.widget`, no quotes). NOT a join on `chat_conversations` — the widget writes no
    conversation row and the FK is gone (US-15 AC7, 2026-09-10; older rows
    backfilled). The widget's question text there is verbatim; no reply.
    YouTube only began persisting 2026-08-07 — if its count is 0 after that
    date, something is broken; say so.
  - **YouTube reply length** (since 2026-08-10): for `platform = youtube`
    assistant rows, median words and the count breaching ≤5 sentences / ≤90
    words / ≤25 words-per-sentence (baseline: median 84, one 132-word
    outlier). A rising breach rate means the prompt cap is decaying: propose
    a prompt fix, never a code truncation.

## Categorise every empty-handle query (the analysis that drives everything)

2026-08-07 baseline over 143 queries:

| Category | Share | Meaning |
|---|---|---|
| User's own labs/measurements | 35% | classifier should skip (`MEASUREMENT`) |
| Product / ingredients | 18% | classifier should skip (`PRODUCT`) |
| Greeting / meta / off-topic | 15% | classifier should skip (`GREETING`) |
| Genuine content gap | 19% | no document covers this |
| **Routing miss** | **8%** | **content EXISTS but wasn't found — best target** |
| Account / drug timing | 6% | correctly empty |

~73% were classifier-catchable — track whether that share falls run over run.

## Fix what is safely fixable (priority order)

1. **Routing misses** — content exists, summary doesn't surface it. Rewrite
   *that one summary* to lead with how users actually ask (see
   `.claude/commands/blog-post.md` § "THE RULE THAT MATTERS MOST",
   claude_business repo). Keep the canonical noun and any acronym.
2. **Classifier misses** — a category it should skip but doesn't: propose a
   prompt change; never apply it (Write scope below).
3. **Content gaps** — update [content-backlog.csv](content-backlog.csv)
   (header: `theme,example_queries_anonymised,first_seen,last_seen,count_7d,count_cumulative,status,note`):
   new themes appended, repeat themes updated IN PLACE — never a duplicate row. Quote any field
   containing a comma; example queries anonymised, never containing personal
   health detail. `status` is set by Brad/build sessions (`open` → `planned`
   → `built <handle>` / `declined <reason>`); skip non-open rows when
   reporting. Never invent clinical content.

## Verify — mandatory, no exceptions

- Before any edit: `npx tsx tools/test-chatbot-matching.ts --category <cat>
  --runs 3 --concurrency 5`. Record the number. Apply edits, `npm run
  rebuild-index`, re-run the SAME command. **Lower OR unchanged after-number →
  revert**, and report the attempt with its numbers anyway.
- Before drafting a summary edit, check what the router picked INSTEAD
  (verbose single-query run): a wrong pick despite correct terms is
  selection-side, and no summary edit fixes it (W33: two reverted edits).
- Add every confirmed production failure to `tools/test-queries.json` as a
  regression case, fixed or not, **paraphrased, never verbatim** (Brad
  2026-09-10: the file is public; a failure is a real person's words).
  Numbers and units become typical values that keep the routing intent;
  names, emails, phones and URLs go; the first-person phrasing, misspellings
  and shape of the ask stay, because they are under test. `content-backlog.csv`
  follows the same rule; `tools/test-queries.privacy.test.ts` guards the floor.
- `npx tsx tools/test-classifier.ts --runs 1` if anything
  classifier-adjacent changed. `npm test` before committing.
- ⚠️ **Harness key**: the cloud env var is `ANTHROPIC_TEST_API_KEY`, never
  `ANTHROPIC_API_KEY` (reserved for Claude Code's own auth, never passed to
  scripts; 2026-08-10); every harness and the lint read it first. Missing key
  = NAMED data gap → proposal-only; never paste a key into the repo or report.

## Weekly lint (Brad 2026-09-29, knowledge-refresh plan decision 6, US-43)

After the retrieval work, run the lint in [notes/weekly-lint.md](notes/weekly-lint.md):
deterministic rules, then Sonnet 5.5 detection over this week's changed entries plus
a 1-in-13 slice (`--run --max-calls 60 --max-usd 2`). Both cost lines go in the report.
The first `--run` waits for Brad's written yes on the cost line; until then, no `--run`.
- MAY write `lint-state.json`, `lint-fix-queue.json` (every knowledge-side finding) and
  metrics rows. It reports and queues; it never fixes. A build session (the orchestrator,
  Opus writers) fixes queue items under US-42's batch protocol; Brad signs each batch.
- MAY NOT edit an entry body, `lint-allowlist.json` (Brad's; propose entries), `index.json`, a
  summary outside Verify, or the algorithm side. Signal: queue and lint counts fall each quarter.

## Report sections (file: `YYYY-'W'WW.md` here, ≤150 lines)

TL;DR (3 bullets) · Empty-handle count + category table w/ deltas (append
rows to metrics.csv) · Latency table · Fixes applied w/ before/after harness
numbers · Fixes attempted and reverted (w/ numbers) · Content-gap backlog ·
Weekly lint · Proposals needing Brad · Data gaps · Retro (incl. charter +
LEARNINGS line counts). The lint adds a section: compact the others to stay ≤150.

## Write scope (Brad-set; a loop may never widen it)

- Default `docs/loops/chat-health/**`, plus:
- The `summary:` frontmatter line of individual
  `docs/pathway|guideline|blog/*.md` files — **max 5 per run**, each with
  before/after harness evidence in the report (no numbers, no edit).
- `tools/test-queries.json` (append regression cases).
- Code changes: **Tier 0 — propose only.** Never edit the prompts
  (`chat-system-prompt.md`, `chat-router-prompt.md`,
  `chat-classifier-prompt.md`, `chat-posture-*.md` — compliance and
  clinical-safety carriers) and never edit clinical body content
  (`health_roadmap_algorithm.md`, `evidence.ts`, `roadmap_text.html`, or any
  pathway/blog body) — constitution Guardrails apply above all of this.

## Delivery

Commit `chat-health: weekly retrieval report YYYY-Www` to main; the committed
report is the delivery (no email, constitution rule). Its TL;DR carries fixes
with numbers, the top 3 new or growing content gaps, and what needs Brad.

Charter history: [changelog.md](changelog.md) — history file, exempt
from the operative cap. History NEVER lives inside this charter.
