/**
 * US-32 · the hosted server's guards, pinned by their WORDING and their
 * BOUNDARIES.
 *
 * `mcp.hosted.test.ts` proves the chain works. This file proves the refusals
 * refuse for the reason they claim: a mismatch refusal is distinguishable from
 * an outage, it teaches a guessing agent nothing, the 50-row cap is 50 and not
 * 1, a malformed body is a 400, and the tool list is the nine tools by NAME —
 * a length assertion cannot see a tool being renamed or swapped.
 *
 * The harness is the same shape as `mcp.hosted.test.ts`'s: real Requests
 * through the route's own loader/action, with Dropbox as an in-memory folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

import { serveClientMetadata } from '../lib/mcp-cimd.test-helpers';
import type { ClaimsState } from '../lib/single-use-claims.test-helpers';

/** One claim store behind every server instance in this file (US-36 AC9). */
const claims = vi.hoisted(() => ({ state: null as null | ClaimsState, noClient: false }));
vi.mock('../lib/supabase-client.server', async (actual) => {
  const helpers = await import('../lib/single-use-claims.test-helpers');
  claims.state ??= helpers.newClaimsState();
  const client = helpers.claimsAdmin(claims.state);
  return { ...(await actual<object>()), get supabaseAdmin() { return claims.noClient ? null : client; } };
});
vi.mock('@sentry/react-router', async (actual) => ({ ...(await actual<object>()), captureMessage: vi.fn() }));
// The real counter, watched: H59 reads which kind of confirm refusal each row names.
vi.mock('../lib/product-events.server', async (actual) => {
  const original = await actual<typeof import('../lib/product-events.server')>();
  return { ...original, recordServerEvent: vi.fn(original.recordServerEvent) };
});
import { recordServerEvent } from '../lib/product-events.server';
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { createCoreRow } from '../../packages/health-core/src/blood-tests';
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { resetMcpMemory } from '../lib/mcp-grants.server';
import { resetClaimsState } from '../lib/single-use-claims.test-helpers';
import { MAX_LAB_ROWS_PER_CALL } from '../../packages/health-core/src/mcp-tools';
import { REPO_PUBLIC } from '../../packages/health-core/src/plan';
import { mcpEndpoint, setAdapterFactory } from '../lib/mcp.server';
import { action, loader } from './mcp.$';

const ISSUER = 'https://mcp.example.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const NOW = '2026-09-02T10:00:00.000Z';

/**
 * The nine tools, spelled out. Written by hand on purpose: comparing the
 * server's list to `MCP_TOOLS` proves only that the server echoes itself, and
 * every doc, guide and consent screen in the repo counts to this list (D4–D9).
 */
const NINE_TOOLS = [
  'read_record', 'get_plan', 'add_measurement', 'add_lab_values',
  'correct_value', 'update_profile', 'report_feedback', 'import_documents', 'file_results',
];

let cloud: MemoryCloud;
let connections = 0;

beforeEach(() => {
  // A client id that is a URL means a CIMD fetch: answered here, so no DNS or socket leaves the machine.
  serveClientMetadata();
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 3).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  resetMcpMemory();
  resetClaimsState(claims.state!);
  claims.noClient = false;
  cloud = new MemoryCloud();
  setAdapterFactory(() => new MemoryAdapter(cloud));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    refresh_token: `dropbox-refresh-token-${++connections}`,
    access_token: 'dropbox-access-token',
    expires_in: 14400,
  })));
});

afterEach(() => {
  setAdapterFactory(null);
  vi.unstubAllGlobals();
  delete process.env.MCP_SEAL_KEYS;
});

function unescapeHtml(text: string): string {
  return text.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
}

function get(path: string, headers: HeadersInit = {}): Promise<Response> {
  const url = new URL(path, ISSUER);
  const splat = url.pathname.replace(/^\/mcp\/?/, '');
  return Promise.resolve(loader({ request: new Request(url, { headers }), params: { '*': splat }, context: {} } as never)) as Promise<Response>;
}

function post(path: string, init: RequestInit): Promise<Response> {
  const url = new URL(path, ISSUER);
  const splat = url.pathname.replace(/^\/mcp\/?/, '');
  return Promise.resolve(action({ request: new Request(url, { method: 'POST', ...init }), params: { '*': splat }, context: {} } as never)) as Promise<Response>;
}

async function connect(): Promise<string> {
  const register = await post('/mcp/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
  });
  expect(register.status).toBe(201);
  const clientId = (await register.json()).client_id as string;

  const consent = await get(`/mcp/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
    state: 'client-state', resource: `${ISSUER}/mcp`,
  })}`);
  expect(consent.status).toBe(200);
  const sealedState = unescapeHtml(/name="state" value="([^"]+)"/.exec(await consent.text())![1]);

  const pressed = await post('/mcp/authorize', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: sealedState }),
  });
  const nonce = new URL(pressed.headers.get('location')!).searchParams.get('state')!;
  const cookie = pressed.headers.get('set-cookie')!.split(';')[0];

  const back = await get(`/mcp/callback?code=dropbox-code&state=${encodeURIComponent(nonce)}`, { cookie });
  const code = new URL(back.headers.get('location')!).searchParams.get('code')!;

  const tokens = await post('/mcp/token', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
      code_verifier: VERIFIER, client_id: clientId,
    }),
  });
  expect(tokens.status).toBe(200);
  return (await tokens.json()).access_token as string;
}

