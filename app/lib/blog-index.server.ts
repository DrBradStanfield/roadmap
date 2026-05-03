import { readFileSync } from 'fs';
import path from 'path';

export interface BlogIndexEntry {
  title: string;
  handle: string;
  url: string;
  tags: string[];
  keywords?: string[];
  publishedAt: string;
  youtube?: string;
  summary?: string;
  type?: 'reference' | 'article' | 'guideline' | 'pathway';
}

const INDEX_PATH = path.join(process.cwd(), 'docs/blog/index.json');

let cached: BlogIndexEntry[] | null = null;

/**
 * Read and parse `docs/blog/index.json`. Cached for the lifetime of the process —
 * the file is rebuilt at deploy time, and process restarts pick up new entries.
 *
 * Returns `[]` if the file is missing or malformed (warning logged once).
 */
export function loadBlogIndex(): BlogIndexEntry[] {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(INDEX_PATH, 'utf-8')) as BlogIndexEntry[];
  } catch {
    console.warn(`docs/blog/index.json not found at ${INDEX_PATH} — features depending on blog data will be empty`);
    cached = [];
  }
  return cached;
}
