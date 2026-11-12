/**
 * Weekly knowledge lint, deterministic half (US-43; knowledge-refresh plan
 * Phase 3 and decision 6). No model, no network unless --check-links.
 *
 * Rules, over docs/blog (references and video articles) and docs/guideline,
 * every entry every week (they are cheap):
 *   unresolved-marker / uncited-reference / uncited-list   every [n] resolves (AC7)
 *   doi-shape / pmid-shape / id-mismatch / link-dead        identifiers (AC7)
 *   grokipedia                                             no body cites Grokipedia (AC7, F6)
 *   dose-mismatch       a number plus unit in index.json's summary the body never states (AC2 tokeniser)
 *   product-rise        product mentions above the stored baseline (AC7)
 *   Topic masters (US-50 AC7). Static, in test:all (tools/knowledge-lint-masters.test.ts): topic-no-master, master-front
 *   fail; master-gate, master-doi warn; master-key-points warns on a master with a view and no sound "## Key safety
 *   points" section (US-50 AC12; the batch checker's --key-safety-points fails it). guide-shape fails a `kind: condition`
 *   guideline with bad keys, over 35,000 characters, a missing or misordered template section, a non-bullet line in Get help now, or a red flag or any emergency-number list without the
 *   exact emergency line (US-70 AC1; guideErrors, shared with the checker's --guides). lint-allowlist.json waives them as it does every rule. Weekly only, dated:
 *   master-stale, source-stale, master-places, master-overlap (masters sharing a DOI: the pair goes to adversary review).
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
 *     --write-master-hashes [--date YYYY-MM-DD]
 *                             write the masters section of lint-state.json (free; each batch's publish commit runs it);
 *                             exits 1 on an unwaived master-places finding and keeps that master's earlier hashes
 *     --init-state            write the first lint-state.json (refuses if one exists); after
 *                             that only knowledge-lint-compare.ts --run advances it
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getArg } from '../packages/health-core/src/models';
import { VIEW_HEADING, duplicateKeys, fmValue, guideErrors, isGuideText, keySafetyErrors, masterKeyError, sentences, validDate } from './knowledge-batch-check';
import {
  SLICE_WEEKS, PATHS, contentHash, bucketOf, readJson, loadCorpus, unescapeMd, normalise, splitReferences, findMarkers, DOI_OK, PMID_OK,
  extractIdentifiers, checkLinks, productMentions, lintEntry, validateAllowList, isAllowed, queueItem, queueCovered, appendFixQueue, queueLine,
  type Entry, type RuleId, type Finding, type AllowEntry, type Topic, type LintState, type DueItem, type Fetch, type Stats, type LintResult,
} from './knowledge-lint-rules';
export {
  SLICE_WEEKS, PATHS, contentHash, bucketOf, entryFrom, loadCorpus, normalise, splitReferences, findMarkers, ruleMarkers, extractIdentifiers,
  ruleIdentifiers, checkLinks, ruleGrokipedia, doseTokens, ruleDose, productMentions, lintEntry, validateAllowList, pairAllowances, isAllowed,
  queueItem, queueCovered, appendFixQueue, queueLine,
} from './knowledge-lint-rules';
export type { EntryType, Entry, RuleId, Finding, AllowEntry, Topic, LintState, DueItem, LinkId, LintResult } from './knowledge-lint-rules';

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
    pairs: prev?.pairs ?? {},
    ...(prev?.masters ? { masters: prev.masters } : {}),
    algorithm: Object.fromEntries(topics.map(t => [t.topic, contentHash(algorithmExcerpt(algo, t.headings))])),
    entries: Object.fromEntries(entries.map(e => {
      const products = productMentions(e.body);
      const base = prev?.entries[e.handle]?.products;
      return [e.handle, { hash: contentHash(e.raw), products: base === undefined ? products : Math.min(base, products) }];
    })),
  };
}

// ---------------------------------------------------------------------------
// Topic masters (US-50 AC7). A master is a reference with `reviewed:` or a view heading;
// unrewritten references are exempt. Static checks take no date; weekly checks take today.
// ---------------------------------------------------------------------------

/** A text anchor in a place that must follow a master's current view: file plus a snippet, never a line number. */
export interface MasterPlace { topic: string; file: string; snippet: string }
export interface MastersConfig { productIngredients: string[]; places: MasterPlace[] }
type Read = (rel: string) => string | null;