async function rpc(access: string, method: string, params: unknown = {}) {
  const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), NOW);
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } };
}

async function callTool(access: string, name: string, args: unknown) {
  const answer = await rpc(access, 'tools/call', { name, arguments: args });
  return { text: answer.result!.content![0].text, isError: answer.result!.isError === true };
}

const LDL_ID = 'ldl-row';
const STORED_LDL = 3.2;

function seedWithLdl(day = '2026-08-30'): void {
  const recordedAt = `${day}T00:00:00.000Z`;
  const file: RoadmapFile = {
    ...createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' }),
    // Every blood test is a core row in labValues (US-66 AC1).
    labValues: [createCoreRow({
      id: LDL_ID, metric: 'ldl', value: STORED_LDL, recordedAt, createdAt: recordedAt,
    })],
  };
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
}

function seedEmpty(): void {
  const file = createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' });
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
}

function storedRecord(): RoadmapFile {
  return JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
}

// ---------------------------------------------------------------------------

describe('the tool list is nine tools, by name (US-32 AC1, US-35 AC12, US-36 AC11)', () => {
  it('offers exactly the nine named tools, in order', async () => {
    seedEmpty();
    const listed = await rpc(await connect(), 'tools/list');
    expect(listed.result!.tools!.map((t) => t.name)).toEqual(NINE_TOOLS);
  });
});

describe('a mismatched expectedValue is refused, in words that say why (US-32 AC5)', () => {
  it('names the row and tells the agent to read again — not an outage, not an allowance', async () => {
    seedWithLdl();
    const access = await connect();
    const answer = await callTool(access, 'correct_value', { id: LDL_ID, newValue: 2.8, expectedValue: 9.9 });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(LDL_ID);
    expect(answer.text).toContain('does not hold the value you expected');
    expect(answer.text).toContain('read the record again');
    // The three refusals this must never be confused with.
    expect(answer.text).not.toContain('allowance');
    expect(answer.text).not.toContain('did not answer');
    expect(answer.text).not.toContain('90 days');
    expect(storedRecord().labValues.find((m) => m.id === LDL_ID)!.status).toBe('active');
  });

  it('never echoes the STORED value, so guessing teaches the agent nothing (US-32 AC5)', async () => {
    // The whole point of the guard: a caller that guessed wrong must not learn
    // the real number from the refusal. Nothing pinned this before.
    seedWithLdl();
    const access = await connect();
    for (const guess of [9.9, 0.1, 3.3]) {
      const answer = await callTool(access, 'correct_value', { id: LDL_ID, newValue: 2.8, expectedValue: guess });
      expect(answer.isError).toBe(true);
      expect(answer.text).not.toContain(String(STORED_LDL));
    }
  });
});

describe('the lab-row cap is fifty, not fewer (US-32 AC6)', () => {
  function rows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      metricName: `test-${i}`, value: 1, unit: 'mg/L', recordedAt: '2026-08-30',
    }));
  }

  it('accepts a call of exactly fifty rows and refuses fifty-one', async () => {
    seedEmpty();
    const access = await connect();

    const atCap = await callTool(access, 'add_lab_values', { values: rows(MAX_LAB_ROWS_PER_CALL) });
    expect(atCap.isError).toBe(false);
    expect(storedRecord().labValues).toHaveLength(MAX_LAB_ROWS_PER_CALL);

    const overCap = await callTool(access, 'add_lab_values', { values: rows(MAX_LAB_ROWS_PER_CALL + 1) });
    expect(overCap.isError).toBe(true);
    // Nothing partial: the whole call is refused, not the last row.
    expect(storedRecord().labValues).toHaveLength(MAX_LAB_ROWS_PER_CALL);
  });
});

