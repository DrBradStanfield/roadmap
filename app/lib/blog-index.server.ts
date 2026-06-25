import { readFileSync } from 'fs';
import path from 'path';

export interface BlogIndexEntry {
  title: string;
  handle: string;
  url: string;
  /** microvitamin.com (commerce) SEO post URL, when a commerce version exists.
   *  `url` stays the drstanfield.com (education) URL. The chatbot cites
   *  `commerceUrl` on the brand surface and `url` on the doctor surface
   *  (see chat-posture-brand.md / chat-posture-doctor.md). */
  commerceUrl?: string;
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

/**
 * Find the blog post written for a given YouTube video ID. Matches against
 * the entry's `youtube` URL field (which the /blog-post skill sets to either
 * `https://www.youtube.com/watch?v=<id>` or `https://youtu.be/<id>`).
 * Returns null if no entry has that video ID.
 */
export function findBlogByVideoId(videoId: string): BlogIndexEntry | null {
  if (!videoId) return null;
  for (const entry of loadBlogIndex()) {
    if (entry.youtube?.includes(videoId)) return entry;
  }
  return null;
}
