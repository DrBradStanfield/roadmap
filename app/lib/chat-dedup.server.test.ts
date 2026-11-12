import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { ClaimsState } from './single-use-claims.test-helpers';

const claims = vi.hoisted(() => ({ state: null as null | ClaimsState }));
vi.mock('./supabase-client.server', async (actual) => {
  const helpers = await import('./single-use-claims.test-helpers');
  claims.state ??= helpers.newClaimsState();
  return { ...(await actual<object>()), supabaseAdmin: helpers.claimsAdmin(claims.state) };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const { findDuplicateReply, claimChatTurn, CHAT_BUSY_REPLY, CHAT_TURN_TTL_MS } = await import('./chat-dedup.server');
type DedupHistoryItem = import('./chat-dedup.server').DedupHistoryItem;
const { resetClaimsState } = await import('./single-use-claims.test-helpers');
const { RETRY_MAX_ATTEMPTS, RETRY_DELAY_MS, ANTHROPIC_TIMEOUT_MS } = await import('./anthropic-fetch.server');
const { CLASSIFIER_TIMEOUT_MS } = await import('./chat-classifier.server');
const { ROUTER_TIMEOUT_MS } = await import('./chat-router.server');
const Sentry = await import('@sentry/react-router');

const now = () => new Date().toISOString();
const pair = (reply: Partial<DedupHistoryItem>): DedupHistoryItem[] => [
  { role: 'user', content: 'q', created_at: now() },
  { role: 'assistant', content: 'a', created_at: now(), ...reply },
];

describe('findDuplicateReply', () => {
  it('re-serves an ordinary reply to a byte-identical resend', () => {
    expect(findDuplicateReply(pair({}), 'q')?.content).toBe('a');
  });
  it('never re-serves a fallback (US-15 AC3)', () => {
    expect(findDuplicateReply(pair({ is_fallback: true }), 'q')).toBeNull();
  });
  it('never re-serves a refusal line: a resend gets a fresh answer (US-15 AC14)', () => {
    expect(findDuplicateReply(pair({ failure_mode: 'refusal' }), 'q')).toBeNull();
  });
});

// US-15 AC63: one answer per identical message while a turn runs.
const SCOPE = '12345678-1234-4234-8234-123456789abc';
const MESSAGE = 'Synthetic question about sleep';
const SECRET = 'test-secret-good';
const allSentryArgs = () => JSON.stringify([vi.mocked(Sentry.captureMessage).mock.calls, vi.mocked(Sentry.captureException).mock.calls]);

describe('US-15 AC63 — claimChatTurn', () => {
  beforeEach(() => {
    resetClaimsState(claims.state!);
    vi.stubEnv('SHOPIFY_API_SECRET', SECRET);
    vi.mocked(Sentry.captureMessage).mockClear();
    vi.mocked(Sentry.captureException).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('an identical message while the first turn runs gets busy; one row is stored', async () => {
    expect((await claimChatTurn(SCOPE, MESSAGE, [], 'shopify')).kind).toBe('run');
    expect((await claimChatTurn(SCOPE, MESSAGE, [], 'shopify')).kind).toBe('busy');
    expect(claims.state!.rows.size).toBe(1);
    expect(CHAT_BUSY_REPLY).toBe('Still answering this question. Try sending it again in a moment.');
  });

  it('a different message in the same thread runs, and so does the same message in another thread', async () => {
    await claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
    expect((await claimChatTurn(SCOPE, 'Another synthetic question', [], 'shopify')).kind).toBe('run');
    expect((await claimChatTurn('87654321-4321-4321-8321-cba987654321', MESSAGE, [], 'shopify')).kind).toBe('run');
  });

  it('after release the same message runs again (a fallback gets its retry)', async () => {
    const first = await claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
    if (first.kind !== 'run') throw new Error('expected run');
    first.release();
    await vi.waitFor(() => expect(claims.state!.rows.size).toBe(0));
    expect((await claimChatTurn(SCOPE, MESSAGE, [], 'shopify')).kind).toBe('run');
  });

  it('a claim older than the TTL does not block, and is gone', async () => {
    await claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
    const [oldKey] = [...claims.state!.rows.keys()];
    claims.state!.rows.get(oldKey)!.createdAt -= CHAT_TURN_TTL_MS + 1_000;
    // Another thread's stale claim of the same kind goes in the same sweep.
    claims.state!.rows.set('f'.repeat(64), { kind: 'chat-turn', createdAt: Date.now() - CHAT_TURN_TTL_MS - 1_000 });
    claims.state!.rows.set('e'.repeat(64), { kind: 'mcp-confirm', createdAt: Date.now() - CHAT_TURN_TTL_MS - 1_000 });
    expect((await claimChatTurn(SCOPE, MESSAGE, [], 'shopify')).kind).toBe('run');
    expect(claims.state!.rows.get(oldKey)!.createdAt).toBeGreaterThan(Date.now() - 5_000);
    expect(claims.state!.rows.has('f'.repeat(64))).toBe(false);
    expect(claims.state!.rows.has('e'.repeat(64))).toBe(true);
  });

  it('a live claim younger than the TTL still blocks', async () => {
    await claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
    const [key] = [...claims.state!.rows.keys()];
    claims.state!.rows.get(key)!.createdAt -= CHAT_TURN_TTL_MS - 5_000;
    expect((await claimChatTurn(SCOPE, MESSAGE, [], 'shopify')).kind).toBe('busy');
  });

  it('the stored key is an HMAC under the server secret with the fixed label: hex only, no text, no id, never plain sha256', async () => {
    await claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
    const [[key, row]] = [...claims.state!.rows.entries()];
    expect(row.kind).toBe('chat-turn');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(crypto.createHmac('sha256', SECRET).update(`chat-turn-claim:v1\n${SCOPE}\n${MESSAGE}`, 'utf8').digest('hex'));
    expect(key).not.toBe(crypto.createHash('sha256').update(`${SCOPE}\n${MESSAGE}`, 'utf8').digest('hex'));
    expect(key).not.toContain(SCOPE.replace(/-/g, ''));
  });

  it('a store that is down or has no table fails open with fixed words that carry no text', async () => {
    for (const down of ['error', 'throw', 'hang'] as const) {
      resetClaimsState(claims.state!);
      claims.state!.down = down;
      if (down === 'hang') vi.useFakeTimers();
      const pending = claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
      if (down === 'hang') await vi.advanceTimersByTimeAsync(5_100);
      expect((await pending).kind, down).toBe('run');
      vi.useRealTimers();
    }
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Chat: turn claim failed', expect.objectContaining({ tags: expect.objectContaining({ feature: 'chat' }) }));
    expect(allSentryArgs()).not.toContain(MESSAGE);
    expect(allSentryArgs()).not.toContain(SCOPE);
  });

  it('with no server secret it fails open, never hashes without one, and reports once per process in fixed words', async () => {
    vi.stubEnv('SHOPIFY_API_SECRET', '');
    vi.resetModules();
    const fresh = await import('./chat-dedup.server');
    const SentryNow = await import('@sentry/react-router');
    vi.mocked(SentryNow.captureMessage).mockClear();
    expect((await fresh.claimChatTurn(SCOPE, MESSAGE, [], 'shopify')).kind).toBe('run');
    expect((await fresh.claimChatTurn(SCOPE, MESSAGE, [], 'shopify')).kind).toBe('run');
    expect(claims.state!.inserts).toBe(0);
    const missing = vi.mocked(SentryNow.captureMessage).mock.calls.filter(([m]) => m === 'Chat: turn claim has no key secret');
    expect(missing).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(SentryNow.captureMessage).mock.calls)).not.toContain(MESSAGE);
  });

  it('a finished reply under 60 s is re-served before any claim, and nothing is written', async () => {
    const history: DedupHistoryItem[] = [
      { role: 'user', content: MESSAGE, created_at: now() },
      { role: 'assistant', content: 'Synthetic stored answer', created_at: now() },
    ];
    expect(await claimChatTurn(SCOPE, MESSAGE, history, 'discord')).toEqual({ kind: 'duplicate', content: 'Synthetic stored answer' });
    expect(claims.state!.inserts).toBe(0);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('chat: duplicate user message detected, re-serving previous reply',
      expect.objectContaining({ tags: expect.objectContaining({ platform: 'discord', diagnostic: 'dedup' }) }));
  });

  it('busy is reported in fixed words with the message length only', async () => {
    await claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
    await claimChatTurn(SCOPE, MESSAGE, [], 'shopify');
    expect(Sentry.captureMessage).toHaveBeenCalledWith('chat: turn already running',
      expect.objectContaining({ tags: expect.objectContaining({ diagnostic: 'inflight' }), extra: { messageLength: MESSAGE.length } }));
    expect(allSentryArgs()).not.toContain(MESSAGE);
  });

  it('the TTL outlasts the longest turn its timeouts allow: classifier, router and answer, each with its retry', () => {
    const stage = (timeoutMs: number) => RETRY_MAX_ATTEMPTS * timeoutMs + (RETRY_MAX_ATTEMPTS - 1) * RETRY_DELAY_MS;
    const longestTurn = stage(CLASSIFIER_TIMEOUT_MS) + stage(ROUTER_TIMEOUT_MS) + stage(ANTHROPIC_TIMEOUT_MS);
    expect(longestTurn).toBeLessThan(CHAT_TURN_TTL_MS);
    expect(CHAT_TURN_TTL_MS).toBe(180_000);
  });
});
