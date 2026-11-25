/**
 * US-15 AC65, AC72: the chat docs (system prompt, algorithm, products, both
 * postures) are one state, read once at import. Any one absent, unreadable or
 * blank is 'missing', which names the files, carries no text and sends exactly
 * one Sentry message for the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const FILES = [
  'app/lib/chat-system-prompt.md',
  'health_roadmap_algorithm.md',
  'docs/products.md',
  'app/lib/chat-posture-doctor.md',
  'app/lib/chat-posture-brand.md',
] as const;

const fsState = vi.hoisted(() => ({ reads: {} as Record<string, () => string> }));

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>();
  const readFileSync = ((file: string, ...rest: unknown[]) => {
    const hit = Object.keys(fsState.reads).find((f) => String(file).endsWith(f));
    return hit ? fsState.reads[hit]() : (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const enoent = () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };
const eacces = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };

/** Every file present with synthetic text named after it, then the overrides. */
function reader(over: Partial<Record<string, () => string>> = {}) {
  return (file: string): string => (over[file] ?? (() => `text of ${file}`))();
}

const LOADED = {
  kind: 'loaded',
  text: 'text of app/lib/chat-system-prompt.md',
  algorithm: 'text of health_roadmap_algorithm.md',
  products: 'text of docs/products.md',
  doctorPosture: 'text of app/lib/chat-posture-doctor.md',
  brandPosture: 'text of app/lib/chat-posture-brand.md',
};

describe('US-15 AC65, AC72: loadChatPrompt', () => {
  it('all present: loaded with each file text', async () => {
    const { loadChatPrompt } = await import('./chat-system-prompt.server');
    expect(loadChatPrompt(reader())).toEqual(LOADED);
  });

  const cases = FILES.flatMap((file) => ([
    ['absent', enoent], ['unreadable', eacces], ['empty', () => ''], ['whitespace only', () => ' \n\t\n'],
  ] as const).map(([how, read]) => [file, how, read] as const));
  it.each(cases)('%s %s: missing, naming that file only', async (file, _how, read) => {
    const { loadChatPrompt } = await import('./chat-system-prompt.server');
    expect(loadChatPrompt(reader({ [file]: read }))).toEqual({ kind: 'missing', files: [file] });
  });

  it('two missing: names both', async () => {
    const { loadChatPrompt } = await import('./chat-system-prompt.server');
    expect(loadChatPrompt(reader({ 'docs/products.md': enoent, 'app/lib/chat-posture-brand.md': () => '' })))
      .toEqual({ kind: 'missing', files: ['docs/products.md', 'app/lib/chat-posture-brand.md'] });
  });
});

describe('US-15 AC65, AC72: CHAT_PROMPT at import', () => {
  async function importFresh(reads: Record<string, () => string>) {
    fsState.reads = Object.fromEntries(FILES.map((f) => [f, reads[f] ?? (() => `text of ${f}`)]));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Sentry = await import('@sentry/react-router');
    vi.mocked(Sentry.captureMessage).mockClear();
    const mod = await import('./chat-system-prompt.server');
    await import('./chat-system-prompt.server'); // a second import evaluates nothing again
    return { mod, captureMessage: vi.mocked(Sentry.captureMessage) };
  }

  it.each([
    ['prompt absent', { 'app/lib/chat-system-prompt.md': enoent }, ['app/lib/chat-system-prompt.md']],
    ['prompt empty', { 'app/lib/chat-system-prompt.md': () => '' }, ['app/lib/chat-system-prompt.md']],
    ['algorithm absent', { 'health_roadmap_algorithm.md': enoent }, ['health_roadmap_algorithm.md']],
    ['products and doctor posture empty', { 'docs/products.md': () => '', 'app/lib/chat-posture-doctor.md': () => ' ' }, ['docs/products.md', 'app/lib/chat-posture-doctor.md']],
  ])('%s: missing, exactly one Sentry message naming the files', async (_case, reads, files) => {
    const { mod, captureMessage } = await importFresh(reads);
    expect(mod.CHAT_PROMPT).toEqual({ kind: 'missing', files });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(`Chat docs missing: ${files.join(', ')}`, { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain('ENOENT');
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain('text of');
  });

  it('all present: loaded with the file texts, and no Sentry message', async () => {
    const { mod, captureMessage } = await importFresh({});
    expect(mod.CHAT_PROMPT).toEqual(LOADED);
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
