import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-15 AC33: a run_roadmap turn through the real route and the real
// getChatCompletion, with only the network, database and classifier stubbed.
// The tool's input and output never reach chat_timing, Sentry, the
// chat_match_events row or any log; the usage counter carries two counts.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  auth: vi.fn(),
  productEvents: [] as Array<Record<string, unknown>>,
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
  supabaseAdmin: { from: () => ({ insert: async (row: Record<string, unknown>) => { mocks.productEvents.push(row); return { error: null }; } }) },
}));
vi.mock('../lib/chat-router.server', async (original) => ({
  ...await original<typeof import('../lib/chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('../lib/chat-classifier.server', () => ({
  classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }),
  shouldFireRouter: () => false,
}));

process.env.ANTHROPIC_API_KEY ??= 'sk-test-dummy';

import { action } from './api.chat';
import { reportedToCanonical } from '../../packages/health-core/src/units';
import { SERVER_VISITOR_ID } from '../lib/product-events.server';

const question = 'analyse my data: LDL 169 mg/dL, weight 83.7 kg, HDL 1.23 mmol';
const PROFILE = { unitSystem: 'si', medications: [], screenings: [], sex: 'male', heightCm: 181, birthYear: 1969, birthMonth: 8, ldlC: 2.6 };
const STATED = { values: [
  { field: 'ldlC', value: 169, unit: 'mg/dL' },
  { field: 'weightKg', value: 83.7, unit: 'kg' },
  { field: 'hdlC', value: 1.23, unit: 'mmol' }, // not a unit the table knows: rejected
] };
const ANSWER = 'From your roadmap: your LDL card says to discuss it with your doctor. These values are not saved.';
// What only the tool computed: the SI LDL, and the payload's own keys.
const TOOL_OUTPUT = [String(reportedToCanonical('ldl', 169, 'mg/dL')!.valueSI), 'latestValues', 'currentSuggestions', 'derivedValues'];
const TOOL_INPUT = ['169', '83.7', '1.23', 'mg/dL'];

let inserts: Array<{ table: string; row: Record<string, unknown> }>;
let envelopes: unknown[];
let consoleCalls: () => string;
let anthropicBodies: Array<Record<string, any>>;

beforeEach(() => {
  inserts = [];
  envelopes = [];
  mocks.productEvents = [];
  anthropicBodies = [];
  mocks.auth.mockResolvedValue({ client: { from: mocks.from }, userId: '12345678-1234-4234-8234-123456789abc', customerId: null, admin: null });
  mocks.from.mockReset().mockImplementation((table: string) => {
    const query: any = {};
    for (const method of ['select', 'eq', 'order', 'limit', 'single', 'update', 'delete']) query[method] = () => query;
    query.insert = (row: Record<string, unknown>) => { inserts.push({ table, row }); return query; };
    query.then = (resolve: any, reject: any) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return query;
  });
  const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  consoleCalls = () => JSON.stringify(spies.map((s) => s.mock.calls));
  const reply = (stop_reason: string, content: unknown[]) => new Response(JSON.stringify({
    content, stop_reason, usage: { input_tokens: 7, output_tokens: 3 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    anthropicBodies.push(JSON.parse(init.body));
    return anthropicBodies.length === 1
      ? reply('tool_use', [{ type: 'tool_use', id: 'toolu_run', name: 'run_roadmap', input: STATED }])
      : reply('end_turn', [{ type: 'text', text: ANSWER }]);
  }));
  Sentry.init({
    dsn: 'https://public@example.invalid/1', defaultIntegrations: false,
    transport: () => ({ send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }),
  });
});

afterEach(async () => { await Sentry.close(); vi.unstubAllGlobals(); vi.resetAllMocks(); vi.restoreAllMocks(); });

async function post(body: Record<string, unknown>) {
  const request = new Request('https://drstanfield.com/api/chat?logged_in_customer_id=123', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  const res = await action({ request, params: {} } as Parameters<typeof action>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

describe('US-15 AC33: a run_roadmap turn keeps the tool\'s data out of every log', () => {
  it('answers from the second call; the plan ran on the request\'s guestInputs', async () => {
    const res = await post({ message: question, localFirst: true, canApplyEdits: true, guestInputs: PROFILE });
    const reply = await res.json();
    expect(reply.content).toBe(ANSWER);
    expect(reply.isFallback).toBe(false);
    expect(anthropicBodies).toHaveLength(2);
    const result = JSON.parse(anthropicBodies[1].messages.at(-1).content[0].content);
    expect(result.applied).toEqual(['ldlC', 'weightKg']);
    expect(result.rejected).toEqual([{ field: 'hdlC', reason: 'unit not recognised for this field: ask the user which unit' }]);
    expect(result.roadmap.profile).toMatchObject({ sex: 'male', heightCm: 181 });
  });

  it('chat_timing, the console, Sentry and the chat_match_events row carry no tool input or output', async () => {
    await post({ message: question, localFirst: true, canApplyEdits: true, guestInputs: PROFILE });
    await Sentry.flush();
    const timing = JSON.parse(consoleCalls().match(/\{\\"evt\\":\\"chat_timing\\".*?\}(?=")/)![0].replace(/\\"/g, '"'));
    expect(timing.roadmapRun).toBe(true);
    for (const leak of [...TOOL_INPUT, ...TOOL_OUTPUT]) {
      expect(consoleCalls()).not.toContain(leak);
      expect(JSON.stringify(envelopes)).not.toContain(leak);
    }
    // The widget row keeps the question as before (AC7) and nothing the tool computed.
    const row = inserts.find((i) => i.table === 'chat_match_events')!.row;
    expect(row.message).toBe(question);
    for (const leak of TOOL_OUTPUT) expect(JSON.stringify(row)).not.toContain(leak);
    expect(Object.keys(row).some((k) => /roadmap|tool/i.test(k))).toBe(false);
  });

  it('the usage signal is one server event with two counts and nothing else', async () => {
    await post({ message: question, localFirst: true, canApplyEdits: true, guestInputs: PROFILE });
    expect(mocks.productEvents).toEqual([{ event_name: 'chat_run_roadmap', visitor_id: SERVER_VISITOR_ID, metadata: { count: 2, rejected: 1 } }]);
  });

  it('a turn without the tool round records no event and logs roadmapRun: false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'An answer.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await post({ message: 'hello', localFirst: true, canApplyEdits: true, guestInputs: PROFILE });
    expect(mocks.productEvents).toEqual([]);
    expect(consoleCalls()).toContain('\\"roadmapRun\\":false');
  });
});