const frontOf = (e: Entry) => /^---\n([\s\S]*?)\n---/.exec(e.raw)?.[1] ?? '';
const reviewedOf = (e: Entry) => /^"(\d{4}-\d{2}-\d{2})"$/.exec(fmValue(frontOf(e), 'reviewed') ?? '')?.[1] ?? null;
const publishedOf = (e: Entry) => /^publishedAt:\s*"?(\d{4}-\d{2}-\d{2})/m.exec(frontOf(e))?.[1] ?? null;
const jsonList = (e: Entry, key: string): unknown[] => {
  try { const j = JSON.parse(fmValue(frontOf(e), key) ?? ''); return Array.isArray(j) ? j : []; } catch { return []; }
};
const topicsOf = (e: Entry) => jsonList(e, 'topics').filter((t): t is string => typeof t === 'string');
const isMaster = (e: Entry) => e.type === 'reference' && (fmValue(frontOf(e), 'reviewed') !== null || viewSection(e.body) !== null);
const placeId = (p: MasterPlace) => `${p.file}: ${p.snippet}`;

/** The "Current view (reviewed …)" or "Current evidence position" section, heading included. */
export function viewSection(body: string): string | null {
  const lines = body.split('\n');
  const i = lines.findIndex(l => VIEW_HEADING.test(l));
  if (i < 0) return null;
  const j = lines.findIndex((l, k) => k > i && /^#{1,2}\s/.test(l));
  return lines.slice(i, j < 0 ? undefined : j).join('\n');
}
/** The view's hash ignores its heading, so a re-review that changes only the date is not a change of view. */
const viewHash = (section: string) => contentHash(normalise(section.split('\n').slice(1).join('\n')));
/** The hash a master-places waiver names (`view`); "" for a master with no view section. */
export const masterViewHash = (body: string) => { const sec = viewSection(body); return sec ? viewHash(sec) : ''; };

export function staticMasterFindings(entries: Entry[], products: string, cfg: MastersConfig): { fails: Finding[]; warns: Finding[] } {
  const fails: Finding[] = [], warns: Finding[] = [];
  const refs = new Map(entries.filter(e => e.type === 'reference').map(e => [e.handle, e]));
  const prod = unescapeMd(products).toLowerCase();
  for (const e of entries) {
    if (e.type === 'guideline' && isGuideText(e.raw)) for (const err of guideErrors(e.raw)) fails.push({ rule: 'guide-shape', handle: e.handle, item: err });
    if (e.type === 'article') {
      const hidden = fmValue(frontOf(e), 'router') === 'hidden';
      for (const t of topicsOf(e)) {
        const m = refs.get(t);
        if (!m) { fails.push({ rule: 'topic-no-master', handle: e.handle, item: t }); continue; }
        const r = reviewedOf(m), pub = publishedOf(e);
        if (hidden && (!r || (pub && r < pub))) warns.push({ rule: 'master-gate', handle: e.handle, item: t, detail: r ? `master reviewed ${r}, post published ${pub}` : 'master has no reviewed date' });
      }
    }
    if (!isMaster(e)) continue;
    for (const k of ['reviewed', 'sources']) {
      const v = fmValue(frontOf(e), k), err = v === null ? 'missing' : masterKeyError(k, v);
      if (err) fails.push({ rule: 'master-front', handle: e.handle, item: k, detail: err });
    }
    for (const k of duplicateKeys(frontOf(e))) fails.push({ rule: 'master-front', handle: e.handle, item: k, detail: 'appears more than once' });
    const keyErrors = keySafetyErrors(e.body);
    if (keyErrors.length) warns.push({ rule: 'master-key-points', handle: e.handle, item: 'key safety points', detail: keyErrors.join('; ') });
    const sec = cfg.productIngredients.includes(e.handle) ? viewSection(e.body) : null;
    if (!sec) continue;
    const lines = splitReferences(e.body).refs;
    const cited = findMarkers(sec).flatMap(m => m.nums).map(n => lines.get(n) ?? '');
    for (const doi of extractIdentifiers([sec, ...cited].join('\n')).dois) {
      if (!prod.includes(doi.toLowerCase())) warns.push({ rule: 'master-doi', handle: e.handle, item: doi.toLowerCase(), detail: 'in the current view, not in docs/products.md' });
    }
  }
  return { fails, warns };
}

const readFrom = (root: string): Read => rel => existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null;

/** The static checks over the real files (the test:all half), less what lint-allowlist.json waives, matched as weekly. */
export function staticMasterChecks(root: string) {
  const { entries, masters, allow } = loadInputs(root);
  const { fails, warns } = staticMasterFindings(entries, readFrom(root)('docs/products.md') ?? '', masters);
  const keep = (fs: Finding[]) => fs.filter(f => !isAllowed(f, allow));
  return { fails: keep(fails), warns: keep(warns) };
}

export function loadMastersConfig(raw: { productIngredients?: string[]; places?: MasterPlace[] } | undefined, known: Set<string>): MastersConfig {
  const cfg = { productIngredients: raw?.productIngredients ?? [], places: raw?.places ?? [] };
  for (const h of [...cfg.productIngredients, ...cfg.places.map(p => p.topic)]) if (!known.has(h)) throw new Error(`lint-topics.json: no entry "${h}"`);
  cfg.places.forEach((p, i) => {
    if (!p.file || p.file.startsWith('/') || p.file.split('/').includes('..')) throw new Error(`lint-topics.json masters.places[${i}]: file must be a repo-relative path`);
    if (!p.snippet?.trim()) throw new Error(`lint-topics.json masters.places[${i}]: snippet is empty`);
  });
  return cfg;
}

/** Hash of the paragraph holding the snippet (so edits elsewhere in the file don't count); null when the anchor text is gone. */
function placeHash(p: MasterPlace, read: Read): string | null {
  const text = read(p.file);
  const para = text?.split(/\n\s*\n/).find(x => normalise(x).includes(normalise(p.snippet)));
  return para === undefined ? null : contentHash(normalise(para));
}

/**
 * Each master's view hash and its places' hashes. A reference with registered places but no view yet is stored with
 * hash "", so its first rewrite compares against the places as they stood before it.
 */
export function masterHashes(entries: Entry[], cfg: MastersConfig, read: Read, date: string): NonNullable<LintState['masters']> {
  const out: NonNullable<LintState['masters']> = {};
  for (const e of entries.filter(x => x.type === 'reference')) {
    const sec = viewSection(e.body), places = cfg.places.filter(p => p.topic === e.handle);
    if (!sec && !places.length) continue;
    out[e.handle] = { hash: sec ? viewHash(sec) : '', at: date, places: Object.fromEntries(places.map(p => [placeId(p), placeHash(p, read) ?? 'missing'])) };
  }
  return out;
}

const DAY = 864e5;
/** Date-dependent; weekly only, never test:all. */
export function weeklyMasterFindings(entries: Entry[], today: string, state: LintState | null, cfg: MastersConfig, read: Read): Finding[] {
  const out: Finding[] = [];
  const posts = entries.filter(e => e.type === 'article');
  for (const m of entries.filter(isMaster)) {
    const reviewed = reviewedOf(m);
    const newest = posts.filter(p => topicsOf(p).includes(m.handle) && publishedOf(p))
      .reduce<Entry | null>((a, p) => !a || publishedOf(p)! > publishedOf(a)! ? p : a, null);
    if (reviewed && newest && reviewed < publishedOf(newest)!) out.push({ rule: 'master-stale', handle: m.handle, item: newest.handle, detail: `reviewed ${reviewed}, ${newest.handle} published ${publishedOf(newest)}` });
    for (const src of jsonList(m, 'sources') as { name?: string; checked?: string }[]) {
      if (src?.name === 'brad-video') continue; // dated by its post, not fetched
      const age = src?.checked && validDate(src.checked) ? Math.round((Date.parse(today) - Date.parse(src.checked)) / DAY) : 0;
      if (age > 35) out.push({ rule: 'source-stale', handle: m.handle, item: String(src.name), detail: `checked ${src.checked}, ${age} days ago` });
    }
    // No stored hash (a first rewrite) counts as a change, and a place with no stored hash as unchanged: check it or waive it.
    const sec = viewSection(m.body), prior = state?.masters?.[m.handle];
    const view = sec ? viewHash(sec) : '', changed = !!sec && view !== prior?.hash;
    for (const p of cfg.places.filter(x => x.topic === m.handle)) {
      const id = placeId(p), now = placeHash(p, read), was = prior?.places[id];
      if (now === null) out.push({ rule: 'master-places', handle: m.handle, item: id, view, detail: 'anchor text not found; re-register the place' });
      else if (changed && (was === undefined || was === now)) out.push({ rule: 'master-places', handle: m.handle, item: id, view, detail: was === undefined ? 'no earlier hash for this place (first rewrite or newly registered); check it follows the current view' : `current view changed since ${prior!.at}; this place did not` });
    }
  }
  return [...out, ...overlapFindings(entries.filter(isMaster))];
}

/** Masters that share a DOI may disagree about it: each pair goes to adversary review with both current views. */
function overlapFindings(masters: Entry[]): Finding[] {
  const out: Finding[] = [];
  const dois = new Map(masters.map(m => [m.handle, new Set(extractIdentifiers(m.body).dois.map(d => d.toLowerCase()))]));
  const said = (m: Entry) => { const t = sentences(viewSection(m.body) ?? '').join(' '); return t.length > 400 ? `${t.slice(0, 397)}...` : t; };
  masters.forEach((a, i) => masters.slice(i + 1).forEach(b => {
    const shared = [...dois.get(a.handle)!].filter(d => dois.get(b.handle)!.has(d)).sort();
    if (shared.length) out.push({ rule: 'master-overlap', handle: a.handle, pair: [a.handle, b.handle], item: shared.join(' '), detail: `${a.handle}: "${said(a)}" | ${b.handle}: "${said(b)}"` });
  }));
  return out;
}

/**
 * Store each master's current-view and place hashes (free; each batch's publish commit runs it). A master with an
 * unwaived master-places finding keeps its earlier view hash, so the drift is still there next week. Its flagged places
 * store their hash now, so a later edit clears them; its other places keep their earlier hash. It advances once every
 * flagged place changes or is waived for this view (a waiver names the view hash) in lint-allowlist.json.
 */
export function writeMasterHashes(root: string, date: string, entries?: Entry[], cfg?: MastersConfig, allow?: AllowEntry[]) {
  const file = join(root, PATHS.state);
  if (!existsSync(file)) throw new Error(`${PATHS.state} missing; run --init-state first`);
  const inputs = entries && cfg && allow ? null : loadInputs(root);
  const es = entries ?? inputs!.entries, c = cfg ?? inputs!.masters, al = allow ?? inputs!.allow;
  const state = readJson(file) as LintState, read = readFrom(root);
  const findings = weeklyMasterFindings(es, date, state, c, read).filter(f => f.rule === 'master-places');
  const unwaived = findings.filter(f => !isAllowed(f, al));
  const next = masterHashes(es, c, read, date);
  for (const h of new Set(unwaived.map(f => f.handle))) {
    const prior = state.masters?.[h], flagged = new Set(unwaived.filter(f => f.handle === h).map(f => f.item));
    const places = Object.fromEntries(Object.entries(next[h]?.places ?? {}).map(([id, now]) => [id, flagged.has(id) ? now : prior?.places[id] ?? now]));
    next[h] = { hash: prior?.hash ?? '', at: prior?.at ?? date, places };
  }
  state.masters = next;
  writeFileSync(file, `${JSON.stringify(state, null, 1)}\n`);
  return { written: Object.keys(next).length, findings, unwaived };
}

// ---------------------------------------------------------------------------
// Run and report
// ---------------------------------------------------------------------------

export interface LintInputs { entries: Entry[]; state: LintState | null; allow: AllowEntry[]; topics: Topic[]; nouns: Record<string, string>; masters: MastersConfig; algo: string }

export function loadInputs(root: string): LintInputs {
  const opt = (p: string) => existsSync(join(root, p)) ? readJson(join(root, p)) : null;
  const entries = loadCorpus(root);
  const { topics = [], nouns = {}, masters } = (opt(PATHS.topics) ?? {}) as { topics?: Topic[]; nouns?: Record<string, string>; masters?: Parameters<typeof loadMastersConfig>[0] };
  const known = new Set(entries.map(e => e.handle));
  for (const h of [...topics.flatMap(t => t.handles), ...Object.keys(nouns)]) if (!known.has(h)) throw new Error(`lint-topics.json: no entry "${h}"`);
  return {
    entries, topics, nouns, masters: loadMastersConfig(masters, known), state: opt(PATHS.state), allow: validateAllowList(opt(PATHS.allow) ?? {}),
    algo: existsSync(join(root, PATHS.algorithm)) ? readFileSync(join(root, PATHS.algorithm), 'utf8') : '',
  };
}


export async function runLint(root: string, opts: { checkLinks?: { cap: number; delayMs: number; fetchImpl: Fetch } }): Promise<LintResult> {
  const { entries, state, allow, topics, masters, algo } = loadInputs(root);
  const corpus = { total: entries.length, guideline: 0, reference: 0, article: 0 };
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
  const date = new Date().toISOString().slice(0, 10), read = readFrom(root);
  const sm = staticMasterFindings(entries, read('docs/products.md') ?? '', masters);
  all.push(...sm.fails, ...sm.warns, ...weeklyMasterFindings(entries, date, state, masters, read));
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
    links = { checked: r.checked, unchecked: r.unchecked, unverified: r.unverified, conclusive: r.conclusive };
  }
  const findings = all.filter(f => !isAllowed(f, allow));
  return {
    date, corpus, findings, suppressed: all.length - findings.length,
    allowEntries: allow.length, stats, due, cursor: state?.cursor ?? 0, stateMissing: !state, links,
  };
}

