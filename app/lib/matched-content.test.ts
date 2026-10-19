/**
 * US-50 AC4: loaded entries reach the answer model without their YAML
 * frontmatter, and the frontmatter never counts against MAX_BLOG_CHARS.
 * US-50 AC5: each loaded block opens with a header naming its type and date,
 * plus the title and the links the posture rules cite (`url:`, `commerceUrl:`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadMatchedContent, contentHeader, MAX_BLOG_CHARS } from './matched-content';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';

const index = loadBlogIndex();
const video = index.find(e => e.youtube && e.commerceUrl)!;
const pathway = index.find(e => e.type === 'pathway')!;

describe('frontmatter stripped before the model (US-50 AC4)', () => {
  it('a loaded entry carries its body, never its frontmatter block', () => {
    const { content } = loadMatchedContent([video.handle]);
    expect(content).not.toMatch(/^---/);
    expect(content).not.toMatch(/^keywords:/m);
    expect(content).not.toMatch(/^summary:/m);
    expect(content).toContain(fs.readFileSync(path.join('docs/blog', `${video.handle}.md`), 'utf-8').replace(/^---[\s\S]*?---\n\n?/, '').slice(0, 500));
  });

  describe('the cap counts the stripped text', () => {
    const realRead = fs.readFileSync;
    afterEach(() => { vi.restoreAllMocks(); });

    it('two entries whose bodies fit load together, though their raw files would not', () => {
      const files: Record<string, string> = {
        'fm-test-a': `---\nsummary: ${'s'.repeat(60_000)}\n---\n\n${'a'.repeat(60_000)}`,
        'fm-test-b': `---\nsummary: x\n---\n\n${'b'.repeat(59_000)}`,
      };
      vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        const handle = path.basename(String(p), '.md');
        if (handle in files) return files[handle];
        return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.readFileSync);
      expect(files['fm-test-a'].length + files['fm-test-b'].length).toBeGreaterThan(MAX_BLOG_CHARS);
      const { content, skipped } = loadMatchedContent(['fm-test-a', 'fm-test-b']);
      expect(skipped).toEqual([]);
      expect(content).toContain('a'.repeat(60_000));
      expect(content).toContain('b'.repeat(59_000));
      expect(content).not.toContain('sss');
    });
  });
});

describe('block headers (US-50 AC5)', () => {
  const base: BlogIndexEntry = { title: 'T', handle: 'h', url: 'u', tags: [], publishedAt: '2025-03-12T08:00:00Z' };

  it('names the type and date', () => {
    expect(contentHeader({ ...base, type: 'reference', reviewed: '2026-10-20' }, {})).toBe('[reference — reviewed 2026-10-20]');
    expect(contentHeader({ ...base, type: 'reference' }, {})).toBe('[reference — published 2025-03-12]');
    expect(contentHeader({ ...base, youtube: 'https://youtu.be/x' }, {})).toBe('[video post — published 2025-03-12]');
    expect(contentHeader(base, {})).toBe('[article — published 2025-03-12]');
    expect(contentHeader({ ...base, type: 'pathway', publishedAt: '' }, {})).toBe('[pathway]');
    expect(contentHeader(undefined, {})).toBe('[article]');
  });

  it('carries the title, links and video link from the frontmatter, and only those (B2)', () => {
    expect(contentHeader(base, { title: 'A post', url: 'https://d/a', commerceUrl: 'https://m/a', youtube: 'https://youtu.be/x', keywords: ['k'] }))
      .toBe('[article — published 2025-03-12]\ntitle: A post\nurl: https://d/a\ncommerceUrl: https://m/a\nyoutube: https://youtu.be/x');
  });

  it('a loaded video post opens with its header; a pathway gets no link it never had', () => {
    const { content } = loadMatchedContent([video.handle, pathway.handle]);
    expect(content!.startsWith(`[video post — published ${video.publishedAt.slice(0, 10)}]\ntitle: ${video.title}\nurl: ${video.url}\ncommerceUrl: ${video.commerceUrl}\nyoutube: ${video.youtube}\n\n`)).toBe(true);
    expect(content).toContain(`\n\n---\n\n[pathway]\ntitle: ${pathway.title}\n\n`);
  });
});
