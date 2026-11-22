import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The three fire-and-forget writes after an answered turn (api.chat.ts logMatchEvent, the assistant
// message, the conversation timestamp): the transcript rows of US-15 AC8 and the router row of US-15
// AC7/AC26. Pins what each `.then(...).catch(...)` does on a resolved value and on a rejection.
const mocks = vi.hoisted(() => ({ from: vi.fn(), reportChatError: vi.fn() }));
vi.mock('../lib/route-helpers.server', async (o) => ({ ...await o<object>(), getAuthenticatedUser: vi.fn(async () => null) }));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/supabase-identity.server', async (o) => ({ ...await o<object>(), logAudit: vi.fn() }));
vi.mock('../lib/supabase-guest.server', async (o) => ({ ...await o<object>(),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })) }));
vi.mock('../lib/supabase-client.server', () => ({ supabaseAdmin: null, createUserClient: () => ({ from: mocks.from }) }));
vi.mock('../lib/chat-turn-io.server', async (o) => ({ ...await o<object>(), reportChatError: mocks.reportChatError }));
vi.mock('../lib/chat.server', async (original) => (await import('../lib/chat-server.test-helpers')).chatServerStub(await original<typeof import('../lib/chat.server')>()));
vi.mock('../lib/chat-router.server', async (o) => ({ ...await o<object>(), routeQuery: vi.fn(), reportRouterFailure: vi.fn() }));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }), shouldFireRouter: () => false }));

import { action } from './api.chat';

const convId = '12345678-1234-4234-8234-123456789abc';
let outcome: Record<string, 'rejects' | 'error'>;
let written: string[];

beforeEach(() => {
  outcome = {}; written = [];
  mocks.from.mockImplementation((table: string) => {
    let key = `select ${table}`;
    const query: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'single', 'maybeSingle']) query[m] = () => query;
    query.insert = (row: { role?: string }) => { key = `insert ${table}${row.role ? ` ${row.role}` : ''}`; written.push(key); return query; };
    query.update = () => { key = `update ${table}`; written.push(key); return query; };
    // A native promise from `.then`, as postgrest-js returns, so the old `.catch` runs too.
    query.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => (outcome[key] === 'rejects'
      ? Promise.reject(new Error('network down'))
      : Promise.resolve({ data: { id: convId }, error: outcome[key] === 'error' ? { message: 'denied' } : null })).then(ok, bad);
    return query;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat', { method: 'POST', body: JSON.stringify(body) });
  const res = await action({ request, params: {}, context: undefined } as unknown as Parameters<typeof action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}
const reported = () => mocks.reportChatError.mock.calls.map((c) => c[0]);
const transcript = { message: 'what is a good LDL', sessionToken: 'tok' };

describe('api.chat fire-and-forget writes: resolved value and rejection', () => {
  it('all three resolve with no error: nothing reported, the match event follows the assistant row (US-15 AC8)', async () => {
    expect((await post(transcript)).status).toBe(200);
    expect(written.slice(2)).toEqual(['insert chat_messages assistant', 'update chat_conversations', 'insert chat_match_events']);
    expect(reported()).toEqual([]);
  });

  it.each([
    ['insert chat_messages assistant', 'error', 'Chat: Failed to save assistant message'],
    ['insert chat_match_events', 'error', 'Chat: Match-event insert failed'],
    ['insert chat_messages assistant', 'rejects', 'Chat: Failed to save assistant message'],
    ['update chat_conversations', 'rejects', 'Chat: Failed to update conversation timestamp'],
    ['insert chat_match_events', 'rejects', 'Chat: Match-event insert failed'],
  ] as const)('%s %s: %j is reported once and the turn still answers 200', async (key, how, line) => {
    outcome[key] = how;
    const res = await post(transcript);
    expect(res.status).toBe(200);
    expect((await res.json()).content).toBe('Synthetic answer');
    expect(reported()).toEqual([line]);
    if (key === 'insert chat_messages assistant') expect(written).not.toContain('insert chat_match_events');
  });

  it("widget turn (US-15 AC7): its only row, the match event, rejects and the catch reports it", async () => {
    outcome['insert chat_match_events'] = 'rejects';
    expect((await post({ ...transcript, localFirst: true })).status).toBe(200);
    expect(written).toEqual(['insert chat_match_events']);
    expect(reported()).toEqual(['Chat: Match-event insert failed']);
  });
});
