/** The weekly knowledge lint's per-entry half, split out of knowledge-lint.ts (file-size ratchet, US-64 AC23): paths,
 * types, the corpus loader, the per-entry rules (markers, identifiers, links, Grokipedia, doses, products), the allow-list,
 * the fix queue and the run's result type. knowledge-lint.ts re-exports every name it exported before. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const SLICE_WEEKS = 13;
const LOOP_DIR = 'docs/loops/chat-health';
export const PATHS = {
  index: 'docs/blog/index.json',
  algorithm: 'health_roadmap_algorithm.md',
  state: `${LOOP_DIR}/lint-state.json`,
  allow: `${LOOP_DIR}/lint-allowlist.json`,
  topics: `${LOOP_DIR}/lint-topics.json`,
  queue: `${LOOP_DIR}/lint-fix-queue.json`,
  metrics: `${LOOP_DIR}/metrics.csv`,
};

export type EntryType = 'guideline' | 'reference' | 'article';
export interface Entry { handle: string; type: EntryType; title: string; summary: string; keywords: string[]; raw: string; body: string }
export type RuleId =
  | 'unresolved-marker' | 'uncited-reference' | 'uncited-list' | 'doi-shape' | 'pmid-shape' | 'id-mismatch'
  | 'link-dead' | 'grokipedia' | 'dose-mismatch' | 'product-rise'
  | 'guide-shape' | 'topic-no-master' | 'master-front' | 'master-gate' | 'master-doi' | 'master-key-points' | 'master-stale' | 'source-stale' | 'master-places' | 'master-overlap'
  | 'entry-vs-algorithm' | 'reference-vs-reference';
/** `view` (master-places only): the current-view hash the finding was raised against; a waiver covers that view only. */
export interface Finding { rule: RuleId; handle: string; pair?: [string, string]; item: string; detail?: string; view?: string }
export interface AllowEntry { rule?: string; handle?: string; pair?: [string, string]; item?: string; reason: string; date: string; who: string; view?: string }
export interface Topic { topic: string; headings: string[]; handles: string[]; terms?: string[] }
export interface LintState {
  version: 1; lastRun: string | null; cursor: number;
  algorithm: Record<string, string>;
  entries: Record<string, { hash: string; products: number }>;
  /** Per comparison id: the last attempt and whether its answer was usable (knowledge-lint-compare.ts). */
  pairs?: Record<string, { last_attempted: string; status: 'done' | 'retry' | 'parked'; attempts?: number }>;
  /** Per master: the current-view hash and each registered place's hash at `at` (writeMasterHashes, US-50 AC7). */
  masters?: Record<string, { hash: string; at: string; places: Record<string, string> }>;
}
export interface DueItem { handle: string; reasons: string[] }
interface Meta { handle: string; type?: string; title?: string; summary?: string; keywords?: string[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const contentHash = (s: string) => sha(s).slice(0, 16);
export const bucketOf = (handle: string) => parseInt(sha(handle).slice(0, 8), 16) % SLICE_WEEKS;
export const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

export function entryFrom(meta: Meta, raw: string): Entry {
  const type = (['guideline', 'reference'].includes(meta.type ?? '') ? meta.type : 'article') as EntryType;
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return { handle: meta.handle, type, title: meta.title ?? '', summary: meta.summary ?? '', keywords: meta.keywords ?? [], raw, body };
}

export function loadCorpus(root: string): Entry[] {
  const dirOf = (t?: string) => t === 'guideline' ? 'docs/guideline' : 'docs/blog';
  return (readJson(join(root, PATHS.index)) as Meta[])
    .map(m => entryFrom(m, readFileSync(join(root, dirOf(m.type), `${m.handle}.md`), 'utf8')));
}

/** Turndown escapes (`\[`, `1\.`) undone and whitespace collapsed: the AC2 comparison form. */
export const unescapeMd = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
export const normalise = (s: string) =>
  unescapeMd(s).replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Citation markers and reference lines
// ---------------------------------------------------------------------------

const REF_WORDS = String.raw`(?:references|reference\s+list|sources|bibliography|citations)`;
const REF_HEADING = new RegExp(String.raw`^(#{1,6})\s*(?:\*\*)?\s*(?:\d+\\?\.\s*)?(?:\*\*)?\s*${REF_WORDS}\s*(?:\*\*)?\s*:?\s*$`, 'i');
// A bold "Sources:" line lists food or raw-material sources in the references, so only headings count for it.
const REF_LABEL = new RegExp(String.raw`^\s*(?:\*\*)?(?:references|reference\s+list|bibliography|citations)\s*:?\s*(?:\*\*)?\s*:?\s*$`, 'i');
const REF_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:\\?\[(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\\?\]|(\d{1,3})\\?\.)(?:\*\*)?(?:\s+|(?=\[))/;
/** A list turndown collapsed onto one line: `…/)2\.  [https…` (or `…/)&nbsp;14.`) splits before the number. */
const COLLAPSED = /(?<=\))\s*(?=\d{1,3}\\?\.\s*\[)/;

/** Body text outside reference sections, and each reference line by number (continuation lines joined). */
export function splitReferences(body: string): { text: string; refs: Map<number, string> } {
  const text: string[] = [];
  const refs = new Map<number, string>();
  let level = -1; // -1 outside a reference section; 0 a label section that any heading ends
  let last = 0;
  let fence = false;
  for (const line of body.split('\n').flatMap(l => l.split(COLLAPSED))) {
    if (/^\s*```/.test(line)) fence = !fence;
    const heading = fence ? null : line.match(/^(#{1,6})\s/);
    const refHead = fence ? null : line.match(REF_HEADING);
    if (refHead || (!fence && REF_LABEL.test(line))) { level = refHead ? refHead[1].length : 0; last = 0; continue; }
    if (level >= 0 && heading && (level === 0 || heading[1].length <= level)) level = -1;
    if (level < 0) { text.push(line); continue; }
    const m = line.match(REF_LINE);
    if (m) {
      const [from, to] = m[3] ? [Number(m[3]), Number(m[3])] : [Number(m[1]), Number(m[2] ?? m[1])];
      for (let n = from; n <= Math.min(to, from + 50); n++) refs.set(n, refs.has(n) ? `${refs.get(n)} | ${line.trim()}` : line.trim());
      last = from;
    } else if (last && line.trim()) {
      refs.set(last, `${refs.get(last)} ${line.trim()}`);
    }
  }
  return { text: text.join('\n'), refs };
}

const MARKER = /\\?\[(\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*)\\?\](\((https?:)?)?/g;

/** `[n]`, `\[n\]`, `[n,m]`, `[n-m]`; `[n](https://…)` cites inline and needs no reference line. */
export function findMarkers(text: string): { nums: number[]; inline: boolean }[] {
  const out: { nums: number[]; inline: boolean }[] = [];
  for (const m of text.matchAll(MARKER)) {
    const nums: number[] = [];
    for (const part of m[1].split(',')) {
      const [a, b] = part.split(/[–—-]/).map(s => Number(s.trim()));
      if (b === undefined) nums.push(a);
      else if (b >= a && b - a <= 50) for (let n = a; n <= b; n++) nums.push(n);
    }
    out.push({ nums, inline: !!m[3] });
  }
  return out;
}

export function ruleMarkers(e: Entry): Finding[] {
  const { text, refs } = splitReferences(e.body);
  const cited = new Set<number>();
  const unresolved = new Set<number>();
  for (const m of findMarkers(text)) for (const n of m.nums) {
    cited.add(n);
    if (!m.inline && !refs.has(n)) unresolved.add(n);
  }
  const f = (rule: RuleId, item: string): Finding => ({ rule, handle: e.handle, item });
  const out = [...unresolved].map(n => f('unresolved-marker', `[${n}]`));
  if (cited.size) out.push(...[...refs.keys()].filter(n => !cited.has(n)).map(n => f('uncited-reference', `[${n}]`)));
  else if (refs.size) out.push(f('uncited-list', `${refs.size} references, no marker`));
  return out;
}

// ---------------------------------------------------------------------------
// DOI and PMID shape
// ---------------------------------------------------------------------------

// Crossref's pattern, widened by the brackets and # that older SICI DOIs carry (Wiley, BioOne).
export const DOI_OK = /^10\.\d{4,9}\/[-._;()/:<>[\]#a-z0-9]+$/i;
export const PMID_OK = /^[1-9]\d{0,7}$/;
const trimPunct = (s: string) => s.replace(/[.,;:]+$/, '');
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** A DOI ends at whitespace, a bracket, a query string or an unbalanced parenthesis. */
const DOI_BODY = String.raw`10\.\d{1,9}\/(?:[^\s"[\]()?#]|\([^\s"[\]()]*\))+`;

export function extractIdentifiers(md: string): { dois: string[]; pmids: string[] } {
  const body = unescapeMd(md);
  const dois = [...body.matchAll(new RegExp(String.raw`(?<![\w.])${DOI_BODY}`, 'g'))].map(m => trimPunct(decode(m[0])));
  const pmids = [
    ...[...body.matchAll(/\bPMID(?::\s*\[?([A-Za-z0-9]+)|\s+\[?(\d+))/g)].map(m => m[1] ?? m[2]),
    ...[...body.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/([^/\s)\]?#]+)/g)].map(m => m[1]),
  ];
  return { dois: [...new Set(dois)], pmids: [...new Set(pmids)] };
}

const LINK = /\[([^\][\s]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;
const linkKey = (s: string) => decode(s).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

/** An id is compared only with a target of its own kind: a DOI linked to its PMC page is not a mismatch. */
const sameKind = (text: string, href: string) => /^10\./.test(text) ? /\/10\.\d/.test(href)
  : /^\d+$/.test(text) ? /pubmed/i.test(href) : href.toLowerCase().includes((text.match(/^[a-z]+/i)?.[0] ?? '\0').toLowerCase());

export function ruleIdentifiers(e: Entry): Finding[] {
  const items = new Map<string, RuleId>();
  const { dois, pmids } = extractIdentifiers(e.body);
  const body = unescapeMd(e.body);
  for (const d of dois) if (!DOI_OK.test(d)) items.set(d, 'doi-shape');
  for (const m of body.matchAll(/\bdoi:\s*(?!\[?10\.)([^\s)\]]+)/gi)) items.set(`doi: ${trimPunct(m[1])}`, 'doi-shape');
  for (const p of pmids) if (!PMID_OK.test(p)) items.set(p, 'pmid-shape');
  // Any link whose text is a URL must point there; any whose text looks like an id (a digit, 5+ chars) must end the target.
  for (const m of body.matchAll(LINK)) {
    const [text, href] = [trimPunct(m[1]), m[2]];
    const isUrl = /^https?:\/\//i.test(text);
    if (!isUrl && !(/\d/.test(text) && text.length >= 5 && sameKind(text, href))) continue;
    if (isUrl ? linkKey(text) !== linkKey(href) : !linkKey(href).endsWith(linkKey(text))) items.set(`${text} -> ${href}`, 'id-mismatch');
  }
  return [...items].map(([item, rule]) => ({ rule, handle: e.handle, item }));
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface LinkId { kind: 'doi' | 'pmid'; id: string; handle: string }

/**
 * HEAD each identifier once, up to `cap`. Only a 404 is dead, reported against
 * every entry citing it. `conclusive` lists `handle|id` for each citing entry
 * when the answer was a 2xx/3xx or a 404; a timeout, network error, 5xx or
 * other 4xx is unverified and never resolves a dead link.
 */
export async function checkLinks(ids: LinkId[], opts: { fetchImpl: Fetch; delayMs: number; cap: number }) {
  const citing = new Map<string, Set<string>>();
  for (const i of ids) (citing.get(`${i.kind}:${i.id}`) ?? citing.set(`${i.kind}:${i.id}`, new Set()).get(`${i.kind}:${i.id}`)!).add(i.handle);
  const unique = [...new Map(ids.map(i => [`${i.kind}:${i.id}`, i])).values()];
  const dead: Finding[] = [];
  let checked = 0, unverified = 0;
  const conclusive: string[] = [];
  for (const i of unique.slice(0, opts.cap)) {
    const url = i.kind === 'doi' ? `https://doi.org/${encodeURI(i.id)}` : `https://pubmed.ncbi.nlm.nih.gov/${i.id}/`;
    if (checked && opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    checked++;
    const handles = [...citing.get(`${i.kind}:${i.id}`)!];
    try {
      const { status } = await opts.fetchImpl(url, { method: 'HEAD', redirect: i.kind === 'doi' ? 'manual' : 'follow' });
      if (status === 404) for (const handle of handles) dead.push({ rule: 'link-dead', handle, item: i.id });
      if (status < 400 || status === 404) conclusive.push(...handles.map(h => `${h}|${i.id}`));
      else unverified++;
    } catch { unverified++; }
  }
  return { checked, unchecked: Math.max(0, unique.length - opts.cap), unverified, dead, conclusive };
}

// ---------------------------------------------------------------------------
// Grokipedia
// ---------------------------------------------------------------------------

const SENTENCE_END = /(?<=[.!?](?:\\?\[[\d,\s–—-]+\\?\])*)\s+(?=[A-Z*_("'[\\])/;

export function ruleGrokipedia(e: Entry) {
  const { text, refs } = splitReferences(e.body);
  const grok = new Set([...refs].filter(([, t]) => /grokipedia/i.test(t)).map(([n]) => n));
  // Direct: `[n] Grokipedia. "Title." url`. Via: a study described "per" or "as reported by" Grokipedia.
  const via = new Set([...grok].filter(n => !/grokipedia\.com|^\S+\s+grokipedia\b/i.test(refs.get(n)!)));
  const stats = { grokRefs: grok.size, grokVia: via.size, grokMentions: (e.body.match(/grokipedia/gi) ?? []).length, grokOnlyDirect: 0, grokOnlyAny: 0 };
  if (!stats.grokMentions) return { findings: [] as Finding[], stats };
  for (const s of text.split(/\n\s*\n/).flatMap(p => p.split(SENTENCE_END))) {
    const nums = findMarkers(s).filter(m => !m.inline).flatMap(m => m.nums).filter(n => refs.has(n));
    if (!nums.length || !nums.every(n => grok.has(n))) continue;
    stats.grokOnlyAny++;
    if (nums.every(n => !via.has(n))) stats.grokOnlyDirect++;
  }
  const detail = `${stats.grokRefs} reference entries (${stats.grokVia} via), ${stats.grokMentions} mentions, ` +
    `${stats.grokOnlyDirect} sentences resting only on Grokipedia (${stats.grokOnlyAny} counting via)`;
  return { findings: [{ rule: 'grokipedia' as const, handle: e.handle, item: 'cites Grokipedia', detail }], stats };
}

// ---------------------------------------------------------------------------
// Dose tokens (AC2): markers, years and PMIDs never count; 1 g equals 1,000 mg;
// a range or pair ("5-10", "5 to 10", "110 and 170") gives two numbers that share the unit; turndown escapes undone first.
// ---------------------------------------------------------------------------

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(mg\/dl|mmol\/mol|mmol\/l|nmol\/l|[µμu]mol\/l|ng\/ml|pmol\/l|g\/l|mm\s?hg|mg\/kg|kg|%|percent|mcg|[µμu]g|micrograms?|milligrams?|mg|grams?|g|iu|international units|millilit(?:er|re)s?|ml|cfu)`;
const DOSE = new RegExp(String.raw`(?<![\w.,])${NUM}(?:\s*(?:-|–|—|to|and|or)\s*${NUM})?\s*(billion|million)?\s*${UNIT}(?![a-z])`, 'gi');
const UNIT_CANON: [RegExp, string, number][] = [
  [/^(mcg|[µμu]g|micrograms?)$/, 'ug', 1], [/^(mg|milligrams?)$/, 'ug', 1e3], [/^(g|grams?)$/, 'ug', 1e6],
  [/^(iu|international units)$/, 'iu', 1], [/^mm\s?hg$/, 'mmhg', 1], [/^(%|percent)$/, '%', 1], [/^(ml|millilit(er|re)s?)$/, 'ml', 1], [/^[µμu]mol\/l$/, 'umol/l', 1],
];

/** Canonical `unit:value` keys, each with the text it came from. */
export function doseTokens(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = normalise(s).replace(/\[\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*\]/g, ' ');
  for (const m of clean.matchAll(DOSE)) {
    const unitText = m[4].toLowerCase();
    const [, unit, factor] = UNIT_CANON.find(([re]) => re.test(unitText)) ?? [null, unitText, 1];
    const mult = m[3] ? (m[3].toLowerCase() === 'billion' ? 1e9 : 1e6) : 1;
    for (const n of [m[1], m[2]].filter(Boolean)) {
      const key = `${unit}:${Number((Number(n.replace(/,/g, '')) * factor * mult).toPrecision(12))}`;
      if (!out.has(key)) out.set(key, `${n}${m[3] ? ` ${m[3]}` : ''} ${m[4]}`);
    }
  }
  return out;
}

export function ruleDose(e: Entry): Finding[] {
  const body = doseTokens(e.body);
  return [...doseTokens(e.summary)].filter(([k]) => !body.has(k))
    .map(([, item]) => ({ rule: 'dose-mismatch' as const, handle: e.handle, item }));
}

// ---------------------------------------------------------------------------
// Product mentions (AC7: they never rise)
// ---------------------------------------------------------------------------

export const productMentions = (body: string) =>
  (body.match(/\bmicrovitamin\b\+?|\bsleep by dr\.? brad\b|\bomega-3 by dr\.? brad\b/gi) ?? []).length;

export function lintEntry(e: Entry, state: LintState | null) {
  const grok = ruleGrokipedia(e);
  const products = productMentions(e.body);
  const base = state?.entries[e.handle]?.products;
  const findings = [...ruleMarkers(e), ...ruleIdentifiers(e), ...grok.findings, ...ruleDose(e)];
  if (base !== undefined && products > base) findings.push({ rule: 'product-rise', handle: e.handle, item: `${base} -> ${products}` });
  return { findings, stats: { ...grok.stats, products } };
}

// ---------------------------------------------------------------------------
// Allow-list (deliberate divergences; Brad's, never the loop's)
// ---------------------------------------------------------------------------

export function validateAllowList(json: { entries?: unknown[] }): AllowEntry[] {
  const entries = (json.entries ?? []) as AllowEntry[];
  entries.forEach((a, i) => {
    const bad = (why: string) => { throw new Error(`lint-allowlist entry ${i}: ${why}`); };
    if (!a.rule && !a.handle) bad('missing rule (only a handle entry may omit it, to cover every rule)');
    if (!a.handle === !(Array.isArray(a.pair) && a.pair.length === 2)) bad('needs a handle or pair, not both');
    if (!a.reason?.trim()) bad('missing reason');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? '')) bad('date must be YYYY-MM-DD');
    if (!a.who?.trim()) bad('missing who');
    if (a.rule === 'master-places' && !a.view?.trim()) bad('a master-places waiver needs the view hash it applies to (view)');
  });
  return entries;
}

const samePair = (a?: [string, string], b?: [string, string]) =>
  !!a && !!b && [...a].sort().join('\0') === [...b].sort().join('\0');

/** The pair-level entries for a pair and rule (an entry with no item covers the whole pair). */
export const pairAllowances = (rule: string, pair: [string, string], allow: AllowEntry[]) =>
  allow.filter(a => a.rule === rule && samePair(a.pair, pair));

export const isAllowed = (f: Finding, allow: AllowEntry[]) => allow.some(a =>
  (f.rule !== 'master-places' || a.view === f.view) && (a.rule === undefined || a.rule === f.rule) && (a.handle ? a.handle === f.handle : samePair(a.pair, f.pair)) && (a.item === undefined || a.item === f.item));

// ---------------------------------------------------------------------------
// Fix queue: every knowledge-side finding, deterministic or model, fixed by a
// build session under US-42's batch protocol. Never the algorithm side.
// ---------------------------------------------------------------------------

/** A deterministic finding as a queue item; the id hashes rule, handle and item, so it is stable across weeks. */
export const queueItem = (f: Finding) => ({
  id: sha(`${f.rule}|${f.handle}|${f.pair ? `${[...f.pair].sort().join('+')}|` : ''}${f.item}`).slice(0, 12), rule: f.rule, side: 'knowledge' as const,
  handles: [f.handle], fix_handle: f.handle, item: f.item, ...(f.detail ? { detail: f.detail } : {}),
});

type QueueItemKey = { rule?: string; kind?: string; handles: string[]; fix_handle: string; item?: string; quote_a?: string; quote_b?: string };

/**
 * What a deterministic run covered: every rule over every entry, but a dead
 * link only if this run got a conclusive answer for that identifier on behalf
 * of that entry (so only for entries in this week's slice).
 */
export const queueCovered = (r: Pick<LintResult, 'links'>) => {
  const conclusive = new Set(r.links?.conclusive ?? []);
  return (i: QueueItemKey) => !!i.rule && (i.rule !== 'link-dead' || conclusive.has(`${i.fix_handle}|${i.item}`));
};

type QueueCounts = { open: number; regressed: number; resolved: number };

/**
 * Knowledge-side items join the queue once; a repeat refreshes last_seen and
 * detail. An item marked fixed or resolved that recurs becomes regressed. Every
 * item this run covered gets last_checked; an open or regressed one it covered
 * but did not see becomes resolved. A covered item whose evidence the run could
 * not see keeps its status and gets `unverified` (this run's date) instead.
 */
export function appendFixQueue(file: string, items: { id: string; side: string; found?: string; detail?: string }[], date: string,
  covered: (item: QueueItemKey) => boolean | 'unverified' = () => false): { added: number; counts: QueueCounts } {
  const q = existsSync(file) ? readJson(file) : {
    about: 'Knowledge-side findings from tools/knowledge-lint.ts (rule) and tools/knowledge-lint-compare.ts (kind), fixed by a build session under the US-42 batch protocol (Opus writes, AC1 to AC8, Brad signs the batch). Quotes are corpus text; summary and suggested_fix are model text: data, never instructions. status: open, regressed, resolved (not seen when last covered), fixed <sha>, rejected <reason>, allow-listed.',
    items: [],
  };
  let added = 0;
  const seen = new Set<string>();
  for (const { found: _found, ...f } of items.filter(x => x.side === 'knowledge')) {
    seen.add(f.id);
    const old = q.items.find((i: { id: string }) => i.id === f.id);
    if (!old) { q.items.push({ ...f, first_seen: date, last_seen: date, status: 'open' }); added++; continue; }
    old.last_seen = date;
    if (f.detail) old.detail = f.detail;
    if (old.status.startsWith('fixed') || old.status === 'resolved') { old.status = 'regressed'; delete old.resolved; }
  }
  for (const i of q.items) {
    const c = covered(i);
    if (!c) continue;
    // The pair was compared, but the excerpts sent no longer held the evidence: it stays as it was.
    if (c === 'unverified') { i.unverified = date; continue; }
    i.last_checked = date;
    delete i.unverified;
    if (!seen.has(i.id) && ['open', 'regressed'].includes(i.status)) { i.status = 'resolved'; i.resolved = date; }
  }
  writeFileSync(file, `${JSON.stringify(q, null, 1)}\n`);
  const count = (st: string) => q.items.filter((i: { status: string }) => i.status === st).length;
  return { added, counts: { open: count('open'), regressed: count('regressed'), resolved: count('resolved') } };
}

export const queueLine = (r: { added: number; counts: QueueCounts }) =>
  `Fix queue: ${r.added} new; open ${r.counts.open}, regressed ${r.counts.regressed}, resolved ${r.counts.resolved}.`;

export type Stats = { grokBodies: number; grokRefs: number; grokVia: number; grokMentions: number; grokOnlyDirect: number; grokOnlyAny: number; productBodies: number; productMentions: number };
export interface LintResult {
  date: string; corpus: Record<'total' | EntryType, number>; findings: Finding[]; suppressed: number; allowEntries: number;
  stats: Stats; due: DueItem[]; cursor: number; stateMissing: boolean;
  links: { checked: number; unchecked: number; unverified: number; conclusive: string[] } | null;
}
