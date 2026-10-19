/**
 * US-50 AC6: a YouTube comment loads its video's post, plus only the
 * "Current view" or "Current evidence position" section of each master the post
 * names, de-duplicated against the router's picks and capped. These sections
 * sit in their own labelled block and never in "Referenced Blog Articles", so
 * the reply-or-skip rule's input is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const fakes = vi.hoisted(() => {
  const ref = (handle: string, reviewed?: string) => ({
    title: `Master ${handle}`, handle, url: `https://drstanfield.com/blogs/articles/${handle}`, tags: [],
    publishedAt: '2024-01-01T00:00:00Z', type: 'reference' as const, ...(reviewed ? { reviewed } : {}),
  });
  return [
    ref('tm-collagen', '2026-10-20'),
    ref('tm-nad'),
    ref('tm-empty'),
    ref('tm-big', '2026-10-20'),
    { title: 'An article', handle: 'tm-article', url: 'u', tags: [], publishedAt: '2025-01-01T00:00:00Z' },
  ];
});

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));
vi.mock('./blog-index.server', async (orig) => {
  const real = await orig<typeof import('./blog-index.server')>();
  return { ...real, loadBlogIndex: () => [...real.loadBlogIndex(), ...fakes] };
});
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: vi.fn(async () => ({ classification: 'ROUTE' })),
}));
vi.mock('./chat-router.server', async (orig) => ({
  ...(await orig<typeof import('./chat-router.server')>()),
  routeQuery: vi.fn(async () => ({ handles: [], rawJson: '{"handles":[]}', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null })),
}));
vi.mock('./chat.server', async (orig) => ({
  ...(await orig<typeof import('./chat.server')>()),
  getChatCompletion: vi.fn(async () => ({ content: 'SKIP_NO_REPLY', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, isFallback: false })),
}));

import { currentViewSection, masterViews, runPipeline, MASTER_VIEWS_HEADING, MAX_MASTER_VIEW_CHARS } from './youtube-bot.server';
import { getChatCompletion } from './chat.server';
import { routeQuery } from './chat-router.server';

const VIEW = '## Current view (reviewed 20 October 2026)\n\nCollagen peptides may improve skin hydration [the-collagen-peptides-for-skin-story-is-changing].';
const files: Record<string, string> = {
  'tm-collagen': `---\ntitle: "Collagen"\nreviewed: "2026-10-20"\n---\n\n# Collagen\n\nIntro.\n\n${VIEW}\n\n## Brad's videos on this topic\n\n- 2025: old video.\n\n## Evidence review\n\nLong review.\n`,
  'tm-nad': `---\ntitle: "NAD"\n---\n\n# NAD\n\n## Current evidence position\n\nAn evidence summary, not Brad's view.\n\n## Evidence review\n\nMore.\n`,
  'tm-empty': `---\ntitle: "Empty"\n---\n\n# Empty\n\n## Evidence review\n\nOnly a review.\n`,
  'tm-big': `---\ntitle: "Big"\n---\n\n## Current view (reviewed 20 October 2026)\n\n${'x'.repeat(MAX_MASTER_VIEW_CHARS)}\n`,
  'tm-article': `---\ntitle: "An article"\n---\n\n## Current view (reviewed 20 October 2026)\n\nNot a master.\n`,
};
const realRead = fs.readFileSync;
function fakeFiles() {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const handle = path.basename(String(p), '.md');
    if (handle in files) return files[handle];
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
}
afterEach(() => { vi.restoreAllMocks(); });

describe('currentViewSection (US-50 AC6)', () => {
  it('takes the Current view section, heading to the next ## heading', () => {
    expect(currentViewSection(files['tm-collagen'])).toBe(VIEW.replace(/^## /, '### '));
  });

  it('takes a Current evidence position section the same way', () => {
    expect(currentViewSection(files['tm-nad'])).toBe("### Current evidence position\n\nAn evidence summary, not Brad's view.");
  });

  it('a master with neither section gives nothing', () => {
    expect(currentViewSection(files['tm-empty'])).toBeNull();
  });
});

describe('masterViews (US-50 AC6)', () => {
  it('adds each named master\'s section under its own label and header, in topics order', () => {
    fakeFiles();
    const block = masterViews(['tm-collagen', 'tm-nad', 'tm-empty'], [])!;
    expect(block.startsWith(`${MASTER_VIEWS_HEADING}\n\n[reference — current view reviewed 2026-10-20]\ntitle: Collagen\n\n### Current view`)).toBe(true);
    expect(block).toContain('[reference — published 2024-01-01]\ntitle: NAD\n\n### Current evidence position');
    expect(block.indexOf('Collagen peptides')).toBeLessThan(block.indexOf('An evidence summary'));
    expect(block).not.toContain('Evidence review');
    expect(block).not.toContain("Brad's videos");
  });

  it('skips a master the router already loaded, a repeat, a missing handle and a non-reference', () => {
    fakeFiles();
    const block = masterViews(['tm-collagen', 'tm-nad', 'tm-nad', 'no-such-master', 'tm-article'], ['tm-collagen'])!;
    expect(block).not.toContain('Collagen peptides');
    expect(block.match(/An evidence summary/g)).toHaveLength(1);
    expect(block).not.toContain('Not a master');
  });

  it('a section that would pass the cap is skipped, never the rest', () => {
    fakeFiles();
    const block = masterViews(['tm-big', 'tm-collagen'], [])!;
    expect(block).not.toContain('xxxx');
    expect(block).toContain('Collagen peptides');
    expect(block.length).toBeLessThanOrEqual(MAX_MASTER_VIEW_CHARS + MASTER_VIEWS_HEADING.length + 2);
  });

  it('no topics, or nothing to add, gives null', () => {
    fakeFiles();
    expect(masterViews(undefined, [])).toBeNull();
    expect(masterViews(['tm-empty'], [])).toBeNull();
  });
});

describe('runPipeline: the reply-or-skip input (US-50 AC6)', () => {
  const thread = { topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: 'Is collagen still worth taking for skin?', publishedAt: '2026-10-20T00:00:00Z' };
  const entry = { title: 'Old collagen video', handle: 'old-collagen', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z', topics: ['tm-collagen'] };

  function systemOf(): string[] {
    const blocks = vi.mocked(getChatCompletion).mock.calls.at(-1)![0] as Array<{ text: string }>;
    return blocks.map(b => b.text);
  }

  it('with no router match, the master view is loaded but no Referenced Blog Articles block exists', async () => {
    fakeFiles();
    await runPipeline(thread, entry, 'The video body.');
    const texts = systemOf();
    expect(texts.some(t => t.startsWith('## Referenced Blog Articles'))).toBe(false);
    const platform = texts.find(t => t.includes('The video body.'))!;
    // The prompt names the heading in its rules; the block itself is the heading then a header.
    expect(platform.indexOf(`${MASTER_VIEWS_HEADING}\n\n[reference`)).toBeGreaterThan(platform.indexOf('The video body.'));
    expect(platform).toContain('Collagen peptides may improve skin hydration');
  });

  it('a master the router picked loads once, as router-matched content', async () => {
    fakeFiles();
    vi.mocked(routeQuery).mockResolvedValueOnce({ handles: ['tm-collagen'], rawJson: null, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null });
    await runPipeline(thread, entry, 'The video body.');
    const texts = systemOf();
    expect(texts.find(t => t.startsWith('## Referenced Blog Articles'))).toContain('Collagen peptides');
    expect(texts.join('\n')).not.toContain(`${MASTER_VIEWS_HEADING}\n\n[reference`);
  });
});
