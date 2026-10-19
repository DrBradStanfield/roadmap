// The router's view of the knowledge-base index, shared by the production router
// (chat-router.server.ts) and its harness (tools/test-chatbot-matching.ts).
// Sentry-free, so the harness can import it under tsx.
import type { BlogIndexEntry } from './blog-index.server';

/**
 * The index the router sees (US-50 AC3). A `router: hidden` article leaves it
 * only when every master in its `topics` is a reference reviewed (YYYY-MM-DD)
 * on or after the post's publish date, so a stale master never answers alone and a newer video
 * stays visible until its master catches up. Every other entry stays.
 * `TOPIC_MASTER_HIDE=off` is the rollback: the full index.
 */
export function routerView(index: BlogIndexEntry[], hide = process.env.TOPIC_MASTER_HIDE !== 'off'): BlogIndexEntry[] {
  if (!hide) return index;
  const byHandle = new Map(index.map(e => [e.handle, e]));
  const covered = (post: BlogIndexEntry) => {
    const day = post.publishedAt?.slice(0, 10);
    return !!day && !!post.topics?.length && post.topics.every(t => {
      const master = byHandle.get(t);
      return master?.type === 'reference' && /^\d{4}-\d{2}-\d{2}$/.test(master.reviewed ?? '') && master.reviewed! >= day;
    });
  };
  return index.filter(e => !(e.router === 'hidden' && (e.type ?? 'article') === 'article' && covered(e)));
}

/**
 * Cap on summary length in the ROUTER's view of the index.
 *
 * The router's job is discriminative — "is this entry about the user's topic?" —
 * which does not need the full summary. Full summaries averaged 269 chars and
 * made the rendered index ~81K tokens; capping at 150 brings it to ~44K (54%)
 * with no entries dropped.
 *
 * Measured with tools/test-chatbot-matching.ts (--runs 1, 2026-08-07), routing
 * did NOT degrade — it improved slightly in every arm:
 *   symptomatic (n=81):  baseline 92.6%  →  cap150 96.3%  →  cap120 93.8%
 *   supplement  (n=16):  baseline 81.3%  →  cap120 87.5%
 * Likely mechanism: less prose to scan sharpens the signal. Differences are
 * within single-run noise, so treat this as "no degradation detected" rather
 * than a proven gain — but the direction was consistent across all three.
 *
 * Only the ROUTER sees the truncated text. index.json is untouched, and
 * buildKnowledgeOverview() in chat.server.ts keeps its own 50-word cap.
 * The harness's --summary-cap overrides it for A/B runs.
 */
export const ROUTER_SUMMARY_MAX_CHARS = 150;

function capSummary(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  // Prefer a clause boundary so we never sever mid-word.
  for (const sep of ['. ', '; ', ', ', ' ']) {
    const p = cut.lastIndexOf(sep);
    if (p > max * 0.6) return cut.slice(0, p).replace(/[ ,;.]+$/, '');
  }
  return cut.trimEnd();
}

// Type order: pathway, guideline, reference, article (clinical first).
const TYPE_ORDER: Record<string, number> = { pathway: 0, guideline: 1, reference: 2, article: 3 };
const typeRank = (e: BlogIndexEntry) => TYPE_ORDER[e.type ?? 'article'] ?? 3;

/**
 * The router's index block: one line per entry, sorted by type then handle for
 * stable Anthropic cache keys. Locking this sort order; changes = cache miss.
 */
export function routerIndexBlock(view: BlogIndexEntry[], summaryCap = ROUTER_SUMMARY_MAX_CHARS): string {
  return [...view]
    .sort((a, b) => typeRank(a) - typeRank(b) || a.handle.localeCompare(b.handle))
    .map(e => `[${e.type ?? 'article'}] ${e.handle}: ${capSummary(e.summary ?? e.title ?? '', summaryCap)}`)
    .join('\n');
}
