/**
 * US-15 AC54: the chat audit pulls every row in its window, not the first 1000.
 *
 * PostgREST answers a select with at most its max-rows setting (1000 on
 * Supabase; app/lib/reminder-v2-purge-page.test.ts pins the same cap) and says
 * nothing about the rest: the status is 200. Rows written in one transaction
 * share `created_at` (Postgres `now()` is the transaction's start), and tied
 * rows come back in no fixed order from one query to the next, so a paged pull
 * also needs a tie-break that is unique.
 *
 * The tool runs as a child process against a small PostgREST over HTTP: it
 * filters `created_at=gte.…`, sorts by the `order` it is sent, orders tied rows
 * differently on every request (as Postgres may), applies `offset` and `limit`,
 * caps each answer (1000, as Supabase; and 400, a project set lower), and
 * refuses a parameter it does not know with a 400. Synthetic rows only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MESSAGES = 1500;
const ROUTING = 1200;
const TIED = 7; // rows per created_at value: 7 divides no page boundary (400, 800, 1000, 1200), so a tie straddles each one

type Row = Record<string, unknown> & { id: string; created_at: string };

const at = (start: number, i: number) => new Date(start + Math.floor(i / TIED) * 1000).toISOString();
const start = Date.now() - 2 * 24 * 60 * 60 * 1000;
const tables: Record<string, Row[]> = {
  chat_messages: Array.from({ length: MESSAGES }, (_, i) => ({
    id: `m-${String(i).padStart(5, '0')}`, created_at: at(start, i), role: i % 2 ? 'assistant' : 'user',
    content: `Synthetic line ${i}.`, model: null, input_tokens: 0, output_tokens: 0, discord_message_id: null,
    is_fallback: false, failure_mode: null, error_detail: null,
    chat_conversations: { id: `c-${Math.floor(i / 2)}`, platform: 'shopify', external_id: null },
  })),
  chat_match_events: Array.from({ length: ROUTING }, (_, i) => ({
    id: `r-${String(i).padStart(5, '0')}`, created_at: at(start, i), message_id: `m-${String(i).padStart(5, '0')}`,
    conversation_id: `c-${Math.floor(i / 2)}`, user_id: 'u-synthetic', message: `Synthetic question ${i}?`,
    router_context: { platform: 'shopify' }, is_fallback: false, failure_mode: null, matched_handles: [],
    router_latency_ms: 1, router_cache_hit: false, router_error: null, router_raw: null, classification: null,
    router_skipped: null,
  })),
};

/** What the server does this run: its row cap, and the table whose second page answers 503 ('' for none). */
const server = { maxRows: 1000, failTable: '', requestNo: 0, requests: [] as string[], perTable: {} as Record<string, number> };

/** A tie order that changes per request: what an unordered tie may do in Postgres. */
function tieRank(id: string, salt: number): number {
  let h = salt * 2654435761;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function answer(url: URL): { status: number; body: unknown; range?: string } {
  const table = tables[url.pathname.replace('/rest/v1/', '')];
  if (!table) return { status: 404, body: { message: `fake PostgREST: no table ${url.pathname}` } };
  let order: Array<[string, 'asc' | 'desc']> = [];
  let since = '';
  let offset = 0;
  let limit = Infinity;
  for (const [key, raw] of url.searchParams) {
    if (key === 'select') continue;
    else if (key === 'created_at' && raw.startsWith('gte.')) since = raw.slice(4);
    else if (key === 'order') order = raw.split(',').map((o) => o.split('.') as [string, 'asc' | 'desc']);
    else if (key === 'offset') offset = Number(raw);
    else if (key === 'limit') limit = Number(raw);
    else return { status: 400, body: { message: `fake PostgREST: unsupported parameter ${key}=${raw}` } };
  }
  const salt = server.requestNo;
  const rows = table
    .filter((r) => r.created_at >= since)
    .sort((a, b) => {
      for (const [column, dir] of order) {
        const x = String(a[column]);
        const y = String(b[column]);
        if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return tieRank(a.id, salt) - tieRank(b.id, salt);
    })
    .slice(offset, offset + Math.min(limit, server.maxRows));
  return { status: 200, body: rows, range: rows.length ? `${offset}-${offset + rows.length - 1}/*` : '*/*' };
}

type Run = { exit: number | null; stderr: string; requests: string[]; messages?: Array<{ message_id: string }>; routing?: Array<{ message_id: string }> };

let http: Server;
let port = 0;
const dirs: string[] = [];

/** One run of the tool against the server as configured. */
async function runTool(maxRows: number, failTable = ''): Promise<Run> {
  Object.assign(server, { maxRows, failTable, requestNo: 0, requests: [], perTable: {} });
  const dir = mkdtempSync(join(tmpdir(), 'chat-audit-cap-'));
  dirs.push(dir);
  let stderr = '';
  const exit = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tools/chat-audit-pull.ts', '--days', '5', '--output-dir', dir, '--no-html'], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', TZ: 'UTC', SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_KEY: 'synthetic-audit-key' },
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', resolve);
  });
  const read = (name: string) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : undefined);
  return { exit, stderr, requests: server.requests, messages: read('messages.json'), routing: read('routing.json') };
}

