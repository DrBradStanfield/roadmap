/**
 * US-41 AC6–AC12 · search_knowledge and get_article on the hosted connector,
 * behind MCP_KNOWLEDGE_TOOLS.
 *
 * Real Requests through the route's own loader/action, as in
 * `mcp.hosted-guards.test.ts`, against the real knowledge base on disk (the
 * suite runs from the repo root). `fetch` is stubbed for the OAuth dance and
 * then cleared: a knowledge call that reached the network would show here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { serveClientMetadata } from '../lib/mcp-cimd.test-helpers';
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';
import { resetMcpMemory } from '../lib/mcp-grants.server';
import { INSTRUCTIONS, mcpEndpoint, setAdapterFactory } from '../lib/mcp.server';
import { callKnowledgeTool, cutEntry, isServed, KNOWLEDGE_NOTE, KNOWLEDGE_TOOLS, MAX_ARTICLE_CHARS, MAX_EXCERPT_CHARS, MAX_MASTER_EXCERPT_CHARS, MAX_RESULTS, NOTICE, safetyBlocks } from '../lib/mcp-knowledge.server';
import { loadBlogIndex } from '../lib/blog-index.server';
import { parseFrontmatter } from '../lib/frontmatter';
import { recordServerEvent } from '../lib/product-events.server';
import { action, loader } from './mcp.$';

vi.mock('../lib/product-events.server', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/product-events.server')>();
  return { ...original, recordServerEvent: vi.fn(async () => {}) };
});

const ISSUER = 'https://mcp.example.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const NOW = '2026-10-21T10:00:00.000Z';

/**
 * sha256 of the hosted `tools/list` response body for request id 1, taken at
 * b625b92f before these tools existed. Off, the body must still be these bytes.
 */
const TOOLS_LIST_SHA256_BEFORE = '9650e0d7f4d34c6a68e1008130376bb97e70624404e02bcea389617c701a8eaf';

const NINE_TOOLS = [
  'read_record', 'get_plan', 'add_measurement', 'add_lab_values',
  'correct_value', 'update_profile', 'report_feedback', 'import_documents', 'file_results',
];

const MAGNESIUM = 'magnesium-benefits-best-forms-dosing';
const OMEGA3 = 'omega-3-fish-oil-benefits-forms-dosing-and-side-effects';
const VITAMIN_D = 'vitamin-d-benefits-forms-dosing-and-side-effects';
const B_VITAMINS = 'b-vitamins-benefits-forms-dosing-and-side-effects';

let fetchMock: ReturnType<typeof vi.fn>;
let connections = 0;

beforeEach(() => {
  serveClientMetadata();
  process.env.MCP_ISSUER = ISSUER;
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 3).toString('base64');
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DROPBOX_APP_KEY = 'app-key';
  process.env.DROPBOX_APP_SECRET = 'app-secret';
  delete process.env.MCP_KNOWLEDGE_TOOLS;
  resetMcpMemory();
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(createEmptyFile({ deviceId: 'phone', now: '2026-01-01T00:00:00.000Z' })), version: 1 });
  setAdapterFactory(() => new MemoryAdapter(cloud));
  fetchMock = vi.fn(async () => Response.json({
    refresh_token: `dropbox-refresh-token-${++connections}`,
    access_token: 'dropbox-access-token',
    expires_in: 14400,
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setAdapterFactory(null);
  vi.unstubAllGlobals();
  delete process.env.MCP_SEAL_KEYS;
  delete process.env.MCP_KNOWLEDGE_TOOLS;
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

/** A connection's access token, then the fetch stub cleared so only tool calls count. */
async function connect(): Promise<string> {
  const register = await post('/mcp/register', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
  });
  const clientId = (await register.json()).client_id as string;
  const consent = await get(`/mcp/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
    state: 'client-state', resource: `${ISSUER}/mcp`,
  })}`);
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
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: VERIFIER, client_id: clientId }),
  });
  expect(tokens.status).toBe(200);
  const access = (await tokens.json()).access_token as string;
  fetchMock.mockClear();
  vi.mocked(recordServerEvent).mockClear();
  return access;
}

