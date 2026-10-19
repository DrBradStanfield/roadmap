# Chatbot knowledge: topic masters (proposal, 2026-10-20)

Status: analysis for Brad. Nothing built. Prompted by the collagen update
(Batool 2026 meta-analysis, video and post of 2026-10-15).

## Brad's question

When someone asks about collagen, how does the chatbot know which collagen
post to load? There should be one master collagen file with the current view.
Old posts must stay reachable, so a comment on an old video still gets that
video's script. Would this also shrink the index?

## How it works today (verified 2026-10-20)

1. A Haiku classifier decides whether to route.
2. The Sonnet 5.5 router reads one line per entry, `[type] handle: summary`
   (summary capped at 150 characters), for all 1,067 entries, and returns up
   to 3 handles. It sees **no dates** and **no links between entries**
   (`app/lib/chat-router.server.ts`, the `.map` at line 119).
3. `loadMatchedContent()` (`app/lib/matched-content.ts`) loads those files
   whole, frontmatter included, in router order. Nothing marks one as current
   and another as superseded. The system prompt has no rule for conflicts
   between loaded sources.
4. YouTube: the bot finds the post whose `youtube:` field matches the video
   and loads it as the platform context. It does this **by video ID, not
   through the router**. It then routes the comment like any other question.

The "master file" Brad means already exists: the `reference` entry
`collagen-benefits-best-forms-dosing-and-side-effects` (113 references in all,
one per supplement or nutrient). The router prompt's rule 3 already makes the
reference "usually primary" for supplement questions.

## What goes wrong (collagen, from `chat_match_events`)

Every routed question about collagen itself since 2026-10-08 loaded the reference first.
The other two slots went to old posts, chosen by summary alone:

| Date | Question | Also loaded |
|---|---|---|
| 10-18 | how much collagen should I take for my skin? | can-fix-skin-wrinkles (2025-03), story-is-changing (2026-10) |
| 10-15 | 5 collagen questions on the new video's release day (likely YouTube comments) | no-evidence (2025-08) in 4 of 5 |
| 10-08 | Do collagen supplements improve skin? | can-fix-skin-wrinkles (2025-03), 25%-reduction (2025-06) |

Three faults, in order of harm:

1. **The master is stale.** The reference body still leads with Myung 2025:
   "benefits on skin hydration and elasticity were no longer statistically
   significant" in high-quality studies. The 2026-10-16 Batool update
   (fd68004b) changed products.md, the system prompt and the clinical files,
   but in the reference only its product lines and broken links. So the
   current view lives in products.md and the system prompt, the master says
   the old thing, and the old posts say two opposite old things ("can fix",
   "no evidence").
2. **No precedence.** The answer model gets 3 dated-only-in-frontmatter
   files and no rule for which wins. The reference's `publishedAt` is
   2025-04-29, older than the new post, so even "newest wins" would pick the
   wrong one for any topic whose master is current but old.
3. **No topic links.** Nothing ties the 4 collagen posts to the collagen
   reference. The router guesses from summaries. On YouTube, the bot loads the
   video's post but nothing guarantees the topic's master comes too.

## Does the index size matter?

Less than it looks. `index.json` is 1.1 MB because it carries keywords; the
router sees only the capped one-line view, about 206K characters (roughly 50K
tokens of index, ~75K with the prompt). By type:

| Type | Entries | Router characters | Share |
|---|---|---|---|
| pathway | 749 | 140K | 68% |
| article (video posts) | 202 | 41K | 20% |
| reference | 113 | 24K | 12% |
| guideline | 3 | 0.5K | 0% |

Dropping every video post from the router view saves about a fifth. The block
is cached (read at $0.20/MTok, about $0.01 a turn), and the answer model never
sees it. Pathways are the bulk. So size is not a reason to restructure;
precedence and currency are.

## Proposal

1. **The reference is the topic master.** Each reference gets a short
   "Current position" section at the top: Brad's present view in 3–6
   sentences, the key citation, and a `reviewed:` date in frontmatter. The
   long evidence review stays below it.
2. **Posts point to their master.** Video posts get a `topics:` frontmatter
   list of reference handles (collagen posts → the collagen reference). One
   post can name several. Rebuild-index carries it into `index.json`.
3. **Code, not the router, adds the master.** When a routed or YouTube-loaded
   post names a topic, `loadMatchedContent()` adds that reference if it is not
   already loaded (counting against the 3 slots and the character cap, master
   first). Deterministic and testable, unlike a prompt rule.
4. **Label what is loaded.** Each block gets a header: "CURRENT POSITION
   (reviewed 2026-10-16)" for a master, "Older video post (published
   2025-03-12); may be out of date" for a post. One prompt rule: where they
   differ, the current position wins, and say plainly that the view changed
   and why. That is how Brad talks about it himself.
5. **Keep old posts.** They stay in `index.json`, so YouTube still finds a
   video's script and "what did you say in that video" questions still work.
   Optional, later: hide posts whose topic has a master from the router view
   (about −20% of the index), so the router's spare slots go to other topics.
   Test before doing it; it changes what rule 4 ("what does Dr Brad think")
   can reach.
6. **Process.** The `/blog-post` skill (claude_business) gains one step: when
   a new post changes Brad's view on a topic, update that reference's current
   position and `reviewed:` date in the same commit. A lint flags a post
   newer than its master's `reviewed:` date.

## First step

Collagen only: write the collagen current position (Batool 2026, with the
Myung 2025 caveat placed below it), tag the 4 collagen posts, add the code in
step 3 and the labels in step 4, and add router plus answer fixtures for the
10-18 and 10-08 questions. Then measure on the fixtures before touching the
other 112 references.

## Costs and risks

- Writing 113 current positions is clinical writing: Opus writer, adversary
  and Codex per batch, the same pipeline as the pathway refresh. Do the
  topics with traffic first.
- A wrong current position is now loaded on every question on that topic.
  One page carries more weight, so it needs more review than any one post.
- Tagging 202 posts is mechanical (Sonnet), but each tag needs a check.
- The pathway refresh is unaffected: pathways have no posts pointing at them.