describe('a malformed request body is a 400, not a crash (US-32 AC17)', () => {
  it('answers 400 with a JSON-RPC error rather than throwing', async () => {
    seedEmpty();
    const access = await connect();
    const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0", oops',
    }), NOW);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('Not valid JSON');
    // A parse failure must not be dressed up as something the user broke in
    // their record: nothing was read and nothing was written.
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// US-36 AC9 — two-phase for the permanent tools, replayed by a scripted assistant
// ---------------------------------------------------------------------------
import { OUTPUTS } from '../../packages/health-core/src/mcp-tools';
import { STEP_WINDOWS } from '../lib/mcp-step.server';

const { nbfSeconds: PROPOSAL_NBF_SECONDS, ttlSeconds: PROPOSAL_LIFETIME_SECONDS } = STEP_WINDOWS.proposal;
/** One answer for a receipt that is not ours, or names other arguments, another tool or another connection (US-36 AC9, 2026-10-07). */
const NOT_OURS = 'does not match these arguments on this connection, or is not ours';
/** The user's own words, quoted in every confirming call and commit (US-36 AC9, US-35 AC7, 2026-10-07). */
const APPROVED = 'Yes, go ahead';
const QUOTE_APPROVAL = (name: string) =>
  `If the user has not yet answered the proposal in their own words, show it to them and end your turn. Otherwise quote the user’s approval: call ${name} again with the same arguments, confirm set to the same receipt, and approval set to the user’s own words approving this change, quoted from their message. Nothing was written.`;
import { WRITE_COST, WRITES_PER_HOUR } from '../lib/mcp-grants.server';

/** The refusal while a confirm cannot be checked: worded, and nothing is written. */
const CLAIM_UNCHECKED = 'The confirm could not be checked just now, so nothing was written. Try the same call once more in a minute. If it is then refused as already used, propose the change again.';
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

async function callToolAt(access: string, name: string, args: unknown, now: string) {
  const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), now);
  expect(res.status).toBe(200);
  const answer = (await res.json()) as { result: { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean } };
  return { text: answer.result.content[0].text, structured: answer.result.structuredContent, isError: answer.result.isError === true };
}

