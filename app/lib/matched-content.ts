import fs from 'fs';
import path from 'path';
import { isMaster, loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { parseFrontmatter, stripFrontmatter } from './frontmatter';
// A cycle (youtube-context imports this file); both use the other only inside functions.
import { reducedMaster } from './youtube-context';

// Sentry-free on purpose: the router harness and the YouTube dry run import this
// under tsx, which cannot follow chat.server.ts's server import chain. Paths
// resolve from process.cwd(), so run those tools from the repo root.

// ~30K tokens. Above the largest entry in the corpus (the B vitamins master,
// about 106,000 body chars), so any single routed entry fits (US-15 AC23). Two
// masters often pass it together (vitamin D + vitamin K, about 134,000): the
// second then loads reduced (US-50 AC13).
export const MAX_BLOG_CHARS = 120_000;

const articleCache = new Map<string, string | null>();

function contentDir(handle: string): string {
  const type = loadBlogIndex().find(a => a.handle === handle)?.type;
  if (type === 'guideline') return 'docs/guideline';
  if (type === 'pathway') return 'docs/pathway';
  return 'docs/blog';
}

/**
 * Load the full markdown of a blog article, reference, guideline or pathway.
 * Memoized: articles don't change at runtime. Null if the file doesn't exist.
 */
export function loadBlogArticle(handle: string): string | null {
  // Validate handle to prevent path traversal
  if (!/^[a-z0-9-]+$/.test(handle)) return null;

  const cached = articleCache.get(handle);
  if (cached !== undefined) return cached;

  try {
    const content = fs.readFileSync(
      path.join(process.cwd(), contentDir(handle), `${handle}.md`), 'utf-8',
    );
    articleCache.set(handle, content);
    return content;
  } catch {
    articleCache.set(handle, null);
    return null;
  }
}

/**
 * The line a loaded block opens with: its type and date (US-50 AC5), so the
 * answer model can rank a master's current view above an older post. Then the
 * title and the links the posture rules cite, from the file's own frontmatter,
 * which is otherwise stripped (US-50 AC4); a pathway gains no link it never had.
 */
export function contentHeader(entry: BlogIndexEntry | undefined, fm: Record<string, unknown>): string {
  const type = entry?.type ?? 'article';
  const day = entry?.publishedAt?.slice(0, 10);
  const kind = type === 'article' && entry?.youtube ? 'video post' : type;
  const label = entry?.reviewed ? `${kind} — reviewed ${entry.reviewed}` : day ? `${kind} — published ${day}` : kind;
  const links = ['title', 'url', 'commerceUrl', 'youtube'].filter(k => typeof fm[k] === 'string').map(k => `${k}: ${fm[k]}`);
  return [`[${label}]`, ...links].join('\n');
}

/** An entry as the answer model reads it: header, then the body without frontmatter. */
export function contentBlock(handle: string, content: string): string {
  const entry = loadBlogIndex().find(a => a.handle === handle);
  return `${contentHeader(entry, parseFrontmatter(content) ?? {})}\n\n${stripFrontmatter(content)}`;
}

/**
 * Concatenate the content for the router's handles, in order, up to
 * MAX_BLOG_CHARS, each as contentBlock() gives it, so frontmatter never counts
 * (US-50 AC4). A topic master that would overflow the cap loads reduced, as
 * reducedMaster() gives it, so its safety sections still reach the model
 * (US-50 AC13). Any other entry, or a master whose reduced form still does not
 * fit, is skipped (listed in `skipped`), never the rest of the list (US-15 AC23). `titles` names the
 * entries loaded, from the blog index, never model output (US-15 AC20), and
 * only those in `titled`; the content is the same either way (US-15 AC25).
 */
export function loadMatchedContent(handles: string[], titled = handles): { content: string | null; titles: string[]; skipped: string[] } {
  const parts: string[] = [];
  const titles: string[] = [];
  const skipped: string[] = [];
  let totalChars = 0;
  for (const handle of handles) {
    const raw = loadBlogArticle(handle);
    if (!raw) continue;
    const entry = loadBlogIndex().find(a => a.handle === handle);
    let content = contentBlock(handle, raw);
    const reduced = totalChars + content.length > MAX_BLOG_CHARS && entry && isMaster(entry) && reducedMaster(raw);
    if (reduced) {
      content = `${contentHeader(entry, parseFrontmatter(raw) ?? {})}\n\n[Shortened to fit the content limit: this page's current view and safety sections only. The full page has ${stripFrontmatter(raw).length.toLocaleString('en-US')} characters.]\n\n${reduced}`;
    }
    if (totalChars + content.length > MAX_BLOG_CHARS) {
      skipped.push(handle);
      continue;
    }
    parts.push(content);
    totalChars += content.length;
    if (entry?.title && titled.includes(handle)) titles.push(entry.title);
  }
  return { content: parts.length > 0 ? parts.join('\n\n---\n\n') : null, titles, skipped };
}
