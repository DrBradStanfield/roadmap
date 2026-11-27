/**
 * US-15 AC65, AC72, AC80: every chat doc is one load state. The required docs
 * (system prompt, algorithm, products, both postures) make it 'missing' when any
 * is absent, unreadable or blank: it names the files and carries no text. The
 * optional ones (writing style, answer bank, router, classifier and YouTube prompts, blog index) make it
 * 'degraded', naming them: chat answers without them. Nothing is read at import;
 * the first chatDocs() call reads once and reports once.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlogIndexEntry } from './blog-index.server';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  callAnthropicWithUsage: vi.fn(async () => ({ content: '{"handles":[]}', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } })),
}));
// Every readFileSync, default or named import, is recorded and passed through.
const reads = vi.hoisted(() => [] as string[]);
vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>();
  const readFileSync = ((file: string, ...rest: unknown[]) => {
    reads.push(String(file));
    return (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

const REQUIRED = [
  'app/lib/chat-system-prompt.md',
  'health_roadmap_algorithm.md',
  'docs/products.md',
  'app/lib/chat-posture-doctor.md',
  'app/lib/chat-posture-brand.md',
] as const;
const OPTIONAL = ['docs/writing-style.md', 'docs/chatbot/answer-bank.md', 'app/lib/chat-router-prompt.md', 'app/lib/chat-classifier-prompt.md', 'app/lib/chat-youtube-prompt.md'] as const;
const INDEX = 'docs/blog/index.json';

const ENTRIES: BlogIndexEntry[] = [
  { title: 'Collagen', handle: 'collagen', url: 'u', tags: [], publishedAt: '2024-01-01T00:00:00Z', type: 'reference', reviewed: '2026-10-20' },
  { title: 'Old collagen video', handle: 'collagen-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z', topics: ['collagen'], router: 'hidden' },
  { title: 'Sleep', handle: 'sleep', url: 'u', tags: [], publishedAt: '2024-01-01T00:00:00Z', type: 'guideline', summary: 'Sleep well.' },
];

/** Every file's text, named after the file; the router prompt carries the count placeholder. */
const textOf = (file: string) => (file.endsWith('chat-router-prompt.md') ? 'router: a {{ENTRY_COUNT}}-entry index' : `text of ${file}`);
const allTexts = (over: Record<string, string | null> = {}) =>
  ({ ...Object.fromEntries([...REQUIRED, ...OPTIONAL].map((f) => [f, textOf(f)])), ...over });
