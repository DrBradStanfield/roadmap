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

vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] } }));
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { resetMcpMemory } from '../lib/mcp-grants.server';
import { MAX_LAB_ROWS_PER_CALL } from '../../packages/health-core/src/mcp-tools';
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
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 3).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  resetMcpMemory();
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
    measurements: [createMeasurement({
      id: LDL_ID, metricType: 'ldl', value: STORED_LDL, recordedAt, createdAt: recordedAt,
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
    expect(storedRecord().measurements.find((m) => m.id === LDL_ID)!.status).toBe('active');
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
import { PROPOSAL_LIFETIME_SECONDS, PROPOSAL_NBF_SECONDS } from '../lib/mcp.server';
import { WRITE_COST, WRITES_PER_HOUR } from '../lib/mcp-grants.server';

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
    expect(proposed.text).toContain('WAIT for their own yes');
    const data = OUTPUTS.correct_value.parse(proposed.structured);
    expect(data).toMatchObject({ proposal: true, correctsId: LDL_ID, value: 2.8, confirmFrom: at(PROPOSAL_NBF_SECONDS) });
    const receipt = data.confirm!;
    expect(storedRecord().measurements).toHaveLength(1);
    expect(storedRecord().measurements[0].status).toBe('active');

    // 2. Chained straight after: not yet, and told not to spin.
    const early = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt }, at(2));
    expect(early.isError).toBe(true);
    expect(early.text).toContain(`can be used from ${at(PROPOSAL_NBF_SECONDS)}`);
    expect(early.text).toContain('end your turn');

    // 3. After the pause, but with the number changed under the user's yes.
    const altered = await callToolAt(access, 'correct_value', { ...FIX, newValue: 0.8, confirm: receipt }, at(11));
    expect(altered.isError).toBe(true);
    expect(altered.text).toContain('different arguments');

    // 4. Someone else's connection to the same client, holding the receipt.
    const foreign = await callToolAt(stranger, 'correct_value', { ...FIX, confirm: receipt }, at(11));
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('not valid for this connection');

    // 5. Another tool, same receipt.
    const wrongTool = await callToolAt(access, 'update_profile', { heightCm: 170, expected: { heightCm: null }, confirm: receipt }, at(11));
    expect(wrongTool.isError).toBe(true);
    expect(wrongTool.text).toContain('different arguments');
    expect(storedRecord().measurements).toHaveLength(1);

    // 6. The honest path: same arguments, same connection, after the pause. Written once.
    const written = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt }, at(11));
    expect(written.isError).toBe(false);
    expect(written.text).toContain('Saved to the user’s Dropbox');
    expect(OUTPUTS.correct_value.parse(written.structured).proposal).toBeUndefined();
    expect(storedRecord().measurements).toHaveLength(2);
    expect(storedRecord().measurements.find((m) => m.id === LDL_ID)!.status).toBe('entered-in-error');

    // 7. Replayed: refused, and nothing else changes.
    const replay = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt }, at(12));
    expect(replay.isError).toBe(true);
    expect(replay.text).toContain('already been used');
    expect(storedRecord().measurements).toHaveLength(2);

    // 8. The proposal was charged (a correction's five); the confirm was not. Eleven
    //    more charged proposals fit in the hour; the twelfth meets the allowance.
    const newRow = storedRecord().measurements.find((m) => m.correctsId === LDL_ID)!;
    for (let i = 0; i < WRITES_PER_HOUR / WRITE_COST.correct - 1; i++) {
      const wrong = await callToolAt(access, 'correct_value', { id: newRow.id, newValue: 2.7, expectedValue: 9.9 }, at(13));
      expect(wrong.isError, `guess ${i}`).toBe(true);
      expect(wrong.text, `guess ${i}`).not.toContain('allowance');
    }
    const spent = await callToolAt(access, 'correct_value', { id: newRow.id, newValue: 2.7, expectedValue: 2.8 }, at(13));
    expect(spent.isError).toBe(true);
    expect(spent.text).toContain('allowance');
  });

  it('a receipt expires at fifteen minutes, and an expectedValue mismatch is refused before any receipt exists, without the stored value', async () => {
    seedWithLdl();
    const access = await connect();
    const receipt = OUTPUTS.correct_value.parse((await callToolAt(access, 'correct_value', FIX, NOW)).structured).confirm!;
    const late = await callToolAt(access, 'correct_value', { ...FIX, confirm: receipt }, at(PROPOSAL_LIFETIME_SECONDS + 1));
    expect(late.isError).toBe(true);
    expect(late.text).toContain('has expired');
    expect(storedRecord().measurements).toHaveLength(1);

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
    const done = await callToolAt(access, 'update_profile', { heightCm: 178, expected: { heightCm: null }, confirm: data.confirm }, at(11));
    expect(done.isError).toBe(false);
    expect(storedRecord().profile.heightCm).toBe(178);

    const same = await callToolAt(access, 'update_profile', { heightCm: 178, expected: { heightCm: 178 } }, at(12));
    expect(same.isError).toBe(false);
    expect(same.text).toContain('already says that');
    expect(OUTPUTS.update_profile.parse(same.structured).confirm).toBeUndefined();
  });

  it('report_feedback: the receipt is bound to the prepared text, so spacing and case drift confirm and a different report does not', async () => {
    seedEmpty();
    const access = await connect();
    const report = { kind: 'bug', title: 'Tool refused a valid day', detail: 'Steps  here.\nThen it refused.' };
    const proposed = await callToolAt(access, 'report_feedback', report, NOW);
    expect(proposed.isError).toBe(false);
    expect(proposed.text).toContain('Would file a PUBLIC GitHub issue');
    expect(proposed.text).not.toContain('github.com/DrBradStanfield/roadmap/issues/new'); // the proposal is not a link to submit
    const data = OUTPUTS.report_feedback.parse(proposed.structured);
    expect(data).toMatchObject({ filed: false, proposal: true });

    const other = await callToolAt(access, 'report_feedback', { ...report, detail: 'Something else entirely.', confirm: data.confirm }, at(11));
    expect(other.isError).toBe(true);
    expect(other.text).toContain('different arguments');

    const drifted = await callToolAt(access, 'report_feedback', { ...report, title: 'tool refused a valid day', detail: 'steps here. then it refused.', confirm: data.confirm }, at(11));
    expect(drifted.isError).toBe(false);
    // No GitHub token in this suite: the confirmed call answers with the link the user submits.
    const filed = OUTPUTS.report_feedback.parse(drifted.structured);
    expect(filed.filed).toBe(false);
    expect(filed.proposal).toBeUndefined();
    expect(drifted.text).toContain('github.com');
  });

  it('a stale receipt against the tool list: `confirm` is published on exactly the three permanent tools', async () => {
    seedEmpty();
    const listed = await rpc(await connect(), 'tools/list');
    const withConfirm = (listed.result!.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>)
      .filter((t) => 'confirm' in t.inputSchema.properties).map((t) => t.name);
    expect(withConfirm).toEqual(['correct_value', 'update_profile', 'report_feedback']);
  });
});
