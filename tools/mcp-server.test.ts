/**
 * US-32 — the stdio MCP server.
 *
 * The tools themselves are pinned in `mcp-tools.test.ts`. What is tested here
 * is the shell: the JSON-RPC handshake, line framing over a real stream, and
 * the fact that a write tool actually lands bytes on disk through the same
 * backup-and-replace path the CLI uses.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '@roadmap/health-core';
import { handle, MAX_LINE_BYTES, serve } from './mcp-server';

const CTX = { deviceId: 'us32_server', now: '2026-09-01T09:00:00Z' };

function fixture(): RoadmapFile {
  const file = createEmptyFile(CTX);
  Object.assign(file.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem: 'si' });
  file.measurements.push(createMeasurement({
    id: 'm1', metricType: 'ldl', value: 3.4, recordedAt: '2026-07-14',
    createdAt: '2026-07-14T08:00:00Z', source: 'lab_import',
  }));
  file.reminderOptIn = {
    status: 'active', token: 'SECRET-CAPABILITY-TOKEN', email: 'brad@example.com',
    provider: 'dropbox', updatedAt: CTX.now, lamport: 1,
  };
  return file;
}

function writeFixture(file: RoadmapFile): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'us32-'));
  const path = join(dir, 'health-roadmap.json');
  writeFileSync(path, JSON.stringify(file, null, 2));
  return { dir, path };
}

/** One tools/call, as the protocol carries it. */
function call(path: string, name: string, args: unknown = {}, id = 1) {
  const response = handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, path) as
    { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { code: number } };
  return response;
}

function text(response: { result?: { content: Array<{ text: string }> } }): string {
  return response.result!.content[0].text;
}