describe('US-36 AC9 — a permanent write takes two calls, identical arguments, the same connection, 10 s apart, inside 15 min', () => {
  const FIX = { id: LDL_ID, newValue: 2.8, expectedValue: STORED_LDL };

  it('a malformed confirm is refused before the arguments are canonicalised, and nesting too deep for that is refused in words (US-36 AC9)', async () => {
    seedWithLdl();
    const access = await connect();
    // Written as text: JSON.stringify itself overflows on this depth, while the server's JSON.parse does not.
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    for (const confirm of ['not-a-receipt', '00000000-0000-0000-0000-000000000000']) {
      const args = `{"id":"${FIX.id}","newValue":${FIX.newValue},"expectedValue":${FIX.expectedValue},"confirm":"${confirm}","approval":"${APPROVED}","deep":${deep}}`;
      const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"correct_value","arguments":${args}}}`,
      }), at(11));
      const answer = (await res.json()) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
      expect(answer.error, confirm).toBeUndefined();
      expect(answer.result!.isError, confirm).toBe(true);
      expect(answer.result!.content[0].text, confirm).toContain('Nothing was written');
    }
    expect(storedRecord().labValues).toHaveLength(1);
  });

  it('a scripted assistant obeying a planted line: every shortcut is refused in words, and the honest path writes once, uncharged', async () => {
    // The sequence the review measured a small model taking from a line in a
    // clinic letter (5/6): read, then correct_value straight away. Deterministic
    // here — no model — so a regression fails CI, not a monthly monitor.
    seedWithLdl();
    const access = await connect();
    const stranger = await connect();
    expect((await callTool(access, 'read_record', {})).isError).toBe(false);

    // 1. The planted call, without confirm: every guard runs, nothing is written, a receipt comes back.
    const proposed = await callToolAt(access, 'correct_value', FIX, NOW);
    expect(proposed.isError).toBe(false);
    expect(proposed.text).toMatch(/^PROPOSAL — nothing written yet\./);
    expect(proposed.text).toContain('WAIT for their own yes, in their own words');
    // A bare "yes" quoted alone was blocked live by ChatGPT's safety layer (2026-10-07); an approval naming the change passed.
    expect(proposed.text).toContain('not a bare “yes”');
    const data = OUTPUTS.correct_value.parse(proposed.structured);
    expect(data).toMatchObject({ proposal: true, correctsId: LDL_ID, value: 2.8, confirmFrom: at(PROPOSAL_NBF_SECONDS) });
    const receipt = data.confirm!;
    // UUID-shaped: ChatGPT read the old 400-character sealed blob as a disguised payload and blocked the confirm (2026-10-07).
    expect(receipt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(proposed.text).toContain(`confirm: ${receipt}`);
    expect(proposed.text).toContain('approval set to the user’s own words approving it, quoted exactly');
    expect(storedRecord().labValues).toHaveLength(1);
    expect(storedRecord().labValues[0].status).toBe('active');

    // 2. Chained straight after: not yet, and told not to spin.
    const early = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(2));
    expect(early.isError).toBe(true);
    expect(early.text).toContain(`can be used from ${at(PROPOSAL_NBF_SECONDS)}`);
    expect(early.text).toContain('end your turn');

    // 3. After the pause, but with the number changed under the user's yes.
    const altered = await callToolAt(access, 'correct_value', { ...FIX, newValue: 0.8, confirm: receipt, approval: APPROVED }, at(11));
    expect(altered.isError).toBe(true);
    expect(altered.text).toContain(NOT_OURS);

    // 4. Someone else's connection to the same client, holding the receipt.
    const foreign = await callToolAt(stranger, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11));
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain(NOT_OURS);

    // 5. Another tool, same receipt.
    const wrongTool = await callToolAt(access, 'update_profile', { heightCm: 170, expected: { heightCm: null }, confirm: receipt, approval: APPROVED }, at(11));
    expect(wrongTool.isError).toBe(true);
    expect(wrongTool.text).toContain(NOT_OURS);
    expect(storedRecord().labValues).toHaveLength(1);

    // 5b. The receipt without the user's words (ChatGPT blocked exactly this call, 2026-10-07): refused before the
    //     receipt is checked, so it is not spent, and not charged — step 8's count of eleven proves it.
    for (const approval of [undefined, '', '   ']) {
      const unquoted = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, ...(approval === undefined ? null : { approval }) }, at(11));
      expect(unquoted.isError, JSON.stringify(approval)).toBe(true);
      expect(unquoted.text, JSON.stringify(approval)).toBe(QUOTE_APPROVAL('correct_value'));
    }
    expect(storedRecord().labValues).toHaveLength(1);

    // 6. The honest path: same arguments, same connection, after the pause, quoting the user. Written once.
    const written = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11));
    expect(written.isError).toBe(false);
    expect(written.text).toContain('Saved to the user’s Dropbox');
    expect(OUTPUTS.correct_value.parse(written.structured).proposal).toBeUndefined();
    expect(storedRecord().labValues).toHaveLength(2);
    expect(storedRecord().labValues.find((m) => m.id === LDL_ID)!.status).toBe('entered-in-error');

    // 7. Replayed: refused, and nothing else changes.
    const replay = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(12));
    expect(replay.isError).toBe(true);
    expect(replay.text).toContain('already been used');
    expect(storedRecord().labValues).toHaveLength(2);

    // 8. The proposal was charged (a correction's five); the confirm was not. Eleven
    //    more charged proposals fit in the hour; the twelfth meets the allowance.
    const newRow = storedRecord().labValues.find((m) => m.correctsId === LDL_ID)!;
    for (let i = 0; i < WRITES_PER_HOUR / WRITE_COST.correct - 1; i++) {
      const wrong = await callToolAt(access, 'correct_value', { id: newRow.id, newValue: 2.7, expectedValue: 9.9 }, at(13));
      expect(wrong.isError, `guess ${i}`).toBe(true);
      expect(wrong.text, `guess ${i}`).not.toContain('allowance');
    }
    const spent = await callToolAt(access, 'correct_value', { id: newRow.id, newValue: 2.7, expectedValue: 2.8 }, at(13));
    expect(spent.isError).toBe(true);
    expect(spent.text).toContain('allowance');
  });

  it('US-36 AC9 (2026-10-07) — the quoted approval is not part of the call’s identity, is capped at 200 characters, and is never echoed', async () => {
    seedWithLdl();
    const access = await connect();
    // Words on the proposal are stripped like confirm: the receipt names the arguments alone.
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', { ...FIX, approval: 'Sure, propose it' }, NOW)).structured).confirm!;
    const long = 'Yes '.repeat(51);
    const tooLong = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: long }, at(11));
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toBe('approval is at most 200 characters: quote only the user’s own words approving this change. Nothing was written.');
    const notText = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: 5 }, at(11));
    expect(notText.text).toBe(QUOTE_APPROVAL('correct_value'));
    // "Not valid yet", not "not ours": the MAC matched with these words, so they are outside the identity.
    const early = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: 'OK do it' }, at(2));
    expect(early.text).toContain(`can be used from ${at(PROPOSAL_NBF_SECONDS)}`);
    expect(storedRecord().labValues).toHaveLength(1);
    // Different words again, and the same receipt writes: none of the refusals above spent it.
    const words = 'Yes, correct it zq7-approval-marker';
    const written = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: words }, at(11));
    expect(written.isError).toBe(false);
    expect(written.text).not.toContain('zq7-approval-marker');
    expect(storedRecord().labValues).toHaveLength(2);
    // Held for the one request only: nothing in the user's folder carries the words.
    for (const [name, stored] of cloud.files) expect(stored.json, name).not.toContain('zq7-approval-marker');
  });

  it('US-36 AC9 (2026-10-07, adversarial review R1) — a chained confirm with no words is told to wait, not to quote; the receipt then works with the words', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    // The window is checked before the words: an assistant chaining the second call is sent back to the user.
    const chained = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt }, at(2));
    expect(chained.isError).toBe(true);
    expect(chained.text).toBe(`That confirm receipt is not valid yet: it can be used from ${at(PROPOSAL_NBF_SECONDS)}, after the user has answered. Do not retry before then; end your turn. Nothing was written.`);
    expect(storedRecord().labValues).toHaveLength(1);
    const written = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11));
    expect(written.isError).toBe(false);
    expect(storedRecord().labValues).toHaveLength(2);
  });

  it('a receipt expires at fifteen minutes, and an expectedValue mismatch is refused before any receipt exists, without the stored value', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    const late = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(PROPOSAL_LIFETIME_SECONDS + 1));
    expect(late.isError).toBe(true);
    expect(late.text).toContain('has expired');
    expect(storedRecord().labValues).toHaveLength(1);

    const guessed = await callToolAt(access, 'correct_value', { ...FIX, expectedValue: 9.9 }, NOW);
    expect(guessed.isError).toBe(true);
    expect(guessed.structured).toBeUndefined();
    expect(guessed.text).not.toContain(String(STORED_LDL));
  });

  it('update_profile: a change proposes and confirms; a no-op has nothing to confirm', async () => {
    seedEmpty();
    const access = await connect();
    const proposed = await callToolAt(access, 'update_profile', { heightCm: 178, expected: { heightCm: null } }, NOW);
    expect(proposed.isError).toBe(false);
    const data = OUTPUTS.update_profile.parse(proposed.structured);
    expect(data.changed).toEqual([{ field: 'heightCm', from: null, to: 178 }]);
    expect(storedRecord().profile.heightCm).toBeUndefined();
    // The receipt's identity is key-order-free at every depth: the same arguments re-emitted with `expected` reordered still confirm.
    const reordered = await callToolAt(access, 'update_profile', { expected: { sex: null, heightCm: null }, heightCm: 178, sex: 'male' }, NOW);
    expect(reordered.isError).toBe(false);
    const receipt = OUTPUTS.update_profile.parse(reordered.structured).confirm!;
    expect(receipt).not.toBe(data.confirm);
    const done = await callToolAt(access, 'update_profile', { heightCm: 178, sex: 'male', expected: { heightCm: null, sex: null }, confirm: receipt, approval: APPROVED }, at(11));
    expect(done.isError).toBe(false);
    expect(storedRecord().profile.heightCm).toBe(178);
    // The first receipt names other arguments (no `sex`), so it does not confirm this call.
    const other = await callToolAt(access, 'update_profile', { heightCm: 178, sex: 'male', expected: { heightCm: null, sex: null }, confirm: data.confirm, approval: APPROVED }, at(11));
    expect(other.text).toContain(NOT_OURS);

    const same = await callToolAt(access, 'update_profile', { heightCm: 178, expected: { heightCm: 178 } }, at(12));
    expect(same.isError).toBe(false);
    expect(same.text).toContain('already says that');
    expect(OUTPUTS.update_profile.parse(same.structured).confirm).toBeUndefined();
  });

  it('report_feedback: the receipt is bound to the prepared text, so spacing and case drift confirm and a different report does not', async () => {
    seedEmpty();
    // While the repository is hidden only a surface that can file may propose (US-32 AC39), so this
    // one gets a GitHub token and a GitHub that files; while public it stays tokenless.
    if (!REPO_PUBLIC) {
      process.env.GITHUB_ISSUES_TOKEN = 'ghp-test-token';
      const passThrough = fetch;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (String(url).startsWith('https://api.github.com/')
        ? Response.json({ html_url: 'https://github.com/DrBradStanfield/roadmap/issues/5', number: 5 }, { status: 201 })
        : passThrough(url, init))));
    }
    try {
      const access = await connect();
      const report = { kind: 'bug', title: 'Tool refused a valid day', detail: 'Steps  here.\nThen it refused.' };
      const proposed = await callToolAt(access, 'report_feedback', report, NOW);
      expect(proposed.isError).toBe(false);
      // US-32 AC39: the proposal calls the issue public only while the repository is.
      expect(proposed.text).toContain(REPO_PUBLIC
        ? 'Would file a PUBLIC GitHub issue'
        : 'an issue on the project’s GitHub, which is temporarily not public and becomes public when it is');
      expect(proposed.text.includes('PUBLIC GitHub issue')).toBe(REPO_PUBLIC);
      // The receipt is the one human review step, so it shows the DETAIL that
      // goes public — not the title alone, which hides what is filed.
      expect(proposed.text).toContain(report.detail); // exactly the text sent, spacing and all
      expect(proposed.text).not.toContain('github.com/DrBradStanfield/roadmap/issues/new'); // the proposal is not a link to submit
      const data = OUTPUTS.report_feedback.parse(proposed.structured);
      expect(data).toMatchObject({ filed: false, proposal: true });
      // US-32 AC39: no structured link on a proposal, public or hidden: the confirm files it.
      expect(data.url).toBe('');

      const other = await callToolAt(access, 'report_feedback', { ...report, detail: 'Something else entirely.', confirm: data.confirm, approval: APPROVED }, at(11));
      expect(other.isError).toBe(true);
      expect(other.text).toContain(NOT_OURS);

      const drifted = await callToolAt(access, 'report_feedback', { ...report, title: 'tool refused a valid day', detail: 'steps here. then it refused.', confirm: data.confirm, approval: APPROVED }, at(11));
      // Either way the receipt held. Tokenless while public: the confirmed call answers with the link the
      // user submits. With the token while hidden: it files, and hands over the number, not a link that 404s.
      expect(drifted.isError).toBe(false);
      const filed = OUTPUTS.report_feedback.parse(drifted.structured);
      expect(filed.proposal).toBeUndefined();
      if (REPO_PUBLIC) {
        expect(filed.filed).toBe(false);
        expect(drifted.text).toContain('github.com');
      } else {
        expect(filed).toMatchObject({ filed: true, url: '', number: 5 });
      }

      // A confirm call that does not even parse (no detail) is refused in words, never answered as an
      // internal error: the receipt's identity is computed before the schema runs (adversarial review 2026-09-07).
      seedEmpty();
      const fresh = OUTPUTS.report_feedback.parse((await callToolAt(access, 'report_feedback', report, at(20))).structured).confirm!;
      const malformed = await callToolAt(access, 'report_feedback', { kind: 'bug', title: report.title, confirm: fresh, approval: APPROVED }, at(31));
      expect(malformed.isError).toBe(true);
      expect(malformed.text).toContain(NOT_OURS);
    } finally {
      delete process.env.GITHUB_ISSUES_TOKEN;
    }
  });

  it('a stale receipt against the tool list: `confirm` is published on exactly the three permanent tools', async () => {
    seedEmpty();
    const listed = await rpc(await connect(), 'tools/list');
    const withConfirm = (listed.result!.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>)
      .filter((t) => 'confirm' in t.inputSchema.properties).map((t) => t.name);
    expect(withConfirm).toEqual(['correct_value', 'update_profile', 'report_feedback']);
  });
});

describe('US-36 AC9 — a confirm works once across restarts', () => {
  const FIX = { id: LDL_ID, newValue: 2.8, expectedValue: STORED_LDL };
  afterEach(() => {
    delete process.env.GITHUB_ISSUES_TOKEN;
  });

  /** A GitHub that files, counted. */
  function stubGithub(): { filed: number } {
    process.env.GITHUB_ISSUES_TOKEN = 'test-token-good';
    const count = { filed: 0 };
    const passThrough = fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith('https://api.github.com/')) return passThrough(url, init);
      count.filed++;
      return Response.json({ html_url: 'https://github.com/DrBradStanfield/roadmap/issues/7', number: 7 }, { status: 201 });
    }));
    return count;
  }

  it('a confirm resent after a memory reset is refused as already used, and nothing is written or filed again', async () => {
    seedWithLdl();
    const access = await connect();
    const github = stubGithub();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    expect((await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11))).isError).toBe(false);
    const version = cloud.files.get(ROADMAP_FILE_NAME)!.version;
    resetMcpMemory();
    const again = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(12));
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already been used');
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(version);
    expect(storedRecord().labValues).toHaveLength(2);

    const report = { kind: 'bug', title: 'Tool refused a valid day', detail: 'Steps here.' };
    const filing = OUTPUTS.report_feedback.parse((await callToolAt(access, 'report_feedback', report, at(20))).structured).confirm!;
    expect((await callToolAt(access, 'report_feedback', { ...report, confirm: filing, approval: APPROVED }, at(31))).isError).toBe(false);
    expect(github.filed).toBe(1);
    resetMcpMemory();
    const refiled = await callToolAt(access, 'report_feedback', { ...report, confirm: filing, approval: APPROVED }, at(32));
    expect(refiled.isError).toBe(true);
    expect(refiled.text).toContain('already been used');
    expect(github.filed).toBe(1);
  });

  it('an update_profile confirm resent after the stored value was set back writes nothing', async () => {
    seedEmpty();
    const record = storedRecord();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify({ ...record, profile: { ...record.profile, heightCm: 170 } }), version: 2 });
    const access = await connect();
    const args = { heightCm: 180, expected: { heightCm: 170 } };
    const receipt = OUTPUTS.update_profile.parse((await callToolAt(access, 'update_profile', args, NOW)).structured).confirm!;
    expect((await callToolAt(access, 'update_profile', { ...args, confirm: receipt, approval: APPROVED }, at(11))).isError).toBe(false);
    expect(storedRecord().profile.heightCm).toBe(180);
    const changed = storedRecord();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify({ ...changed, profile: { ...changed.profile, heightCm: 170 } }), version: 9 });
    resetMcpMemory();
    const again = await callToolAt(access, 'update_profile', { ...args, confirm: receipt, approval: APPROVED }, at(12));
    expect(again.isError).toBe(true);
    expect(again.text).toContain('already been used');
    expect(storedRecord().profile.heightCm).toBe(170);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(9);
  });

  it('two server instances over one claim store: the second confirm is refused', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    expect((await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11))).isError).toBe(false);
    vi.resetModules();
    const second = await import('../lib/mcp.server');
    second.setAdapterFactory(() => new MemoryAdapter(cloud));
    try {
      const res = await second.mcpEndpoint(new Request(`${ISSUER}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'correct_value', arguments: { ...FIX, confirm: receipt, approval: APPROVED } } }),
      }), at(12));
      const answer = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      expect(answer.result.isError).toBe(true);
      expect(answer.result.content[0].text).toContain('already been used');
      expect(storedRecord().labValues).toHaveLength(2);
    } finally {
      second.setAdapterFactory(null);
    }
  });

  it('while the claim store cannot be reached a confirm is refused in words, writes nothing and charges nothing', async () => {
    const Sentry = await import('@sentry/react-router');
    vi.mocked(Sentry.captureMessage).mockClear();
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    for (const down of ['throw', 'error'] as const) {
      claims.state!.down = down;
      const refused = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11));
      expect(refused.isError, down).toBe(true);
      expect(refused.text, down).toBe(CLAIM_UNCHECKED);
      expect(storedRecord().labValues, down).toHaveLength(1);
      expect(cloud.files.get(ROADMAP_FILE_NAME)!.version, down).toBe(1);
    }
    // Fixed words and a fixed tag: nothing that names the receipt, the connection or the client.
    expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
      ['mcp_confirm: claim store unavailable', { level: 'warning', tags: { feature: 'mcp_confirm' } }],
      ['mcp_confirm: claim store unavailable', { level: 'warning', tags: { feature: 'mcp_confirm' } }],
    ]);

    claims.state!.down = false;
    const written = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(12));
    expect(written.isError).toBe(false);
    expect(storedRecord().labValues).toHaveLength(2);

    // Only the proposal was charged: eleven more charged proposals fit in the hour; the twelfth meets the allowance.
    const newRow = storedRecord().labValues.find((m) => m.correctsId === LDL_ID)!;
    for (let i = 0; i < WRITES_PER_HOUR / WRITE_COST.correct - 1; i++) {
      const wrong = await callToolAt(access, 'correct_value', { id: newRow.id, newValue: 2.7, expectedValue: 9.9 }, at(13));
      expect(wrong.text, `guess ${i}`).not.toContain('allowance');
    }
    const spent = await callToolAt(access, 'correct_value', { id: newRow.id, newValue: 2.7, expectedValue: 2.8 }, at(13));
    expect(spent.text).toContain('allowance');
  });

  it('a claim the store kept but whose answer was lost: the retry is refused as already used, and nothing is written', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    claims.state!.down = 'commit-then-throw';
    const lost = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11));
    expect(lost.text).toBe(CLAIM_UNCHECKED);
    claims.state!.down = false;
    // This machine forgot the key before refusing, so the retry asks the store, which answers.
    const retry = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(12));
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain('already been used');
    expect(claims.state!.inserts).toBe(2);
    expect(storedRecord().labValues).toHaveLength(1);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(1);
  });

  it('a claim the store did not keep: the retry claims and writes once, and a resend after that is refused from memory', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    claims.state!.down = 'throw';
    expect((await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11))).text).toBe(CLAIM_UNCHECKED);
    claims.state!.down = false;
    expect((await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(12))).isError).toBe(false);
    expect(storedRecord().labValues).toHaveLength(2);
    expect(claims.state!.inserts).toBe(2);
    // A claim the store accepted stays in this machine's map: the resend never reaches the store.
    const resend = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(13));
    expect(resend.text).toContain('already been used');
    expect(claims.state!.inserts).toBe(2);
    expect(storedRecord().labValues).toHaveLength(2);
  });

  it('with no claim store configured a confirm is refused in words and nothing is written', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    claims.noClient = true;
    const refused = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, approval: APPROVED }, at(11));
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(CLAIM_UNCHECKED);
    expect(storedRecord().labValues).toHaveLength(1);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(1);
  });
});

