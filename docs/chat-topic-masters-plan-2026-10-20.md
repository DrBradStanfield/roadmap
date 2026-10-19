# Topic masters: plan (v2)

Status: plan for Brad, 2026-10-20. Nothing built. v2 folds in a fresh Opus
adversary review (17 findings) and Codex (gpt-6.1-sol, 2 findings) of v1.
Earlier analysis: [chat-topic-masters-proposal-2026-10-20.md](chat-topic-masters-proposal-2026-10-20.md).
Stories: extends US-15 (chat) and US-42 (knowledge refresh).

## The problem in one paragraph

The chatbot's knowledge of a supplement is spread over many files that drift
apart. When Brad changed his view on collagen (Batool 2026), the fix landed in
products.md, the system prompt, the three clinical files and the diet
guideline, but not in the collagen reference page, which still leads with the
2025 Myung review. The router also loads old collagen posts beside the
reference, chosen by summary alone, with no dates. So the answer model reads
up to three files that disagree, and the file meant to be the master is the
most out of date.

## Decisions Brad has made (2026-10-20)

| # | Decision |
|---|---|
| D1 | Each of the 113 reference pages becomes its topic's master: current view on top with a `reviewed:` date, the evidence review below, and a dated list of Brad's videos on the topic. |
| D2 | Video posts get a `topics:` list naming their master. Posts a master fully covers leave the router's list. All posts stay in the system for YouTube comments and readers. |
| D3 | Topics with no master stay visible to the router. |
| D4 | A master changes for two reasons only: a new Brad video, or a change in its sources (ConsumerLab, NIH ODS). No literature search: one new paper must not swing a conclusion. |
| D5 | Sources are re-checked monthly. |
| D6 | A mechanical lint flags a master older than its newest linked post, an overdue source, or a master that changed while the other places its topic appears did not. |
| D7 | The three clinical files stay, and the lint checks them against the master. |
| D8 | products.md keeps the latest studies behind each product ingredient, not just product facts. |
| D9 | Opus writes, a fresh adversary and Codex review. When the review is clean, publish without Brad. Bring Brad only the points where we are unsure. |
| D10 | Old video post bodies are never edited (only a `topics:` line is added to their frontmatter). When a master changes, its published web page is updated too. |
| D11 | All 113 masters now, in batches. |
| D12 | Masters live in this repo's `docs/blog/`; triggers and source checks live in claude_business (`/blog-post`, supplement-wiki tooling). This is the existing split. |
| D13 | ConsumerLab rules stand: our own words, never its proprietary sections, raw text never in the repo. |

## What changed from v1, and why

| v1 said | v2 says | Found by |
|---|---|---|
| Hide every post with a `topics:` tag | Hide only posts whose whole subject is one master's substance; never tag drug, lifestyle or test posts to a supplement master | both reviewers |
| Tag and hide all posts first | A post hides only once its master has been rewritten (`reviewed:` set), behind an env flag | adversary |
| Same-view video: "bump nothing" | A same-view video moves `reviewed:` forward (the view was confirmed) | both |
| Date checks in `test:all` | Date checks in the weekly knowledge-lint loop (US-43); only static checks in `test:all` | adversary |
| A new general safety rule | No new rule; the collagen and nitric-oxide lines stay | adversary |
| Move per-topic rules into masters | Keep them where they are; register them so the lint flags them when a master changes | adversary |
| Agents publish to Shopify with `--update` | The ID map is stale and the tool defaults to the wrong store; see section 8 | adversary |
| A new process beside US-42 | Master rewrites run under US-42's checker and rules; D9 needs US-42 AC6 and AC8 amended | adversary |

## Design

### 1. The master page

Every reference keeps its URL, handle and evidence review. Additions:

- Frontmatter, one line per key (the index builder reads only `key: value`
  lines): `reviewed: "2026-10-20"` and `sources:` as single-line JSON
  (name, url, checked date, fingerprint). The loader strips frontmatter
  before the answer model sees a page, so URLs and hashes never reach it.
