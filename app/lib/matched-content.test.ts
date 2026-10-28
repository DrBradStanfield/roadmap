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
const guideline = index.find(e => e.type === 'guideline')!;

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
    expect(contentHeader({ ...base, type: 'guideline', publishedAt: '' }, {})).toBe('[guideline]');
    expect(contentHeader(undefined, {})).toBe('[article]');
  });

  it('carries the title, links and video link from the frontmatter, and only those (B2)', () => {
    expect(contentHeader(base, { title: 'A post', url: 'https://d/a', commerceUrl: 'https://m/a', youtube: 'https://youtu.be/x', keywords: ['k'] }))
      .toBe('[article — published 2025-03-12]\ntitle: A post\nurl: https://d/a\ncommerceUrl: https://m/a\nyoutube: https://youtu.be/x');
  });

  it('a loaded video post opens with its header; a guideline gets no link it never had', () => {
    const { content } = loadMatchedContent([video.handle, guideline.handle]);
    expect(content!.startsWith(`[video post — published ${video.publishedAt.slice(0, 10)}]\ntitle: ${video.title}\nurl: ${video.url}\ncommerceUrl: ${video.commerceUrl}\nyoutube: ${video.youtube}\n\n`)).toBe(true);
    expect(content).toContain(`\n\n---\n\n[guideline]\ntitle: ${guideline.title}\n\n`);
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
  // A real page grown to `size` chars, measured on the raw file with its
  // frontmatter, by a section its reduced forms leave out, so a test pins the cap's behaviour, not today's page sizes: the masters keep
  // growing (omega-3 passed the old 120,000 cap on 2026-10-22).
  const grown = (raw: string, size: number) => `${raw}\n\n## Grown for the test\n\n${'z'.repeat(Math.max(0, size - raw.length))}\n`;
  const grow = (sizes: Record<string, number>) => (handle: string, raw: string) => (handle in sizes ? grown(raw, sizes[handle]) : raw);
  // loadMatchedContent from a fresh module (loadBlogArticle caches), reading
  // each .md file through `edit`.
  async function loaderWith(edit: (handle: string, raw: string) => string) {
    vi.resetModules();
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const raw = (realRead as (...a: unknown[]) => unknown)(p, ...rest);
      return String(p).endsWith('.md') ? edit(path.basename(String(p), '.md'), String(raw)) : raw;
    }) as typeof fs.readFileSync);
    return (await import('./matched-content')).loadMatchedContent;
  }
  // Vitamin D grown so vitamin K, whole, no longer fits after it.
  const bigD = grow({ [D]: MAX_BLOG_CHARS - 30_000 });

  it('vitamin D + vitamin K: both load, with vitamin K\'s warfarin lines', async () => {
    const { content, titles, skipped } = (await loaderWith(bigD))([D, K]);
    expect(skipped).toEqual([]);
    expect(titles).toHaveLength(2);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    expect(content).toMatch(/^#+ Warfarin and Vitamin K Antagonists$/m);
    expect(content).toContain('Vitamin K can have a serious and potentially dangerous interaction with warfarin');
    expect(content).toMatch(/^#+ 5\. Safety and Side Effects$/m);
    expect(content).toContain('Internal note, do not quote: this page is shortened to fit.');
  });

  // US-15 AC23: the cap sits above the largest entry, so a master routed alone
  // loads whole, evidence sections and all (omega-3 outgrew 120,000 on 2026-10-22).
  it('every current master loads whole when routed alone', () => {
    for (const m of index.filter(isMaster).map(e => e.handle)) {
      const { reduced, skipped } = loadMatchedContent([m]);
      expect({ m, reduced, skipped }).toEqual({ m, reduced: [], skipped: [] });
    }
  });

  it('names each master that loaded reduced, for the match log (US-50 AC14 usage signal)', async () => {
    expect((await loaderWith(bigD))([D, K]).reduced).toEqual([K]);
    expect(loadMatchedContent([MG]).reduced).toEqual([]);
  });

  // A large non-master routed before or between masters must leave the later
  // masters their room too (the re-check: 197 of 1,140 pairs with one between,
  // 42 with it first, dropped a master whole).
  const LITHIUM = 'lithium-benefits-forms-dosing-and-side-effects';
  // US-50 masters-new-7 (2026-10-25): probiotics became a master; masters-new-13 (2026-10-26): weight loss did too, so beetroot (about 63K, held from the masters plan) stands in.
  const BIG_POST = 'beetroot-benefits-forms-dosing-and-side-effects';
  const warfarin = (content: string | null) => {
    expect(content).toMatch(/^#+ Warfarin and Vitamin K Antagonists$/m);
    expect(content).toContain('Vitamin K can have a serious and potentially dangerous interaction with warfarin');
  };

  it('[lithium, beetroot post, vitamin K]: vitamin K loads with its warfarin lines', () => {
    const { content, skipped } = loadMatchedContent([LITHIUM, BIG_POST, K]);
    expect(skipped).not.toContain(K);
    expect(skipped).not.toContain(LITHIUM);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    warfarin(content);
  });

  it('[beetroot post, vitamin C, B vitamins]: a non-master first leaves both masters their room', () => {
    const C = 'vitamin-c-benefits-forms-dosing-and-side-effects';
    const B = 'b-vitamins-benefits-forms-dosing-and-side-effects';
    const { content, skipped } = loadMatchedContent([BIG_POST, C, B]);
    expect(skipped).not.toContain(C);
    expect(skipped).not.toContain(B);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
    expect(lastPart(content!)).toMatch(/^title: .*B Vitamins/m);
    expect(lastPart(content!)).toMatch(/^#+ \d+\. Safety and Side Effects$/m);
  });

  it('a non-master that fits alongside the later masters\' reserve still loads', () => {
    const { content, skipped } = loadMatchedContent([BIG_POST, LITHIUM]);
    expect(skipped).toEqual([]);
    expect(content).toContain('title: Beetroot: Benefits');
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
  });

  // US-50 masters-new-1 (2026-10-23): vitamin A became a master; masters-new-17 (2026-10-26): mangosteen did too, so l-citrulline (about 60K, held from the masters plan) stands in.
  it('[vitamin K, l-citrulline post, lithium]: a master shrinks so the post after it loads too (review S1)', async () => {
    const A = 'l-citrulline-benefits-forms-dosing-and-side-effects';
    expect(index.find(e => e.handle === A) && isMaster(index.find(e => e.handle === A)!)).toBe(false);
    // Vitamin K grown so the three do not fit whole together.
    const { content, skipped } = (await loaderWith(grow({ [K]: MAX_BLOG_CHARS - 40_000 })))([K, A, LITHIUM]);
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

  it('magnesium + vitamin D: both load, vitamin D reduced with its safety and interactions', async () => {
    const { content, skipped } = (await loaderWith(grow({ [MG]: MAX_BLOG_CHARS - 30_000 })))([MG, D]);
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

  it('every citation in a reduced master keeps its reference line: taurine\'s view cites [26] (Codex R1)', async () => {
    const PROTEIN = 'protein-powders-benefits-types-dosing-and-side-effects';
    const { content, skipped } = (await loaderWith(grow({ [PROTEIN]: MAX_BLOG_CHARS - 20_000 })))([PROTEIN, 'taurine-benefits-forms-dosing-and-side-effects']);
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

  it('a reduced master keeps its Recommended Dosing when it fits: magnesium\'s UL after vitamin D (adversary R2)', async () => {
    const { content } = (await loaderWith(bigD))([D, MG]);
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
      // Fits alone, but not beside vitamin D even at its smallest (about 9,300).
      if (path.basename(String(p), '.md') === 'cap-test-post') return `## Safety\n\n${'p'.repeat(MAX_BLOG_CHARS - 3_000)}`;
      return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    const { content, skipped } = loadMatchedContent([D, 'cap-test-post']);
    expect(skipped).toEqual(['cap-test-post']);
    expect(content).not.toContain('ppp');
  });

  it('a master whose reduced form still does not fit is skipped', async () => {
    const loadMatchedContent = await loaderWith((handle, raw) => (handle === POTASSIUM ? raw.replace('## 5. Safety and Side Effects', `## 5. Safety and Side Effects\n\n${'q'.repeat(MAX_BLOG_CHARS + 5_000)}`) : raw));
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
    expect(large).toContain(BIG_POST);
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
  }, 300_000); // 3 x masters² loads: ~40 s alone at 48 masters, grows with each batch

  it('a reduced master logs what it dropped once, and a whole one logs nothing (review S2)', async () => {
    const loadMatchedContent = await loaderWith((handle, raw) => (handle === K ? raw.replace(/^(## Current view.*)$/m, `$1\n\n${'v'.repeat(6_000)}`) : bigD(handle, raw)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logged = () => warn.mock.calls.map(([m]) => String(m)).filter(m => m.startsWith('Chat reduced master'));
    loadMatchedContent([K]);
    expect(logged()).toEqual([]);
    loadMatchedContent([D, K]);
    expect(logged()).toEqual([`Chat reduced master: current view over 6000 characters, dropped: ${K}`]);
    vi.resetModules();
  });
});
