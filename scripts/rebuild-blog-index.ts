/**
 * Rebuilds docs/blog/index.json from .md file frontmatter.
 *
 * Scans `docs/blog/`, `docs/guideline/`, `docs/pathway/` — extracts YAML
 * frontmatter from every `.md` and writes a single sorted `index.json`
 * (publishedAt descending, undated entries at the end).
 *
 * Use this when:
 *   - You've added a batch of pathway / guideline .md files
 *   - You've edited frontmatter (title, keywords, summary, tags) on existing posts
 *   - You suspect drift between .md files and index.json (e.g., an orphaned .md
 *     the chatbot router can't see)
 *
 * For single-article CREATE: use `/blog-post` (writes both .md and index entry).
 * For single-article RENAME/EDIT: use `/blog-update` (the .md + index entry).
 * For everything else, or to recover from drift: run this script.
 *
 * Usage: npx tsx scripts/rebuild-blog-index.ts
 *        (also exposed as: npm run rebuild-index)
 *
 * History: deleted in c024c08 (Apr 2026, "clean up scripts") — turned out
 * not to be obsolete; restored May 2026 after the aspirin orphan revealed
 * the gap. See docs/chat-architecture.md → "Source of truth: .md frontmatter".
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFrontmatter } from '../app/lib/frontmatter';

const BLOG_DIR = path.join(process.cwd(), 'docs/blog');
const INDEX_PATH = path.join(BLOG_DIR, 'index.json');

interface IndexEntry {
  title: string;
  handle: string;
  url: string;
  /**
   * The microvitamin.com (commerce) SEO post URL, when a commerce version of
   * this post exists. `url` stays the drstanfield.com (education) URL; this is
   * its commerce twin. The chatbot cites `commerceUrl` in brand posture and
   * `url` in doctor posture (falling back to `url` when this is absent).
   * See docs/blog-website-update.md (two-store blog plan).
   */
  commerceUrl?: string;
  tags: string[];
  keywords: string[];
  publishedAt: string;
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
  youtube?: string;
  product?: 'microvitamin' | 'microvitamin-plus' | 'sleep';
  summary?: string;
  /** Master handles this post is about (US-50 AC2). */
  topics?: string[];
  /** Set only on a single-subject post: the router may drop it once its masters are up to date (US-50 AC3). */
  router?: 'hidden';
  /** A master's review date, YYYY-MM-DD (US-50 AC1). */
  reviewed?: string;
}

// Directories to scan for content files
const CONTENT_DIRS = [
  path.join(process.cwd(), 'docs/blog'),
  path.join(process.cwd(), 'docs/guideline'),
  path.join(process.cwd(), 'docs/pathway'),
];

/** One index entry from a file's frontmatter. Exported for tests. */
export function indexEntry(handle: string, fm: Record<string, any>): IndexEntry {
  const entry: IndexEntry = {
    title: fm.title,
    handle,
    url: fm.url || `https://drstanfield.com/blogs/articles/${handle}`,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    keywords: Array.isArray(fm.keywords) ? fm.keywords : [],
    publishedAt: fm.publishedAt || '',
  };

  if (fm.commerceUrl) entry.commerceUrl = fm.commerceUrl;
  if (fm.type) entry.type = fm.type;
  if (fm.youtube) entry.youtube = fm.youtube;
  if (fm.product) entry.product = fm.product;
  if (fm.summary) entry.summary = fm.summary;
  // Topic masters (US-50 AC2). A malformed value is left out, so it hides nothing.
  if (Array.isArray(fm.topics) && fm.topics.every((t: unknown) => typeof t === 'string')) entry.topics = fm.topics;
  // Only an article may leave the router's view; a master, pathway or guideline never does.
  if (fm.router === 'hidden' && (fm.type ?? 'article') === 'article') entry.router = 'hidden';
  else if (fm.router !== undefined) console.warn(`  ⚠ ${handle}: router: ${fm.router} refused (only "hidden", on an article)`);
  if (typeof fm.reviewed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fm.reviewed)) entry.reviewed = fm.reviewed;
  return entry;
}

function main() {
  const index: IndexEntry[] = [];
  const stats = { blog: 0, guideline: 0, pathway: 0, skipped: 0 };

  for (const dir of CONTENT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    const dirName = path.basename(dir);
    console.log(`Found ${files.length} .md files in ${dir}`);

    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm || !fm.title) {
        console.warn(`  ⚠ Skipping ${file} — no valid frontmatter`);
        stats.skipped++;
        continue;
      }

      index.push(indexEntry(file.replace('.md', ''), fm));
      stats[dirName as keyof typeof stats]++;
    }
  }

  // Sort by publishedAt descending (newest first). Pathways/guidelines without
  // an explicit publishedAt sort to the bottom — they're matched by keyword, not
  // by recency, so order doesn't affect routing.
  index.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.log(`\nWrote ${index.length} entries to ${INDEX_PATH}`);
  console.log(`  ${stats.blog} blog + ${stats.guideline} guideline + ${stats.pathway} pathway`);
  if (stats.skipped) console.log(`  ⚠ Skipped ${stats.skipped} files with no/invalid frontmatter`);
}

// Run only as a script, so the test can import indexEntry.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