async function rawRpc(access: string, method: string, params: unknown = {}): Promise<string> {
  const res = await mcpEndpoint(new Request(`${ISSUER}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), NOW);
  expect(res.status).toBe(200);
  return res.text();
}

interface Result {
  content: Array<{ text: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
  tools?: Array<{ name: string }>;
  instructions?: string;
}

async function rpc(access: string, method: string, params: unknown = {}): Promise<Result> {
  return JSON.parse(await rawRpc(access, method, params)).result as Result;
}

const call = (access: string, name: string, args: unknown) => rpc(access, 'tools/call', { name, arguments: args });

describe('US-41 AC6 — off by default, and off is byte-identical', () => {
  it.each([undefined, '', 'true', 'ON', '1', 'yes'])('MCP_KNOWLEDGE_TOOLS=%s: tools/list is the bytes it was before', async (value) => {
    if (value !== undefined) process.env.MCP_KNOWLEDGE_TOOLS = value;
    const body = await rawRpc(await connect(), 'tools/list');
    expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(TOOLS_LIST_SHA256_BEFORE);
  });

  it('off: initialize carries the frozen instructions, and a knowledge call is an unknown tool, uncounted', async () => {
    const access = await connect();
    expect((await rpc(access, 'initialize', { protocolVersion: '2025-11-25' })).instructions).toBe(INSTRUCTIONS);
    const answer = await call(access, 'search_knowledge', { query: 'magnesium sleep' });
    expect(answer.isError).toBe(true);
    expect(answer.content[0].text).toBe('No tool named search_knowledge.');
    expect(vi.mocked(recordServerEvent)).not.toHaveBeenCalled();
  });
});

describe('US-41 AC6 — on, the two tools are listed after the nine', () => {
  beforeEach(() => { process.env.MCP_KNOWLEDGE_TOOLS = 'on'; });

  it('lists the nine, unchanged, then search_knowledge and get_article', async () => {
    const access = await connect();
    const tools = (await rpc(access, 'tools/list')).tools!;
    expect(tools.map((t) => t.name)).toEqual([...NINE_TOOLS, 'search_knowledge', 'get_article']);
    delete process.env.MCP_KNOWLEDGE_TOOLS;
    const before = (await rpc(access, 'tools/list')).tools!;
    expect(tools.slice(0, 9)).toEqual(before);
    expect(JSON.stringify(tools)).not.toMatch(/"cost"/);
  });

  it('initialize says what the two tools are, after the frozen instructions', async () => {
    const instructions = (await rpc(await connect(), 'initialize', { protocolVersion: '2025-11-25' })).instructions;
    expect(instructions).toBe(INSTRUCTIONS + KNOWLEDGE_NOTE);
  });

  it('carries the chatbot rules in both descriptions, with no em dash anywhere a user reads (AC10)', () => {
    for (const tool of KNOWLEDGE_TOOLS) {
      expect(tool.description).toContain('not personalised medical advice');
      expect(tool.description).toContain('doctor or pharmacist');
      expect(tool.description).toContain('emergency');
      expect(tool.description).toContain('Current view');
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    expect(JSON.stringify([KNOWLEDGE_TOOLS, NOTICE, KNOWLEDGE_NOTE])).not.toContain('—');
    // Every result and refusal carries the emergency line (orchestrator, review round 1).
    expect(NOTICE.endsWith(' If this could be an emergency, such as chest pain, stroke signs or trouble breathing, call your local emergency number now.')).toBe(true);
  });
});

describe('US-41 AC7 — search_knowledge: masters first, capped, the notice on every result', () => {
  beforeEach(() => { process.env.MCP_KNOWLEDGE_TOOLS = 'on'; });

  it('puts the topic master first when the query names its topic', async () => {
    const access = await connect();
    for (const [query, master] of [['magnesium for sleep', MAGNESIUM], ['fish oil atrial fibrillation', OMEGA3], ['omega-3 dose', OMEGA3], ['is vitamin d safe with warfarin', VITAMIN_D]] as const) {
      const results = (await call(access, 'search_knowledge', { query })).structuredContent!.results as Array<Record<string, any>>;
      expect(results[0], query).toMatchObject({ handle: master, master: true, type: 'reference' });
      expect(results[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A master's excerpt is its Current view.
      expect(results[0].excerpt).toMatch(/^## Current (view|evidence position)/);
    }
  });

  it('does not promote a master on the words every master shares, or on generic ones (adversary R4)', async () => {
    const access = await connect();
    const results = (await call(access, 'search_knowledge', { query: 'benefits of exercise' })).structuredContent!.results as Array<Record<string, any>>;
    expect(results[0].master).toBe(false);
    const olive = (await call(access, 'search_knowledge', { query: 'olive oil heart' })).structuredContent!.results as Array<Record<string, any>>;
    expect(olive[0].handle).not.toBe(OMEGA3);
  });

  it('returns at most five results, each excerpt capped, the notice first in text and structure', async () => {
    const answer = await call(await connect(), 'search_knowledge', { query: 'side effects dosing benefits vitamin' });
    const results = answer.structuredContent!.results as Array<Record<string, any>>;
    expect(results).toHaveLength(MAX_RESULTS);
    for (const r of results) expect(r.excerpt.length).toBeLessThanOrEqual(r.master ? MAX_MASTER_EXCERPT_CHARS : MAX_EXCERPT_CHARS);
    expect(answer.structuredContent!.notice).toBe(NOTICE);
    expect(answer.content[0].text.startsWith(`{"notice":${JSON.stringify(NOTICE)}`)).toBe(true);
    expect(answer.content[0].text.length).toBeLessThan(MAX_RESULTS * (MAX_EXCERPT_CHARS + 1_500));
  });

  // US-50 AC13: the writer contract puts "who should not take it" last in the
  // Current view, so a master's excerpt is the whole view, not cut at 1,500.
  it('a master excerpt is its whole Current view, the closing caution included', async () => {
    const results = (await call(await connect(), 'search_knowledge', { query: 'potassium supplements' })).structuredContent!.results as Array<Record<string, any>>;
    expect(results[0]).toMatchObject({ handle: 'potassium-benefits-forms-dosing-and-side-effects', master: true });
    expect(results[0].excerpt.length).toBeGreaterThan(MAX_EXCERPT_CHARS);
    expect(results[0].excerpt).toMatch(/Talk to your doctor before taking added potassium if you have kidney disease, .*ACE inhibitor.*\(Brad's current guidance, 6 Oct 2026\)\.$/);
  });

  it('refuses a query that does not fit, in fixed words that never repeat it', async () => {
    const access = await connect();
    for (const args of [{}, { query: '' }, { query: `zebra-canary ${'x'.repeat(250)}` }, { query: 'zebra-canary', extra: 1 }]) {
      const answer = await call(access, 'search_knowledge', args);
      expect(answer.isError).toBe(true);
      expect(answer.content[0].text).toContain(NOTICE);
      expect(answer.content[0].text).not.toContain('zebra-canary');
    }
  });
});

describe('US-41 AC8 — get_article: one entry, size-capped, sections on request', () => {
  beforeEach(() => { process.env.MCP_KNOWLEDGE_TOOLS = 'on'; });

  it('cuts a long master at the cap, says so, and lists its sections', async () => {
    const answer = await call(await connect(), 'get_article', { handle: B_VITAMINS });
    const s = answer.structuredContent!;
    expect(s.notice).toBe(NOTICE);
    expect(s.truncated).toBe(true);
    expect(s.body.length).toBeLessThanOrEqual(MAX_ARTICLE_CHARS);
    expect(s.body).toContain(`Cut at the ${MAX_ARTICLE_CHARS.toLocaleString('en-US')}-character limit`);
    expect(s.sections.length).toBeGreaterThan(3);
    expect(s.body).not.toMatch(/^---\n/);
  });

  it('reads one section by words from its heading', async () => {
    const access = await connect();
    const s = (await call(access, 'get_article', { handle: VITAMIN_D, section: 'drug interactions' })).structuredContent!;
    expect(s.section).toMatch(/Drug Interactions/);
    expect(s.body).toMatch(/^## .*Drug Interactions/);
    expect(s.truncated).toBe(false);
    const missing = await call(access, 'get_article', { handle: VITAMIN_D, section: 'zebra canary' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).not.toContain('zebra');
    expect(missing.content[0].text).toContain('Drug Interactions');
  });

  it('refuses an unknown or path-shaped handle without echoing it', async () => {
    const access = await connect();
    for (const handle of ['zebra-canary-handle', '../../etc/passwd', 'A'.repeat(300)]) {
      const answer = await call(access, 'get_article', { handle });
      expect(answer.isError).toBe(true);
      expect(answer.content[0].text).toContain(NOTICE);
      expect(answer.content[0].text).not.toContain(handle.slice(0, 12));
    }
  });
});

describe('US-41 AC9 — the user\'s AI pays: no network, no model, no record', () => {
  beforeEach(() => { process.env.MCP_KNOWLEDGE_TOOLS = 'on'; });

  it('makes no fetch for a search or an article: no provider token, no model, no API', async () => {
    const access = await connect();
    await call(access, 'search_knowledge', { query: 'creatine side effects' });
    await call(access, 'get_article', { handle: OMEGA3 });
    await call(access, 'get_article', { handle: OMEGA3, section: 'safety' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('imports no model client and no network module', () => {
    const source = readFileSync(new URL('../lib/mcp-knowledge.server.ts', import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual([
      '../../packages/health-core/src/mcp-tools', // type-only
      '../../tools/search-knowledge',
      './blog-index.server',
      './frontmatter',
      './matched-content',
      './router-view',
      'zod',
    ]);
    expect(source).toMatch(/import type \{ McpToolDefinition, ToolAnswer \} from '\.\.\/\.\.\/packages\/health-core\/src\/mcp-tools'/);
    // ChatGPT's two `_meta` keys are the only place the word may appear.
    expect(source.replaceAll("'openai/toolInvocation/", '')).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|anthropic|openai|API_KEY|process\.env\.(?!MCP_KNOWLEDGE_TOOLS\b)\w+)\b/i);
  });
});

describe('US-41 AC11/AC12 — rate-limited, tighter than the other tools; counted by name only', () => {
  beforeEach(() => { process.env.MCP_KNOWLEDGE_TOOLS = 'on'; });

  it('counts a call as tool, client and outcome, never the query or handle', async () => {
    const access = await connect();
    await call(access, 'search_knowledge', { query: 'zebra-canary magnesium' });
    await call(access, 'get_article', { handle: 'zebra-canary-handle' });
    const rows = vi.mocked(recordServerEvent).mock.calls;
    expect(rows).toEqual([
      ['mcp_tool_call', { tool: 'search_knowledge', client: 'other', outcome: 'ok' }],
      ['mcp_tool_call', { tool: 'get_article', client: 'other', outcome: 'refused', reason: 'not-found' }],
    ]);
  });

  it('allows 30 knowledge calls a minute per connection; the refusal opens with the notice', async () => {
    const access = await connect();
    for (let i = 0; i < 30; i++) expect((await call(access, 'get_article', { handle: MAGNESIUM })).isError).toBeFalsy();
    const over = await call(access, 'search_knowledge', { query: 'magnesium' });
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toBe(`${NOTICE}\n\nToo many tool calls from this connection in the last minute. Wait a moment, then try again.`);
    // The record tools keep their own 120 (and their own words).
    expect((await call(access, 'nope', {})).content[0].text).toBe('No tool named nope.');
  });

  it('a knowledge call refused by the shared 120 also opens with the notice (Codex R1)', async () => {
    const access = await connect();
    for (let i = 0; i < 120; i++) await call(access, 'nope', {});
    const over = await call(access, 'get_article', { handle: MAGNESIUM });
    expect(over.content[0].text.startsWith(`${NOTICE}\n\nToo many tool calls`)).toBe(true);
  });

  it('off, the rate-limit refusal is the old words, notice-free', async () => {
    delete process.env.MCP_KNOWLEDGE_TOOLS;
    const access = await connect();
    for (let i = 0; i < 120; i++) await call(access, 'nope', {});
    expect((await call(access, 'search_knowledge', { query: 'magnesium' })).content[0].text)
      .toBe('Too many tool calls from this connection in the last minute. Wait a moment, then try again.');
  });
});

describe('US-41 AC11 — only what is public under Brad\'s name: video articles and topic masters (adversary R3, re-check F4)', () => {
  const index = loadBlogIndex();
  const notServed = index.filter((e) => !isServed(e));

  it('serves the two sets and nothing else', () => {
    expect(notServed.filter((e) => e.type === 'pathway').length).toBeGreaterThan(700);
    expect(notServed.filter((e) => e.type === 'guideline').map((e) => e.handle).sort()).toEqual(['diet', 'exercise', 'sleep']);
    expect(notServed.every((e) => e.type === 'pathway' || e.type === 'guideline' || (e.type === 'reference' && !e.reviewed))).toBe(true);
    expect(index.filter(isServed).every((e) => (e.type ?? 'article') === 'article' || (e.type === 'reference' && !!e.reviewed))).toBe(true);
  });

  it('never returns a pathway, guideline or non-master reference, searched by each one\'s own title', () => {
    const banned = new Set(notServed.map((e) => e.handle));
    for (const e of notServed) {
      const results = (callKnowledgeTool('search_knowledge', { query: e.title.slice(0, 200) }).structured as { results: Array<{ handle: string }> }).results;
      for (const r of results) expect(banned.has(r.handle), `${e.handle} -> ${r.handle}`).toBe(false);
    }
  });

  it('refuses to read any pathway, guideline or non-master reference', () => {
    for (const e of notServed) {
      const answer = callKnowledgeTool('get_article', { handle: e.handle });
      expect(answer.isError, e.handle).toBe(true);
      expect(answer.reason).toBe('not-found');
    }
  });
});

describe('US-41 AC8 — a cut entry keeps every safety section (adversary R1)', () => {
  /** The test's own risk words, wider than the implementation's on purpose (re-check F3). */
  const RISK_HEADING = /^#{2,6} .*\b(?:safe|safety|unsafe|side[- ]effects?|adverse|toxic|toxicity|overdose|interact\w*|contraindicat\w*|precautions?|cautions?|warnings?|pregnan\w*|breastfeeding|lactation|special populations?|risks?|risk factors?|who should not|avoid)\b.*$/gim;

  it('a whole-entry read of every served entry holds each risk heading, inside the cap', () => {
    let cut = 0;
    for (const e of loadBlogIndex().filter(isServed)) {
      const raw = readFileSync(`docs/blog/${e.handle}.md`, 'utf8');
      const s = callKnowledgeTool('get_article', { handle: e.handle }).structured as { body: string; truncated: boolean };
      expect(s.body.length, e.handle).toBeLessThanOrEqual(MAX_ARTICLE_CHARS);
      if (s.truncated) cut++;
      for (const [heading] of raw.matchAll(RISK_HEADING)) {
        expect(s.body, `${e.handle}: ${heading}`).toContain(heading);
      }
    }
    expect(cut).toBeGreaterThan(15);
  });

  it('with no safety section, the note says so and names the headings it cut (F1)', () => {
    const body = `## Start\n${'a'.repeat(3_000)}\n## Middle\n${'b'.repeat(3_000)}\n## Late finding\n${'c'.repeat(3_000)}`;
    const cut = cutEntry(body, 5_000);
    expect(cut.length).toBeLessThanOrEqual(5_000);
    expect(cut).toContain('No safety section was found in this entry; read the sections list.');
    expect(cut).toContain('Late finding');
    expect(cut).not.toContain('follow whole');
  });

  it('safety blocks that alone pass the budget are cut, and the note says so (F2)', () => {
    const body = `## Current view\n${'v'.repeat(5_000)}\n## 5. Safety\n${'s'.repeat(20_000)}`;
    const cut = cutEntry(body, 12_000);
    expect(cut.length).toBeLessThanOrEqual(12_000);
    expect(cut).toContain('too long to fit whole');
    expect(cut).not.toContain('follow whole');
    expect(cut.startsWith('## Current view')).toBe(true);
    expect(cut.indexOf('## 5. Safety')).toBeGreaterThan(4_000);
    // When they fit, the note says whole.
    expect(cutEntry(`## Current view\n${'v'.repeat(20_000)}\n## 5. Safety\nshort`, 12_000)).toContain('follow whole');
  });

  it('widened headings count as safety: contraindications, precautions, adverse, cautions, warnings, pregnancy, special populations, risk factors (F1)', () => {
    for (const h of ['Contraindications', 'Precautions', 'Adverse Events', 'Cautions', 'Warnings', 'Pregnancy and Breastfeeding', 'Special Populations', 'Risk Factors']) {
      expect(safetyBlocks(`## Intro\nx\n## ${h}\ny\n## End\nz`), h).toEqual([`## ${h}\ny`]);
    }
  });

  it('takes a nested safety block once, and stops at the next heading of its level', () => {
    const body = '## A\nx\n### Toxicity\nt\n## 5. Safety\ns\n### Drug interactions\nd\n## 6. Other\no';
    expect(safetyBlocks(body)).toEqual(['### Toxicity\nt', '## 5. Safety\ns\n### Drug interactions\nd']);
  });
});

describe('US-41 AC7 — url is the file\'s own link, never the index\'s (adversary R2)', () => {
  it('an article and a master carry their frontmatter url', () => {
    for (const handle of [MAGNESIUM]) {
      const own = parseFrontmatter(readFileSync(`docs/blog/${handle}.md`, 'utf8'))!.url;
      expect((callKnowledgeTool('get_article', { handle }).structured as { url: string }).url).toBe(own);
    }
    const article = loadBlogIndex().find((e) => (e.type ?? 'article') === 'article')!;
    const own = parseFrontmatter(readFileSync(`docs/blog/${article.handle}.md`, 'utf8'))!.url;
    expect(own).toMatch(/^https:\/\//);
    expect((callKnowledgeTool('get_article', { handle: article.handle }).structured as { url: string }).url).toBe(own);
  });
});