const RULE_ORDER: RuleId[] = ['unresolved-marker', 'uncited-reference', 'uncited-list', 'doi-shape', 'pmid-shape', 'id-mismatch', 'link-dead', 'grokipedia', 'dose-mismatch', 'product-rise',
  'guide-shape', 'topic-no-master', 'master-front', 'master-gate', 'master-doi', 'master-key-points', 'master-stale', 'source-stale', 'master-places', 'master-overlap'];

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
    `Corpus: ${r.corpus.total} entries (${r.corpus.reference} references, ${r.corpus.article} video articles, ${r.corpus.guideline} guidelines). ` +
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
    if (has('--init-state')) {
      const { entries, state, topics, algo } = loadInputs(root);
      if (state) { log(`${PATHS.state} exists; --init-state writes only the first one.`); return 1; }
      const next = nextState(entries, null, topics, algo, '', false);
      writeFileSync(stateFile, `${JSON.stringify(next, null, 1)}\n`);
      log(`Wrote ${PATHS.state}: ${Object.keys(next.entries).length} entries, next slice ${next.cursor + 1} of ${SLICE_WEEKS}.`);
      return 0;
    }
    if (has('--write-master-hashes')) {
      const r = writeMasterHashes(root, getArg(argv, '--date', new Date().toISOString().slice(0, 10)));
      for (const f of r.findings) log(`${r.unwaived.includes(f) ? 'FAIL' : 'WAIVED'} master-places ${f.handle}: ${f.item} (${f.detail}; view ${f.view})`);
      log(`Wrote the masters section of ${PATHS.state}: ${r.written} masters${r.unwaived.length ? `; ${r.unwaived.length} unwaived findings kept their masters' earlier hashes` : ''}.`);
      return r.unwaived.length ? 1 : 0;
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
    if (has('--queue')) {
      log(queueLine(appendFixQueue(join(root, PATHS.queue), r.findings.map(queueItem), r.date, queueCovered(r))));
    }
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
