// The YouTube bot's platform context: its prompt, the video's post and the
// topic masters' current views. Sentry-free, so tools/youtube-comment-dryrun.ts
// builds the same context under tsx.
import fs from 'fs';
import path from 'path';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { loadBlogArticle, contentHeader } from './matched-content';
import { parseFrontmatter, stripFrontmatter } from './frontmatter';

/** Empty when the file is missing; the bot then refuses to start. */
export const YOUTUBE_PROMPT_TEMPLATE = (() => {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'app/lib/chat-youtube-prompt.md'), 'utf-8');
  } catch {
    console.warn('YouTube bot: chat-youtube-prompt.md not found — bot will not start');
    return '';
  }
})();

// ---------------------------------------------------------------------------
// Platform-context construction — substitutes the video's blog post (looked up
// via the shared blog-index/loader the on-site chatbot already uses).
// ---------------------------------------------------------------------------

/** Appended to the platform context on follow-up turns only. The bot has
 *  already answered once in this thread; the bar for speaking again is higher
 *  and disengaging from hostility is mandatory (agreed with Brad 2026-08-10). */
const FOLLOWUP_POSTURE = `

FOLLOW-UP TURN: You already replied once in this comment thread (see the conversation history). This is a follow-up directed at you.
- Answer ONLY a genuine, substantive follow-up question you can ground in the video content or provided articles.
- If the message is hostile, sarcastic, bait, a rant, or mere disagreement without a question — return SKIP_NO_REPLY. Never argue, never defend yourself, never reply to hostility.
- This is your LAST reply in this thread either way, so make it self-contained and do not invite further questions.`;

export function buildYouTubePlatformContext(videoId: string, entry: BlogIndexEntry, body: string, loaded: string[], isFollowUp = false): string {
  const views = masterViews(entry.topics, loaded);
  const base = YOUTUBE_PROMPT_TEMPLATE
    .replace('{{VIDEO_TITLE}}', entry.title)
    .replace('{{VIDEO_URL}}', `https://youtu.be/${videoId}`)
    .replace('{{VIDEO_PUBLISHED}}', entry.publishedAt?.slice(0, 10) || 'unknown')
    .replace('{{VIDEO_CONTENT}}', body);
  // The template ends with the video's content, so the master views follow it.
  const withViews = views ? `${base}\n\n${views}` : base;
  return isFollowUp ? withViews + FOLLOWUP_POSTURE : withViews;
}

// ---------------------------------------------------------------------------
// Topic masters (US-50 AC6): the current-view section of each master the
// video's post names, then its safety sections, in their own labelled block. chat-youtube-prompt.md names
// this heading and tells the model to ignore the block for reply-or-skip.
// ---------------------------------------------------------------------------

/** The router's handles whose content loaded: not skipped by the cap, and the
 *  load produced something. The master views de-duplicate against these. */
export function loadedHandles(routerHandles: string[], matched: { skipped: string[] } | null): string[] {
  return matched ? routerHandles.filter(h => !matched.skipped.includes(h)) : [];
}

export const MASTER_VIEWS_HEADING = "## Brad's current view and safety notes on this video's topics (added automatically for this video; not router-matched content)";

/**
 * Caps on what the master views add. Every named master's current view goes in
 * first (a view runs about 1,600 to 2,100 characters on the six masters
 * published 2026-10-20); one over MAX_VIEW_CHARS is malformed and is dropped
 * and logged. Safety sections, with the bibliography lines they cite, then fill
 * what is left in topics order: first every master's Drug Interactions, then
 * the Safety and Side Effects sections; one that would pass the cap is skipped
 * and logged, and a master whose interactions were skipped adds no other
 * safety section. Sections go in whole, never trimmed. A master's Drug
 * Interactions section runs about 2,000 to 7,000 characters with its cited
 * references; 80,000 lets the stack post
 * (the-only-three-supplements-doctor-brad-takes), which names ten masters with
 * a view once batch 2 lands, carry every view and every master's interactions
 * (about 79,000 measured 2026-10-21); 40,000 dropped six masters' interactions,
 * vitamin K's warfarin warning among them. An interim figure (orchestrator,
 * 2026-10-21) until each master gains a short "Key safety points" section. The
 * YouTube context is uncached, so every character (about 20,000 tokens at the
 * cap) is paid on every comment.
 */
export const MAX_MASTER_VIEW_CHARS = 80_000;
export const MAX_VIEW_CHARS = 6_000;

/** A master's "Current view" or "Current evidence position" section, heading to
 *  the next `## ` heading or `---` line, demoted one level to sit under MASTER_VIEWS_HEADING.
 *  Null when the master has neither. */
