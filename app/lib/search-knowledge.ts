/**
 * The knowledge search core (US-41): tokens, the BM25 ranker and the best
 * section of a body. Pure: no file read, no network, no model. The hosted
 * connector (`mcp-knowledge.server.ts`) and the shell CLI
 * (`tools/search-knowledge.ts`) both rank with it.
 */
import ABBREVIATIONS from './search-knowledge-abbreviations.json';

export const DEFAULT_K = 3;
export const MAX_K = 8;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const STOPWORDS = new Set((
  'a about am an and any are as at be been being but by can could did do does for from get got had has have how i ' +
  "i'm if im in into is it its just me my of on or our should so than that the their them then there these they " +
  'this those to too was we were what when where which who why will with would you your'
).split(' '));

/** Units and the numbers they carry say nothing about the topic ("ldl 4.2 mmol/L", "150/95 mm Hg"). */
const UNITS = new Set('mmol mmhg mm hg mg mcg iu ml dl kg cm mol nmol pmol umol'.split(' '));

/**
 * A light stemmer: plurals, -ing and -ed, and British "ae"/"oe" folded to the
 * American spelling (anaemia, oedema). Rough on purpose: query and entries go
 * through the same function, so a crude stem still meets itself.
 */
function stem(word: string): string {
  let w = word.replace(/ae|oe/g, 'e');
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  return w;
}

/**
 * Clinical abbreviations the index spells out (HTN, T2DM, TSH). The chat
 * matcher's synonym sets were deleted with it in de4455b; this is the minimal
 * set the router fixtures use, keyed on the lower-case word before stemming.
 */
const abbreviations: Record<string, string> = ABBREVIATIONS;

export function tokenize(text: string): string[] {
  // Single letters are dropped, so "vitamin c" also yields "vitaminc" to keep C apart from D.
  return (text.toLowerCase().replace(/\b(vitamin|hepatitis)\s+([a-z])\b/g, '$1 $1$2').match(/[a-z0-9']+/g) ?? [])
    // "4.2mmol" arrives as "2mmol": a number glued to its unit loses the number,
    // and the unit then drops. Letters first ("hba1c", "t2dm", "b12") are kept whole.
    .map((t) => t.replace(/^'+|'+$/g, '').replace(/^\d+(?=[a-z]+$)/, ''))
    .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !STOPWORDS.has(t) && !UNITS.has(t))
    .map(stem);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** The part of an index entry the ranker reads. */
export interface Entry {
  handle: string;
  title: string;
  summary?: string;
  keywords?: string[];
  type?: 'reference' | 'article' | 'guideline';
}

/** How much one occurrence in each field counts; a missing field is not read. */
export type Weights = Partial<Record<'summary' | 'keywords' | 'title' | 'handle', number>>;

/** The variants measured by search-knowledge-eval.ts; BEST is the one the CLI uses. */
export const VARIANTS = {
  summary: { summary: 1 },
  'summary+keywords': { summary: 1, keywords: 1 },
  'summary+keywords+title+handle': { summary: 1, keywords: 1, title: 1, handle: 1 },
} satisfies Record<string, Weights>;
export const BEST: Weights = VARIANTS['summary+keywords+title+handle'];

export interface Hit {
  handle: string;
  type: string;
  title: string;
  summary: string;
  score: number;
}

interface Doc {
  entry: Entry;
  tf: Map<string, number>;
  length: number;
}

export interface Index {
  docs: Doc[];
  df: Map<string, number>;
  avgLength: number;
}

function fieldText(entry: Entry, field: keyof Weights): string {
  if (field === 'keywords') return (entry.keywords ?? []).join(' ');
  if (field === 'handle') return entry.handle.replace(/-/g, ' ');
  return entry[field] ?? '';
}

export function buildIndex(entries: Entry[], weights: Weights = BEST): Index {
  const df = new Map<string, number>();
  const docs = entries.map((entry) => {
    const tf = new Map<string, number>();
    let length = 0;
    for (const [field, weight] of Object.entries(weights) as [keyof Weights, number][]) {
      for (const token of tokenize(fieldText(entry, field))) {
        tf.set(token, (tf.get(token) ?? 0) + weight);
        length += weight;
      }
    }
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    return { entry, tf, length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  return { docs, df, avgLength };
}

/** The query's stems, each known abbreviation followed by its spelled-out form. */
function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return [...new Set(tokenize(words.map((w) => abbreviations[w] ? `${w} ${abbreviations[w]}` : w).join(' ')))];
}

const K1 = 1.2;
const B = 0.75;

/** BM25 over the weighted fields; only entries sharing a term with the query come back. `max` is the CLI's cap; the hosted tool reads a wider pool. */
export function search(index: Index, query: string, k = DEFAULT_K, max = MAX_K): Hit[] {
  const terms = queryTerms(query);
  const n = index.docs.length;
  const scored: { doc: Doc; score: number }[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const df = index.df.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / index.avgLength));
    }
    if (score > 0) scored.push({ doc, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(k, 1), max))
    .map(({ doc: { entry }, score }) => ({
      handle: entry.handle,
      type: entry.type ?? 'article',
      title: entry.title,
      summary: entry.summary ?? '',
      score: Math.round(score * 100) / 100,
    }));
}

/**
 * The section (a heading and the text under it) sharing the most distinct
 * query terms with the query, or the body's start when none shares one.
 */
export function bestSection(text: string, query: string, maxChars: number): string {
  const terms = queryTerms(query);
  let best = text;
  let bestScore = 0;
  for (const section of text.split(/\n(?=#{1,6} )/)) {
    const tokens = new Set(tokenize(section));
    const score = terms.filter((t) => tokens.has(t)).length;
    if (score > bestScore) [best, bestScore] = [section, score];
  }
  return best.trim().slice(0, maxChars);
}