describe('US-32 — the JSON-RPC handshake', () => {
  it('answers initialize with the protocol revision, the tools capability and its instructions', () => {
    const { dir, path } = writeFixture(fixture());
    const response = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, path) as
      { result: { protocolVersion: string; capabilities: object; serverInfo: { name: string }; instructions: string } };

    expect(response.result.protocolVersion).toBe('2025-11-25');
    expect(response.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(response.result.serverInfo.name).toBe('health-roadmap');
    expect(response.result.instructions).toContain('not medical advice');
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the five tools with their schemas, and stays quiet on a notification', () => {
    const { dir, path } = writeFixture(fixture());
    const listed = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, path) as
      { result: { tools: Array<{ name: string; inputSchema: object }> } };

    expect(listed.result.tools.map((t) => t.name)).toEqual([
      'read_record', 'get_plan', 'add_measurement', 'add_lab_values', 'correct_value',
    ]);
    expect(listed.result.tools[0].inputSchema).toMatchObject({ type: 'object' });
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, path)).toBeNull();
    expect(handle({ jsonrpc: '2.0', id: 3, method: 'ping' }, path)).toMatchObject({ result: {} });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses valid JSON that is not a request object, rather than going quiet', () => {
    const { dir, path } = writeFixture(fixture());

    // Batches were removed from MCP after 2025-03. Answering an array with
    // silence would hang a client that still sends one; -32600 with a null id
    // is what it can act on.
    for (const notARequest of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 42, 'ping', null]) {
      expect(handle(notARequest, path), JSON.stringify(notARequest)).toEqual({
        jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A request must be a JSON object' },
      });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('echoes a string id, and treats id 0 as a request and not a notification', () => {
    const { dir, path } = writeFixture(fixture());

    expect(handle({ jsonrpc: '2.0', id: 'abc', method: 'ping' }, path)).toEqual({ jsonrpc: '2.0', id: 'abc', result: {} });
    expect(handle({ jsonrpc: '2.0', id: 0, method: 'ping' }, path)).toEqual({ jsonrpc: '2.0', id: 0, result: {} });
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an unknown method and an unknown tool differently', () => {
    const { dir, path } = writeFixture(fixture());

    expect(handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, path)).toMatchObject({
      error: { code: -32601 },
    });
    // An unknown TOOL is the model's mistake to recover from, not a broken
    // connection — it comes back as a tool result it can read.
    expect(call(path, 'delete_everything').result?.isError).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-32 — tools/call against a real file', () => {
  it('reads the record without the reminder capability token', () => {
    const { dir, path } = writeFixture(fixture());
    const body = text(call(path, 'read_record'));

    expect(body).not.toContain('SECRET-CAPABILITY-TOKEN');
    expect(JSON.parse(body).measurements).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes the plan, hedging and citations intact', () => {
    const { dir, path } = writeFixture(fixture());
    const plan = JSON.parse(text(call(path, 'get_plan')));

    expect(plan.instruction).toContain('never upgrade it into a recommendation');
    expect(plan.suggestions.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes an added measurement to disk, through a backup', () => {
    const { dir, path } = writeFixture(fixture());
    const before = readFileSync(path, 'utf8');

    const response = call(path, 'add_measurement', { metricType: 'hdl', value: 1.2 });

    expect(response.result?.isError).toBeUndefined();
    expect(text(response)).toContain('Saved (backup:');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as RoadmapFile;
    expect(saved.measurements.filter((m) => m.metricType === 'hdl')).toHaveLength(1);
    const backups = readdirSync(dir).filter((n) => n.includes('.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the file untouched when a tool refuses', () => {
    const { dir, path } = writeFixture(fixture());
    const before = readFileSync(path, 'utf8');

    const response = call(path, 'add_measurement', { metricType: 'ldl', value: 2.1, recordedAt: '2026-07-14' });

    expect(response.result?.isError).toBe(true);
    expect(text(response)).toContain('correct_value');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to write over a file whose arrays are not arrays, and leaves it alone', () => {
    // migrateFile rebuilds unrecognised bytes as a BLANK record. A file that
    // carries schemaVersion but junk elsewhere would be replaced by an empty
    // one and the write would report success.
    const dir = mkdtempSync(join(tmpdir(), 'us32-'));
    const path = join(dir, 'health-roadmap.json');
    const junk = '{"schemaVersion":1,"measurements":"nope","labValues":42}';
    writeFileSync(path, junk);

    const response = call(path, 'add_measurement', { metricType: 'hdl', value: 1.2 });

    expect(response.result?.isError).toBe(true);
    expect(text(response)).toContain('not a health-roadmap.json');
    expect(readFileSync(path, 'utf8')).toBe(junk);
    expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns a missing or unreadable record into a refusal the assistant can explain', () => {
    const { dir } = writeFixture(fixture());
    const response = call(join(dir, 'not-here.json'), 'read_record');

    expect(response.result?.isError).toBe(true);
    expect(text(response)).toContain('Cannot read');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-32 — the stdio transport', () => {
  it('serves a full session over a stream: initialize, list, read, write, read back', async () => {
    const { dir, path } = writeFixture(fixture());
    const input = new PassThrough();
    const lines: string[] = [];
    serve(input, { write: (chunk: string) => lines.push(...chunk.trim().split('\n')) }, path);

    const send = async (message: object | string) => {
      input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
      await new Promise((resolve) => setImmediate(resolve));
    };
    // Two messages in one chunk, then one split across two — the framing is
    // the whole job of the transport, so it is exercised, not assumed.
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n` +
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    input.write('{"jsonrpc":"2.0","id":2,');
    await send('"method":"tools/list"}');
    await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_measurement', arguments: { metricType: 'hdl', value: 1.2 } } });
    await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_record', arguments: { metric: 'hdl' } } });
    await send('not json at all');

    const responses = lines.map((line) => JSON.parse(line));
    expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4, null]); // the notification got no reply
    expect(responses[0].result.protocolVersion).toBe('2025-11-25');
    expect(responses[1].result.tools).toHaveLength(5);
    expect(responses[2].result.content[0].text).toContain('Saved (backup:');
    expect(JSON.parse(responses[3].result.content[0].text).measurements).toHaveLength(1);
    expect(responses[4].error.code).toBe(-32700);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-32 — the transport refuses a line it will not buffer', () => {
  it('answers -32600 once a single line passes the cap, then recovers on the next line', async () => {
    const { dir, path } = writeFixture(fixture());
    const input = new PassThrough();
    const lines: string[] = [];
    serve(input, { write: (chunk: string) => lines.push(...chunk.trim().split('\n')) }, path);

    const chunk = 'x'.repeat(1024 * 1024);
    for (let written = 0; written <= MAX_LINE_BYTES; written += chunk.length) input.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ id: null, error: { code: -32600 } });

    // The refused line runs to its own newline; the next line is served normally.
    input.write(`\n${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.parse(lines[1])).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-32 — nothing that could reach the network is imported', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, 'mcp-server.ts'),
    join(here, 'record-io.ts'),
    join(here, '..', 'packages', 'health-core', 'src', 'mcp-tools.ts'),
    join(here, '..', 'packages', 'health-core', 'src', 'plan.ts'),
  ];

  it('imports only health-core sources, siblings, zod and node builtins', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const specifiers = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
      expect(specifiers.length, file).toBeGreaterThan(1);
      for (const spec of specifiers) {
        expect(spec, file).toMatch(/^(node:(fs|os|path|url|crypto|stream)|\.\.\/packages\/health-core\/src\/[a-z-]+|\.\/[a-z-]+|zod)$/);
      }
      expect(source, file).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|https?:\/\/[^\s'"]*\/(api|v1))\b/);
    }
  });
});
