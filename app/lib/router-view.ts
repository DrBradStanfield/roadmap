// The router's view of the knowledge-base index, shared by the production router
// (chat-router.server.ts) and its harness (tools/test-chatbot-matching.ts).
// Sentry-free, so the harness can import it under tsx.
import { isMaster, type BlogIndexEntry } from './blog-index.server';

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
  return index.filter(e => !(e.router === 'hidden' && (e.type ?? 'article') === 'article' && covered(e, byHandle)));
}

/** Every topic of the post is a master (AC1) reviewed on or after its publish day (AC3; AC14 uses the same test). */
function covered(post: BlogIndexEntry, byHandle: Map<string, BlogIndexEntry>): boolean {
  const day = post.publishedAt?.slice(0, 10);
  return !!day && !!post.topics?.length && post.topics.every(t => {
    const master = byHandle.get(t);
    return !!master && isMaster(master) && master.reviewed! >= day;
  });
}

const slugsOf = (e: BlogIndexEntry) => [e.handle, e.commerceUrl?.split(/[?#]/)[0].split('/').pop()];

const isArticle = (e: BlogIndexEntry) => (e.type ?? 'article') === 'article';

/**
 * The posts a message names (US-50 AC14), in the order it names them: any
 * article whose handle or microvitamin.com slug it gives in a
 * /blogs/<blog>/<slug> path, or as a bare hyphenated word of at least 4 words
 * ("calcium-rich-foods" names nothing). Callers pass the whole message, not
 * the router's 2,000-character cut. Linear in the message: the lookbehind
 * stops the bare-word pattern restarting inside a run.
 */
export function namedArticles(index: BlogIndexEntry[], message: string): Set<string> {
  const text = message.toLowerCase();
  const said = new Map<string, number>();
  for (const m of text.matchAll(/\/blogs\/[^/\s]+\/([a-z0-9-]+)/g)) if (!said.has(m[1])) said.set(m[1], m.index!);
  for (const m of text.matchAll(/(?<![a-z0-9])[a-z0-9]+(?:-[a-z0-9]+){3,}/g)) if (!said.has(m[0])) said.set(m[0], m.index!);
  const at = (e: BlogIndexEntry) => Math.min(...slugsOf(e).map(s => (s && said.has(s) ? said.get(s)! : Infinity)));
  return new Set(index.filter(e => isArticle(e) && at(e) < Infinity).sort((a, b) => at(a) - at(b)).map(e => e.handle));
}

/** Trailing words that name no topic on their own; "fish oil" still names its master. */
const GENERIC_TAIL = /\s+(supplements|boosters|powders|powder|fish oil|oil|peptides|extract)$/;

/**
 * Patterns for the names a message gives a master's topic (round 2, N2): each
 * part of its title before the colon, split on "(", ")", ",", "/" and " and ";
 * each part also without its generic trailing words, and its first word when
 * that has a digit or hyphen or is in capitals (omega-3, NAD, NMN). A final
 * "s" is optional.
 */
const topicNames = (e: BlogIndexEntry) => {
  const names = new Set<string>();
  for (const part of e.title.split(':')[0].split(/[(),/]|\s+and\s+/).map(p => p.trim()).filter(Boolean)) {
    let name = part.toLowerCase();
    names.add(name);
    for (let tail; (tail = GENERIC_TAIL.exec(name)); name = name.slice(0, tail.index)) if (tail[1] === 'fish oil') names.add('fish oil');
    names.add(name);
    const word = part.split(/\s+/)[0];
    if (/[\d-]/.test(word) || (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word))) names.add(word.toLowerCase());
  }
  return [...names].map(n => new RegExp(`(?<![a-z0-9])${n.replace(/s$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?![a-z0-9])`));
};

/**
 * The post the storefront chat is open on (US-50 AC14): the article whose
 * handle or microvitamin.com slug is `value`, else undefined. `value` is
 * untrusted: it is only compared with index slugs, never stored.
 */
export function openArticle(index: BlogIndexEntry[], value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return index.find(e => isArticle(e) && slugsOf(e).includes(value))?.handle;
}

/**
 * The router's picks with each older post replaced by its topic masters, in
 * its slot (US-50 AC14). An article gives way only when every one of its
 * `topics` is a master reviewed on or after its publish day (covered(), the
 * routerView test, US-50 AC3 and AC5). A post's masters rank by where the message
 * names their topic (topicNames), earliest first, then by its `topics` order.
 * A post the message names, the `open` one or one in `keep` (the YouTube
 * video's own post) stays when picked. Call it only on a turn the router ran.
 * At most 3 handles, in passes: (1) every pick that stays, in its own slot;
 * (2) per replaced pick, its first-ranked master not yet in, in that slot
 * (each pick owns a slot, so one always fits); (3) the open post when the
 * router picked nothing or one of its masters is in, then each post the
 * message names that the router did not pick (not one in `keep`), in the
 * order the message names them; (4) the ranked masters of every named, open
 * or kept post that stays, picked ones in slot order, then pass-3 ones;
 * (5) the other masters of replaced picks, in slot order. The list is in slot
 * order; a pass-3 post sits after the first of its own masters in the final
 * list, else at the end.
 */
export function preferMasters(picks: string[], index: BlogIndexEntry[], message: string, opts: { open?: string; keep?: string[] } = {}): { handles: string[]; replaced: string[] } {
  const { open, keep = [] } = opts;
  const byHandle = new Map(index.map(e => [e.handle, e]));
  const text = message.toLowerCase();
  const named = namedArticles(index, message);
  const mentionedAt = (m: string) => Math.min(Infinity, ...topicNames(byHandle.get(m)!).map(re => text.search(re)).filter(i => i >= 0));
  const mastersOf = (h: string) => {
    const entry = byHandle.get(h);
    const masters = entry && isArticle(entry) ? (entry.topics ?? []).filter(t => { const m = byHandle.get(t); return !!m && isMaster(m); }) : [];
    return masters.map((m, i) => ({ m, i, at: mentionedAt(m) })).sort((a, b) => a.at - b.at || a.i - b.i).map(x => x.m);
  };
  // Chosen handles and their sort keys: slot * 100 + place in the slot; pass-3 masters go last, in order.
  const chosen = new Map<string, number>();
  const LAST = 1e6;
  const take = (h: string, key: number) => { if (!chosen.has(h) && chosen.size < 3) chosen.set(h, key); };
  const rest: [string, number][] = [];
  const replaced: string[] = [];
  const unique = [...new Set(picks)];
  const toReplace: [string[], number][] = [];
  const staying: [string, number][] = [];
  unique.forEach((pick, slot) => {
    const masters = mastersOf(pick);
    const entry = byHandle.get(pick);
    const isNamed = named.has(pick) || pick === open || keep.includes(pick);
    if (!isNamed && !!entry && isArticle(entry) && covered(entry, byHandle)) { replaced.push(pick); toReplace.push([masters, slot]); return; }
    take(pick, slot * 100);
    if (isNamed) staying.push([pick, slot * 100]);
  });
  for (const [masters, slot] of toReplace) {
    const first = masters.find(m => !chosen.has(m));
    if (first) take(first, slot * 100);
    masters.forEach((m, j) => rest.push([m, slot * 100 + 1 + j]));
  }
  const forced: string[] = [];
  const openFits = !!open && (unique.length === 0 || mastersOf(open).some(m => chosen.has(m)));
  for (const post of [...(open && openFits ? [open] : []), ...[...named].filter(h => !keep.includes(h))]) {
    if (unique.includes(post) || chosen.has(post) || chosen.size >= 3) continue;
    chosen.set(post, LAST);
    forced.push(post);
    staying.push([post, LAST]);
  }
  for (const [post, key] of staying) mastersOf(post).forEach((m, j) => take(m, key === LAST ? LAST + chosen.size : key + 1 + j));
  for (const [m, key] of rest.sort((a, b) => a[1] - b[1])) take(m, key);
  const handles = [...chosen].filter(([h]) => !forced.includes(h)).sort((a, b) => a[1] - b[1]).map(([h]) => h);
  for (const post of forced) {
    const anchor = mastersOf(post).map(m => handles.indexOf(m)).find(i => i >= 0);
    handles.splice(anchor === undefined ? handles.length : anchor + 1, 0, post);
  }
  return { handles, replaced };
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
