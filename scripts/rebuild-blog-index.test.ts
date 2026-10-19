/**
 * US-50 AC2: the index carries a post's `topics`, `router` and a master's
 * `reviewed`, each from a one-line frontmatter key (`topics` is a single-line
 * JSON array). Anything else in those keys is left out of the entry.
 */
import { describe, it, expect } from 'vitest';
import { indexEntry } from './rebuild-blog-index';
import { parseFrontmatter } from '../app/lib/frontmatter';

const md = (lines: string[]) => `---\n${lines.join('\n')}\n---\n\nBody.\n`;
const entry = (lines: string[]) => indexEntry('a-post', parseFrontmatter(md(['title: "A post"', ...lines]))!);

describe('rebuild-blog-index topic-master keys (US-50 AC2)', () => {
  it('carries topics, router and reviewed', () => {
    const e = entry([
      'publishedAt: "2025-03-12T00:00:00Z"',
      'topics: ["collagen", "nad-nmn"]',
      'router: "hidden"',
      'reviewed: "2026-10-20"',
    ]);
    expect(e.topics).toEqual(['collagen', 'nad-nmn']);
    expect(e.router).toBe('hidden');
    expect(e.reviewed).toBe('2026-10-20');
  });

  it('leaves the keys out when the file has none (a rebuild adds nothing today)', () => {
    const e = entry(['publishedAt: "2025-03-12T00:00:00Z"']);
    expect(Object.keys(e)).toEqual(['title', 'handle', 'url', 'tags', 'keywords', 'publishedAt']);
  });

  it('refuses router on a file that is not an article (M1)', () => {
    expect(entry(['type: "reference"', 'router: "hidden"']).router).toBeUndefined();
    expect(entry(['type: "pathway"', 'router: "hidden"']).router).toBeUndefined();
    expect(entry(['type: "article"', 'router: "hidden"']).router).toBe('hidden');
  });

  it('drops malformed values: router other than hidden, a non-array or non-string topics, a bad date', () => {
    expect(entry(['router: "visible"']).router).toBeUndefined();
    expect(entry(['topics: collagen']).topics).toBeUndefined();
    expect(entry(['topics: [1, 2]']).topics).toBeUndefined();
    expect(entry(['reviewed: "20 October 2026"']).reviewed).toBeUndefined();
  });
});
