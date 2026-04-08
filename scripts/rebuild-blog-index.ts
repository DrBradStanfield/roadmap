/**
 * Rebuilds docs/blog/index.json from .md file frontmatter.
 *
 * Use after batch article generation (where multiple agents wrote .md files
 * but skipped index.json to avoid concurrent write corruption).
 *
 * Usage: npx tsx scripts/rebuild-blog-index.ts
 */

import fs from 'fs';
import path from 'path';

const BLOG_DIR = path.join(process.cwd(), 'docs/blog');
const INDEX_PATH = path.join(BLOG_DIR, 'index.json');

interface IndexEntry {
  title: string;
  handle: string;
  url: string;
  tags: string[];
  keywords: string[];
  publishedAt: string;
  type?: 'reference' | 'article';
  youtube?: string;
  summary?: string;
}

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
  const files = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.md'));
  console.log(`Found ${files.length} .md files in ${BLOG_DIR}`);

  const index: IndexEntry[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(BLOG_DIR, file), 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.title) {
      console.warn(`  ⚠ Skipping ${file} — no valid frontmatter`);
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

    if (fm.type) entry.type = fm.type;
    if (fm.youtube) entry.youtube = fm.youtube;
    if (fm.summary) entry.summary = fm.summary;

    index.push(entry);
  }

  // Sort by publishedAt descending (newest first)
  index.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.log(`\nWrote ${index.length} entries to ${INDEX_PATH}`);

  // Stats
  const refCount = index.filter(e => e.type === 'reference').length;
  const blogCount = index.length - refCount;
  console.log(`  ${refCount} reference articles, ${blogCount} blog posts`);
}

main();
