/**
 * US-50 AC3: the router's view of the index. A `router: hidden` post leaves the
 * view only when every master in its `topics` exists and was reviewed on or
 * after the post's publish date. Everything else stays.
 * `TOPIC_MASTER_HIDE=off` restores the full view.
 */
import { describe, it, expect } from 'vitest';
import { routerView, routerIndexBlock, preferMasters, namedArticles } from './router-view';
import type { BlogIndexEntry } from './blog-index.server';

const post = (handle: string, over: Partial<BlogIndexEntry> = {}): BlogIndexEntry => ({
  title: handle, handle, url: `https://x/${handle}`, tags: [], publishedAt: '2025-03-12T00:00:00Z', ...over,
});
const master = (handle: string, reviewed?: string): BlogIndexEntry =>
  post(handle, { type: 'reference', publishedAt: '2024-01-01T00:00:00Z', ...(reviewed ? { reviewed } : {}) });

const handles = (view: BlogIndexEntry[]) => view.map(e => e.handle);

describe('routerView (US-50 AC3)', () => {
  const collagen = master('collagen', '2026-10-20');
  const nad = master('nad-nmn'); // not rewritten yet: no reviewed date

  it('omits a hidden post whose master was reviewed on or after the post', () => {
    const hidden = post('collagen-video', { topics: ['collagen'], router: 'hidden' });
    const sameDay = post('collagen-same-day', { topics: ['collagen'], router: 'hidden', publishedAt: '2026-10-20T09:00:00Z' });
    expect(handles(routerView([collagen, hidden, sameDay], true))).toEqual(['collagen']);
  });

  it('keeps a mixed-topic post (topics but no router: hidden)', () => {
    const mixed = post('reverse-signs-skin-aging', { topics: ['collagen'] });
    expect(handles(routerView([collagen, mixed], true))).toEqual(['collagen', 'reverse-signs-skin-aging']);
  });

  it('keeps a hidden post whose master is not reviewed', () => {
    const hidden = post('nmn-video', { topics: ['nad-nmn'], router: 'hidden' });
    expect(handles(routerView([nad, hidden], true))).toEqual(['nad-nmn', 'nmn-video']);
  });

  it('keeps a hidden post newer than its master\'s reviewed date', () => {
    const newer = post('collagen-new-video', { topics: ['collagen'], router: 'hidden', publishedAt: '2026-10-21T00:00:00Z' });
    expect(handles(routerView([collagen, newer], true))).toEqual(['collagen', 'collagen-new-video']);
  });

  it('keeps a hidden post when any one of its masters fails the gate, is missing, or is not a reference', () => {
    const two = post('two-masters', { topics: ['collagen', 'nad-nmn'], router: 'hidden' });
    const missing = post('missing-master', { topics: ['no-such-master'], router: 'hidden' });
    const notRef = post('article-as-master', { topics: ['an-article'], router: 'hidden' });
    const article = post('an-article', { reviewed: '2026-10-20' });
    const noTopics = post('no-topics', { router: 'hidden' });
    const view = routerView([collagen, nad, two, missing, notRef, article, noTopics], true);
    expect(handles(view)).toEqual(['collagen', 'nad-nmn', 'two-masters', 'missing-master', 'article-as-master', 'an-article', 'no-topics']);
  });

  it('hides only article entries: a reference, pathway or guideline marked hidden stays (M1)', () => {
    const asRef = master('other-ref', '2026-10-20');
    const hiddenRef: BlogIndexEntry = { ...asRef, topics: ['collagen'], router: 'hidden' };
    const hiddenPathway = post('a-pathway', { type: 'pathway', topics: ['collagen'], router: 'hidden' });
    expect(handles(routerView([collagen, hiddenRef, hiddenPathway], true))).toEqual(['collagen', 'other-ref', 'a-pathway']);
  });

  it('a hidden post with no publish date stays, and does not throw (L1)', () => {
    const undated = post('undated', { topics: ['collagen'], router: 'hidden', publishedAt: undefined as unknown as string });
    expect(handles(routerView([collagen, undated], true))).toEqual(['collagen', 'undated']);
  });

  it('a master whose reviewed is not YYYY-MM-DD hides nothing (L2)', () => {
    const odd = master('odd', 'zzzz');
    const hidden = post('odd-video', { topics: ['odd'], router: 'hidden' });
    expect(handles(routerView([odd, hidden], true))).toEqual(['odd', 'odd-video']);
  });

  it('TOPIC_MASTER_HIDE=off restores the full view', () => {
    const hidden = post('collagen-video', { topics: ['collagen'], router: 'hidden' });
    const prev = process.env.TOPIC_MASTER_HIDE;
    try {
      process.env.TOPIC_MASTER_HIDE = 'off';
      expect(handles(routerView([collagen, hidden]))).toEqual(['collagen', 'collagen-video']);
      delete process.env.TOPIC_MASTER_HIDE;
      expect(handles(routerView([collagen, hidden]))).toEqual(['collagen']);
    } finally {
      if (prev === undefined) delete process.env.TOPIC_MASTER_HIDE; else process.env.TOPIC_MASTER_HIDE = prev;
    }
  });

  it('the index block lists only the view, sorted by type then handle', () => {
    const hidden = post('collagen-video', { topics: ['collagen'], router: 'hidden', summary: 'old collagen video' });
    const block = routerIndexBlock(routerView([hidden, collagen, post('b-article')], true));
    expect(block).toBe('[reference] collagen: collagen\n[article] b-article: b-article');
  });
});

