#!/usr/bin/env tsx
/**
 * search_knowledge — Dr Brad's knowledge base, searched from the shell (US-41).
 *
 * A lexical ranker (BM25) over `docs/blog/index.json`: every article,
 * reference and guideline, scored on its summary, its `keywords`, its title
 * and its handle. No model, no embeddings, no network. An assistant with
 * a shell runs it beside `get-plan.ts` and cites what it finds by handle.
 *
 * Usage:
 *   npx tsx tools/search-knowledge.ts "statins and muscle pain"
 *   npx tsx tools/search-knowledge.ts "ferritin" --k 5 --excerpt
 *   npx tsx tools/search-knowledge.ts --article diet
 *
 * The query is read from argv and goes nowhere else: no log, no file, no
 * error message repeats it. Run from the repo root: the index and bodies are
 * read through the chat server's own loaders, which resolve from the cwd.
 */
import { pathToFileURL } from 'node:url';
import { loadBlogIndex } from '../app/lib/blog-index.server';
import { loadBlogArticle, MAX_BLOG_CHARS } from '../app/lib/matched-content';
import { bestSection, buildIndex, DEFAULT_K, MAX_K, search } from '../app/lib/search-knowledge';

export const POSTURE =
  "Educational content from Dr Brad Stanfield's knowledge base, not medical advice. Cite the handle of any entry you use.";
export const DEFAULT_EXCERPT_CHARS = 6_000;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** The entry's markdown without its YAML frontmatter, which repeats the index. */
function body(handle: string): string | null {
  const text = loadBlogArticle(handle);
  return text === null ? null : text.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

const count = (n: number) => n.toLocaleString('en-US');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `search_knowledge — search Dr Brad's knowledge base, offline, no model.

  npx tsx tools/search-knowledge.ts "<question or keywords>" [--k 3] [--excerpt] [--max-chars 6000] [--json]
  npx tsx tools/search-knowledge.ts --article <handle> [--max-chars 160000] [--json]

search      Ranks every article, supplement reference and guideline by its
            summary, keywords, title and handle (BM25), and
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