describe('US-36 AC9 (H59) — a refused confirm names its kind on the counter row, and its words do not change', () => {
  const FIX = { id: LDL_ID, newValue: 2.8, expectedValue: STORED_LDL };
  const refusedConfirms = () => vi.mocked(recordServerEvent).mock.calls
    .filter(([name, meta]) => name === 'mcp_tool_call' && (meta as { outcome?: string }).outcome === 'refused')
    .map(([, meta]) => meta);

  it('each of the six refusals records its own confirmReason beside reason confirm, and nothing else', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    vi.mocked(recordServerEvent).mockClear();
    const confirm = (args: Record<string, unknown>, now: string) => callToolAt(access, 'correct_value', { ...FIX, confirm: receipt, ...args }, now);

    const early = await confirm({ approval: APPROVED }, at(2));
    expect(early.text).toBe(`That confirm receipt is not valid yet: it can be used from ${at(PROPOSAL_NBF_SECONDS)}, after the user has answered. Do not retry before then; end your turn. Nothing was written.`);
    const invalid = await confirm({ newValue: 0.8, approval: APPROVED }, at(11));
    expect(invalid.text).toBe('That confirm receipt does not match these arguments on this connection, or is not ours. Nothing was written. Call correct_value again without confirm, with exactly what the user approved, to propose afresh.');
    expect((await confirm({}, at(11))).text).toBe(QUOTE_APPROVAL('correct_value'));
    expect((await confirm({ approval: 'Yes '.repeat(51) }, at(11))).text).toBe('approval is at most 200 characters: quote only the user’s own words approving this change. Nothing was written.');
    claims.state!.down = 'error';
    expect((await confirm({ approval: APPROVED }, at(11))).text).toBe(CLAIM_UNCHECKED);
    claims.state!.down = false;
    expect((await confirm({ approval: APPROVED }, at(12))).isError).toBe(false);
    const spent = await confirm({ approval: APPROVED }, at(13));
    expect(spent.text).toBe('That confirm receipt has already been used. Nothing was written. If the user wants another change, call correct_value again without confirm.');
    // A fresh proposal on the corrected row, let lapse.
    const newRow = storedRecord().labValues.find((m) => m.correctsId === LDL_ID)!;
    const next = { id: newRow.id, newValue: 2.7, expectedValue: 2.8 };
    const lapsing = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', next, at(14))).structured).confirm!;
    const expired = await callToolAt(access, 'correct_value', { ...next, confirm: lapsing, approval: APPROVED }, at(14 + PROPOSAL_LIFETIME_SECONDS + 1));
    expect(expired.text).toBe('That confirm receipt has expired (15 minutes). Nothing was written. Call correct_value again without confirm to propose afresh.');

    const row = (confirmReason: string) => ({ tool: 'correct_value', client: expect.any(String), outcome: 'refused', reason: 'confirm', confirmReason, step: 'confirm' });
    expect(refusedConfirms()).toEqual([
      row('confirm-early'), row('confirm-invalid'), row('confirm-approval'), row('confirm-approval'),
      row('confirm-unavailable'), row('confirm-spent'), row('confirm-expired'),
    ]);
    // Content-free: no receipt, argument or quoted word reaches a row.
    const rows = JSON.stringify(vi.mocked(recordServerEvent).mock.calls);
    for (const leak of [receipt, lapsing, newRow.id, LDL_ID, APPROVED, '2.8', '0.8']) expect(rows).not.toContain(leak);
  });

  it('a refusal other than a confirm carries no confirmReason', async () => {
    seedWithLdl();
    const access = await connect();
    vi.mocked(recordServerEvent).mockClear();
    expect((await callToolAt(access, 'correct_value', { ...FIX, expectedValue: 9.9 }, NOW)).isError).toBe(true);
    expect(refusedConfirms()).toEqual([{ tool: 'correct_value', client: expect.any(String), outcome: 'refused', reason: 'value-changed', step: 'propose' }]);
  });
});

