/**
 * Weekly knowledge lint, deterministic half (US-43; knowledge-refresh plan
 * Phase 3 and decision 6). No model, no network unless --check-links.
 *
 * Rules, over docs/blog (references and video articles), docs/pathway and
 * docs/guideline, every entry every week (they are cheap):
 *   unresolved-marker / uncited-reference / uncited-list   every [n] resolves (AC7)
 *   doi-shape / pmid-shape / id-mismatch / link-dead        identifiers (AC7)
 *   grokipedia                                             no body cites Grokipedia (AC7, F6)
 *   dose-mismatch       a number plus unit in index.json's summary the body never states (AC2 tokeniser)
 *   product-rise        product mentions above the stored baseline (AC7)
 * The selector picks what the model half (knowledge-lint-compare.ts) reads this
 * week: entries changed since the last run, entries whose algorithm topic
 * changed, and one of 13 hash buckets, so a full pass takes about a quarter.
 * docs/loops/chat-health/lint-allowlist.json holds deliberate divergences; every
 * rule consults it.
 *
 * Usage (from the repo root):
 *   npx tsx tools/knowledge-lint.ts                 all rules; the report to stdout
 *   npx tsx tools/knowledge-lint.ts --dry-run       the handles due this week, nothing else
 *     --out <file.md>         also write the report (at most 150 lines, LOOP.md)
 *     --json <file.json>      every finding, uncapped
 *     --check-links [--link-cap 500] [--link-delay-ms 1000]
 *                             HEAD the DOIs and PMIDs of this week's due entries
 *     --append-metrics <YYYY-Www>   append the counts to chat-health/metrics.csv
 *     --queue                 add each finding to lint-fix-queue.json (knowledge side, once)
 *     --init-state            write the first lint-state.json (refuses if one exists)
 *     --save-state            advance the state; run it after the compare step
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getArg } from '../packages/health-core/src/models';

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

export type EntryType = 'pathway' | 'guideline' | 'reference' | 'article';
export interface Entry { handle: string; type: EntryType; title: string; summary: string; keywords: string[]; raw: string; body: string }
export type RuleId =
  | 'unresolved-marker' | 'uncited-reference' | 'uncited-list' | 'doi-shape' | 'pmid-shape' | 'id-mismatch'
  | 'link-dead' | 'grokipedia' | 'dose-mismatch' | 'product-rise'
  | 'entry-vs-algorithm' | 'pathway-vs-reference' | 'reference-vs-reference';
export interface Finding { rule: RuleId; handle: string; pair?: [string, string]; item: string; detail?: string }
export interface AllowEntry { rule: string; handle?: string; pair?: [string, string]; item?: string; reason: string; date: string; who: string }
export interface Topic { topic: string; headings: string[]; handles: string[]; terms?: string[] }
export interface LintState {
  version: 1; lastRun: string | null; cursor: number;
  algorithm: Record<string, string>;
  entries: Record<string, { hash: string; products: number }>;
}
export interface DueItem { handle: string; reasons: string[] }
interface Meta { handle: string; type?: string; title?: string; summary?: string; keywords?: string[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const contentHash = (s: string) => sha(s).slice(0, 16);
export const bucketOf = (handle: string) => parseInt(sha(handle).slice(0, 8), 16) % SLICE_WEEKS;
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

export function entryFrom(meta: Meta, raw: string): Entry {
  const type = (['pathway', 'guideline', 'reference'].includes(meta.type ?? '') ? meta.type : 'article') as EntryType;
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return { handle: meta.handle, type, title: meta.title ?? '', summary: meta.summary ?? '', keywords: meta.keywords ?? [], raw, body };
}

export function loadCorpus(root: string): Entry[] {
  const dirOf = (t?: string) => t === 'pathway' ? 'docs/pathway' : t === 'guideline' ? 'docs/guideline' : 'docs/blog';
  return (readJson(join(root, PATHS.index)) as Meta[])
    .map(m => entryFrom(m, readFileSync(join(root, dirOf(m.type), `${m.handle}.md`), 'utf8')));
}

/** Turndown escapes (`\[`, `1\.`) undone and whitespace collapsed: the AC2 comparison form. */
const unescapeMd = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
export const normalise = (s: string) =>
  unescapeMd(s).replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Citation markers and reference lines