const read = (over: Record<string, string | null> = {}, blogIndex: BlogIndexEntry[] = ENTRIES) =>
  ({ type: 'read' as const, texts: allTexts(over), blogIndex });

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('US-15 AC80: transition table', () => {
  it('unread + read, all present: loaded, the docs assembled as the prompt builders read them', async () => {
    const { transition } = await import('./chat-system-prompt.server');
    const next = transition({ kind: 'unread' }, read());
    expect(next.kind).toBe('loaded');
    if (next.kind !== 'loaded') return;
    expect(next.docs.systemPrompt).toBe('text of app/lib/chat-system-prompt.mdtext of health_roadmap_algorithm.md');
    expect(next.docs.productsBlock).toContain('text of docs/products.md');
    expect(next.docs.productsBlock).toContain('## WRITING STYLE (applies to every answer)\n\ntext of docs/writing-style.md');
    expect(next.docs.productsBlock).toContain('## ANSWER BANK (approved answers to customer questions)\n\ntext of docs/chatbot/answer-bank.md');
    expect(next.docs.doctorPosture).toBe('text of app/lib/chat-posture-doctor.md');
    expect(next.docs.brandPosture).toBe('text of app/lib/chat-posture-brand.md');
    // The router's view drops the hidden post: two entries, in the count, the block and the allow-list.
    expect(next.docs.router.prompt).toBe('router: a 2-entry index');
    expect(next.docs.router.indexBlock.split('\n')).toHaveLength(2);
    expect([...next.docs.router.handles].sort()).toEqual(['collagen', 'sleep']);
    expect(next.docs.knowledgeOverview).toContain('a health knowledge base with 3 entries');
    expect(next.docs.knowledgeOverview).toContain('- Sleep — Sleep well.');
    expect(next.docs.evidence.startsWith('# Clinical Evidence Reference\n')).toBe(true);
    expect(next.docs.classifierPrompt).toBe('text of app/lib/chat-classifier-prompt.md'); // US-15 AC81
    expect(next.docs.youtubePrompt).toBe('text of app/lib/chat-youtube-prompt.md'); // US-15 AC82
  });

  const requiredCases = REQUIRED.flatMap((file) => ([['absent or unreadable', null], ['empty', ''], ['whitespace only', ' \n\t\n']] as const)
    .map(([how, text]) => [file, how, text] as const));
  it.each(requiredCases)('unread + read, %s %s: missing, naming that file only', async (file, _how, text) => {
    const { transition } = await import('./chat-system-prompt.server');
    expect(transition({ kind: 'unread' }, read({ [file]: text }))).toEqual({ kind: 'missing', files: [file] });
  });

  it('unread + read, two required missing and an optional one: missing names the two required only', async () => {
    const { transition } = await import('./chat-system-prompt.server');
    expect(transition({ kind: 'unread' }, read({ 'docs/products.md': null, 'app/lib/chat-posture-brand.md': '', 'docs/writing-style.md': null })))
      .toEqual({ kind: 'missing', files: ['docs/products.md', 'app/lib/chat-posture-brand.md'] });
  });

  it.each([
    ['writing style absent', { 'docs/writing-style.md': null }, ENTRIES, ['docs/writing-style.md']],
    ['answer bank blank', { 'docs/chatbot/answer-bank.md': '  \n' }, ENTRIES, ['docs/chatbot/answer-bank.md']],
    ['router prompt absent', { 'app/lib/chat-router-prompt.md': null }, ENTRIES, ['app/lib/chat-router-prompt.md']],
    ['classifier prompt blank (US-15 AC81)', { 'app/lib/chat-classifier-prompt.md': ' \n' }, ENTRIES, ['app/lib/chat-classifier-prompt.md']],
    ['YouTube prompt blank (US-15 AC82)', { 'app/lib/chat-youtube-prompt.md': '\n' }, ENTRIES, ['app/lib/chat-youtube-prompt.md']],
    ['blog index empty', {}, [], [INDEX]],
    ['writing style and blog index', { 'docs/writing-style.md': '' }, [], ['docs/writing-style.md', INDEX]],
  ])('unread + read, %s: degraded, naming what chat answers without', async (_case, over, index, absent) => {
    const { transition } = await import('./chat-system-prompt.server');
    const next = transition({ kind: 'unread' }, read(over, index));
    expect(next).toMatchObject({ kind: 'degraded', absent });
  });

  it('degraded: the products block, overview and router carry what they had before, without the absent doc', async () => {
    const { transition } = await import('./chat-system-prompt.server');
    const noStyle = transition({ kind: 'unread' }, read({ 'docs/writing-style.md': null }));
    expect(noStyle.kind === 'degraded' && noStyle.docs.productsBlock).not.toContain('WRITING STYLE');
    const noIndex = transition({ kind: 'unread' }, read({}, []));
    expect(noIndex.kind === 'degraded' && noIndex.docs).toMatchObject({ knowledgeOverview: '', router: { prompt: 'router: a 0-entry index', indexBlock: '' } });
    const noRouter = transition({ kind: 'unread' }, read({ 'app/lib/chat-router-prompt.md': null }));
    expect(noRouter.kind === 'degraded' && noRouter.docs.router.prompt).toBe('');
    const noClassifier = transition({ kind: 'unread' }, read({ 'app/lib/chat-classifier-prompt.md': null }));
    expect(noClassifier.kind === 'degraded' && noClassifier.docs.classifierPrompt).toBe('');
    const noYouTube = transition({ kind: 'unread' }, read({ 'app/lib/chat-youtube-prompt.md': null }));
    expect(noYouTube.kind === 'degraded' && noYouTube.docs.youtubePrompt).toBe('');
  });

  it.each(['loaded', 'degraded', 'missing'] as const)('%s + read: unchanged, the docs are read once per process', async (kind) => {
    const { transition } = await import('./chat-system-prompt.server');
    const first = {
      loaded: read(),
      degraded: read({ 'docs/writing-style.md': null }),
      missing: read({ 'docs/products.md': null }),
    }[kind];
    const state = transition({ kind: 'unread' }, first);
    expect(state.kind).toBe(kind);
    expect(transition(state, read({ 'app/lib/chat-system-prompt.md': null }))).toBe(state);
    expect(transition(state, read())).toBe(state);
  });
});

