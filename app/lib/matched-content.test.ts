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
import { isMaster, loadBlogIndex, type BlogIndexEntry } from './blog-index.server';

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

// US-50 AC13: a topic master that would overflow MAX_BLOG_CHARS loads reduced
// (current view, key safety points, safety sections), never skipped whole. The
// router fixture "I notice that there is a small amount of D3…" routes
// [vitamin D, vitamin K]: about 134K together, so vitamin K's warfarin section
// was dropped before this.
describe('a master over the cap loads reduced, safety kept (US-50 AC13)', () => {
  const D = 'vitamin-d-benefits-forms-dosing-and-side-effects';
  const K = 'vitamin-k-benefits-forms-dosing-and-side-effects';
  const MG = 'magnesium-benefits-best-forms-dosing';
  const POTASSIUM = 'potassium-benefits-forms-dosing-and-side-effects';
  const realRead = fs.readFileSync;
  afterEach(() => { vi.restoreAllMocks(); });

  it('vitamin D + vitamin K: both load, with vitamin K\'s warfarin lines', () => {
    const { content, titles, skipped } = loadMatchedContent([D, K]);
    expect(skipped).toEqual([]);
    expect(titles).toHaveLength(2);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    expect(content).toMatch(/^#+ Warfarin and Vitamin K Antagonists$/m);
    expect(content).toContain('Vitamin K can have a serious and potentially dangerous interaction with warfarin');
    expect(content).toMatch(/^#+ 5\. Safety and Side Effects$/m);
    expect(content).toContain('Internal note, do not quote: this page is shortened to fit.');
  });

  it('magnesium + vitamin D: both load, vitamin D reduced with its safety and interactions', () => {
    const { content, skipped } = loadMatchedContent([MG, D]);
    expect(skipped).toEqual([]);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    const tail = content!.slice(content!.lastIndexOf('\n\n---\n\n'));
    expect(tail).toMatch(/^#+ Current view/m);
    expect(tail).toMatch(/^#+ 5\. Safety and Side Effects$/m);
    expect(tail).toMatch(/^#+ 6\. Drug Interactions$/m);
    expect(tail).not.toMatch(/^#+ 3\. Evidence for Health Benefits$/m);
  });

  // The last block of a loaded context: the entry loaded after the final separator.
  const lastPart = (content: string) => content.slice(content.lastIndexOf('\n\n---\n\n'));
  const parts = (content: string) => content.split('\n\n---\n\n');

  it('every citation in a reduced master keeps its reference line: taurine\'s view cites [26] (Codex R1)', () => {
    const { content, skipped } = loadMatchedContent(['protein-powders-benefits-types-dosing-and-side-effects', 'taurine-benefits-forms-dosing-and-side-effects']);
    expect(skipped).toEqual([]);
    const tail = lastPart(content!);
    expect(tail).toContain('Internal note, do not quote');
    expect(tail).toMatch(/^#+ Current view[\s\S]*\[26\]/m);
    expect(tail).toMatch(/^\[26\] Sharma S/m);
  });

  it('a large first master yields so the next master loads at least reduced (adversary R1)', () => {
    for (const pair of [['b-vitamins-benefits-forms-dosing-and-side-effects', 'multivitamins-benefits-evidence-dosing-and-side-effects'], ['vitamin-c-benefits-forms-dosing-and-side-effects', 'b-vitamins-benefits-forms-dosing-and-side-effects']]) {
      const { content, skipped } = loadMatchedContent(pair);
      expect(skipped, pair.join(' + ')).toEqual([]);
      expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
      for (const part of parts(content!)) expect(part, pair.join(' + ')).toMatch(/^#+ \d+\. Safety and Side Effects$/m);
    }
  });

  it('a reduced master keeps its Recommended Dosing when it fits: magnesium\'s UL after vitamin D (adversary R2)', () => {
    const { content } = loadMatchedContent([D, MG]);
    const tail = lastPart(content!);
    expect(tail).toContain('Internal note, do not quote');
    expect(tail).toMatch(/^#+ 4\. Recommended Dosing$/m);
    expect(tail).toContain('The UL for supplemental magnesium (not including food sources) is **350 mg/day**');
  });

  it('the separators count against the cap: content never passes MAX_BLOG_CHARS (R4)', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const handle = path.basename(String(p), '.md');
      if (handle === 'sep-test-a') return 'a'.repeat(60_000);
      if (handle === 'sep-test-b') return 'b'.repeat(MAX_BLOG_CHARS - 60_000 - '[article]\n\n'.length * 2);
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const { content, skipped } = loadMatchedContent(['sep-test-a', 'sep-test-b']);
    expect(skipped).toEqual(['sep-test-b']);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
  });

  it('a non-master entry that would overflow is still skipped whole', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (path.basename(String(p), '.md') === 'cap-test-post') return `## Safety\n\n${'p'.repeat(60_000)}`;
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const { content, skipped } = loadMatchedContent([D, 'cap-test-post']);
    expect(skipped).toEqual(['cap-test-post']);
    expect(content).not.toContain('ppp');
  });

  it('a master whose reduced form still does not fit is skipped', () => {
    const real = String(realRead(path.join('docs/blog', `${POTASSIUM}.md`), 'utf-8'));
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (path.basename(String(p), '.md') === POTASSIUM) return real.replace('## 5. Safety and Side Effects', `## 5. Safety and Side Effects\n\n${'q'.repeat(125_000)}`);
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const { content, skipped } = loadMatchedContent([D, POTASSIUM]);
    expect(skipped).toEqual([POTASSIUM]);
    expect(content).not.toContain('qqq');
  });
  // A fresh module: loadBlogArticle's cache still holds the mocked files above.
  it('every ordered pair of masters loads both, safety sections present, inside the cap (R1, R4)', async () => {
    vi.resetModules();
    const { loadMatchedContent } = await import('./matched-content');
    const masters = loadBlogIndex().filter(isMaster).map(e => e.handle);
    expect(masters.length).toBeGreaterThanOrEqual(20);
    for (const a of masters) for (const b of masters) {
      if (a === b) continue;
      const { content, skipped } = loadMatchedContent([a, b]);
      expect(skipped, `${a} + ${b}`).toEqual([]);
      expect(content!.length, `${a} + ${b}`).toBeLessThanOrEqual(MAX_BLOG_CHARS);
      for (const part of parts(content!)) expect(part, `${a} + ${b}`).toMatch(/^#+ .*Safety/m);
    }
  });
});