// ---------------------------------------------------------------------------

const REF_WORDS = String.raw`(?:references|reference\s+list|sources|bibliography|citations)`;
const REF_HEADING = new RegExp(String.raw`^(#{1,6})\s*(?:\*\*)?\s*(?:\d+\\?\.\s*)?(?:\*\*)?\s*${REF_WORDS}\s*(?:\*\*)?\s*:?\s*$`, 'i');
// A bold "Sources:" line lists food or raw-material sources in the references, so only headings count for it.
const REF_LABEL = new RegExp(String.raw`^\s*(?:\*\*)?(?:references|reference\s+list|bibliography|citations)\s*:?\s*(?:\*\*)?\s*:?\s*$`, 'i');
const REF_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:\\?\[(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\\?\]|(\d{1,3})\\?\.)(?:\*\*)?\s+/;
/** A list turndown collapsed onto one line: `…/)2\.  [https…` splits before the 2. */
const COLLAPSED = /(?<=\))(?=\d{1,3}\\?\.\s+\[)/;

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
const DOI_OK = /^10\.\d{4,9}\/[-._;()/:<>[\]#a-z0-9]+$/i;
const PMID_OK = /^[1-9]\d{0,7}$/;
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

export function ruleIdentifiers(e: Entry): Finding[] {
  const items = new Map<string, RuleId>();
  const { dois, pmids } = extractIdentifiers(e.body);
  const body = unescapeMd(e.body);
  for (const d of dois) if (!DOI_OK.test(d)) items.set(d, 'doi-shape');
  for (const m of body.matchAll(/\bdoi:\s*(?!\[?10\.)([^\s)\]]+)/gi)) items.set(`doi: ${trimPunct(m[1])}`, 'doi-shape');
  for (const p of pmids) if (!PMID_OK.test(p)) items.set(p, 'pmid-shape');
  for (const m of body.matchAll(new RegExp(String.raw`\[(10\.[^\]\s]+)\]\(https?:\/\/(?:dx\.)?doi\.org\/(${DOI_BODY})`, 'g'))) {
    const [text, href] = [m[1], m[2]].map(s => trimPunct(decode(s)).toLowerCase());
    if (text !== href) items.set(`${m[1]} -> ${m[2]}`, 'id-mismatch');
  }
  for (const m of body.matchAll(/PMID:?\s*\[(\d+)\]\(https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?\)/g)) {
    if (m[1] !== m[2]) items.set(`PMID ${m[1]} -> ${m[2]}`, 'id-mismatch');
  }
  return [...items].map(([item, rule]) => ({ rule, handle: e.handle, item }));
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface LinkId { kind: 'doi' | 'pmid'; id: string; handle: string }

/** HEAD each identifier once, up to `cap`. Only a 404 is dead; anything else unexpected is unverified. */
export async function checkLinks(ids: LinkId[], opts: { fetchImpl: Fetch; delayMs: number; cap: number }) {
  const unique = [...new Map(ids.map(i => [`${i.kind}:${i.id}`, i])).values()];
  const dead: Finding[] = [];
  let checked = 0, unverified = 0;
  for (const i of unique.slice(0, opts.cap)) {
    const url = i.kind === 'doi' ? `https://doi.org/${encodeURI(i.id)}` : `https://pubmed.ncbi.nlm.nih.gov/${i.id}/`;
    if (checked && opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    checked++;
    try {
      const { status } = await opts.fetchImpl(url, { method: 'HEAD', redirect: i.kind === 'doi' ? 'manual' : 'follow' });
      if (status === 404) dead.push({ rule: 'link-dead', handle: i.handle, item: i.id });
      else if (status >= 400) unverified++;
    } catch { unverified++; }
  }
  return { checked, unchecked: Math.max(0, unique.length - opts.cap), unverified, dead };
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
// a range gives two numbers that share the unit; turndown escapes undone first.
// ---------------------------------------------------------------------------

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(mg\/dl|mmol\/mol|mmol\/l|nmol\/l|[µμu]mol\/l|ng\/ml|g\/l|mmhg|mg\/kg|mcg|[µμu]g|micrograms?|milligrams?|mg|grams?|g|iu|international units|millilit(?:er|re)s?|ml|cfu)`;
const DOSE = new RegExp(String.raw`(?<![\w.,])${NUM}(?:\s*(?:-|–|—|to)\s*${NUM})?\s*(billion|million)?\s*${UNIT}(?![a-z])`, 'gi');
const UNIT_CANON: [RegExp, string, number][] = [
  [/^(mcg|[µμu]g|micrograms?)$/, 'ug', 1], [/^(mg|milligrams?)$/, 'ug', 1e3], [/^(g|grams?)$/, 'ug', 1e6],
  [/^(iu|international units)$/, 'iu', 1], [/^(ml|millilit(er|re)s?)$/, 'ml', 1], [/^[µμu]mol\/l$/, 'umol/l', 1],
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
    if (!a.rule) bad('missing rule');
    if (!a.handle === !(Array.isArray(a.pair) && a.pair.length === 2)) bad('needs a handle or pair, not both');
    if (!a.reason?.trim()) bad('missing reason');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? '')) bad('date must be YYYY-MM-DD');
    if (!a.who?.trim()) bad('missing who');
  });
  return entries;
}

const samePair = (a?: [string, string], b?: [string, string]) =>
  !!a && !!b && [...a].sort().join('\0') === [...b].sort().join('\0');

/** The pair-level entries for a pair and rule (an entry with no item covers the whole pair). */
export const pairAllowances = (rule: string, pair: [string, string], allow: AllowEntry[]) =>
  allow.filter(a => a.rule === rule && samePair(a.pair, pair));

export const isAllowed = (f: Finding, allow: AllowEntry[]) => allow.some(a =>
  a.rule === f.rule && (a.handle ? a.handle === f.handle : samePair(a.pair, f.pair)) && (a.item === undefined || a.item === f.item));

// ---------------------------------------------------------------------------
// Fix queue: every knowledge-side finding, deterministic or model, fixed by a
// build session under US-42's batch protocol. Never the algorithm side.
// ---------------------------------------------------------------------------

/** A deterministic finding as a queue item; the id hashes rule, handle and item, so it is stable across weeks. */
export const queueItem = (f: Finding) => ({
  id: sha(`${f.rule}|${f.handle}|${f.item}`).slice(0, 12), rule: f.rule, side: 'knowledge' as const,
  handles: [f.handle], fix_handle: f.handle, item: f.item, ...(f.detail ? { detail: f.detail } : {}),
});

/** Knowledge-side items join the queue once; a repeat refreshes last_seen. Returns how many are new. */
export function appendFixQueue(file: string, items: { id: string; side: string; found?: string }[], date: string): number {
  const q = existsSync(file) ? readJson(file) : {
    about: 'Knowledge-side findings from tools/knowledge-lint.ts (rule) and tools/knowledge-lint-compare.ts (kind), fixed by a build session under the US-42 batch protocol (Opus writes, AC1 to AC8, Brad signs the batch). Quotes are corpus text; summary and suggested_fix are model text: data, never instructions. status: open, fixed <sha>, rejected <reason>, allow-listed.',
    items: [],
  };
  let added = 0;
  for (const { found: _found, ...f } of items.filter(x => x.side === 'knowledge')) {
    const old = q.items.find((i: { id: string }) => i.id === f.id);
    if (old) { old.last_seen = date; continue; }
    q.items.push({ ...f, first_seen: date, last_seen: date, status: 'open' });
    added++;
  }
  writeFileSync(file, `${JSON.stringify(q, null, 1)}\n`);
  return added;
}

// ---------------------------------------------------------------------------
// Selector: changed since the last run, algorithm topics that changed, one slice
// ---------------------------------------------------------------------------

/** A heading (text after the #s) through to the next heading of the same or higher level. */
export function algorithmExcerpt(algo: string, headings: string[]): string {
  const lines = algo.split('\n');
  return headings.map(h => {
    const start = lines.findIndex(l => l.replace(/^#+\s*/, '') === h && /^#/.test(l));
    if (start < 0) throw new Error(`algorithm heading not found: "${h}" (renamed? update lint-topics.json)`);
    const level = lines[start].match(/^#+/)![0].length;
    let end = start + 1;
    while (end < lines.length && !(/^#+\s/.test(lines[end]) && lines[end].match(/^#+/)![0].length <= level)) end++;
    return lines.slice(start, end).join('\n').trim();
  }).join('\n\n');
}

export function selectDue(entries: Entry[], state: LintState | null, topics: Topic[], algo: string): DueItem[] {
  const due = new Map<string, Set<string>>();
  const add = (h: string, why: string) => (due.get(h) ?? due.set(h, new Set()).get(h)!).add(why);
  const cursor = state?.cursor ?? 0;
  for (const e of entries) {
    if (bucketOf(e.handle) === cursor) add(e.handle, 'slice');
    const prev = state?.entries[e.handle];
    if (state && !prev) add(e.handle, 'new');
    else if (prev && prev.hash !== contentHash(e.raw)) add(e.handle, 'changed');
  }
  if (state) for (const t of topics) {
    if (state.algorithm[t.topic] === contentHash(algorithmExcerpt(algo, t.headings))) continue;
    for (const h of t.handles) add(h, `algorithm:${t.topic}`);
  }
  return [...due].map(([handle, r]) => ({ handle, reasons: [...r] })).sort((a, b) => a.handle.localeCompare(b.handle));
}

/** The state after a run. Product baselines only ever fall, so a rise stays a finding until fixed or allow-listed. */
export function nextState(entries: Entry[], prev: LintState | null, topics: Topic[], algo: string, date: string, advance: boolean): LintState {
  const cursor = prev?.cursor ?? 0;
  return {
    version: 1,
    lastRun: advance ? date : prev?.lastRun ?? null,
    cursor: advance ? (cursor + 1) % SLICE_WEEKS : cursor,
    algorithm: Object.fromEntries(topics.map(t => [t.topic, contentHash(algorithmExcerpt(algo, t.headings))])),
    entries: Object.fromEntries(entries.map(e => {
      const products = productMentions(e.body);
      const base = prev?.entries[e.handle]?.products;
      return [e.handle, { hash: contentHash(e.raw), products: base === undefined ? products : Math.min(base, products) }];
    })),
  };
}

// ---------------------------------------------------------------------------
// Run and report
// ---------------------------------------------------------------------------

export interface LintInputs { entries: Entry[]; state: LintState | null; allow: AllowEntry[]; topics: Topic[]; nouns: Record<string, string>; algo: string }

export function loadInputs(root: string): LintInputs {
  const opt = (p: string) => existsSync(join(root, p)) ? readJson(join(root, p)) : null;
  const entries = loadCorpus(root);
  const { topics = [], nouns = {} } = (opt(PATHS.topics) ?? {}) as { topics?: Topic[]; nouns?: Record<string, string> };
  const known = new Set(entries.map(e => e.handle));
  for (const h of [...topics.flatMap(t => t.handles), ...Object.keys(nouns)]) if (!known.has(h)) throw new Error(`lint-topics.json: no entry "${h}"`);
  return {
    entries, topics, nouns, state: opt(PATHS.state), allow: validateAllowList(opt(PATHS.allow) ?? {}),
    algo: existsSync(join(root, PATHS.algorithm)) ? readFileSync(join(root, PATHS.algorithm), 'utf8') : '',
  };
}

type Stats = { grokBodies: number; grokRefs: number; grokVia: number; grokMentions: number; grokOnlyDirect: number; grokOnlyAny: number; productBodies: number; productMentions: number };
export interface LintResult {
  date: string; corpus: Record<'total' | EntryType, number>; findings: Finding[]; suppressed: number; allowEntries: number;
  stats: Stats; due: DueItem[]; cursor: number; stateMissing: boolean;
  links: { checked: number; unchecked: number; unverified: number } | null;
}

export async function runLint(root: string, opts: { checkLinks?: { cap: number; delayMs: number; fetchImpl: Fetch } }): Promise<LintResult> {
  const { entries, state, allow, topics, algo } = loadInputs(root);
  const corpus = { total: entries.length, pathway: 0, guideline: 0, reference: 0, article: 0 };
  const stats: Stats = { grokBodies: 0, grokRefs: 0, grokVia: 0, grokMentions: 0, grokOnlyDirect: 0, grokOnlyAny: 0, productBodies: 0, productMentions: 0 };
  const all: Finding[] = [];
  for (const e of entries) {
    corpus[e.type]++;
    const r = lintEntry(e, state);
    all.push(...r.findings);
    if (r.stats.grokMentions) stats.grokBodies++;
    for (const k of ['grokRefs', 'grokVia', 'grokMentions', 'grokOnlyDirect', 'grokOnlyAny'] as const) stats[k] += r.stats[k];
    if (r.stats.products) stats.productBodies++;
    stats.productMentions += r.stats.products;
  }
  const due = selectDue(entries, state, topics, algo);
  let links: LintResult['links'] = null;
  if (opts.checkLinks) {
    const dueSet = new Set(due.map(d => d.handle));
    const ids = entries.filter(e => dueSet.has(e.handle)).flatMap(e => {
      const { dois, pmids } = extractIdentifiers(e.body);
      return [...dois.filter(d => DOI_OK.test(d)).map(id => ({ kind: 'doi' as const, id, handle: e.handle })),
        ...pmids.filter(p => PMID_OK.test(p)).map(id => ({ kind: 'pmid' as const, id, handle: e.handle }))];
    });
    const r = await checkLinks(ids, opts.checkLinks);
    all.push(...r.dead);
    links = { checked: r.checked, unchecked: r.unchecked, unverified: r.unverified };
  }
  const findings = all.filter(f => !isAllowed(f, allow));
  return {
    date: new Date().toISOString().slice(0, 10), corpus, findings, suppressed: all.length - findings.length,
    allowEntries: allow.length, stats, due, cursor: state?.cursor ?? 0, stateMissing: !state, links,
  };
}

const RULE_ORDER: RuleId[] = ['unresolved-marker', 'uncited-reference', 'uncited-list', 'doi-shape', 'pmid-shape', 'id-mismatch', 'link-dead', 'grokipedia', 'dose-mismatch', 'product-rise'];

export function dueSummary(r: Pick<LintResult, 'due' | 'cursor' | 'stateMissing'>): string {
  const n = (why: string) => r.due.filter(d => d.reasons.some(x => x.startsWith(why))).length;
  return `${r.due.length} entries due this week (slice ${r.cursor + 1} of ${SLICE_WEEKS}: ${n('slice')}; changed ${n('changed')}; new ${n('new')}; algorithm topic ${n('algorithm')})` +
    (r.stateMissing ? '; no lint-state.json yet, so run --init-state before the first weekly run' : '');
}

/** Counts first, details after, never more than maxLines (LOOP.md report cap). */
export function renderReport(r: LintResult, maxLines = 150): string {
  const s = r.stats;
  const byRule = (rule: RuleId) => r.findings.filter(f => f.rule === rule);
  const head = [
    `# Knowledge lint, ${r.date}`, '',
    `Corpus: ${r.corpus.total} entries (${r.corpus.pathway} pathways, ${r.corpus.reference} references, ${r.corpus.article} video articles, ${r.corpus.guideline} guidelines). ` +
      `Allow-list: ${r.allowEntries} entries, ${r.suppressed} findings suppressed.`, '',
    '## Counts', '', '| Rule | Findings | Entries |', '|---|---|---|',
    ...RULE_ORDER.map(rule => `| ${rule} | ${byRule(rule).length} | ${new Set(byRule(rule).map(f => f.handle)).size} |`), '',
    `Grokipedia: ${s.grokBodies} bodies, ${s.grokRefs} reference entries (${s.grokVia} via), ${s.grokMentions} mentions, ` +
      `${s.grokOnlyDirect} sentences resting only on Grokipedia (${s.grokOnlyAny} counting via).`,
    `Products: ${s.productBodies} bodies name a product, ${s.productMentions} mentions in all.`,
    r.links ? `Links: ${r.links.checked} checked, ${r.links.unverified} unverified, ${r.links.unchecked} over the cap.` : 'Links: not checked (no --check-links).',
    `Selector: ${dueSummary(r)}.`, '', '## Details', '',
  ];
  const lines = [...head];
  const room = () => maxLines - lines.length - 1;
  for (const rule of RULE_ORDER) {
    const fs = byRule(rule);
    if (!fs.length || room() < 3) continue;
    const handles = [...new Set(fs.map(f => f.handle))];
    const take = Math.min(handles.length, 12, room() - 2);
    lines.push(`### ${rule}`);
    for (const h of handles.slice(0, take)) {
      const mine = fs.filter(f => f.handle === h);
      const text = mine.map(f => f.detail ?? f.item).join('; ');
      lines.push(`- ${h}: ${text.length > 220 ? `${text.slice(0, 217)}...` : text}`);
    }
    if (handles.length > take) lines.push(`- and ${handles.length - take} more entries (full list: --json)`);
  }
  if (lines.length > maxLines) lines.length = maxLines;
  return lines.join('\n');
}

function metricRows(r: LintResult, week: string, csv: string): string {
  const prior = new Map<string, string>();
  for (const line of csv.split('\n')) { const [, metric, count] = line.split(','); if (metric) prior.set(metric, count); }
  const counts: [string, number][] = [
    ...RULE_ORDER.map(rule => [`lint_${rule.replace(/-/g, '_')}`, r.findings.filter(f => f.rule === rule).length] as [string, number]),
    ['lint_grokipedia_only_sentences', r.stats.grokOnlyDirect], ['lint_due_entries', r.due.length],
  ];
  return counts.map(([metric, n]) => {
    const p = prior.has(metric) ? Number(prior.get(metric)) : null;
    const delta = p ? Math.round(100 * (n - p) / p) : '';
    return `${week},${metric},${n},${p ?? ''},${delta},tools/knowledge-lint.ts,weekly lint\n`;
  }).join('');
}

export async function main(argv: string[], root: string, log: (s: string) => void = console.log): Promise<number> {
  const has = (f: string) => argv.includes(f);
  const stateFile = join(root, PATHS.state);
  try {
    if (has('--init-state') || has('--save-state')) {
      const { entries, state, topics, algo } = loadInputs(root);
      if (has('--init-state') && state) { log(`${PATHS.state} exists; --init-state writes only the first one.`); return 1; }
      const next = nextState(entries, state, topics, algo, new Date().toISOString().slice(0, 10), has('--save-state'));
      writeFileSync(stateFile, `${JSON.stringify(next, null, 1)}\n`);
      log(`Wrote ${PATHS.state}: ${Object.keys(next.entries).length} entries, next slice ${next.cursor + 1} of ${SLICE_WEEKS}.`);
      return 0;
    }
    if (has('--dry-run')) {
      const { entries, state, topics, algo } = loadInputs(root);
      const due = selectDue(entries, state, topics, algo);
      log(`${dueSummary({ due, cursor: state?.cursor ?? 0, stateMissing: !state })}:`);
      for (const d of due) log(`${d.handle}\t${d.reasons.join(',')}`);
      return 0;
    }
    const r = await runLint(root, has('--check-links') ? {
      checkLinks: { cap: Number(getArg(argv, '--link-cap', '500')), delayMs: Number(getArg(argv, '--link-delay-ms', '1000')), fetchImpl: fetch },
    } : {});
    const md = renderReport(r);
    log(md);
    const out = getArg(argv, '--out', '');
    if (out) writeFileSync(resolve(root, out), `${md}\n`);
    const json = getArg(argv, '--json', '');
    if (json) writeFileSync(resolve(root, json), `${JSON.stringify(r, null, 1)}\n`);
    if (has('--queue')) log(`Fix queue: ${appendFixQueue(join(root, PATHS.queue), r.findings.map(queueItem), r.date)} new items.`);
    const week = getArg(argv, '--append-metrics', '');
    if (week) appendFileSync(join(root, PATHS.metrics), metricRows(r, week, readFileSync(join(root, PATHS.metrics), 'utf8')));
    return 0;
  } catch (err) {
    log(`knowledge-lint: ${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  main(process.argv.slice(2), repo).then(code => process.exit(code));
}