- `## Current view (reviewed 20 October 2026)`: 3–6 sentences. The
  conclusion, the key citation, the dose the trials used, who it is for
  and who it is not for.
- `## Brad's videos on this topic`: date, title, one-line take, and
  "superseded on X" where the view has since moved.
- The evidence review below, revised to agree.
- The index summary is rewritten in the same commit (collagen's still says
  "wrinkle reduction … 10–15g/day", and the router reads it every time).

**Whose view.** The answer prompt lets the model quote loaded content as
Brad's view, so this section must never put words in his mouth:

- Where Brad has a video or post on the topic, the current view restates
  that post, and each sentence cites its handle.
- Where he has none (most of the 113), the section is titled
  "Current evidence position", says it is an evidence summary, and does
  not claim to be his view (Q1).

### 2. Linking posts to masters

- Sonnet proposes `topics:` for the 202 posts; Opus checks each one.
- A post is **hidden from the router** only when its whole subject is one
  master's substance (the four collagen posts, the four NAD/NMN posts).
  A post that mixes subjects keeps its tag for the master's video list but
  stays routable (reverse-signs-skin-aging also covers sunscreen and
  retinoids; salt-substitutes holds the SSaSS trial; 5-livesaving-blog-tests
  is about blood tests). Drug posts (GLP-1, statins), lifestyle and test
  posts are never tagged to a supplement master.
- That flag is explicit: `router: hidden` in the post's frontmatter,
  set only by the Opus check, never inferred from `topics:`.
- Gate in code: a hidden post stays in the router view until its master has
  a `reviewed:` date. So no topic ever loads a stale master alone.
- The filter sits in the router's index block, not in `loadBlogIndex()`
  (the YouTube bot finds posts through that), and the matching harness
  applies the same filter. ROUTER_VERSION is bumped. An env flag turns the
  filter off, which is the rollback.
- Tests: every untagged post, every mixed post and every master stays in the
  router view; a mixed-topic regression case. The 27 router fixtures that
  expect a post handle are re-pointed to the master before the filter ships.
- Router rules 3 and 4 change so supplement questions and "what does Dr Brad
  think" route to the master.
- Effect, honestly sized: articles are the most-loaded type today (155 of 389
  loaded slots since 09-20). Hiding single-subject posts cuts the duplicates
  on supplement questions. The index shrinks by much less than 20%, because
  mixed posts stay.

### 3. YouTube

A comment still loads its video's post by video ID. New:

- The bot also loads the **current-view section only** of the post's
  master(s), not the whole page (references run 29–83K characters, and the
  YouTube context is uncached), de-duplicated against the router's picks and
  size-capped.
- Masters added this way do not count as "related articles loaded" for the
  reply-or-skip rule in `chat-youtube-prompt.md`, so the bot does not start
  replying to comments it skips today.
- Two-axis rule: the video's post is the authority on what the video said;
  the current view is the authority on Brad's view today.
- Whether a public reply may say "Brad's view has since changed" under his
  own old video is a question for Brad (Q5).

### 4. Precedence in the answer prompt

- Loaded blocks get a header with type and date.
- One rule: a master's current view beats any older loaded post, and a reply
  says plainly when the view changed.
- This must be reconciled with the existing section that calls loaded
  content "supplementary, not authoritative": the current view outranks
  posts, and the system prompt and products.md still outrank both.

### 5. Per-topic rules (collagen worked through)

v1 proposed moving these out of the system prompt. The review showed that is
mostly unsafe, so v2 keeps them and makes the lint watch them.

The collagen line (`chat-system-prompt.md:104`, 1,334 characters) mixes:

| Part | Example | v2 |
|---|---|---|
| Evidence claim | "may improve skin hydration and elasticity (Batool 2026)" | stays; also in the master and products.md (D8) |
| Trial dose | "Trials used 0.5 to 10 g a day" | stays; also in the master and products.md |
| Precedence | "even when a loaded article gives other doses"; never cite Myung 2025 | stays for now; the general rule (section 4) covers it once tested |
| Product compliance | never imply 12.5 g is within the studied range | stays (system prompt and products.md) |
| Clinical safety | never for skin disease, wounds, burns | stays, collagen-specific |

