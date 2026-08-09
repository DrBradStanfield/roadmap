# Chat-health loop — charter (chatbot retrieval quality)

Inherits everything in [../LOOP.md](../LOOP.md) (the constitution) — read it
FIRST; this file holds only this loop's deltas. Schedule: Mondays ~10:23am NZ
(cron `23 22 * * 0` UTC). Registry: [../REGISTRY.md](../REGISTRY.md).
Sibling: [product-health](../product-health/LOOP.md) covers how people *use
the tool*; you cover one thing only — **does the chatbot retrieve the right
knowledge, and answer well from it.** Read its latest report for context,
then stay in your lane.

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
6. **The classifier and router stay serial.** The classifier's only job is
   deciding whether the router fires; running them concurrently fires the
   router every turn and deletes the entire saving. See
   `chat-architecture.md` § "Do not re-parallelise".

## Orient (read yourself, not via workers)

1. This charter + `LEARNINGS.md` + `metrics.csv` here.
2. The two most recent reports in this folder.
3. `docs/chat-overview.html` "Current state at a glance" (claude_business
   repo) — build-session envs only; unreachable from the cloud runner, where
   it is a standing named gap (don't re-discover this each run).

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
    (`chat_messages.is_fallback = true`, with `failure_mode`).
  - **Latency**: `router_latency_ms` median/p90 + `router_cache_hit` rate.
    Baseline 2026-08-07: median 1,615ms, p90 3,063ms, hit-rate 39%.
  - **Per-platform volume**: join `chat_conversations.platform`
    (`shopify`/`discord`/`youtube`). YouTube only began persisting
    2026-08-07 — if its count is 0 after that date, something is broken;
    say so.

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
3. **Content gaps** — update [content-backlog.csv](content-backlog.csv): new
   themes appended, repeat themes updated IN PLACE (bump `last_seen`,
   `count_7d`, `count_cumulative` — never a duplicate row). Quote any field
   containing a comma; example queries anonymised, never containing personal
   health detail. `status` is set by Brad/build sessions (`open` → `planned`
   → `built <handle>` / `declined <reason>`); skip non-open rows when
   reporting. Never invent clinical content.

## Verify — mandatory, no exceptions

- Before any edit: `npx tsx tools/test-chatbot-matching.ts --category <cat>
  --runs 3 --concurrency 5`. Record the number. Apply edits, `npm run
  rebuild-index`, re-run the SAME command. **Lower OR unchanged after-number →
  revert**, and report the attempt with its numbers anyway.
- Before drafting a summary edit for a failing query, check what the router
  picked INSTEAD (verbose/single-query run). Selection-side failures (wrong
  entry chosen despite correct terms) can't be fixed by summary edits — W33
  spent two reverted edits learning this.
- Add every confirmed production failure to `tools/test-queries.json` as a
  regression case, fixed or not.
- `npx tsx tools/test-classifier.ts --runs 1` if anything
  classifier-adjacent changed. `npm test` before committing.
- ⚠️ **Harness key gotcha**: the cloud env var must be named
  `ANTHROPIC_TEST_API_KEY`, NOT `ANTHROPIC_API_KEY` — the platform reserves
  the latter for Claude Code's own auth and never passes it to scripts
  (observed 2026-08-10). All three harnesses check `ANTHROPIC_TEST_API_KEY`
  first. Missing key = NAMED data gap → run proposal-only; never paste a key
  into the repo or report.

## Report sections (file: `YYYY-'W'WW.md` here, ≤150 lines)

TL;DR (3 bullets) · Empty-handle count + category table w/ deltas (append
rows to metrics.csv) · Latency table · Fixes applied w/ before/after harness
numbers · Fixes attempted and reverted (w/ numbers) · Content-gap backlog ·
Proposals needing Brad · Data gaps · Retro (incl. charter + LEARNINGS line
counts).

## Write scope (Brad-set; self-amendment may never widen it)

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

Commit `chat-health: weekly retrieval report YYYY-Www` to main. No email
(constitution rule; the run-complete notification + committed report are the
delivery). The report's TL;DR must carry: fixes with numbers, top 3
new/growing content gaps, and what needs Brad's approval.

## Changelog (self-amendments — newest first, keep 10)

- 2026-08-10 (Brad): Delivery reconciled with the constitution — Gmail draft
  killed (W33 proposal 5); notification + committed report are the delivery.
- 2026-08-10 (W33 run): orient step 3 marked cloud-unreachable (standing gap);
  Verify gains "inspect the router's alternative pick before editing" and
  reverts now also fire on an UNCHANGED after-number (W33: two no-gain edits).
- 2026-08-10 (Brad): content gaps now accumulate in content-backlog.csv —
  a ledger, per Brad, not a markdown table (machine-updatable, GitHub still
  renders it); in-place increments, status column; email surfaces top 3.
- 2026-08-10: v2 — compacted to a deltas-only charter under the fleet
  constitution (211 → ~160 lines): orchestration, entropy, self-improvement,
  reporting and repo rules deduped to ../LOOP.md; success signal declared;
  metrics.csv introduced; Supabase chat-table read access verified.
- 2026-08-07: v1, authored in-session with Brad. Encodes the
  measure-then-revert rule, the six ground truths, and the empty-handle
  category baseline.
