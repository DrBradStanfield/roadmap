/**
 * US-32 — the stdio MCP server.
 *
 * The tools themselves are pinned in `mcp-tools.test.ts`. What is tested here
 * is the shell: the JSON-RPC handshake, line framing over a real stream, and
 * the fact that a write tool actually lands bytes on disk through the same
 * backup-and-replace path the CLI uses.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { createEmptyFile, createMeasurement, type RoadmapFile } from '@roadmap/health-core';
import { MCP_TOOLS, OUTPUTS } from '../packages/health-core/src/mcp-tools';
import { run as runCli } from './edit-record';
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
async function call(path: string, name: string, args: unknown = {}, id = 1) {
  return (await handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, path)) as
    { result?: { content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean }; error?: { code: number } };
}

function text(response: { result?: { content: Array<{ text: string }> } }): string {
  return response.result!.content[0].text;
}

/** The stdio server runs on the real clock; a write states the real day. */
const TODAY = new Date().toISOString().slice(0, 10);

describe('US-32 — the JSON-RPC handshake', () => {
  it('answers initialize with the protocol revision, the tools capability and its instructions', async () => {
    const { dir, path } = writeFixture(fixture());
    const response = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, path)) as
      { result: { protocolVersion: string; capabilities: object; serverInfo: { name: string }; instructions: string } };

    expect(response.result.protocolVersion).toBe('2025-11-25');
    expect(response.result.capabilities).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });
    expect(response.result.serverInfo.name).toBe('health-roadmap');
    expect(response.result.instructions).toContain('not medical advice');
    expect(response.result.instructions).toContain('report_feedback');
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the eight tools with their schemas, and stays quiet on a notification', async () => {
    const { dir, path } = writeFixture(fixture());
    const listed = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, path)) as
      { result: { tools: Array<{ name: string; inputSchema: object }> } };

    expect(listed.result.tools.map((t) => t.name)).toEqual([
      'read_record', 'get_plan', 'add_measurement', 'add_lab_values', 'correct_value', 'update_profile', 'report_feedback',
      'import_documents',
    ]);
    expect(listed.result.tools[0].inputSchema).toMatchObject({ type: 'object' });
    expect((await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, path))).toBeNull();
    expect((await handle({ jsonrpc: '2.0', id: 3, method: 'ping' }, path))).toMatchObject({ result: {} });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses valid JSON that is not a request object, rather than going quiet', async () => {
    const { dir, path } = writeFixture(fixture());

    // Batches were removed from MCP after 2025-03. Answering an array with
    // silence would hang a client that still sends one; -32600 with a null id
    // is what it can act on.
    for (const notARequest of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], 42, 'ping', null]) {
      expect((await handle(notARequest, path)), JSON.stringify(notARequest)).toEqual({
        jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A request must be a JSON object' },
      });
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('echoes a string id, and treats id 0 as a request and not a notification', async () => {
    const { dir, path } = writeFixture(fixture());

    expect((await handle({ jsonrpc: '2.0', id: 'abc', method: 'ping' }, path))).toEqual({ jsonrpc: '2.0', id: 'abc', result: {} });
    expect((await handle({ jsonrpc: '2.0', id: 0, method: 'ping' }, path))).toEqual({ jsonrpc: '2.0', id: 0, result: {} });
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an unknown method and an unknown tool differently', async () => {
    const { dir, path } = writeFixture(fixture());

    expect((await handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, path))).toMatchObject({
      error: { code: -32601 },
    });
    // An unknown TOOL is the model's mistake to recover from, not a broken
    // connection — it comes back as a tool result it can read.
    expect((await call(path, 'delete_everything')).result?.isError).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-32 — tools/call against a real file', () => {
  it('reads the record without the reminder capability token', async () => {
    const { dir, path } = writeFixture(fixture());
    const body = text((await call(path, 'read_record')));

    expect(body).not.toContain('SECRET-CAPABILITY-TOKEN');
    expect(JSON.parse(body).measurements).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes the plan, hedging and citations intact', async () => {
    const { dir, path } = writeFixture(fixture());
    const plan = JSON.parse(text((await call(path, 'get_plan'))));

    expect(plan.instruction).toContain('never upgrade it into a recommendation');
    expect(plan.suggestions.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes an added measurement to disk, and names the backup it made', async () => {
    const { dir, path } = writeFixture(fixture());

    const response = (await call(path, 'add_measurement', { metricType: 'hdl', value: 1.2, recordedAt: TODAY }));

    expect(response.result?.isError).toBeUndefined();
    const backup = /backup: ([^)]+)\)/.exec(text(response))![1];
    expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toEqual([backup]);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as RoadmapFile;
    expect(saved.measurements.filter((m) => m.metricType === 'hdl')).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the file untouched when a tool refuses', async () => {
    const { dir, path } = writeFixture(fixture());
    const before = readFileSync(path, 'utf8');

    const response = (await call(path, 'add_measurement', { metricType: 'ldl', value: 2.1, recordedAt: '2026-07-14' }));

    expect(response.result?.isError).toBe(true);
    expect(text(response)).toContain('correct_value');
    expect(readFileSync(path, 'utf8')).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns a missing or unreadable record into a refusal the assistant can explain', async () => {
    const { dir } = writeFixture(fixture());
    const response = (await call(join(dir, 'not-here.json'), 'read_record'));

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
    await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_measurement', arguments: { metricType: 'hdl', value: 1.2, recordedAt: TODAY } } });
    await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_record', arguments: { metric: 'hdl' } } });
    await send('not json at all');

    const responses = lines.map((line) => JSON.parse(line));
    expect(responses.map((r) => r.id)).toEqual([1, 2, 3, 4, null]); // the notification got no reply
    expect(responses[0].result.protocolVersion).toBe('2025-11-25');
    expect(responses[1].result.tools).toHaveLength(MCP_TOOLS.length);
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

  it('answers a valid line before the overlong one that followed it in the same chunk', async () => {
    // The refusal used to be written straight from the data handler while the
    // valid line waited on the async chain, so the client read the answers in
    // the wrong order.
    const { dir, path } = writeFixture(fixture());
    const input = new PassThrough();
    const lines: string[] = [];
    serve(input, { write: (chunk: string) => lines.push(...chunk.trim().split('\n')) }, path);

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' })}\n${'x'.repeat(MAX_LINE_BYTES + 1)}`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(lines.map((line) => JSON.parse(line).id)).toEqual([11, null]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-32 — a storage failure reaches the client as a refusal, not silence', () => {
  it('answers the request that failed, with its own id', async () => {
    // Today a conflict storm or a failed verify escapes `handle`, and the
    // transport answers with id null — a reply the client cannot match to its
    // request, so it waits forever.
    vi.resetModules();
    vi.doMock('../packages/health-core/src/file-adapter', async () => {
      // The adapter module is re-instantiated with the rest of the graph, so
      // the ConflictError SyncManager catches must come from THAT copy.
      const { ConflictError } = await import('../packages/health-core/src/adapter');
      const record = fixture();
      return {
        BACKUPS_KEPT: 3,
        FileAdapter: class {
          readonly id = 'file';
          readonly label = 'Local file';
          readonly path = '/tmp/never-written.json';
          lastBackup = '';
          async connect() {}
          isConnected() { return true; }
          async disconnect() {}
          async read() { return { body: JSON.parse(JSON.stringify(record)), version: 'v1' }; }
          async write(): Promise<never> { throw new ConflictError('another writer, every time'); }
          async readDocument(): Promise<never> { throw new Error('no'); }
          async writeDocument(): Promise<never> { throw new Error('no'); }
        },
      };
    });
    try {
      const { handle: mocked } = await import('./mcp-server');
      const response = (await mocked({
        jsonrpc: '2.0', id: 77, method: 'tools/call',
        params: { name: 'add_measurement', arguments: { metricType: 'hdl', value: 1.2, recordedAt: TODAY } },
      }, '/tmp/never-written.json')) as { id: number; result: { content: Array<{ text: string }>; isError?: boolean } };

      expect(response.id).toBe(77);
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain('conflict storm');
    } finally {
      vi.doUnmock('../packages/health-core/src/file-adapter');
      vi.resetModules();
    }
  });
});

describe('US-32 — a bug in us still answers the request that hit it', () => {
  it('answers -32603 with the request’s own id, never a null-id -32600', async () => {
    // A failure that is NOT the record's — a broken adapter, a tool breaking
    // its own contract — is ours, not something to word as a refusal. It still
    // has to carry the id, or the client waits for a reply it can match.
    vi.resetModules();
    vi.doMock('../packages/health-core/src/file-adapter', () => ({
      BACKUPS_KEPT: 3,
      FileAdapter: class {
        readonly id = 'file';
        readonly label = 'Local file';
        readonly path = '/tmp/never-read.json';
        lastBackup = '';
        async connect() {}
        isConnected() { return true; }
        async disconnect() {}
        async read(): Promise<never> { throw new TypeError('adapter is broken'); }
        async write(): Promise<never> { throw new TypeError('adapter is broken'); }
        async readDocument(): Promise<never> { throw new Error('no'); }
        async writeDocument(): Promise<never> { throw new Error('no'); }
      },
    }));
    try {
      const { handle: mocked } = await import('./mcp-server');
      const response = (await mocked({
        jsonrpc: '2.0', id: 'abc', method: 'tools/call',
        params: { name: 'read_record', arguments: {} },
      }, '/tmp/never-read.json')) as { id: string; error: { code: number; message: string } };

      expect(response.id).toBe('abc');
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain('adapter is broken');
    } finally {
      vi.doUnmock('../packages/health-core/src/file-adapter');
      vi.resetModules();
    }
  });
});

describe('US-32 — nothing that could reach the network is imported', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, 'mcp-server.ts'),
    join(here, '..', 'packages', 'health-core', 'src', 'file-adapter.ts'),
    join(here, '..', 'packages', 'health-core', 'src', 'mcp-tools.ts'),
    join(here, '..', 'packages', 'health-core', 'src', 'plan.ts'),
  ];

  it('imports only health-core sources, siblings, zod and node builtins', async () => {
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

describe('US-32 AC9 — report_feedback over the wire', () => {
  it('returns a prefilled issue URL and leaves the record exactly as it was', async () => {
    const { dir, path } = writeFixture(fixture());
    const before = statSync(path);

    const response = (await call(path, 'report_feedback', {
      kind: 'feature', title: 'let me track resting heart rate', detail: 'The record has nowhere to put it.',
    }));

    const link = text(response).split('\n')[0];
    expect(link).toContain('https://github.com/DrBradStanfield/roadmap/issues/new?labels=from-connector,feature');
    expect(response.result!.isError).toBeUndefined();
    // No write, no backup: the file is only the thing being reported about.
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('works when there is no record at all — the one tool that never reads the file', async () => {
    // The likeliest moment to report feedback is the moment the tool failed:
    // wrong path, record not created yet. Opening the record first turned that
    // into "no record here", swallowing the report.
    const dir = mkdtempSync(join(tmpdir(), 'us32-'));
    const path = join(dir, 'health-roadmap.json');

    const response = (await call(path, 'report_feedback', {
      kind: 'bug', title: 'the server cannot find my record', detail: 'It says no record here.',
    }));

    expect(response.result!.isError).toBeUndefined();
    expect(text(response)).toContain('github.com/');
    expect(text(response)).toContain('/issues/new');
    // Nothing was created: no record, no backup, an empty directory.
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-31 AC8/AC9, US-32 AC6 — the CLI and the stdio server share one write path', () => {
  /** Everything a run is entitled to differ by: minted ids, clocks, and who wrote. */
  function normalise(json: string): unknown {
    const ids = new Map<string, string>();
    const stable = (id: string) => ids.get(id) ?? (ids.set(id, `id${ids.size}`), `id${ids.size - 1}`);
    return JSON.parse(json, (key, value) => {
      if (key === 'id' || key === 'correctsId') return typeof value === 'string' ? stable(value) : value;
      if (key === 'createdAt' || key === 'updatedAt' || key === 'lastDeviceId') return '<run>';
      return value;
    });
  }

  it('writes byte-identical records for the same add, ids and clocks aside', async () => {
    const cli = writeFixture(fixture());
    const mcp = writeFixture(fixture());

    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(await runCli(['add', cli.path, '--metric', 'hdl', '--value', '1.2', '--date', '2026-08-14'])).toBe(0);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
    const written = await call(mcp.path, 'add_measurement', { metricType: 'hdl', value: 1.2, recordedAt: '2026-08-14' });
    expect(written.result?.isError).toBeUndefined();

    const [fromCli, fromMcp] = [readFileSync(cli.path, 'utf8'), readFileSync(mcp.path, 'utf8')];
    expect(normalise(fromMcp)).toEqual(normalise(fromCli));
    // One serializer, not two: same indentation, same trailing newline.
    expect(fromMcp.split('\n').length).toBe(fromCli.split('\n').length);
    expect(fromMcp.endsWith('\n') && fromCli.endsWith('\n')).toBe(true);
    rmSync(cli.dir, { recursive: true, force: true });
    rmSync(mcp.dir, { recursive: true, force: true });
  });
});


describe('US-32 — structured results reach the client unchanged', () => {
  it('carries the tool’s own structured answer beside the text, and none on a refusal', async () => {
    const { dir, path } = writeFixture(fixture());

    const added = await call(path, 'add_measurement', { metricType: 'hdl', value: 1.2, recordedAt: TODAY });
    const structured = added.result!.structuredContent;
    // The tool built this; the server only passed it along. The saved-backup
    // note the surface adds belongs to the text, never to the structure.
    expect(OUTPUTS.add_measurement.parse(structured)).toEqual(structured);
    expect((structured as { value: number }).value).toBe(1.2);
    expect(added.result!.content[0].text).toContain('Saved (backup:');

    const read = await call(path, 'read_record');
    expect(OUTPUTS.read_record.parse(read.result!.structuredContent)).toBeTruthy();
    expect(JSON.stringify(read.result!.structuredContent)).not.toContain('SECRET-CAPABILITY-TOKEN');

    const refused = await call(path, 'add_measurement', { metricType: 'hdl' });
    expect(refused.result!.isError).toBe(true);
    expect(refused.result!.structuredContent).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('US-35 AC11 — import_documents is listed here and refuses here', () => {
  it('points at the website or the hosted connector, and leaves the file exactly as it was', async () => {
    const { dir, path } = writeFixture(fixture());
    const before = readFileSync(path, 'utf8');
    const response = await call(path, 'import_documents', {});
    expect(response.result!.isError).toBe(true);
    expect(text(response)).toMatch(/website|hosted connector/);
    expect(text(response)).toContain('Nothing was read');
    expect(readFileSync(path, 'utf8')).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});