/**
 * US-50 AC14: after routing, an article pick that names topic masters is
 * replaced by those masters in its slot, unless the article is named (open
 * in the chat, its URL or handle in the message, or the YouTube video's own
 * post) or newer than every master it names.
 */
describe('preferMasters (US-50 AC14)', () => {
  const d = master('vitamin-d', '2026-10-20');
  const k = master('vitamin-k', '2026-10-20');
  const stale = master('nad-nmn'); // a reference with no reviewed date: not a master
  const dVideo = post('vitamin-d-video', { topics: ['vitamin-d'] });
  const dkVideo = post('d-and-k-video', { topics: ['vitamin-d', 'vitamin-k'] });
  const pathway = post('a-pathway', { type: 'pathway', topics: ['vitamin-d'] });
  const guideline = post('a-guideline', { type: 'guideline', topics: ['vitamin-d'] });
  const ref = { ...master('other-ref'), topics: ['vitamin-d'] };
  const nadVideo = post('nad-video', { topics: ['nad-nmn'] });
  const plain = post('plain-article');
  const index = [d, k, stale, dVideo, dkVideo, pathway, guideline, ref, nadVideo, plain];
  const none = new Set<string>();

  it('replaces an article pick with its master in the same slot', () => {
    expect(preferMasters(['a-pathway', 'vitamin-d-video', 'plain-article'], index, none))
      .toEqual({ handles: ['a-pathway', 'vitamin-d', 'plain-article'], replaced: ['vitamin-d-video'] });
  });

  it('a multi-master article becomes all its masters, in its slot', () => {
    expect(preferMasters(['d-and-k-video', 'plain-article'], index, none))
      .toEqual({ handles: ['vitamin-d', 'vitamin-k', 'plain-article'], replaced: ['d-and-k-video'] });
  });

  it('keeps the result to 3 handles', () => {
    expect(preferMasters(['a-pathway', 'd-and-k-video', 'plain-article'], index, none))
      .toEqual({ handles: ['a-pathway', 'vitamin-d', 'vitamin-k'], replaced: ['d-and-k-video'] });
  });

  it('dedupes: a master the router picked keeps its own place, and is not added twice', () => {
    expect(preferMasters(['d-and-k-video', 'vitamin-d', 'plain-article'], index, none))
      .toEqual({ handles: ['vitamin-k', 'vitamin-d', 'plain-article'], replaced: ['d-and-k-video'] });
    expect(preferMasters(['vitamin-d-video', 'd-and-k-video'], index, none))
      .toEqual({ handles: ['vitamin-d', 'vitamin-k'], replaced: ['vitamin-d-video', 'd-and-k-video'] });
    expect(preferMasters(['vitamin-d', 'vitamin-d-video'], index, none))
      .toEqual({ handles: ['vitamin-d'], replaced: ['vitamin-d-video'] });
  });

  it('a named article stays, and its masters load beside it', () => {
    expect(preferMasters(['vitamin-d-video', 'plain-article'], index, new Set(['vitamin-d-video'])))
      .toEqual({ handles: ['vitamin-d-video', 'vitamin-d', 'plain-article'], replaced: [] });
  });

  it('an article newer than every master it names stays (US-50 AC5)', () => {
    const newer = post('newer-video', { topics: ['vitamin-d', 'vitamin-k'], publishedAt: '2026-10-21T08:00:00Z' });
    const sameDay = post('same-day-video', { topics: ['vitamin-d'], publishedAt: '2026-10-20T08:00:00Z' });
    expect(preferMasters(['newer-video', 'same-day-video'], [...index, newer, sameDay], none))
      .toEqual({ handles: ['newer-video', 'vitamin-d'], replaced: ['same-day-video'] });
  });

  it('pathways, guidelines, references, non-master topics and articles with no topics are untouched', () => {
    expect(preferMasters(['a-pathway', 'a-guideline', 'other-ref'], index, none))
      .toEqual({ handles: ['a-pathway', 'a-guideline', 'other-ref'], replaced: [] });
    expect(preferMasters(['nad-video', 'plain-article', 'not-in-index'], index, none))
      .toEqual({ handles: ['nad-video', 'plain-article', 'not-in-index'], replaced: [] });
  });
});