export function currentViewSection(md: string): string | null {
  const body = stripFrontmatter(md);
  const heading = body.match(/^## (?:Current view\b|Current evidence position\b).*$/m);
  if (!heading || heading.index === undefined) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const next = rest.search(/^(?:## |---\s*$)/m);
  return `#${heading[0]}${next === -1 ? rest : rest.slice(0, next)}`.trim();
}

/** A body heading that names safety, side effects, cautions, interactions,
 *  contraindications or who should not take it ("## 5. Safety and Side
 *  Effects", "## 6. Drug Interactions" on the published masters). */
const SAFETY_HEADING = /^## .*\b(?:safety|side effects?|cautions?|interactions?|contraindications?|who should not)\b/i;
const INTERACTIONS_HEADING = /^#+ .*\binteractions?\b/i;

/** A master's bibliography from its References section, marker number to
 *  line: "[n] text" and "n. text" lines both come back as "[n] text". */
function bibliography(body: string): Map<number, string> {
  const refs = body.split(/^(?=## )/m).find(s => /^## .*\bReferences\b/.test(s)) ?? '';
  return new Map([...refs.matchAll(/^(?:\[(\d+)\]|(\d+)\.) +(.+)$/gm)]
    .map(m => [Number(m[1] ?? m[2]), `[${m[1] ?? m[2]}] ${m[3]}`]));
}

/** The marker numbers a section cites: [3], [3, 5] and [6–7]. A bracketed
 *  DOI ("[10.1000/x]") is not a marker. */
function citedNumbers(text: string): number[] {
  const cited = new Set<number>();
  for (const [, list] of text.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
    for (const part of list.split(',')) {
      const [from, to = from] = part.split(/[–-]/).map(Number);
      for (let n = from; n <= Math.min(to, from + 50); n++) cited.add(n);
    }
  }
  return [...cited].sort((a, b) => a - b);
}

/** Each safety section of a master, heading to the next `## ` heading, every
 *  heading in it demoted one level, followed by the bibliography lines its
 *  [n] markers cite. Interactions sections come first. Empty when the master
 *  has none. */
export function safetySections(md: string): string[] {
  const body = stripFrontmatter(md);
  const refs = bibliography(body);
  return body.split(/^(?=## )/m)
    .filter(s => SAFETY_HEADING.test(s))
    .sort((a, b) => Number(INTERACTIONS_HEADING.test(b)) - Number(INTERACTIONS_HEADING.test(a)))
    .map(s => {
      const section = s.replace(/^(#+) /gm, '#$1 ').trim();
      const cited = citedNumbers(section).flatMap(n => refs.get(n) ?? []);
      return cited.length > 0 ? `${section}\n\nReferences cited above:\n\n${cited.join('\n')}` : section;
    });
}

/**
 * The master views for a comment: each reference named in the post's `topics`,
 * once, skipping masters already loaded as router-matched content (pass the
 * loaded handles, from loadedHandles(), never the router's raw picks). Every
 * master with a current view under MAX_VIEW_CHARS adds it; its safety sections
 * follow while they fit the cap, interactions first, and one that does not is
 * skipped and logged. Null when nothing is added.
 */
export function masterViews(topics: string[] | undefined, loaded: string[]): string | null {
  const masters: { handle: string; view: string; safety: string[] }[] = [];
  for (const handle of new Set(topics ?? [])) {
    if (loaded.includes(handle)) continue;
    const entry = loadBlogIndex().find(e => e.handle === handle);
    if (entry?.type !== 'reference') continue;
    const md = loadBlogArticle(handle);
    const section = md && currentViewSection(md);
    if (!section) continue;
    if (section.length > MAX_VIEW_CHARS) {
      console.warn(`YouTube master views: current view over ${MAX_VIEW_CHARS} characters, dropped: ${handle}`);
      continue;
    }
    masters.push({ handle, view: `${contentHeader(entry, parseFrontmatter(md) ?? {})}\n\n${section}`, safety: safetySections(md) });
  }
  if (masters.length === 0) return null;
  // The length of the joined parts below: views, separators, then each safety
  // section with its "\n\n" join.
  const SEPARATOR = '\n\n---\n\n';
  let total = masters.reduce((n, m) => n + m.view.length, SEPARATOR.length * (masters.length - 1));
  // Two passes in topics order: every master's interactions sections, then the
  // other safety sections of each master whose interactions all went in.
  const kept = new Set<string>();
  const blocked = new Set<string>();
  for (const pass of [true, false]) {
    for (const { handle, safety } of masters) {
      for (const s of safety.filter(s => INTERACTIONS_HEADING.test(s) === pass)) {
        if (!blocked.has(handle) && total + s.length + 2 <= MAX_MASTER_VIEW_CHARS) { total += s.length + 2; kept.add(s); continue; }
        if (pass) blocked.add(handle);
        console.warn(`YouTube master views: safety section skipped for the cap: ${handle} "${s.split('\n')[0].slice(1)}"`);
      }
    }
  }
  const parts = masters.map(({ view, safety }) => [view, ...safety.filter(s => kept.has(s))].join('\n\n'));
  return `${MASTER_VIEWS_HEADING}\n\n${parts.join(SEPARATOR)}`;
}
