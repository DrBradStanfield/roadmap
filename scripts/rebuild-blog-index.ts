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
   * See docs/blog-website-update.html (two-store blog plan).
   */
  commerceUrl?: string;
  tags: string[];
  keywords: string[];
  publishedAt: string;
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
  youtube?: string;
  product?: 'microvitamin' | 'microvitamin-plus' | 'sleep';
  summary?: string;
}

// Directories to scan for content files
const CONTENT_DIRS = [
  path.join(process.cwd(), 'docs/blog'),
  path.join(process.cwd(), 'docs/guideline'),
  path.join(process.cwd(), 'docs/pathway'),
];

function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, any> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value: any = rawValue.trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Parse JSON arrays
    if (value.startsWith('[')) {
      try { value = JSON.parse(value); } catch {}
    }

    fm[key] = value;
  }
  return fm;
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

      const handle = file.replace('.md', '');
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

      index.push(entry);
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

main();