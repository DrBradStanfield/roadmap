#!/usr/bin/env tsx
/**
 * search_knowledge — Dr Brad's knowledge base, searched from the shell (US-41).
 *
 * A lexical ranker (BM25) over `docs/blog/index.json`: every article,
 * reference, guideline and pathway, scored on its summary, its `keywords`, its
 * title and its handle. No model, no embeddings, no network. An assistant with
 * a shell runs it beside `get-plan.ts` and cites what it finds by handle.
 *
 * Usage:
 *   npx tsx tools/search-knowledge.ts "statins and muscle pain"
 *   npx tsx tools/search-knowledge.ts "ferritin" --k 5 --excerpt
 *   npx tsx tools/search-knowledge.ts --article hypertension-in-adults
 *
 * The query is read from argv and goes nowhere else: no log, no file, no
 * error message repeats it. Run from the repo root: the index and bodies are
 * read through the chat server's own loaders, which resolve from the cwd.
 */
import { pathToFileURL } from 'node:url';
import { loadBlogIndex } from '../app/lib/blog-index.server';
import { loadBlogArticle, MAX_BLOG_CHARS } from '../app/lib/matched-content';
import ABBREVIATIONS from './search-knowledge-abbreviations.json';

export const POSTURE =
  "Educational content from Dr Brad Stanfield's knowledge base, not medical advice. Cite the handle of any entry you use.";
const DEFAULT_K = 3;
export const MAX_K = 8;
export const DEFAULT_EXCERPT_CHARS = 6_000;

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
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
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

/** BM25 over the weighted fields; only entries sharing a term with the query come back. */
export function search(index: Index, query: string, k = DEFAULT_K): Hit[] {
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
    .slice(0, Math.min(Math.max(k, 1), MAX_K))
    .map(({ doc: { entry }, score }) => ({
      handle: entry.handle,
      type: entry.type ?? 'article',
      title: entry.title,
      summary: entry.summary ?? '',
      score: Math.round(score * 100) / 100,
    }));
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** The entry's markdown without its YAML frontmatter, which repeats the index. */
function body(handle: string): string | null {
  const text = loadBlogArticle(handle);
  return text === null ? null : text.replace(/^---\n[\s\S]*?\n---\n+/, '');
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

const count = (n: number) => n.toLocaleString('en-US');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `search_knowledge — search Dr Brad's knowledge base, offline, no model.

  npx tsx tools/search-knowledge.ts "<question or keywords>" [--k 3] [--excerpt] [--max-chars 6000] [--json]
  npx tsx tools/search-knowledge.ts --article <handle> [--max-chars 120000] [--json]

search      Ranks every article, supplement reference, guideline and clinical
            pathway by its summary, keywords, title and handle (BM25), and
            prints the best --k (default ${DEFAULT_K}, at most ${MAX_K}).
            --excerpt adds the section of each body that best matches
            the query, up to --max-chars (default ${count(DEFAULT_EXCERPT_CHARS)}) per entry.
            --json prints { posture, results } for a program to read.
--article   get_article: prints one entry's full body, up to --max-chars
            (default ${count(MAX_BLOG_CHARS)}, which fits every entry).
            --json prints { posture, handle, title, body }.

Educational content, not medical advice. Cite the handle. Run from the repo root.
This tool writes your query nowhere. Your shell or assistant may keep its own command history.
`;

class Refusal extends Error {}

const VALUE_FLAGS = ['--k', '--max-chars', '--article'] as const;
const BOOL_FLAGS = ['--excerpt', '--json'] as const;

interface Args {
  query: string;
  k?: number;
  maxChars?: number;
  article?: string;
  excerpt: boolean;
  json: boolean;
}

function positiveInt(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Refusal(`${flag} must be a whole number of 1 or more`);
  return Number(raw);
}

/** Every refusal names the flag, never the query: the query goes nowhere but the ranker. */
function parseArgs(argv: string[]): Args {
  const words: string[] = [];
  const args: Args = { query: '', excerpt: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((BOOL_FLAGS as readonly string[]).includes(token)) {
      args[token === '--json' ? 'json' : 'excerpt'] = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(token)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Refusal(`${token} needs a value`);
      if (token === '--k') args.k = Math.min(positiveInt(token, value), MAX_K);
      else if (token === '--max-chars') args.maxChars = positiveInt(token, value);
      else args.article = value;
    } else if (token.startsWith('--')) {
      throw new Refusal('Unknown option');
    } else {
      words.push(token);
    }
  }
  args.query = words.join(' ').trim();
  if (!args.article && !args.query) throw new Refusal('No query given');
  if (args.article && args.query) throw new Refusal('--article takes a handle, not a query');
  if (args.article && (args.k !== undefined || args.excerpt)) throw new Refusal('--article takes only --max-chars and --json');
  return args;
}

function article(handle: string, json: boolean, maxChars = MAX_BLOG_CHARS): string {
  const entry = loadBlogIndex().find((e) => e.handle === handle);
  const text = entry ? body(handle) : null;
  if (!entry || text === null) throw new Refusal('No entry has that handle');
  const cut = text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n[truncated: ${count(maxChars)} of ${count(text.length)} chars; raise --max-chars for more]\n`
    : text;
  if (json) return `${JSON.stringify({ posture: POSTURE, handle, title: entry.title, body: cut }, null, 2)}\n`;
  return `${POSTURE}\n\n[${entry.type ?? 'article'}] ${handle}: ${entry.title}\n\n${cut}`;
}

function searchOutput(args: Args): string {
  const hits = search(buildIndex(loadBlogIndex()), args.query, args.k ?? DEFAULT_K);
  const maxChars = args.maxChars ?? DEFAULT_EXCERPT_CHARS;
  const bodies = hits.map((hit) => (args.excerpt ? body(hit.handle) : null));
  if (args.json) {
    const results = hits.map((hit, i) => {
      const text = bodies[i];
      return text === null ? hit : { ...hit, excerpt: bestSection(text, args.query, maxChars) };
    });
    return `${JSON.stringify({ posture: POSTURE, results }, null, 2)}\n`;
  }
  const blocks = hits.map((hit, i) => {
    const head = `${i + 1}. [${hit.type}] ${hit.handle} (score ${hit.score.toFixed(1)})\n   ${hit.title}\n   ${hit.summary}`;
    const text = bodies[i];
    if (text === null) return head;
    const excerpt = bestSection(text, args.query, maxChars);
    return `${head}\n--- excerpt (${count(excerpt.length)} of ${count(text.length)} chars) ---\n${excerpt}`;
  });
  return `${POSTURE}\n\n${blocks.length ? blocks.join('\n\n') : 'No entry matched. Try other words.'}\n`;
}

export function run(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const args = parseArgs(argv);
    if (loadBlogIndex().length === 0) throw new Refusal('docs/blog/index.json did not load; run from the repo root');
    process.stdout.write(args.article ? article(args.article, args.json, args.maxChars) : searchOutput(args));
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`search_knowledge: ${error.message}\n  Run with --help for the options.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not exit(): a piped stdout drains before the process ends.
  process.exitCode = run(process.argv.slice(2));
}
