# Topic masters: plan

Status: plan for Brad, 2026-10-20. Nothing built. Supersedes the analysis in
[chat-topic-masters-proposal-2026-10-20.md](chat-topic-masters-proposal-2026-10-20.md).
Story: a new US (draft below), extending US-15.

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
| D2 | Video posts get a `topics:` list naming their master. Linked posts leave the router's list. They stay in the system for YouTube comments and readers. |
| D3 | Posts with no master (statins, exercise and the like) stay visible to the router. |
| D4 | A master changes for two reasons only: a new Brad video, or a change in its sources (ConsumerLab, NIH ODS). No PubMed literature search: a single new paper must not swing the conclusion. |
| D5 | Sources are re-checked monthly. |
| D6 | A mechanical lint fails loudly when a master is older than its newest linked post, a source is overdue, or a master changed but the other places its topic appears did not. |
| D7 | The three clinical files stay, and the lint checks them against the master. |
| D8 | products.md keeps the latest studies behind each product ingredient, not just product facts. |
| D9 | Opus writes, a fresh adversary and Codex review. When the review is clean, publish without Brad. Bring Brad only the points where we are unsure. |
| D10 | Old video posts are never edited. When a master changes, its published web page is updated too. |
| D11 | All 113 masters now, in batches. |
| D12 | Masters live in this repo's `docs/blog/`; triggers and source checks live in claude_business (`/blog-post`, the supplement-wiki tooling). This is the existing split. |
| D13 | ConsumerLab rules stand: our own words, never its proprietary sections, raw text never in the repo. |

## Design

### 1. The master page

Every reference keeps its URL, handle and evidence review. Three additions:

```markdown
---
type: "reference"
reviewed: "2026-10-20"            # date the current view was last confirmed
sources:                          # one row per source, re-checked monthly
  - { name: consumerlab, url: "...", checked: "2026-10-20", fingerprint: "sha256:..." }
  - { name: nih-ods,     url: "...", checked: "2026-10-20", fingerprint: "sha256:..." }
  - { name: brad-video,  handle: "the-collagen-peptides-for-skin-story-is-changing", date: "2026-10-15" }
---

## Brad's current view (reviewed 20 October 2026)
3–6 sentences. The conclusion, the key citation, the dose the trials used,
who it is for and who it is not for.

## Brad's videos on this topic
- 15 Oct 2026, "The Collagen Peptides for Skin Story is Changing": hydration
  and elasticity improve; wrinkles do not. Current.
- 27 Aug 2025, "No Evidence to Support the Use of Collagen Supplements":
  rebutted Myung 2025; claimed wrinkle benefits. Superseded on wrinkles.
- ...

## (existing evidence review, revised to agree with the current view)
```

The current view comes from Brad's own latest words on the topic, in order:
his newest video post on it, then products.md and the clinical files where
they carry a Brad position. The writer never invents a position. Where Brad
has never spoken on a topic, the current view is an evidence summary from
ConsumerLab and NIH, labelled as such (Q1).

### 2. Linking posts to masters

- A Sonnet pass proposes `topics:` for all 202 video posts, from title,
  summary and body; an Opus pass checks each proposal. A post can name
  several masters (a "5 supplements that work" post names five).
- `scripts/rebuild-blog-index.ts` carries `topics` into `index.json`.
- The router's view (`chat-router.server.ts`) drops a post whose `topics`
  is non-empty. Posts without `topics` stay. A unit test asserts every
  untagged post and every master is in the router's view, so a topic
  without a master can never disappear (D3).
- Router prompt rules 3 and 4 change: a supplement question routes to the
  master; "what does Dr Brad think" routes to the master, whose video list
  answers "what did you say in the video". A post with no master still
  routes as today.
- Expected effect: about 20% fewer router lines, and one file loaded per
  supplement instead of up to three (about a third less loaded text on the
  10-18 collagen question).

### 3. YouTube

A comment on a video still loads that video's post by video ID, as today
(D2). New: the bot also loads the post's master(s) into the same platform
context, after the post. The YouTube prompt gains a two-axis rule: the video's
post is the authority on what the video said; the master is the authority on
Brad's view today. Where they differ, the reply says the view has moved on
and gives the current one. The current "canonical, authoritative" wording in
`chat-youtube-prompt.md` changes to match.

### 4. Precedence in the answer prompt

One general rule replaces per-topic "even when a loaded article says
otherwise" clauses: a master's current view beats any older loaded post, and
a reply says plainly when Brad's view changed. Loaded blocks get a header
with their type and date so the model can apply it.

### 5. What happens to per-topic rules (collagen worked through)

Today's collagen rule (`chat-system-prompt.md:104`, about 1,500 characters)
mixes five kinds of instruction. Each goes to the place that is loaded when
it is needed:

| Part of the rule | Example | Goes to | Why |
|---|---|---|---|
| Evidence claim | "may improve skin hydration and elasticity (Batool 2026)" | master's current view, and products.md (D8) | the master carries the view; products.md is always loaded, so product questions still see it |
| Dose the trials used | "Trials used 0.5 to 10 g a day" | master and products.md | same |
| Precedence | "even when a loaded article or video gives other doses"; never cite Myung 2025 | the general rule (section 4) plus the master marking Myung as superseded | no topic-specific clause needed |
| Product compliance | never imply 12.5 g is within the studied range; structure/function wording only | stays always loaded: products.md's collagen block (it is already there twice, lines 149 and 518) | must hold on product turns, where the router never runs |
| Clinical safety | never for a skin disease, wound, burn, or a pathway-covered condition | stays in the system prompt, rewritten as a general rule for any supplement | a safety line must not depend on routing |

