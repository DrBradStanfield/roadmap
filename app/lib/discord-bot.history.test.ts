// US-15 AC8a: latest retained context, chronological and owner-scoped.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Query = {
  table: string;
  selection?: string;
  filters: Array<{ column: string; op: 'eq' | 'gte'; value: unknown }>;
  ordering?: { column: string; ascending: boolean };
  cap?: number;
};
const edge = vi.hoisted(() => ({
  listeners: new Map<string, (message: unknown) => void>(),
  complete: vi.fn(), capture: vi.fn(),
  tables: {} as Record<string, Row[]>, queries: [] as Query[],
}));

// Replace only external boundaries; the event handler, lookups and dedup run unchanged.
vi.mock('discord.js', () => ({
  Client: class {
    user = { id: 'bot' };
    once() {}
    on(event: string, callback: (message: unknown) => void) { edge.listeners.set(event, callback); }
    login() { return Promise.resolve(); }
    destroy() {}
  },
  Events: { MessageCreate: 'message', ClientReady: 'ready', Error: 'error' },
  GatewayIntentBits: {}, Partials: {},
}));
vi.mock('@sentry/react-router', () => ({ captureException: edge.capture, captureMessage: vi.fn() }));
vi.mock('./platform-chat.server', () => ({ platformChatCompletion: edge.complete }));
vi.mock('./chat.server', () => ({ reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic', CHAT_MODEL: 'synthetic' }));
vi.mock('./chat-router.server', () => ({ ROUTER_VERSION: 'synthetic' }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: {
  from: (table: string) => {
    const spec: Query = { table, filters: [] };
    edge.queries.push(spec);
    let write = false;
    // Apply the actual caller's predicates, sorting and cap, never implicit ownership.
    const execute = () => {
      if (write) return { data: null, error: null };
      let rows = [...(edge.tables[table] ?? [])];
      for (const { column, op, value } of spec.filters) {
        rows = rows.filter(row => op === 'eq' ? row[column] === value
          : String(row[column]) >= String(value));
      }
      const ordering = spec.ordering;
      if (ordering) rows.sort((a, b) => String(a[ordering.column]).localeCompare(String(b[ordering.column])) * (ordering.ascending ? 1 : -1));
      if (spec.cap !== undefined) rows = rows.slice(0, spec.cap);
      return { data: rows, error: null };
    };
    const query = {
      select: (selection: string) => { spec.selection = selection; return query; },
      eq: (column: string, value: unknown) => { spec.filters.push({ column, op: 'eq', value }); return query; },
      gte: (column: string, value: unknown) => { spec.filters.push({ column, op: 'gte', value }); return query; },
      order: (column: string, options: { ascending: boolean }) => { spec.ordering = { column, ...options }; return query; },
      limit: (cap: number) => { spec.cap = cap; return query; },
      maybeSingle: async () => { const result = execute(); return { ...result, data: result.data?.[0] ?? null }; },
      single: async () => ({ data: { id: 'new-synthetic' }, error: null }),
      insert: () => { write = true; return query; },
      update: () => { write = true; return query; },
      then: (resolve: (result: ReturnType<typeof execute>) => unknown) => Promise.resolve(execute()).then(resolve),
    };
    return query;
  },
} }));

const NOW = '2026-10-21T12:00:00.000Z';
function turns(count: number, conversationId = 'owned') {
  return Array.from({ length: count }, (_, i) => ({
    id: `turn-${conversationId}-${i}`, conversation_id: conversationId,
    role: i % 2 === 0 ? 'user' : 'assistant', content: `Synthetic turn ${i}` as string | null,
    created_at: new Date(Date.parse(NOW) - (count - i) * 1000).toISOString(),
    is_fallback: false, failure_mode: null as string | null,
    discord_message_id: i === count - 1 ? 'parent' : null,
  }));
}
function message(reply = false, content = 'New synthetic question') {
  return {
    id: 'incoming', author: { id: 'author', bot: false }, guild: { id: 'guild' }, system: false,
    content, channelId: 'ai', mentions: { everyone: false, users: new Set<string>() },
    reference: reply ? { messageId: 'parent' } : null,
    channel: { isThread: () => false, isTextBased: () => false,
      messages: { fetch: vi.fn().mockResolvedValue({ author: { id: 'bot' } }) } },
    reply: vi.fn().mockResolvedValue({ id: 'sent' }),
  };
}
async function send(incoming: ReturnType<typeof message>) {
  edge.listeners.get('message')!(incoming);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  expect(edge.capture).not.toHaveBeenCalled();
  expect(incoming.reply).toHaveBeenCalledTimes(1);
}
const modelTurns = (rows: ReturnType<typeof turns>) => rows.map(({ role, content }) => ({ role, content }));
let stop: () => void;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  edge.listeners.clear(); edge.queries.length = 0;
  edge.tables = { chat_conversations: [{ id: 'owned', platform: 'discord', external_id: 'author', updated_at: NOW }], chat_messages: [] };
  for (const [key, value] of Object.entries({ DISCORD_BOT_TOKEN: 'synthetic', DISCORD_FORCE_START: 'true',
    DISCORD_SERVER_ID: 'guild', DISCORD_BOT_PROFILE_ID: 'synthetic',
    DISCORD_DEDICATED_AI_CHANNEL_ID: 'ai', DISCORD_EXCLUDED_CHANNEL_IDS: '',
    DISCORD_DrBradStanfield_USER_ID: '' })) vi.stubEnv(key, value);
  edge.complete.mockResolvedValue({ content: 'Synthetic answer',
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    isFallback: false, routerResult: null, classifier: { classification: 'GREETING', routerSkipped: true } });
  stop = (await import('./discord-bot.server')).stopDiscordBot;
});
afterEach(() => { stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it.each([false, true])('passes the newest 20 of 24 stored turns in chronological order (reply=%s)', async reply => {
  const history = turns(24);
  // Storage order is not chronological; the query must sort before limiting.
  edge.tables.chat_messages = [...history].reverse();
  await send(message(reply));
  expect(edge.complete).toHaveBeenCalledExactlyOnceWith({ message: 'New synthetic question', history: modelTurns(history.slice(-20)) });
});

it.each([0, 6, 20])('keeps all %s turns at or below the exact cap', async count => {
  const history = turns(count);
  edge.tables.chat_messages = [...history].reverse();
  await send(message());
  expect(edge.complete).toHaveBeenCalledExactlyOnceWith({ message: 'New synthetic question', history: modelTurns(history) });
  expect(edge.queries.find(query => query.table === 'chat_messages' && query.selection?.startsWith('role,')))
    .toMatchObject({ cap: 20, ordering: { column: 'created_at', ascending: false },
      filters: [{ column: 'conversation_id', op: 'eq', value: 'owned' }] });
});

it('omits purged user and assistant text without modifying the stored null rows', async () => {
  const history = turns(24);
  history[0].content = null;
  history[10].content = null;
  history[11].content = null;
  edge.tables.chat_messages = [...history].reverse();
  await send(message());
  expect(edge.complete).toHaveBeenCalledExactlyOnceWith({ message: 'New synthetic question',
    history: modelTurns(history.slice(-20).filter(row => row.content !== null)) });
  expect(history.filter(row => row.content === null).map(row => row.id))
    .toEqual(['turn-owned-0', 'turn-owned-10', 'turn-owned-11']);
});

it('uses empty context when all stored text is purged', async () => {
  edge.tables.chat_messages = turns(24).map(row => ({ ...row, content: null }));
  await send(message());
  expect(edge.complete).toHaveBeenCalledExactlyOnceWith({ message: 'New synthetic question', history: [] });
});

it.each([false, true])('re-serves the latest recent duplicate after more than 20 turns (reply=%s)', async reply => {
  const history = turns(24);
  edge.tables.chat_messages = history;
  const incoming = message(reply, history[22].content!);
  await send(incoming);
  expect(edge.complete).not.toHaveBeenCalled();
  expect(incoming.reply).toHaveBeenCalledExactlyOnceWith({ content: `<@author> ${history[23].content}`,
    allowedMentions: { repliedUser: false, users: ['author'] } });
  expect(edge.queries.every(query => query.selection !== undefined)).toBe(true); // no persistence writes
});

it.each(['fallback', 'refusal', 'expired', 'purged-assistant', 'purged-user', 'nonconsecutive'] as const)
('does not re-serve a %s duplicate', async condition => {
  const history = turns(24);
  const repeated = history[22].content!;
  if (condition === 'fallback') history[23].is_fallback = true;
  if (condition === 'refusal') history[23].failure_mode = 'refusal';
  if (condition === 'expired') history.forEach(row => { row.created_at = new Date(Date.parse(row.created_at) - 60_000).toISOString(); });
  if (condition === 'purged-assistant') history[23].content = null;
  if (condition === 'purged-user') history[22].content = null;
  if (condition === 'nonconsecutive') { history[20].content = repeated; history[22].content = 'Different latest question'; }
  edge.tables.chat_messages = history;
  await send(message(false, repeated));
  expect(edge.complete).toHaveBeenCalledExactlyOnceWith({ message: repeated,
    history: modelTurns(history.slice(-20).filter(row => row.content !== null)) });
});

it('keeps recent continuity scoped to this Discord author and platform', async () => {
  const history = turns(24);
  edge.tables.chat_conversations.push(
    { id: 'foreign', platform: 'discord', external_id: 'other-author', updated_at: '2026-10-21T12:00:01.000Z' },
    { id: 'shopify', platform: 'shopify', external_id: 'author', updated_at: '2026-10-21T12:00:02.000Z' });
  edge.tables.chat_messages = [...history, ...turns(24, 'foreign'), ...turns(24, 'shopify')];
  await send(message());
  expect(edge.complete).toHaveBeenCalledExactlyOnceWith({ message: 'New synthetic question', history: modelTurns(history.slice(-20)) });
  expect(edge.queries.find(query => query.table === 'chat_conversations' && query.selection === 'id'))
    .toMatchObject({ cap: 1, ordering: { column: 'updated_at', ascending: false }, filters: [
      { column: 'platform', op: 'eq', value: 'discord' },
      { column: 'external_id', op: 'eq', value: 'author' },
      { column: 'updated_at', op: 'gte', value: '2026-10-21T11:30:00.000Z' },
    ] });
});

it.each(['other-author', 'other-platform'])('rejects reply history belonging to %s', async mismatch => {
  edge.tables.chat_messages = turns(24);
  const conversation = edge.tables.chat_conversations[0];
  if (mismatch === 'other-author') conversation.external_id = 'someone-else';
  else conversation.platform = 'shopify';
  await send(message(true));
  expect(edge.complete).toHaveBeenCalledExactlyOnceWith({ message: 'New synthetic question', history: [] });
  expect(edge.queries.find(query => query.table === 'chat_conversations' && query.selection === 'platform, external_id'))
    .toMatchObject({ filters: [{ column: 'id', op: 'eq', value: 'owned' }] });
});
