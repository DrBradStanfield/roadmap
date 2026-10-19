# Chatbot knowledge: topic masters (proposal, 2026-10-20)

Status: analysis for Brad, revised after a fresh Opus adversary and Codex
(gpt-6.1-sol) review. Nothing built. Prompted by the collagen update (Batool
2026 meta-analysis, video and post of 2026-10-15). Story: US-15.

## Brad's question

When someone asks about collagen, how does the chatbot know which collagen
post to load? There should be one master collagen file with the current view.
Old posts must stay reachable, so a comment on an old video still gets that
video's script. Would this also shrink the index?

## How it works today (verified 2026-10-20)

1. A Haiku classifier decides whether to route.
2. The Sonnet 5.5 router reads one line per entry, `[type] handle: summary`
   (summary capped at 150 characters), for all 1,067 entries, and returns up
   to 3 handles. It sees no dates and no links between entries
   (`app/lib/chat-router.server.ts:111-120`).
3. `loadMatchedContent()` (`app/lib/matched-content.ts`) loads those files
   whole, frontmatter included, in router order, up to 120K characters.
4. YouTube: the bot finds the post whose `youtube:` field matches the video
   (by video ID, not the router) and puts it in the platform context, which
   `chat-youtube-prompt.md` calls canonical. It also routes the comment.
5. Precedence exists, but per topic. `chat-system-prompt.md:104` (added in
   fd68004b, 2026-10-16) tells the model to give the Batool 0.5–10 g range
   "even when a loaded article or video gives other doses", and never to cite
   Pu, Kim or Myung as evidence that collagen helps skin. No general rule says
   which loaded source wins.

The master file Brad means already exists: the `reference` entry
`collagen-benefits-best-forms-dosing-and-side-effects`. There are 113
references, one per supplement or nutrient. Router rule 3 makes the reference
"usually primary" for supplement questions.

## What the data shows (collagen)

Router picks (`chat_match_events`). Every routed question about collagen
itself loaded the reference first:

| Date | Question | Also loaded |
|---|---|---|
| 10-18 | how much collagen should I take for my skin? (twice, 8 minutes apart; likely a test) | can-fix-skin-wrinkles (2025-03), story-is-changing (2026-10) |
| 10-15 | 5 YouTube comments on the new video | no-evidence (2025-08) in 4 of 5 |
| 10-08 | Do collagen supplements improve skin? | can-fix-skin-wrinkles (2025-03), 25%-reduction (2025-06) |

Answers. The 5 YouTube replies on 10-15 matched the current view: one cites
Batool 2026 (hydration and elasticity, not wrinkles), none repeats Myung. The
video's own post was in context as canonical. The widget keeps no transcript
(US-15 AC7), so the 10-18 and 10-08 answers cannot be read back. **No wrong
answer is on record yet.** The risk is real, but unmeasured.

What is actually wrong:

1. **The master is the least current file on its topic.** Its body leads with
   Myung 2025 ("no longer statistically significant" in high-quality studies,
   line 28), its FAQ still claims a 7–20% wrinkle improvement, and its index
   summary still says "wrinkle reduction" and "dosing (10–15g/day)", the Pu
   line fd68004b retired everywhere else. The router reads that summary on
   every collagen question. The old posts are less wrong than this: the
   "no-evidence" post is a rebuttal of Myung, and it and "can fix" both say
   collagen works. Their gap from today's view is wrinkles and doses.
2. **Precedence is patched topic by topic in the always-loaded prompt.** It
   worked for collagen, but each changed view adds lines to the cached system
   prompt instead of fixing the topic's own file.
3. **Nothing links posts to their topic.** At least 14 video posts make
   collagen claims (the 4 collagen posts plus only-supplements-work-2025,
   reverse-signs-skin-aging, supplements-best-skin-tightening and others).
   The collagen data does not show a master going missing, though.

## Does the index size matter?

No. `index.json` is 1.1 MB (keywords 289K, uncapped summaries 341K, plus
formatting), but the router sees only the capped one-line view: about 184K
characters, roughly 46K tokens.

| Type | Entries | Router characters | Share |
|---|---|---|---|
| pathway | 749 | 126K | 68% |
| article (video posts) | 202 | 36K | 20% |
| reference | 113 | 22K | 12% |
| guideline | 3 | 0.5K | 0% |

That block is cached (about $0.01 a turn) and the answer model never sees it.
Hiding every video post would save a fifth. Not a reason to restructure.

## Recommendation (staged; stop when the data says the problem is solved)

1. **Measure first.** Add fixed-handle answer checks (US-15 AC24) for the
   10-18 and 10-08 handle sets and two YouTube-style comments, graded against
   the current view. Run them after the test key resets on 2026-11-01, or on
   Brad's yes before then.
2. **Fix the collagen master now.** Rewrite its lead (Batool 2026 first, Myung
   placed below with its caveats), the wrinkle FAQ and its frontmatter
   summary, consistent with the three clinical files. Opus writer, then
   adversary and Codex. This is the cheapest fix and helps whatever comes
   next.
3. **One general rule instead of per-topic patches.** In the system prompt:
   a reference's current position, and any topic rule in this prompt, beat
   older loaded posts; when they differ, say the view changed and why. For
   YouTube, a two-axis rule: the video's post is authoritative for what the
   video said; the reference is authoritative for Brad's view now. This keeps
   replies matched to the script, which Brad asked to protect.
4. **Build the linking machinery only if step 1 shows a gap.** That means a
   `topics:` frontmatter list on posts, with code adding the master. If
   built, it must:
   - add the master on top of the router's picks, within the 120K cap,
     never evicting a routed entry (US-15 AC23);
   - name it in "sources" (AC20: pass it in `titled`);
   - update the AC24 fixture contract;
   - for YouTube, inject through the platform context, which does not use
     `loadMatchedContent()`.
5. **Process.** When a new post changes Brad's view, the `/blog-post` skill
   (claude_business) updates that topic's reference in the same commit. A
   lint compares post dates with the reference's `reviewed:` date. The lint
   cannot check agreement with the three clinical files; that stays with
   review.

Usage signal: the AC24 answer checks above, then router picks in
`chat_match_events` for the topics touched.

## Costs and risks

- A reference that carries a "current position" becomes a fourth copy of
  clinical content that the three-file sync (CLAUDE.md) does not cover.
  Fixing it for collagen means checking it against `evidence.ts`,
  `health_roadmap_algorithm.md` and `roadmap_text.html`, not just the posts.
- Rolling this out to all 113 references is the same clinical pipeline as the
  pathway refresh. Do the topics with traffic first, and only where a view
  changed.
- A wrong master is loaded on every question on its topic, so it needs more
  review than any one post.