The catch, and why this is not "delete the rule": the classifier skips the
router on about 59% of turns, including product questions, and the router
returns nothing for questions about Brad's own products ("how much collagen is
in MicroVitamin+?" loaded nothing on 10-16 and 10-17). On those turns no
master loads. Anything
that must hold on every turn stays in an always-loaded block: products.md for
ingredients in Brad's products, the system prompt for safety. So the system
prompt shrinks only by the topic-specific evidence and precedence clauses.
Today that is two rules (collagen, nitric oxide), so the saving is small. The
real gain is that the next change of view goes to one master plus products.md,
not into the system prompt.

### 6. Triggers

**A new video** (`/blog-post`, claude_business). After writing the post:
1. Propose its `topics:` from the script.
2. For each master, compare the script's position with the master's current
   view. Same view: add the video to the master's list, bump nothing else.
   Changed view: draft a master update (section 8 pipeline).
3. Run the lint.

**A source change** (monthly, claude_business). For each master, fetch the
NIH ODS fact sheet (public HTTP) and the ConsumerLab page (Brad's logged-in
Chrome through DevTools; captcha guard). Fingerprint the parts we use. A
changed fingerprint queues a draft. ConsumerLab needs Brad's Mac and browser,
so this is a local session, not a cloud loop (Q4).

### 7. Lint (`tools/topic-lint.ts`, run in `test:all`)

Fails when:
1. A master's `reviewed:` is older than its newest linked post.
2. A source's `checked:` is more than 35 days old (monthly plus slack).
3. A master's current view changed in a commit that did not touch, or
   explicitly waive, each place listed for that topic in
   `docs/topic-register.json`: products.md lines, the three clinical files'
   ids (`supplement-collagen`), diet guideline lines, answer-bank entries,
   system-prompt rules.
4. A citation in a master's current view is missing from products.md where
   the topic is a product ingredient (D8), or from `evidence.ts` where an id
   is registered.
5. A post names a master that does not exist, or a master has no sources.

The lint checks agreement mechanically (citations, dates, ids). It cannot
judge whether two sentences mean the same thing; the adversary does that.

### 8. Write, review, publish (per batch of about 10 masters)

1. Sonnet: fetch ConsumerLab (Chrome) and NIH for the batch; record
   fingerprints; collect each topic's linked posts.
2. Opus `worker-opus`, one per master: write the current view, the video
   list, and revise the evidence review to agree. Changes from the old page
   are listed in a batch notes file.
3. Fresh Opus `adversary` and Codex on the batch. Two rounds at most.
4. **Unsure list.** Anything either reviewer or the writer could not settle
   goes to Brad as a short list (D9). Always on it, whatever the reviewers
   say: a change in the direction of a recommendation (for becomes against
   or the reverse), a dose change, a new safety warning or one removed, a
   conflict between ConsumerLab or NIH and Brad's latest video, and any
   claim about one of Brad's products.
5. Clean masters publish: commit the `.md`, update the drstanfield.com
   article (`shopify-article-create.js --update`), regenerate and update the
   microvitamin.com commerce copy (`commerceUrl`, brand posture), rebuild
   the index. The chatbot reads the `.md` from the deployed app, so the
   chatbot change goes live at the next Deploy (Brad, or the Tier 3 path).
   Agents cannot deploy.

Batch order: changed-view topics first (collagen; NAD/NMN with its four
posts; resveratrol), then by chat traffic.

### 9. Draft story (for docs/user-stories.md)

US-xx Topic masters. ACs: one master per reference with `reviewed:` and
`sources:`; `topics:` on posts; router view excludes linked posts and keeps
every untagged post and every master (tested); YouTube loads the video's
post plus its masters; the general precedence rule; lint checks 1–5 in
`test:all`; publish updates both stores.
Usage signal: loaded characters per routed turn and the share of
supplement turns whose first loaded entry is a master, from
`chat_match_events`.

## Pushback

1. **Publishing without Brad (D9).** Agreed, with the unsure list in step 4
   as the floor. This changes the pathway-refresh rule (Brad signs every
   batch), so it needs writing into the refresh rulings, or the two
   processes will contradict each other.
2. **Agents writing to Shopify.** Updating live articles is a live write.
   Auto mode may block it, as it blocked report edits in the pathway refresh.
   If it does, either Brad adds an allow rule for
   `shopify-article-create.js --update`, or the batch stops at "ready to
   publish" and Brad runs one command.
3. **Two web pages per master.** Each reference exists on drstanfield.com and,
   rewritten for brand posture, on microvitamin.com. Updating both doubles
   the publish step and the review surface (the commerce rewrite has its own
   compliance rules).
4. **Grokipedia.** The supplement-wiki pipeline uses it as a third source.
   D4 names only ConsumerLab and NIH. I would drop it from the monthly
   check: it is the least reliable of the three and changes often, which
   would trigger needless drafts (Q2).
5. **Scale.** 113 masters is about 6 pathway-sized batches of clinical
   writing, plus 202 post tags. ConsumerLab extraction for 113 topics through
   Brad's browser is the slow part, and the captcha guard is still open.

## Questions for Brad

- **Q1.** Topics where you have never made a video (most of the 113): is an
  evidence summary labelled "evidence summary, not a Brad position" right, or
  should those masters carry no current-view section?
- **Q2.** Drop Grokipedia from the monthly source check?
- **Q3.** Does an update to the microvitamin.com copy go out with the
  drstanfield.com one every time, or only when the change touches a product
  claim?
- **Q4.** Monthly ConsumerLab checks need your Mac and logged-in Chrome. OK
  to run them as a scheduled local session?
