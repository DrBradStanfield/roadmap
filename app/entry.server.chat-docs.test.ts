/**
 * US-15 AC80: the server's start path (entry.server.tsx, where the bots start)
 * reads the chat docs once. A missing doc sends its one Sentry error at start,
 * and a later chat entry reads and reports nothing more.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ absent: [] as string[], reads: [] as string[] }));
const DOCS = [
  'app/lib/chat-system-prompt.md', 'health_roadmap_algorithm.md', 'docs/products.md',
  'app/lib/chat-posture-doctor.md', 'app/lib/chat-posture-brand.md',
  'docs/writing-style.md', 'docs/chatbot/answer-bank.md', 'app/lib/chat-router-prompt.md', 'docs/blog/index.json',
];

vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>();
  const readFileSync = ((file: string, ...rest: unknown[]) => {
    const doc = DOCS.find((d) => String(file).endsWith(d));
    if (doc) state.reads.push(doc);
    if (doc && state.absent.includes(doc)) throw new Error('ENOENT');
    return (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./shopify.server', () => ({ addDocumentResponseHeaders: vi.fn() }));
// The crons and bots start themselves on import; stand-ins keep this test to the docs.
vi.mock('./lib/reminder-v2-cron.server', () => ({ stopReminderV2Cron: vi.fn() }));
vi.mock('./lib/trending-cron.server', () => ({ stopTrendingCron: vi.fn() }));
vi.mock('./lib/discord-bot.server', () => ({ stopDiscordBot: vi.fn() }));
vi.mock('./lib/youtube-bot.server', () => ({ stopYouTubeBot: vi.fn() }));
vi.mock('./lib/chat-purge-cron.server', () => ({ stopChatPurgeCron: vi.fn() }));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  state.reads.length = 0;
  state.absent = [];
});

async function start(absent: string[]) {
  state.absent = absent;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const Sentry = await import('@sentry/react-router');
  vi.mocked(Sentry.captureMessage).mockClear();
  await import('./entry.server');
  return vi.mocked(Sentry.captureMessage);
}

describe('US-15 AC80: chat docs warmed at server start', () => {
  it('a missing doc: one Sentry error at start; a later chat entry reads and reports nothing more', async () => {
    const captureMessage = await start(['docs/products.md']);
    expect(captureMessage.mock.calls).toEqual([['Chat docs missing: docs/products.md', { level: 'error', tags: { feature: 'chat', subsystem: 'system-prompt' } }]]);
    const readsAtStart = state.reads.length;
    expect(readsAtStart).toBeGreaterThanOrEqual(8);
    const { chatDocs } = await import('./lib/chat-system-prompt.server');
    expect(chatDocs()).toEqual({ kind: 'missing', files: ['docs/products.md'] });
    expect(state.reads).toHaveLength(readsAtStart);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('all present: loaded at start with no report, and each doc read once', async () => {
    const captureMessage = await start([]);
    expect(captureMessage).not.toHaveBeenCalled();
    const { chatDocs } = await import('./lib/chat-system-prompt.server');
    expect(chatDocs().kind).toBe('loaded');
    expect(new Set(state.reads).size).toBe(state.reads.length);
    expect([...state.reads].sort()).toEqual([...DOCS].sort());
  });
});
