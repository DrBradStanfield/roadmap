import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-15 AC16/AC17: `stream: true` answers as NDJSON — thinking and text deltas,
// then one `done` line carrying exactly the JSON the non-stream path returns.
// Without the flag the route is unchanged.

const THINKING = 'Weighing the LDL guideline entry';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  getChatCompletion: vi.fn(),
  completion: {} as Record<string, unknown>,
  articles: null as null | { content: string; titles: string[] },
  // Set to the real loader to check what loads and what is titled (US-15 AC20).
  loadArticles: null as null | ((handles: string[]) => { content: string; titles: string[] } | null),
  blogArticles: undefined as string | null | undefined,
  fireRouter: false,
  classifierGate: Promise.resolve(),
}));
vi.mock('../lib/route-helpers.server', async (original) => ({
  ...await original<typeof import('../lib/route-helpers.server')>(),
  getAuthenticatedUser: mocks.auth,
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('../lib/supabase.server', () => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: vi.fn(async () => ({ sessionId: '87654321-4321-4321-8321-cba987654321', sessionToken: 'tok' })),
  GuestRateLimitError: class extends Error {},
}));
vi.mock('../lib/chat.server', async (original) => ({
  resolveChatContext: () => ({ healthDocuments: [], userContextJson: '{}' }),
  buildSystemBlocks: (_u: string, opts?: { blogArticles?: string | null }) => { mocks.blogArticles = opts?.blogArticles; return []; },
  buildConversationMessages: (_history: unknown, message: string) => [{ role: 'user', content: message }],
  matchDocumentTitle: () => null,
  loadMatchedArticlesFromHandles: (handles: string[]) => mocks.loadArticles ? mocks.loadArticles(handles) : mocks.articles,
  DOCTOR_POSTURE: '', BRAND_POSTURE: '',
  getChatCompletion: mocks.getChatCompletion,
  reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('../lib/chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(async () => ({ handles: ['apob'], latencyMs: 0, cacheHit: false, usage: { inputTokens: 0, cacheReadTokens: 0 } })),
  reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({ classifyMessage: async () => { await mocks.classifierGate; return { routerSkipped: true, classification: 'SKIP', latencyMs: 0 }; }, shouldFireRouter: () => mocks.fireRouter }));

import { action } from './api.chat';
import { routeQuery } from '../lib/chat-router.server';

const id = '12345678-1234-4234-8234-123456789abc';
let inserts: Array<{ table: string; row: Record<string, unknown> }>;
let consoleLog: { mock: { calls: unknown[][] } };

beforeEach(() => {
  inserts = [];
  mocks.articles = null;
  mocks.loadArticles = null;
  mocks.blogArticles = undefined;
  mocks.fireRouter = false;
  mocks.classifierGate = Promise.resolve();
  mocks.completion = {
    content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    isFallback: false, stopReason: 'end_turn',
  };
  mocks.getChatCompletion.mockReset().mockImplementation(async (_s: unknown, _m: unknown, _c: boolean, onEvent?: (e: unknown) => void) => {
    onEvent?.({ type: 'thinking', text: THINKING });
    onEvent?.({ type: 'text', text: 'Synthetic ' });
    onEvent?.({ type: 'text', text: 'answer' });
    return mocks.completion;
  });
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: id, customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'single', 'update', 'delete']) query[method] = () => query;
    query.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return query; };
    query.then = (resolve: any, reject: any) =>
      Promise.resolve({ data: table === 'chat_conversations' ? { id } : [], error: null }).then(resolve, reject);
    return query;
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat?logged_in_customer_id=123', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  return action({ request, params: {} } as Parameters<typeof action>[0]);
}

async function lines(res: Response) {
  const text = await res.text();
  expect(text.endsWith('\n')).toBe(true);
  return text.trimEnd().split('\n').map((l) => JSON.parse(l));
}

const timing = () => consoleLog.mock.calls.map((c) => JSON.parse(String(c[0]))).find((l) => l.evt === 'chat_timing');

describe('US-15 AC16/AC17 — streamed answers', () => {
  it('writes the deltas, then a done line equal to the non-stream JSON', async () => {
    const res = await post({ message: 'hello', localFirst: true, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const out = (await lines(res)).filter((l) => l.type !== 'status');
    expect(out.slice(0, 3)).toEqual([
      { type: 'thinking', text: THINKING },
      { type: 'text', text: 'Synthetic ' },
      { type: 'text', text: 'answer' },
    ]);
    expect(out).toHaveLength(4);
    const { type, ...done } = out[3];
    expect(type).toBe('done');

    const plain = await (await post({ message: 'hello', localFirst: true })).json();
    expect(done).toEqual({ ...plain, conversationId: done.conversationId });
    expect(done).toEqual({ success: true, conversationId: done.conversationId, messageId: null, content: 'Synthetic answer', isFallback: false, sessionToken: 'tok', isGuest: true });
  });

  it('a refusal: done carries the refusal line, isRefusal and isFallback (the client never re-serves it)', async () => {
    const line = "I can't help with that here. Please raise it with your doctor or pharmacist.";
    Object.assign(mocks.completion, { content: line, isRefusal: true, refusalCategory: 'bio', stopReason: 'refusal', failureMode: 'refusal' });
    const done = (await lines(await post({ message: 'hello', localFirst: true, stream: true }))).at(-1);
    expect(done).toMatchObject({ type: 'done', content: line, isRefusal: true, isFallback: true });
    expect(done).not.toHaveProperty('discard');
  });

  it('a fallback: done carries the fallback', async () => {
    Object.assign(mocks.completion, { content: 'Sorry', isFallback: true, failureMode: 'api-error', stopReason: undefined });
    const done = (await lines(await post({ message: 'hello', localFirst: true, stream: true }))).at(-1);
    expect(done).toMatchObject({ type: 'done', content: 'Sorry', isFallback: true });
  });

  it('proposed edits ride on the done line', async () => {
    const edit = { kind: 'field', field: 'weight', value: 80 };
    Object.assign(mocks.completion, { proposedEdits: [edit] });
    const done = (await lines(await post({ message: 'hello', localFirst: true, stream: true }))).at(-1);
    expect(done.proposedEdits).toEqual([edit]);
  });

  it('logs streamed and firstTokenMs in chat_timing, and never the thinking or the answer', async () => {
    await lines(await post({ message: 'hello', localFirst: true, stream: true }));
    expect(timing().streamed).toBe(true);
    expect(timing().firstTokenMs).toEqual(expect.any(Number));
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(THINKING);
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('Synthetic');
  });

  it('stored surfaces persist the final answer once the stream completes', async () => {
    await lines(await post({ message: 'hello', stream: true }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(inserts.map((i) => i.table)).toEqual(['chat_conversations', 'chat_messages', 'chat_messages', 'chat_match_events']);
    expect(inserts[2].row).toMatchObject({ role: 'assistant', content: 'Synthetic answer' });
    expect(JSON.stringify(inserts)).not.toContain(THINKING);
  });

  it('a failure after the stream opened ends it with an error done line', async () => {
    mocks.getChatCompletion.mockImplementation(async (_s: unknown, _m: unknown, _c: boolean, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'text', text: 'Synth' });
      throw new Error('boom');
    });
    const out = await lines(await post({ message: 'hello', localFirst: true, stream: true }));
    expect(out.at(-1)).toEqual({ type: 'done', success: false, error: 'Failed to process message' });
  });
});

// US-15 AC20: progress lines before the answer, from the moment the stream opens.
describe('US-15 AC20 — status and sources while the answer is prepared', () => {
  it('a routed turn: status, status, sources, status, then the answer and done', async () => {
    mocks.fireRouter = true;
    mocks.articles = { content: 'Article body', titles: ['ApoB explained', 'Statins'] };
    const out = await lines(await post({ message: 'what is the ideal ApoB', localFirst: true, stream: true }));
    expect(out.map((l) => l.type)).toEqual(['status', 'status', 'sources', 'status', 'thinking', 'text', 'text', 'done']);
    expect(out.slice(0, 4)).toEqual([
      { type: 'status', text: 'Reading your question' },
      { type: 'status', text: 'Finding relevant articles' },
      { type: 'sources', titles: ['ApoB explained', 'Statins'] },
      { type: 'status', text: 'Writing the answer' },
    ]);
  });

  it('a turn the router skips: no "Finding" line and no sources', async () => {
    const out = await lines(await post({ message: 'hello', localFirst: true, stream: true }));
    expect(out.slice(0, 2)).toEqual([
      { type: 'status', text: 'Reading your question' },
      { type: 'status', text: 'Writing the answer' },
    ]);
    expect(out.map((l) => l.type)).not.toContain('sources');
  });

  it('the stream opens before the classifier finishes', async () => {
    let release!: () => void;
    mocks.classifierGate = new Promise<void>((r) => { release = r; });
    const res = await post({ message: 'hello', localFirst: true, stream: true });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(first.split('\n')[0])).toEqual({ type: 'status', text: 'Reading your question' });
    release();
    await reader.cancel();
  });

  it('a stage failure after the stream opened is an error done line, not a 500', async () => {
    mocks.from.mockImplementation((table: string) => {
      const query: any = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'single', 'update', 'delete', 'insert']) query[method] = () => query;
      query.then = (resolve: any, reject: any) =>
        Promise.resolve(table === 'chat_conversations' ? { data: null, error: { message: 'db down' } } : { data: [], error: null }).then(resolve, reject);
      return query;
    });
    const res = await post({ message: 'hello', stream: true });
    expect(res.status).toBe(200);
    const out = await lines(res);
    expect(out[0]).toEqual({ type: 'status', text: 'Reading your question' });
    expect(out.at(-1)).toEqual({ type: 'done', success: false, error: 'Failed to create conversation' });
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
    // The unstreamed path keeps its HTTP 500.
    const plain = await post({ message: 'hello' });
    expect(plain.status).toBe(500);
    expect(await plain.json()).toEqual({ success: false, error: 'Failed to create conversation' });
  });
});

// US-15 AC20 with the real loader: every entry that loads is named by its index title.
describe('US-15 AC20 — the real loader names what it loads', () => {
  beforeEach(async () => {
    const real = await vi.importActual<typeof import('../lib/chat.server')>('../lib/chat.server');
    mocks.loadArticles = real.loadMatchedArticlesFromHandles;
    mocks.fireRouter = true;
  });

  it('a routed guideline loads whole and its title is the sources line', async () => {
    vi.mocked(routeQuery).mockResolvedValueOnce(
      { handles: ['sleep'], latencyMs: 0, cacheHit: false, usage: { inputTokens: 0, cacheReadTokens: 0 } } as Awaited<ReturnType<typeof routeQuery>>,
    );
    const out = await lines(await post({ message: "I can't sleep", localFirst: true, stream: true }));
    const m = await vi.importActual<typeof import('../lib/matched-content')>('../lib/matched-content');
    const index = (await vi.importActual<typeof import('../lib/blog-index.server')>('../lib/blog-index.server')).loadBlogIndex();
    expect(out.filter((l: { type: string }) => l.type === 'sources')).toEqual([{ type: 'sources', titles: [index.find((e) => e.handle === 'sleep')!.title] }]);
    expect(mocks.blogArticles).toBe(m.contentBlock('sleep', m.loadBlogArticle('sleep')!));
  });
});

describe('US-15 AC16 — without stream: true the route is unchanged', () => {
  it('answers JSON, calls the model without onEvent, and logs streamed: false', async () => {
    const res = await post({ message: 'hello', localFirst: true });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(mocks.getChatCompletion.mock.calls[0][3]).toBeUndefined(); // no onEvent
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['success', 'conversationId', 'messageId', 'content', 'isFallback', 'sessionToken', 'isGuest']);
    expect(timing().streamed).toBe(false);
    expect(timing().firstTokenMs).toBeNull();
  });

  it('a non-boolean stream flag is ignored', async () => {
    const res = await post({ message: 'hello', localFirst: true, stream: 'yes' });
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

describe('US-15 AC16 — CHAT_STREAMING=false is the off switch', () => {
  afterEach(() => { delete process.env.CHAT_STREAMING; });

  it('answers JSON to stream: true, and the model call is not streamed', async () => {
    process.env.CHAT_STREAMING = 'false';
    const res = await post({ message: 'hello', localFirst: true, stream: true });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(mocks.getChatCompletion.mock.calls[0][3]).toBeUndefined(); // no onEvent
    expect((await res.json()).content).toBe('Synthetic answer');
    expect(timing().streamed).toBe(false);
  });

  it('any other value leaves streaming on', async () => {
    process.env.CHAT_STREAMING = 'true';
    const res = await post({ message: 'hello', localFirst: true, stream: true });
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
  });
});

// US-15 AC19: the form tools go only to the client that applies them.
describe('US-15 AC19 — tools only for a client that applies edits', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Runs the real getChatCompletion behind the route and returns the Anthropic request body. */
  async function anthropicBody(body: Record<string, unknown>) {
    process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';
    const real = await vi.importActual<typeof import('../lib/chat.server')>('../lib/chat.server');
    mocks.getChatCompletion.mockImplementation(real.getChatCompletion);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: 'An answer.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post(body);
    expect((await res.json()).content).toBe('An answer.');
    return JSON.parse(fetchMock.mock.calls[0][1].body);
  }

  it('a body without canApplyEdits sends no tools', async () => {
    expect(await anthropicBody({ message: 'hello' })).not.toHaveProperty('tools');
  });

  it('US-15 AC19: canApplyEdits from a client that is not the widget (no localFirst) sends no tools', async () => {
    expect(await anthropicBody({ message: 'my LDL is 4.1 mmol/L', canApplyEdits: true })).not.toHaveProperty('tools');
    expect(await anthropicBody({ message: 'my LDL is 4.1 mmol/L', localFirst: 'true', canApplyEdits: true })).not.toHaveProperty('tools');
  });

  it('a non-boolean canApplyEdits sends no tools', async () => {
    expect(await anthropicBody({ message: 'hello', localFirst: true, canApplyEdits: 'yes' })).not.toHaveProperty('tools');
  });

  it('canApplyEdits: true sends the form tools, and run_roadmap when the message has a digit (US-15 AC33)', async () => {
    const flags = { localFirst: true, canApplyEdits: true, canApplyProfileEdits: true };
    const sent = await anthropicBody({ message: 'hello', ...flags });
    expect(sent.tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit']);
    const withValue = await anthropicBody({ message: 'my LDL is 4.1 mmol/L', ...flags });
    expect(withValue.tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit', 'run_roadmap']);
  });

  // US-16 AC2 (adversary R1): a widget built before the profile tool sends canApplyEdits alone,
  // and would write a profile edit as a blank medication row. It gets the old tool set.
  it('US-16 AC2: canApplyEdits without canApplyProfileEdits gets no profile tool', async () => {
    const old = await anthropicBody({ message: 'my LDL is 4.1 mmol/L', localFirst: true, canApplyEdits: true });
    expect(old.tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'run_roadmap']);
    const notTrue = await anthropicBody({ message: 'hello', localFirst: true, canApplyEdits: true, canApplyProfileEdits: 'yes' });
    expect(notTrue.tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit']);
    expect(await anthropicBody({ message: 'hello', localFirst: true, canApplyProfileEdits: true })).not.toHaveProperty('tools');
  });

  it('the streamed path passes the same flag', async () => {
    await lines(await post({ message: 'hello', localFirst: true, stream: true, canApplyEdits: true }));
    await lines(await post({ message: 'hello', localFirst: true, stream: true }));
    expect(mocks.getChatCompletion.mock.calls.map((c) => c[2])).toEqual([true, false]);
  });
});

// US-15 AC27 (Sentry 6Y): a 500-unit cut through an emoji left a lone
// surrogate, and PostgREST rejected the row as invalid JSON.
describe('US-15 AC27 — stored cuts keep surrogate pairs whole', () => {
  it('router_raw and error_detail drop an emoji astride the 500-unit cut', async () => {
    mocks.fireRouter = true;
    vi.mocked(routeQuery).mockResolvedValueOnce({
      handles: [], latencyMs: 0, cacheHit: false, usage: { inputTokens: 0, cacheReadTokens: 0 },
      error: 'parse', rawJson: 'r'.repeat(499) + '😀',
    } as Awaited<ReturnType<typeof routeQuery>>);
    Object.assign(mocks.completion, { errorDetail: 'e'.repeat(499) + '😀' });
    await lines(await post({ message: 'hello', stream: true }));
    await new Promise((resolve) => setImmediate(resolve));
    const row = (table: string) => inserts.find((i) => i.table === table && i.row.role !== 'user')?.row;
    expect(row('chat_messages')?.error_detail).toBe('e'.repeat(499));
    expect(row('chat_match_events')?.router_raw).toBe('r'.repeat(499));
    expect(JSON.stringify(inserts)).not.toMatch(/\\u[dD][89a-fA-F]/);
  });
});

// US-15 AC37 (Sentry 6Z): the router timed out twice, and nothing logged how
// long its reply was. Its output token count now rides on the row and the line.
describe('US-15 AC37 — router output tokens on the row and in chat_timing', () => {
  const routerUsage = { inputTokens: 900, outputTokens: 37, cacheCreationTokens: 0, cacheReadTokens: 800 };
  beforeEach(() => {
    mocks.fireRouter = true;
    vi.mocked(routeQuery).mockResolvedValueOnce(
      { handles: ['apob'], rawJson: null, latencyMs: 0, cacheHit: true, error: null, usage: routerUsage },
    );
  });
  const matchRow = async (res: Response) => {
    await lines(res);
    await new Promise((resolve) => setImmediate(resolve));
    return inserts.find((i) => i.table === 'chat_match_events')!.row;
  };

  it('US-15 AC37: a stored-surface row and chat_timing carry the count', async () => {
    expect((await matchRow(await post({ message: 'hello', stream: true }))).router_output_tokens).toBe(37);
    expect(timing().routerOutputTokens).toBe(37);
  });

  it('US-15 AC37: the widget row keeps the count', async () => {
    expect((await matchRow(await post({ message: 'hello', localFirst: true, stream: true }))).router_output_tokens).toBe(37);
  });
});