Why it stays:
- These lines hold on every turn. A master loads only when the router picks
  it, and the router does not run on about half of turns (classifier skips
  222 of 428 since 09-20) and returns nothing on 38 of the 206 it routes,
  including product questions.
- A general safety rule ("never for anything a loaded pathway covers") would
  block vitamin D for deficiency, iron for iron deficiency, melatonin with
  the insomnia pathway. That is a new clinical rule, not a refactor.
- The nitric-oxide line encodes Brad's dietary-nitrate position, which the
  nitric-oxide reference (citrulline, arginine, beetroot) does not.
- US-15 AC35 says the collagen rule lives in the system prompt and
  products.md.

What changes: every such line (collagen, nitric oxide, the dose list at
line 11, the omega-3 rule at line 12) goes in the topic register (section
7), so when a master changes, the lint names the prompt lines to recheck.

### 6. Triggers

**A new video** (`/blog-post`, claude_business):
1. Propose `topics:` and whether the post is single-subject.
2. Compare the script's position with each master's current view.
   - Same view: add the video to the list and move `reviewed:` forward.
   - Changed view: draft a master update (section 8).

**A source change** (monthly):
- NIH ODS fact sheets by public HTTP.
- ConsumerLab through Brad's logged-in Chrome (DevTools; captcha guard
  still open), extracting only the sections supplement-wiki already allows
  (What It Is, What It Does, ConsumerTips, Concerns and Cautions).
- The fingerprint is a hash of that extracted text, normalised (whitespace,
  no dates or page furniture), so layout changes do not queue 113 drafts.
- A changed fingerprint queues a draft.
- Needs Brad's Mac and browser: a scheduled local session (Q4), and Brad
  should check ConsumerLab's terms allow monthly automated reads (Q6).

### 7. Lint

Extend the existing US-43 knowledge lint (`tools/knowledge-lint.ts`, with
`lint-state.json` and `lint-allowlist.json`); do not add a second lint.

**In `test:all` (static, never date-dependent):**
1. A post names a master that does not exist; a master has no sources.
2. A `router: hidden` post's master has no `reviewed:` date (gate check).
3. Every DOI in a master's current view also appears in products.md where
   the topic is a product ingredient. **Warn only**, never fail: a forced
   copy into products.md or `evidence.ts` would turn every master edit into
   a product-block or three-file change.

**In the weekly knowledge-lint loop (date-dependent, reports, never blocks
deploys):**
4. A master's `reviewed:` is older than its newest linked post.
5. A source's `checked:` is more than 35 days old.
6. A master's current view changed (content hash in `lint-state.json`)
   while a place listed for that topic in `docs/topic-register.json` did
   not. The register lists products.md blocks, `evidence.ts` ids, the
   three clinical files, diet-guideline lines, answer-bank entries and
   system-prompt lines. A deliberate non-change is waived in
   `lint-allowlist.json` with author and date.
7. Overlapping masters disagree on a shared DOI's conclusion (red yeast rice
   and cholesterol-lowering supplements; arginine, citrulline and nitric
   oxide; omega-3 and flaxseed) — flagged for the adversary, not decided.

Putting date checks in `test:all` would turn CI red 36 days after any commit,
block every deploy including security fixes, and fail rollbacks.

The answer bank is generated in claude_business, so a flag on it is fixed
there, not here.

### 8. Write, review, publish (batches of about 10; 12 batches)

US-42 already governs these reference files (references-1 re-sourced five
of them). Masters are written under its rules:
- Raw-quote checker (AC2).
- DOIs and PMIDs resolve; no Grokipedia; product mentions do not rise (AC7).
- A study first seen in ConsumerLab is cited only with its PubMed abstract.

Steps per batch:
1. Sonnet fetches ConsumerLab and NIH, records fingerprints, collects each
   topic's posts.
