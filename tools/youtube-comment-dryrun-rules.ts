// The comment shapes and the pure input rules of youtube-comment-dryrun.ts, split out for the file-size
// cap (US-64 AC23): the video-id parse, the filter and the result type. No state, no side effects.

import type { BlogIndexEntry } from '../app/lib/blog-index.server';
import type { Classification } from '../packages/health-core/src/models';

// Extract video ID from URL forms or accept raw ID
export function extractVideoId(input: string): string {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  throw new Error(`Could not extract video ID from: ${input}`);
}

export interface BlogPost {
  slug: string;
  title: string;
  body: string;
  entry: BlogIndexEntry;
}

export interface YouTubeComment {
  author: string;
  text: string;
  likes: number;
  replyCount: number;
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Filter logic — mirrors production rules
// ---------------------------------------------------------------------------

interface FilterDecision {
  keep: boolean;
  reason?: string;
}

export function filterComment(c: YouTubeComment): FilterDecision {
  const text = c.text.trim();
  // Top-level only (we don't pass replies to this loop — fetchComments already
  // returns only top-level threads).
  if (!text) return { keep: false, reason: 'empty' };
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 5) return { keep: false, reason: `too short (${wordCount} words)` };
  // Brad's own channel — if we knew his author display name we'd skip it. The
  // YouTube API's authorChannelId would be the deterministic check; for the
  // dry-run we treat "Dr Brad Stanfield" as Brad's display name and skip those.
  if (/^Dr\.?\s*Brad\s*Stanfield$/i.test(c.author.trim())) return { keep: false, reason: "Brad's own comment" };
  return { keep: true };
}

export interface DryRunResult {
  comment: YouTubeComment;
  filter: FilterDecision;
  classification?: Classification;
  routerHandles?: string[];
  routerError?: string | null;
  reply?: string;
  replyError?: string | null;
  willPost: boolean;
  skipReason?: string;
}
