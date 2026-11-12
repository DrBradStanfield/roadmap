/**
 * US-15 AC65: the chat system prompt is one state, read once at import.
 * Absent, unreadable or blank is 'missing', which carries no text and sends
 * exactly one fixed-words Sentry message for the process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({ read: (): string => 'synthetic prompt' }));

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>();
  const readFileSync = ((file: string, ...rest: unknown[]) =>
    String(file).endsWith('app/lib/chat-system-prompt.md') ? fsState.read() : (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

const enoent = () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };
const eacces = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };

describe('US-15 AC65: loadChatPrompt', () => {
  it.each([
    ['absent', enoent, { kind: 'missing' }],
    ['unreadable', eacces, { kind: 'missing' }],
    ['empty', () => '', { kind: 'missing' }],
    ['whitespace only', () => ' \n\t\n', { kind: 'missing' }],
    ['present', () => 'You are a careful assistant.\n', { kind: 'loaded', text: 'You are a careful assistant.\n' }],
  ])('%s', async (_case, read, expected) => {
    const { loadChatPrompt } = await import('./chat-system-prompt.server');
    expect(loadChatPrompt(read)).toEqual(expected);
  });
});

describe('US-15 AC65: CHAT_PROMPT at import', () => {
  async function importFresh(read: () => string) {
    fsState.read = read;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Sentry = await import('@sentry/react-router');
    vi.mocked(Sentry.captureMessage).mockClear();
    const mod = await import('./chat-system-prompt.server');
    await import('./chat-system-prompt.server'); // a second import evaluates nothing again
    return { mod, captureMessage: vi.mocked(Sentry.captureMessage) };
  }

  it.each([['absent', enoent], ['empty', () => '']])('%s: missing, exactly one fixed-words Sentry message', async (_case, read) => {
    const { mod, captureMessage } = await importFresh(read);
    expect(mod.CHAT_PROMPT).toEqual({ kind: 'missing' });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('Chat system prompt missing', { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } });
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain('ENOENT');
  });

  it('present: loaded with the file text, and no Sentry message', async () => {
    const { mod, captureMessage } = await importFresh(() => 'synthetic prompt text');
    expect(mod.CHAT_PROMPT).toEqual({ kind: 'loaded', text: 'synthetic prompt text' });
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
