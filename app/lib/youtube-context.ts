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
 * Caps on what the master views add. One master's block (header, current view,
 * safety sections) runs 4,900 (taurine) to 12,900 characters (vitamin C) on the
 * six masters published 2026-10-20, so 16,000 per master holds each with room,
 * while a malformed section (a missing next heading pulling in the whole 29K to
 * 83K reference) is skipped. A block over the cap is dropped whole: the view is
 * never sent without its safety text. The 30,000 total holds the two largest
 * masters together, or three typical ones; the YouTube context is uncached, so
 * every character (about 7,500 tokens at the total) is paid on every comment.
 */
export const MAX_MASTER_BLOCK_CHARS = 16_000;
export const MAX_MASTER_VIEW_CHARS = 30_000;

/** A master's "Current view" or "Current evidence position" section, heading to
 *  the next `## ` heading, demoted one level to sit under MASTER_VIEWS_HEADING.
 *  Null when the master has neither. */
export function currentViewSection(md: string): string | null {
  const body = stripFrontmatter(md);
  const heading = body.match(/^## (?:Current view\b|Current evidence position\b).*$/m);
  if (!heading || heading.index === undefined) return null;
  const rest = body.slice(heading.index + heading[0].length);
  const next = rest.search(/^## /m);
  return `#${heading[0]}${next === -1 ? rest : rest.slice(0, next)}`.trim();
}

/** A body heading that names safety, side effects, cautions, interactions,
 *  contraindications or who should not take it ("## 5. Safety and Side
 *  Effects", "## 6. Drug Interactions" on the published masters). */
const SAFETY_HEADING = /^## .*\b(?:safety|side effects?|cautions?|interactions?|contraindications?|who should not)\b/i;

/** Each safety section of a master, heading to the next `## ` heading, every
 *  heading in it demoted one level. Empty when the master has none. */
export function safetySections(md: string): string[] {
  return stripFrontmatter(md).split(/^(?=## )/m)
    .filter(s => SAFETY_HEADING.test(s))
    .map(s => s.replace(/^(#+) /gm, '#$1 ').trim());
}

/**
 * The master views for a comment: each reference named in the post's `topics`,
 * once, skipping masters already loaded as router-matched content (pass the
 * loaded handles, from loadedHandles(), never the router's raw picks). A master
 * with a current view adds it, then its safety sections. A master whose block
 * would pass either cap is skipped whole, never the rest. Null when nothing is
 * added.
 */
export function masterViews(topics: string[] | undefined, loaded: string[]): string | null {
  const parts: string[] = [];
  let total = 0;
  for (const handle of new Set(topics ?? [])) {
    if (loaded.includes(handle)) continue;
    const entry = loadBlogIndex().find(e => e.handle === handle);
    if (entry?.type !== 'reference') continue;
    const md = loadBlogArticle(handle);
    const section = md && currentViewSection(md);
    if (!section) continue;
    const block = [contentHeader(entry, parseFrontmatter(md) ?? {}), section, ...safetySections(md)].join('\n\n');
    if (block.length > MAX_MASTER_BLOCK_CHARS || total + block.length > MAX_MASTER_VIEW_CHARS) continue;
    parts.push(block);
    total += block.length;
  }
  return parts.length > 0 ? `${MASTER_VIEWS_HEADING}\n\n${parts.join('\n\n---\n\n')}` : null;
}