let supabase: Run;
let lower: Run;
let failedMessages: Run;
let failedRouting: Run;

beforeAll(async () => {
  http = createServer((req, res) => {
    server.requests.push(req.url ?? '');
    server.requestNo++;
    if (req.headers.apikey !== 'synthetic-audit-key') {
      res.writeHead(401).end('{"message":"no apikey"}');
      return;
    }
    const table = new URL(req.url ?? '/', 'http://fake').pathname.replace('/rest/v1/', '');
    server.perTable[table] = (server.perTable[table] ?? 0) + 1;
    if (table === server.failTable && server.perTable[table] === 2) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"synthetic outage"}');
      return;
    }
    const { status, body, range } = answer(new URL(req.url ?? '/', 'http://fake'));
    res.writeHead(status, { 'content-type': 'application/json', ...(range ? { 'content-range': range } : {}) });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as AddressInfo).port;
  supabase = await runTool(1000);
  lower = await runTool(400);
  failedMessages = await runTool(1000, 'chat_messages'); // the first page of each table, then a failed page
  failedRouting = await runTool(1000, 'chat_match_events');
}, 180_000);

afterAll(async () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  await new Promise((resolve) => http.close(resolve));
});

const id = (prefix: string, i: number) => `${prefix}-${String(i).padStart(5, '0')}`;

function expectAll(rows: Array<{ message_id: string }> | undefined, count: number) {
  const ids = (rows ?? []).map((r) => r.message_id);
  expect(ids).toHaveLength(count);
  expect(new Set(ids).size).toBe(count);
  expect(ids).toContain(id('m', count - 1));
}

describe('US-15 AC54: chat-audit-pull reads past the PostgREST row cap', () => {
  it('runs to the end', () => {
    expect(supabase.stderr).toBe('');
    expect(supabase.exit).toBe(0);
  });

  it('keeps every chat message in the window, the newest included, each once', () => {
    expectAll(supabase.messages, MESSAGES);
  });

  it('keeps every routing event in the window, the newest included, each once', () => {
    expectAll(supabase.routing, ROUTING);
  });

  it('holds with a project whose cap is lower than 1000', () => {
    expect(lower.exit).toBe(0);
    expectAll(lower.messages, MESSAGES);
    expectAll(lower.routing, ROUTING);
  });

  it('every page asks for the window by created_at, oldest first', () => {
    expect(supabase.requests.length).toBeGreaterThan(2);
    for (const r of supabase.requests) {
      expect(r).toMatch(/[?&]created_at=gte\.\d{4}-\d\d-\d\dT/);
      expect(r).toMatch(/[?&]order=created_at\.asc/);
    }
  });

  it('a page that fails stops the run, naming its table: no audit is written from part of the window', () => {
    for (const [failed, label] of [[failedMessages, 'messages'], [failedRouting, 'routing']] as const) {
      expect(failed.exit).not.toBe(0);
      expect(failed.stderr).toContain(`Failed to pull ${label}: 503`);
      expect(failed.messages).toBeUndefined();
      expect(failed.routing).toBeUndefined();
    }
  });
});