/**
 * The consent screen is the only moment the user decides, so it may not be
 * framed and it may not present a self-chosen name as a credential. `client_name`
 * comes from whoever registered; the honest line beside it says what we can
 * actually check — a pin, the host that published the metadata, or the place
 * the code is sent back to.
 */
describe('the consent screen cannot be framed and names its own trust (US-32)', () => {
  const CLAUDE_CIMD = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

  function authorize(clientId: string, redirect: string): Promise<Response> {
    return get(`/mcp/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: 'code',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    })}`);
  }

  async function register(name: string, redirect: string): Promise<string> {
    const res = await post('/mcp/register', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).client_id as string;
  }

  it('refuses framing, in the CSP and in X-Frame-Options', async () => {
    const consent = await authorize(CLAUDE_CIMD, REDIRECT);
    expect(consent.status).toBe(200);
    // `default-src 'none'` does NOT cover framing: only frame-ancestors does.
    expect(consent.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(consent.headers.get('x-frame-options')).toBe('DENY');
  });

  it('says a pinned vendor client is a known client', async () => {
    const screen = await (await authorize(CLAUDE_CIMD, REDIRECT)).text();
    expect(screen).toContain('Claude');
    expect(screen).toContain('a known client');
    expect(screen).not.toContain('returns you to');
  });

  it('says where a self-registered client sends you back', async () => {
    const clientId = await register('Handy Assistant', REDIRECT);
    const screen = await (await authorize(clientId, REDIRECT)).text();
    expect(screen).toContain('Handy Assistant');
    expect(screen).toContain('returns you to claude.ai');
    expect(screen).not.toContain('a known client');
  });

  it('says a loopback client is a program on this computer', async () => {
    const clientId = await register('Some CLI', 'http://127.0.0.1:12345/callback');
    const screen = await (await authorize(clientId, 'http://127.0.0.1:54321/callback')).text();
    expect(screen).toContain('a program on this computer');
    expect(screen).not.toContain('a known client');
  });

  it('names the host that published an unpinned CIMD document', async () => {
    const clientId = 'https://assistant.example.test/oauth/client.json';
    serveClientMetadata({ [clientId]: {
      client_id: clientId,
      client_name: 'Example Assistant',
      redirect_uris: [REDIRECT],
    } });
    const screen = await (await authorize(clientId, REDIRECT)).text();
    expect(screen).toContain('registered at assistant.example.test');
    expect(screen).not.toContain('a known client');
  });

  it('never lets a registrant’s name reach the page as markup', async () => {
    const clientId = await register('<script>alert(1)</script>', REDIRECT);
    const screen = await (await authorize(clientId, REDIRECT)).text();
    expect(screen).not.toContain('<script>alert(1)</script>');
    expect(screen).toContain('&#60;script&#62;');
  });
});
