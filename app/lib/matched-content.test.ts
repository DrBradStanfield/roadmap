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

  it('names each master that loaded reduced, for the match log (US-50 AC14 usage signal)', () => {
    expect(loadMatchedContent([D, K]).reduced).toEqual([K]);
    expect(loadMatchedContent([MG]).reduced).toEqual([]);
  });

  // A large non-master routed before or between masters must leave the later
  // masters their room too (the re-check: 197 of 1,140 pairs with one between,
  // 42 with it first, dropped a master whole).
  const LITHIUM = 'lithium-benefits-forms-dosing-and-side-effects';
  const PROBIOTICS = 'probiotics-benefits-strains-dosing-and-side-effects';
  const warfarin = (content: string | null) => {
    expect(content).toMatch(/^#+ Warfarin and Vitamin K Antagonists$/m);
    expect(content).toContain('Vitamin K can have a serious and potentially dangerous interaction with warfarin');
  };

  it('[lithium, probiotics, vitamin K]: vitamin K loads with its warfarin lines', () => {
    const { content, skipped } = loadMatchedContent([LITHIUM, PROBIOTICS, K]);
    expect(skipped).not.toContain(K);
    expect(skipped).not.toContain(LITHIUM);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    warfarin(content);
  });

  it('[probiotics, vitamin C, B vitamins]: a non-master first leaves both masters their room', () => {
    const C = 'vitamin-c-benefits-forms-dosing-and-side-effects';
    const B = 'b-vitamins-benefits-forms-dosing-and-side-effects';
    const { content, skipped } = loadMatchedContent([PROBIOTICS, C, B]);
    expect(skipped).not.toContain(C);
    expect(skipped).not.toContain(B);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    expect(lastPart(content!)).toMatch(/^title: .*B Vitamins/m);
    expect(lastPart(content!)).toMatch(/^#+ \d+\. Safety and Side Effects$/m);
  });

  it('a non-master that fits alongside the later masters\' reserve still loads', () => {
    const { content, skipped } = loadMatchedContent([PROBIOTICS, LITHIUM]);
    expect(skipped).toEqual([]);
    expect(content).toContain('title: Probiotics: Benefits');
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
  });

  it('[vitamin K, vitamin A post, lithium]: a master shrinks so the post after it loads too (review S1)', () => {
    const A = 'vitamin-a-benefits-forms-dosing-and-side-effects';
    expect(index.find(e => e.handle === A) && isMaster(index.find(e => e.handle === A)!)).toBe(false);
    const { content, skipped } = loadMatchedContent([K, A, LITHIUM]);
    expect(skipped).toEqual([]);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    expect(content!.split('\n\n---\n\n')[0]).toContain('Internal note, do not quote');
    warfarin(content);
  });

  it('a handle routed twice loads once (review N1)', () => {
    const { content, titles } = loadMatchedContent([D, D]);
    expect(titles).toHaveLength(1);
    expect(content!.match(/^title: /gm)).toHaveLength(1);
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
      if (path.basename(String(p), '.md') === 'cap-test-post') return `## Safety\n\n${'p'.repeat(117_000)}`;
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

  it('every ordered pair of masters with a large non-master first or between: no master skipped, inside the cap', async () => {
    vi.resetModules();
    const { loadMatchedContent, loadBlogArticle, contentBlock, contentForms } = await import('./matched-content');
    const minimum = (h: string) => Math.min(...contentForms(h, loadBlogArticle(h)!).map(f => f.length));
    const masters = loadBlogIndex().filter(isMaster).map(e => e.handle);
    const large = loadBlogIndex().filter(e => !isMaster(e))
      .map(e => ({ handle: e.handle, size: contentBlock(e.handle, loadBlogArticle(e.handle) ?? '').length }))
      .sort((x, y) => y.size - x.size).slice(0, 3).map(e => e.handle);
    expect(large).toContain(PROBIOTICS);
    for (const n of large) for (const a of masters) for (const b of masters) {
      if (a === b) continue;
      for (const order of [[a, n, b], [n, a, b]]) {
        const { content, skipped } = loadMatchedContent(order);
        expect(skipped.filter(h => h !== n), order.join(' + ')).toEqual([]);
        // Masters shrink before a post between them is dropped (review S1).
        if (order[0] === a && minimum(a) + minimum(n) + minimum(b) + 2 * '\n\n---\n\n'.length <= MAX_BLOG_CHARS) expect(skipped, order.join(' + ')).toEqual([]);
        expect(content!.length, order.join(' + ')).toBeLessThanOrEqual(MAX_BLOG_CHARS);
      }
    }
  });

  it('a reduced master logs what it dropped once, and a whole one logs nothing (review S2)', async () => {
    vi.resetModules();
    const real = String(realRead(path.join('docs/blog', `${K}.md`), 'utf-8'));
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (path.basename(String(p), '.md') === K) return real.replace(/^(## Current view.*)$/m, `$1\n\n${'v'.repeat(6_000)}`);
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const { loadMatchedContent } = await import('./matched-content');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logged = () => warn.mock.calls.map(([m]) => String(m)).filter(m => m.startsWith('Chat reduced master'));
    loadMatchedContent([K]);
    expect(logged()).toEqual([]);
    loadMatchedContent([D, K]);
    expect(logged()).toEqual([`Chat reduced master: current view over 6000 characters, dropped: ${K}`]);
    vi.resetModules();
  });
});
