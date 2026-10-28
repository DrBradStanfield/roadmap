/**
 * US-50 AC3: the router's view of the index. A `router: hidden` post leaves the
 * view only when every master in its `topics` exists and was reviewed on or
 * after the post's publish date. Everything else stays.
 * `TOPIC_MASTER_HIDE=off` restores the full view.
 */
import { describe, it, expect } from 'vitest';
import { routerView, routerIndexBlock, preferMasters, namedArticles, openArticle } from './router-view';
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

  it('hides only article entries: a reference or guideline marked hidden stays (M1)', () => {
    const asRef = master('other-ref', '2026-10-20');
    const hiddenRef: BlogIndexEntry = { ...asRef, topics: ['collagen'], router: 'hidden' };
    const hiddenGuideline = post('a-guideline', { type: 'guideline', topics: ['collagen'], router: 'hidden' });
    expect(handles(routerView([collagen, hiddenRef, hiddenGuideline], true))).toEqual(['collagen', 'other-ref', 'a-guideline']);
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
 * US-50 AC14: after routing, an article pick its masters all cover is
 * replaced by a master in its slot, unless the post is named (open in the
 * chat, its URL or handle in the message, or the YouTube video's own post).
 * Slots go in passes: the router's kept picks, one master per replaced pick,
 * the open or named post, then the remaining masters.
 */
describe('preferMasters (US-50 AC14)', () => {
  const d = master('vitamin-d', '2026-10-20');
  const k = master('vitamin-k', '2026-10-20');
  const stale = master('nad-nmn'); // a reference with no reviewed date: not a master
  const dVideo = post('vitamin-d-video', { topics: ['vitamin-d'] });
  const dkVideo = post('d-and-k-video', { topics: ['vitamin-d', 'vitamin-k'] });
  const guideline = post('a-guideline', { type: 'guideline', topics: ['vitamin-d'] });
  const ref = { ...master('other-ref'), topics: ['vitamin-d'] };
  const nadVideo = post('nad-video', { topics: ['nad-nmn'] });
  const plain = post('plain-article');
  const index = [d, k, stale, dVideo, dkVideo, guideline, ref, nadVideo, plain];
  const pm = (picks: string[], opts: { message?: string; open?: string; keep?: string[] } = {}, idx = index) =>
    preferMasters(picks, idx, opts.message ?? '', opts);

  it('replaces an article pick with its master in the same slot', () => {
    expect(pm(['vitamin-d-video', 'plain-article']))
      .toEqual({ handles: ['vitamin-d', 'plain-article'], replaced: ['vitamin-d-video'] });
  });

  it('a multi-master article becomes all its masters, in its slot', () => {
    expect(pm(['d-and-k-video', 'plain-article']))
      .toEqual({ handles: ['vitamin-d', 'vitamin-k', 'plain-article'], replaced: ['d-and-k-video'] });
  });

  it('keeps the result to 3 handles: added masters take only the free slots, in slot order', () => {
    expect(pm(['a-guideline', 'd-and-k-video', 'plain-article']))
      .toEqual({ handles: ['a-guideline', 'vitamin-d', 'plain-article'], replaced: ['d-and-k-video'] });
  });

  it('never drops a master the router picked to make room for an added one', () => {
    const e = master('vitamin-e', '2026-10-20');
    const tri = post('tri-video', { topics: ['vitamin-d', 'vitamin-k', 'vitamin-e'] });
    expect(pm(['tri-video', 'plain-article', 'vitamin-d'], {}, [...index, e, tri]))
      .toEqual({ handles: ['vitamin-k', 'plain-article', 'vitamin-d'], replaced: ['tri-video'] });
  });

  it('dedupes: a master the router picked keeps its own place, and is not added twice', () => {
    expect(pm(['d-and-k-video', 'vitamin-d', 'plain-article']))
      .toEqual({ handles: ['vitamin-k', 'vitamin-d', 'plain-article'], replaced: ['d-and-k-video'] });
    expect(pm(['vitamin-d-video', 'd-and-k-video']))
      .toEqual({ handles: ['vitamin-d', 'vitamin-k'], replaced: ['vitamin-d-video', 'd-and-k-video'] });
    expect(pm(['vitamin-d', 'vitamin-d-video']))
      .toEqual({ handles: ['vitamin-d'], replaced: ['vitamin-d-video'] });
  });

  it('a named article stays, and its masters load beside it', () => {
    expect(pm(['vitamin-d-video', 'plain-article'], { keep: ['vitamin-d-video'] }))
      .toEqual({ handles: ['vitamin-d-video', 'vitamin-d', 'plain-article'], replaced: [] });
  });

  it('an article stays unless every master it names covers it, as routerView (US-50 AC3, AC5)', () => {
    const later = master('vitamin-a', '2026-10-25');
    const newer = post('newer-video', { topics: ['vitamin-d', 'vitamin-k'], publishedAt: '2026-10-21T08:00:00Z' });
    const mixed = post('mixed-video', { topics: ['vitamin-a', 'vitamin-d'], publishedAt: '2026-10-21T08:00:00Z' });
    const sameDay = post('same-day-video', { topics: ['vitamin-d'], publishedAt: '2026-10-20T08:00:00Z' });
    const undated = post('undated-video', { topics: ['vitamin-d'], publishedAt: undefined as unknown as string });
    const all = [...index, later, newer, mixed, sameDay, undated];
    expect(pm(['newer-video', 'mixed-video', 'undated-video'], {}, all))
      .toEqual({ handles: ['newer-video', 'mixed-video', 'undated-video'], replaced: [] });
    expect(pm(['same-day-video'], {}, all))
      .toEqual({ handles: ['vitamin-d'], replaced: ['same-day-video'] });
  });

  // As routerView: a post with any topic not yet a reviewed master stays whole
  // (the live multivitamins-are-no-longer-expensive-urine shape: 5 topics, 3 masters).
  it('a post with any topic not yet a master stays, as routerView (US-50 AC3)', () => {
    const three = ['multi-m', 'bvit-m', 'omega-m'].map(h => master(h, '2026-10-20'));
    const notYet = [master('vit-a-ref'), master('lutein-ref')];
    const mv = post('multivitamins-old-post', { topics: ['multi-m', 'vit-a-ref', 'lutein-ref', 'bvit-m', 'omega-m'] });
    expect(pm(['multivitamins-old-post'], {}, [...index, ...three, ...notYet, mv]))
      .toEqual({ handles: ['multivitamins-old-post'], replaced: [] });
  });

  // Round 2, Codex R1 / N4: a named post that stays loads its masters, covered or not.
  it('a picked post the message names loads with its masters, even when not covered (round 2, N4)', () => {
    const three = ['multi-m', 'bvit-m', 'omega-m'].map(h => master(h, '2026-10-20'));
    const notYet = [master('vit-a-ref'), master('lutein-ref')];
    const mv = post('multivitamins-are-no-longer-expensive-urine', { topics: ['multi-m', 'vit-a-ref', 'lutein-ref', 'bvit-m', 'omega-m'] });
    expect(pm(['multivitamins-are-no-longer-expensive-urine'], { message: 'about /blogs/articles/multivitamins-are-no-longer-expensive-urine' }, [...index, ...three, ...notYet, mv]))
      .toEqual({ handles: ['multivitamins-are-no-longer-expensive-urine', 'multi-m', 'bvit-m'], replaced: [] });
  });

  it('forced named posts go in the order the message names them (round 2, N4)', () => {
    const x = post('x-post-with-long-handle');
    const y = post('y-post-with-long-handle');
    expect(pm(['plain-article'], { message: 'see /blogs/a/y-post-with-long-handle and /blogs/a/x-post-with-long-handle' }, [...index, x, y]).handles)
      .toEqual(['plain-article', 'y-post-with-long-handle', 'x-post-with-long-handle']);
  });

  // Review R1: the open post's masters once took every free slot, so a second
  // replaced post vanished with nothing in its place yet was logged as replaced.
  it('a replaced pick always gets a master slot before the open post\'s other masters (review R1)', () => {
    const many = ['m-one', 'm-two', 'm-three', 'm-four', 'm-five'].map(h => master(h, '2026-10-20'));
    const open = post('open-multi-post', { topics: many.map(m => m.handle) });
    const other = post('other-trial-post', { topics: ['vitamin-k'] });
    expect(pm(['open-multi-post', 'other-trial-post'], { open: 'open-multi-post' }, [...index, ...many, open, other]))
      .toEqual({ handles: ['open-multi-post', 'm-one', 'vitamin-k'], replaced: ['other-trial-post'] });
  });

  // Review R2: the master the question is about goes first.
  it('ranks a post\'s masters by the topic the message names, then by its topics order (review R2)', () => {
    const multi = { ...master('multivitamins-benefits', '2026-10-20'), title: 'Multivitamins: Benefits, Evidence, Dosing, and Side Effects' };
    const a = { ...master('vitamin-a-benefits', '2026-10-20'), title: 'Vitamin A: Benefits, Forms, Dosing, and Side Effects' };
    const mv = post('multivitamins-old-post', { topics: ['multivitamins-benefits', 'vitamin-a-benefits'] });
    const idx = [...index, multi, a, mv];
    expect(pm(['multivitamins-old-post', 'plain-article', 'a-guideline'], { message: 'is the vitamin A in a multivitamin safe in pregnancy?' }, idx).handles)
      .toEqual(['vitamin-a-benefits', 'plain-article', 'a-guideline']);
    expect(pm(['multivitamins-old-post', 'plain-article', 'a-guideline'], { message: 'are multivitamins worth it?' }, idx).handles)
      .toEqual(['multivitamins-benefits', 'plain-article', 'a-guideline']);
  });

  // Review R3: a post the message names by URL or handle loads even when the router did not pick it.
  it('a post the message names loads with its first master, even unpicked or router-hidden (review R3)', () => {
    const hidden = post('old-vitamin-d-trial-video', { topics: ['vitamin-d', 'vitamin-k'], router: 'hidden' });
    const idx = [...index, hidden];
    expect(pm(['plain-article'], { message: 'In old-vitamin-d-trial-video you said what?' }, idx))
      .toEqual({ handles: ['plain-article', 'vitamin-d', 'old-vitamin-d-trial-video'], replaced: [] });
    expect(pm(['vitamin-k', 'plain-article'], { message: 'see /blogs/articles/old-vitamin-d-trial-video' }, idx))
      .toEqual({ handles: ['vitamin-k', 'old-vitamin-d-trial-video', 'plain-article'], replaced: [] });
    // The YouTube video's own post is already in the bot's context: it stays when picked, but is never forced in.
    expect(pm(['plain-article'], { message: 'old-vitamin-d-trial-video was great', keep: ['old-vitamin-d-trial-video'] }, idx).handles)
      .toEqual(['plain-article']);
  });

  describe('the post the chat is open on', () => {
    it('loads right after its first master when the router picked that master', () => {
      expect(pm(['vitamin-d', 'plain-article'], { open: 'vitamin-d-video' }))
        .toEqual({ handles: ['vitamin-d', 'vitamin-d-video', 'plain-article'], replaced: [] });
    });

    it('loads with its masters when the router picked nothing (round 2, N4)', () => {
      expect(pm([], { open: 'd-and-k-video' }))
        .toEqual({ handles: ['vitamin-d', 'd-and-k-video', 'vitamin-k'], replaced: [] });
      expect(pm([], { open: 'plain-article' }))
        .toEqual({ handles: ['plain-article'], replaced: [] });
    });

    it('loads when its master came in by replacing another routed post', () => {
      expect(pm(['d-and-k-video'], { open: 'vitamin-d-video' }))
        .toEqual({ handles: ['vitamin-d', 'vitamin-d-video', 'vitamin-k'], replaced: ['d-and-k-video'] });
    });

    it('sits after the first of its own masters in the list, by its masters order (review R4)', () => {
      expect(pm(['vitamin-k', 'vitamin-d'], { open: 'd-and-k-video' }))
        .toEqual({ handles: ['vitamin-k', 'vitamin-d', 'd-and-k-video'], replaced: [] });
    });

    it('anchors only on the final list, never on a duplicate it drops (Codex C1)', () => {
      expect(pm(['d-and-k-video', 'vitamin-d', 'plain-article'], { open: 'vitamin-d-video' }))
        .toEqual({ handles: ['vitamin-k', 'vitamin-d', 'plain-article'], replaced: ['d-and-k-video'] });
    });

    it('is not forced in when the question routed elsewhere', () => {
      expect(pm(['plain-article'], { open: 'vitamin-d-video' }))
        .toEqual({ handles: ['plain-article'], replaced: [] });
    });

    it('takes only a free slot', () => {
      expect(pm(['vitamin-d', 'plain-article', 'a-guideline'], { open: 'vitamin-d-video' }))
        .toEqual({ handles: ['vitamin-d', 'plain-article', 'a-guideline'], replaced: [] });
    });

    it('stays in its own slot when the router picked it', () => {
      expect(pm(['vitamin-d-video', 'plain-article'], { open: 'vitamin-d-video' }))
        .toEqual({ handles: ['vitamin-d-video', 'vitamin-d', 'plain-article'], replaced: [] });
    });
  });

  it('guidelines, references, non-master topics and articles with no topics are untouched', () => {
    expect(pm(['a-guideline', 'other-ref']))
      .toEqual({ handles: ['a-guideline', 'other-ref'], replaced: [] });
    expect(pm(['nad-video', 'plain-article', 'not-in-index']))
      .toEqual({ handles: ['nad-video', 'plain-article', 'not-in-index'], replaced: [] });
  });
});

describe('namedArticles (US-50 AC14)', () => {
  const video = post('why-arent-cardiologists-prescribing-vitamin-k2', {
    commerceUrl: 'https://microvitamin.com/blogs/articles/vitamin-k2-artery-calcification-trials',
  });
  const one = post('lipoproteina');
  const short = post('calcium-rich-foods');
  const index = [master('vitamin-k', '2026-10-20'), video, one, short];
  const named = (message: string) => [...namedArticles(index, message)];

  it('the article the chat is open on, by its handle or its commerce slug', () => {
    expect(openArticle(index, 'why-arent-cardiologists-prescribing-vitamin-k2')).toBe(video.handle);
    expect(openArticle(index, 'vitamin-k2-artery-calcification-trials')).toBe(video.handle);
  });

  it('an articleHandle that matches no article in the index, or is not a string, is ignored', () => {
    for (const value of ['no-such-post', '', { handle: video.handle }, '../why-arent-cardiologists-prescribing-vitamin-k2', 'vitamin-k', undefined]) {
      expect(openArticle(index, value)).toBeUndefined();
    }
  });

  it('a URL or handle in the message names the post', () => {
    expect(named('About https://microvitamin.com/blogs/articles/vitamin-k2-artery-calcification-trials?ref=x: is it right?')).toEqual([video.handle]);
    expect(named('In WHY-ARENT-CARDIOLOGISTS-PRESCRIBING-VITAMIN-K2, you said...')).toEqual([video.handle]);
    expect(named('see drstanfield.com/blogs/articles/lipoproteina')).toEqual([one.handle]);
    expect(named('see /blogs/news/calcium-rich-foods')).toEqual([short.handle]);
  });

  it('a topic word alone names nothing, nor a bare hyphenated word under 4 words (review R5)', () => {
    expect(named('Is vitamin k2 worth it? What about lipoproteina levels?')).toEqual([]);
    expect(named('the vitamin-k2-artery-calcification-trials-extra post')).toEqual([]);
    expect(named('I eat calcium-rich-foods daily')).toEqual([]);
  });

  it('reads the whole message, past the router\'s 2,000 characters (Codex C2)', () => {
    expect(named(`${'x '.repeat(1_500)}see why-arent-cardiologists-prescribing-vitamin-k2`)).toEqual([video.handle]);
  });

  it('lists posts in the order the message names them (round 2, N4)', () => {
    expect(named('see /blogs/a/lipoproteina then why-arent-cardiologists-prescribing-vitamin-k2')).toEqual([one.handle, video.handle]);
    expect(named('see why-arent-cardiologists-prescribing-vitamin-k2 then /blogs/a/lipoproteina')).toEqual([video.handle, one.handle]);
  });

  // Round 2, N1: the bare-word pattern was quadratic on a long alphanumeric run (about 520 ms on 8,000 characters).
  it('stays fast on a long alphanumeric run (round 2, N1)', () => {
    for (const n of [8_000, 10_000]) {
      const text = 'a'.repeat(n);
      const runs = [0, 1, 2].map(() => { const t0 = performance.now(); namedArticles(index, text); return performance.now() - t0; });
      expect(Math.min(...runs)).toBeLessThan(50);
    }
  });
});

// Round 2, N2: a master is named by any part of its title before the colon,
// with generic trailing words dropped, and by a first word with a digit, a
// hyphen or capitals (omega-3, NAD, NMN).
describe('preferMasters ranks masters by the names the message uses (round 2, N2)', () => {
  const titled = (handle: string, title: string) => ({ ...master(handle, '2026-10-20'), title });
  const omega = titled('omega-m', 'Omega-3 Fish Oil: Benefits, Best Forms, Dosing, and Side Effects');
  const bvit = titled('bvit-m', 'B Vitamins: Benefits, Best Forms, Dosing, and Side Effects');
  const nad = titled('nad-m', 'NAD Boosters (NMN, NR, NADH): Benefits, Forms, Dosing, and Side Effects');
  const mag = titled('mag-m', 'Magnesium: Benefits, Best Forms, Dosing, and Side Effects');
  const brain = post('brain-supplements-old-post', { topics: ['bvit-m', 'omega-m'] });
  const energy = post('energy-supplements-old-post', { topics: ['bvit-m', 'nad-m'] });
  const three = post('three-masters-old-post', { topics: ['bvit-m', 'omega-m', 'mag-m'] });
  const filler = [post('plain-one'), post('plain-two')];
  const index = [omega, bvit, nad, mag, brain, energy, three, ...filler];
  const first = (pick: string, message: string) => preferMasters([pick, 'plain-one', 'plain-two'], index, message).handles[0];

  it('omega-3 and fish oil both name the Omega-3 Fish Oil master', () => {
    expect(first('brain-supplements-old-post', 'Is omega-3 better than B vitamins for the brain?')).toBe('omega-m');
    expect(first('brain-supplements-old-post', 'fish oil or B vitamins for focus?')).toBe('omega-m');
    expect(first('brain-supplements-old-post', 'are B vitamins worth it?')).toBe('bvit-m');
  });

  it('NMN names the NAD Boosters master', () => {
    expect(first('energy-supplements-old-post', 'does NMN help energy?')).toBe('nad-m');
  });

  it('masters the message names come first; the rest keep topics order', () => {
    expect(preferMasters(['three-masters-old-post'], index, 'what about magnesium? see /blogs/a/three-masters-old-post').handles)
      .toEqual(['three-masters-old-post', 'mag-m', 'bvit-m']);
  });
});