2. One Opus `worker-opus` per master writes the current view, the video list,
   the revised review and the new index summary. Changes are listed in a
   batch notes file.
3. US-42 checker, then a fresh `adversary` and Codex. Two rounds at most.
4. **Unsure list to Brad** (D9). Always on it, whatever the reviewers say:
   - a recommendation that changes direction;
   - a dose change;
   - a safety warning added or removed;
   - ConsumerLab or NIH disagreeing with Brad's latest video;
   - any claim about one of Brad's products;
   - any change the lint says touches products.md, the system prompt or the
     three clinical files (those are never auto-published).
5. Clean masters: commit, rebuild the index, and wait for Brad's Deploy
   (agents cannot deploy; Tier 3 rejects clinical content).
6. **After the deploy is verified**, update the web pages, so the site and
   the chatbot never disagree for days:
   - drstanfield.com: resolve the article ID by handle through the API (the
     ID map is stale: 0 of 113 keys match a current handle), run with `--edu`
     explicitly (the tool defaults to microvitamin.com), and save the old
     body for rollback.
   - microvitamin.com: the commerce copy is rebuilt from the live page plus
     product callouts, not from the `.md`, so it always goes on Brad's list.

**What D9 needs changed first:** US-42 AC8 (Brad signs each batch) and AC6
(no agent writes to Shopify) must be amended in `docs/user-stories.md`, with
the unsure-list rule above, or the two processes contradict each other.
Auto mode may also block Shopify writes; if so, Brad adds an allow rule or
runs the publish command himself.

Batch order: changed-view topics first (collagen; NAD/NMN; resveratrol), then
by chat traffic.

### 9. Draft story

US-xx Topic masters (extends US-15 and US-42). ACs:
- One master per reference with `reviewed:` and `sources:`.
- `topics:` on posts; `router: hidden` only on single-subject posts.
- The router view keeps every untagged post, every mixed post and every
  master (tested), and hides nothing whose master is unrewritten.
- YouTube adds the master's current view, capped, outside the skip rule.
- The precedence rule.
- Lint checks 1–3 in `test:all`, 4–7 in the weekly loop.
- Web pages updated after deploy, per store.

Usage signal: loaded characters per routed turn, and the share of supplement
turns whose first loaded entry is a master (`chat_match_events`).

## Pushback

1. **Regression testing is not optional.** You said no measuring, and I agree
   we skip a separate study. But the router change moves 27 existing fixtures
   and touches every supplement answer, so the existing router harness runs
   before the filter ships, as for any router change. It needs the test API
   key (capped until 2026-11-01) or your yes for the production key.
2. **D9 is the biggest risk.** 113 masters published without you, each loaded
   on every question about its topic. The unsure list is the floor. It will
   be long in the first batches.
3. **Cost.** Agents run on your Claude plan, not the API. Rewriting 113
   masters plus reviews is about the size of the pathway refresh, which hit
   session limits twice. Codex runs on your ChatGPT plan; if it runs out, the
   review is adversary-only (Q7).

## Questions for Brad

- **Q1.** Topics you have never made a video on: is a section titled "Current
  evidence position" (an evidence summary, not your view) right?
- **Q2.** Router: hide single-subject posts only (v2), or keep all posts and
  rely on the master winning by precedence?
- **Q3.** D9 means amending US-42 AC6 and AC8. Confirm, with the unsure list
  in section 8 step 4 as the rule?
- **Q4.** Monthly ConsumerLab checks need your Mac and logged-in Chrome. OK
  as a scheduled local session?
- **Q5.** May the YouTube bot say publicly, under your old video, that your
  view has since changed?
- **Q6.** Will you check ConsumerLab's terms allow monthly automated reads of
  113 pages?
- **Q7.** If Codex is out of quota, or the work runs in a cloud loop, does D9
  still allow publishing on the adversary's review alone?
- **Q8.** microvitamin.com copies: always on your list (v2), or skip them
  unless a product claim changes?