describe('namedArticles (US-50 AC14)', () => {
  const video = post('why-arent-cardiologists-prescribing-vitamin-k2', {
    commerceUrl: 'https://microvitamin.com/blogs/articles/vitamin-k2-artery-calcification-trials',
  });
  const one = post('lipoproteina');
  const index = [master('vitamin-k', '2026-10-20'), video, one];
  const named = (message: string, articleHandle?: unknown) => [...namedArticles(index, message, articleHandle)];

  it('the article the chat is open on, by its handle or its commerce slug', () => {
    expect(named('what dose?', 'why-arent-cardiologists-prescribing-vitamin-k2')).toEqual([video.handle]);
    expect(named('what dose?', 'vitamin-k2-artery-calcification-trials')).toEqual([video.handle]);
  });

  it('an articleHandle that matches no index entry, or is not a string, is ignored', () => {
    expect(named('what dose?', 'no-such-post')).toEqual([]);
    expect(named('what dose?', '')).toEqual([]);
    expect(named('what dose?', { handle: video.handle })).toEqual([]);
    expect(named('what dose?', '../why-arent-cardiologists-prescribing-vitamin-k2')).toEqual([]);
  });

  it('a URL or handle in the message names the post', () => {
    expect(named('About https://microvitamin.com/blogs/articles/vitamin-k2-artery-calcification-trials?ref=x: is it right?')).toEqual([video.handle]);
    expect(named('In WHY-ARENT-CARDIOLOGISTS-PRESCRIBING-VITAMIN-K2, you said...')).toEqual([video.handle]);
    expect(named('see drstanfield.com/blogs/articles/lipoproteina')).toEqual([one.handle]);
  });

  it('a topic word alone names nothing', () => {
    expect(named('Is vitamin k2 worth it? What about lipoproteina levels?')).toEqual([]);
    expect(named('the vitamin-k2-artery-calcification-trials-extra post')).toEqual([]);
  });
});