/** A checkout in a temp folder: every file written unless named in `skip`, the index as JSON. */
function tempRoot(skip: string[] = [], over: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-docs-'));
  for (const file of [...REQUIRED, ...OPTIONAL, INDEX]) {
    if (skip.includes(file)) continue;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), over[file] ?? (file === INDEX ? JSON.stringify(ENTRIES) : textOf(file)));
  }
  return root;
}

describe('US-15 AC80: createChatDocs(root)', () => {
  async function sentry() {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Sentry = await import('@sentry/react-router');
    vi.mocked(Sentry.captureMessage).mockClear();
    return vi.mocked(Sentry.captureMessage);
  }

  it('reads nothing when made: files written after it still load at the first call', async () => {
    const { createChatDocs } = await import('./chat-system-prompt.server');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-docs-'));
    const docs = createChatDocs(root);
    fs.rmSync(root, { recursive: true });
    fs.cpSync(tempRoot(), root, { recursive: true });
    expect(docs().kind).toBe('loaded');
  });

  it('reads once: a file removed after the first call changes nothing', async () => {
    const { createChatDocs } = await import('./chat-system-prompt.server');
    const root = tempRoot();
    const docs = createChatDocs(root);
    const first = docs();
    fs.rmSync(path.join(root, 'docs/products.md'));
    expect(docs()).toBe(first);
  });

  it('two roots, two states: one checkout missing a doc leaves the other loaded', async () => {
    const captureMessage = await sentry();
    const { createChatDocs } = await import('./chat-system-prompt.server');
    expect(createChatDocs(tempRoot(['health_roadmap_algorithm.md']))()).toEqual({ kind: 'missing', files: ['health_roadmap_algorithm.md'] });
    expect(createChatDocs(tempRoot())().kind).toBe('loaded');
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('an unreadable required file (a folder in its place) is missing', async () => {
    await sentry();
    const { createChatDocs } = await import('./chat-system-prompt.server');
    const root = tempRoot(['app/lib/chat-posture-doctor.md']);
    fs.mkdirSync(path.join(root, 'app/lib/chat-posture-doctor.md'));
    expect(createChatDocs(root)()).toEqual({ kind: 'missing', files: ['app/lib/chat-posture-doctor.md'] });
  });

  it.each([
    ['prompt absent', ['app/lib/chat-system-prompt.md'], {}, ['app/lib/chat-system-prompt.md']],
    ['products and doctor posture blank', [], { 'docs/products.md': '', 'app/lib/chat-posture-doctor.md': ' ' }, ['docs/products.md', 'app/lib/chat-posture-doctor.md']],
  ])('%s: missing, one Sentry error naming the files, however often it is read', async (_case, skip, over, files) => {
    const captureMessage = await sentry();
    const { createChatDocs } = await import('./chat-system-prompt.server');
    const docs = createChatDocs(tempRoot(skip, over));
    expect(docs()).toEqual({ kind: 'missing', files });
    docs();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(`Chat docs missing: ${files.join(', ')}`, { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toMatch(/ENOENT|text of/);
  });

  it.each([
    ['writing style absent', ['docs/writing-style.md'], {}, ['docs/writing-style.md']],
    ['answer bank blank (was silent)', [], { 'docs/chatbot/answer-bank.md': '\n' }, ['docs/chatbot/answer-bank.md']],
    ['router prompt absent (was a console line)', ['app/lib/chat-router-prompt.md'], {}, ['app/lib/chat-router-prompt.md']],
    ['classifier prompt absent (was its own Sentry message, US-15 AC81)', ['app/lib/chat-classifier-prompt.md'], {}, ['app/lib/chat-classifier-prompt.md']],
    ['YouTube prompt absent (was a console line, US-15 AC82)', ['app/lib/chat-youtube-prompt.md'], {}, ['app/lib/chat-youtube-prompt.md']],
    ['blog index absent (was a console line)', [INDEX], {}, [INDEX]],
  ])('%s: degraded, one Sentry error per absent file, however often it is read', async (_case, skip, over, absent) => {
    const captureMessage = await sentry();
    const { createChatDocs } = await import('./chat-system-prompt.server');
    const docs = createChatDocs(tempRoot(skip, over));
    expect(docs()).toMatchObject({ kind: 'degraded', absent });
    docs();
    expect(captureMessage.mock.calls).toEqual(absent.map((file) => [`Chat knowledge file missing: ${file}`, { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } }]));
  });

  it('all present: loaded, no Sentry message', async () => {
    const captureMessage = await sentry();
    const { createChatDocs } = await import('./chat-system-prompt.server');
    expect(createChatDocs(tempRoot())().kind).toBe('loaded');
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('US-15 AC80: no chat doc is read at import', () => {
  it('importing the docs, chat and router modules reads no doc; the first chatDocs() call reads them', async () => {
    reads.length = 0;
    const docsRead = () => reads.filter((f) => [...REQUIRED, ...OPTIONAL, INDEX].some((d) => f.endsWith(d)));
    const { chatDocs } = await import('./chat-system-prompt.server');
    await import('./chat.server');
    await import('./chat-router.server');
    await import('./chat-classifier.server');
    await import('./youtube-context'); // US-15 AC82
    expect(docsRead()).toEqual([]);
    expect(chatDocs().kind).toBe('loaded');
    expect(docsRead().length).toBeGreaterThanOrEqual(REQUIRED.length + OPTIONAL.length);
  });
});

describe('US-15 AC80: this checkout, as the router and the answer see it', () => {
  const doc = (file: string) => (fs.readFileSync(path.join(process.cwd(), file), 'utf-8') as string);

  it('the router call carries the prompt file with the view count, then the view index block', async () => {
    const { routeQuery, routerHandles } = await import('./chat-router.server');
    const { loadBlogIndex } = await import('./blog-index.server');
    const { routerIndexBlock, routerView } = await import('./router-view');
    const { callAnthropicWithUsage } = await import('./anthropic.server');
    vi.mocked(callAnthropicWithUsage).mockClear();
    const view = routerView(loadBlogIndex());
    expect(view.length).toBeGreaterThan(100);
    await routeQuery('does collagen help skin', undefined, undefined, 'CHAT');
    const body = vi.mocked(callAnthropicWithUsage).mock.calls[0][0] as { system: Array<{ text: string }> };
    expect(body.system.map((b) => b.text)).toEqual([
      doc('app/lib/chat-router-prompt.md').replace(/\{\{ENTRY_COUNT\}\}/g, String(view.length)),
      routerIndexBlock(view),
    ]);
    expect([...routerHandles()]).toEqual(view.map((e) => e.handle));
  });

  it('the answer gets the prompt and algorithm whole, then the writing style and answer bank in the products block', async () => {
    const { buildSystemBlocks } = await import('./chat.server');
    const texts = buildSystemBlocks('{}', { savedChat: '' }).map((b) => b.text);
    expect(texts[0]).toBe(doc('app/lib/chat-system-prompt.md') + doc('health_roadmap_algorithm.md'));
    expect(texts[2]).toContain(`## WRITING STYLE (applies to every answer)\n\n${doc('docs/writing-style.md')}`);
    expect(texts[2]).toContain(`## ANSWER BANK (approved answers to customer questions)\n\n${doc('docs/chatbot/answer-bank.md')}`);
    expect(texts[3]).toContain('## Knowledge Base');
  });
});
