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

export function buildYouTubePlatformContext(videoId: string, entry: BlogIndexEntry, body: string, routerHandles: string[], isFollowUp = false): string {
  const views = masterViews(entry.topics, routerHandles);
  const base = YOUTUBE_PROMPT_TEMPLATE
    .replace('{{VIDEO_TITLE}}', entry.title)
    .replace('{{VIDEO_URL}}', `https://youtu.be/${videoId}`)
    .replace('{{VIDEO_CONTENT}}', body);
  // The template ends with the video's content, so the master views follow it.
  const withViews = views ? `${base}\n\n${views}` : base;
  return isFollowUp ? withViews + FOLLOWUP_POSTURE : withViews;
}

// ---------------------------------------------------------------------------
// Topic masters (US-50 AC6): the current-view section of each master the
// video's post names, in its own labelled block. chat-youtube-prompt.md names
// this heading and tells the model to ignore the block for reply-or-skip.
// ---------------------------------------------------------------------------

export const MASTER_VIEWS_HEADING = "## Brad's current view on this video's topics (added automatically for this video; not router-matched content)";

/**
 * Cap on the master views one comment adds. A current-view section is 3 to 6
 * sentences (about 1,000 to 2,000 characters), so 12,000 holds every master a
 * post names today with room to spare, while a malformed section (a missing
 * next heading pulling in the whole 29K to 83K reference) is skipped. The
 * YouTube context is uncached, so every character is paid on every comment.
 */
export const MAX_MASTER_VIEW_CHARS = 12_000;

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

/**
 * The master views for a comment: each reference named in the post's `topics`,
 * once, skipping masters the router already loaded (they arrive whole as
 * router-matched content). A section that would pass the cap is skipped, never
 * the rest. Null when nothing is added.
 */
export function masterViews(topics: string[] | undefined, routerHandles: string[]): string | null {
  const parts: string[] = [];
  let total = 0;
  for (const handle of new Set(topics ?? [])) {
    if (routerHandles.includes(handle)) continue;
    const entry = loadBlogIndex().find(e => e.handle === handle);
    if (entry?.type !== 'reference') continue;
    const md = loadBlogArticle(handle);
    const section = md && currentViewSection(md);
    if (!section) continue;
    const block = `${contentHeader(entry, parseFrontmatter(md) ?? {})}\n\n${section}`;
    if (total + block.length > MAX_MASTER_VIEW_CHARS) continue;
    parts.push(block);
    total += block.length;
  }
  return parts.length > 0 ? `${MASTER_VIEWS_HEADING}\n\n${parts.join('\n\n---\n\n')}` : null;
}
