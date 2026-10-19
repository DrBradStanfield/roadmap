/**
 * US-50 AC3: the router's view of the index. A `router: hidden` post leaves the
 * view only when every master in its `topics` exists and was reviewed on or
 * after the post's publish date. Everything else stays.
 * `TOPIC_MASTER_HIDE=off` restores the full view.
 */
import { describe, it, expect } from 'vitest';
import { routerView, routerIndexBlock } from './router-view';
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
