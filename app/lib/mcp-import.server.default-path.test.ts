/**
 * US-35 AC5, AC10 · the hosted importer with NO extractor passed runs the real
 * model call (`extractOrClassify`), and only that. The network is stubbed at
 * `fetch`, so what is pinned is everything the caller sees: the request the
 * server sends, the tool's answer bytes, the refusal texts and the three
 * counters an import charges (T30: the seam moved from module state to an option).
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./product-events.server', async (importOriginal) => {
  const original = await importOriginal<typeof import('./product-events.server')>();
  return { ...original, recordServerEvent: vi.fn(async () => {}) };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
import { hostedImporter } from './mcp-import.server';
import { connectionKey, IMPORT_FILES_PER_DAY, importFiles, resetMcpMemory, spendWrites, WRITES_PER_HOUR } from './mcp-grants.server';
import { machineFiles } from './rate-limiter';
import { runToolOverSync } from '../../packages/health-core/src/mcp-tools';
import { recordSync } from '../../packages/health-core/src/roadmap-doc';
import { ROADMAP_FILE_NAME } from '../../packages/health-core/src/adapter';
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-09-02T10:00:00.000Z';
const TOKEN = { clientId: 'c.test', provider: 'dropbox' as const, rt: 'connection-pin', exp: 0 };
const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n`);
const FILES = { 'a.pdf': pdf('lab'), 'b.pdf': pdf('refused'), 'c.pdf': pdf('garbled') };
const LAB_ANSWER = JSON.stringify({
  classification: 'lab_report', reportDate: '2026-08-20', document: null, additionalValues: [],
  values: [{ metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high' }],
});
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

interface Sent { url: string; method: string; model: string; maxTokens: number; system: string; blocks: string[]; file: string }

beforeEach(() => {
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 7).toString('base64');
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key');
  resetMcpMemory();
  machineFiles.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.MCP_SEAL_KEYS;
});

/** The model, at fetch: a lab answer for a.pdf, a refusal for b.pdf, unparseable text for c.pdf. */
function stubModel(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const blocks = body.messages[0].content as Array<{ type: string; source?: { data?: string } }>;
    const data = blocks.find((b) => b.source?.data)?.source?.data;
    const file = Object.keys(FILES).find((name) => b64(FILES[name as keyof typeof FILES]) === data) ?? '?';
    sent.push({ url, method: String(init.method), model: body.model, maxTokens: body.max_tokens, system: sha(String(body.system)), blocks: blocks.map((b) => b.type), file });
    if (file === 'a.pdf') return Response.json({ content: [{ type: 'text', text: LAB_ANSWER }], stop_reason: 'end_turn' });
    if (file === 'b.pdf') return Response.json({ content: [], stop_reason: 'refusal' });
    return Response.json({ content: [{ type: 'text', text: 'not json' }], stop_reason: 'end_turn' });
  }));
  return sent;
}

async function folder() {
  const cloud = new MemoryCloud();
  for (const [name, bytes] of Object.entries(FILES)) cloud.docs.set(name, new Blob([bytes]));
  const adapter = new MemoryAdapter(cloud);
  await adapter.write(ROADMAP_FILE_NAME, createEmptyFile({ deviceId: 'test', now: NOW }), null);
  return adapter;
}

function call(adapter: MemoryAdapter, args: unknown) {
  return runToolOverSync(recordSync(adapter, 'mcp', NOW), 'import_documents', args, NOW, {
    importer: hostedImporter({ token: TOKEN, adapter, client: 'claude', maxCorrectionAgeDays: 90 }),
  });
}

describe('T30 · the hosted importer with no extractor passed calls the real model, unchanged', () => {
  it('pins the request, the answer bytes and the counters for one fixed folder import', async () => {
    const sent = stubModel();
    const adapter = await folder();
    const machineBefore = machineFiles.remaining('machine');

    const answer = await call(adapter, {});

    expect(answer.isError).toBe(false);
    const receipt = (answer.structured as { receipt: string }).receipt;
    expect(answer.text.split(receipt).join('<receipt>')).toMatchInlineSnapshot(`"{"phase":"extracted","route":"dropbox","files":[{"name":"a.pdf","status":"extracted","classification":"lab_report","documentDate":"2026-08-20"},{"name":"b.pdf","status":"failed","reason":"refused","hint":"This file could not be read, and trying again will not help. Ask the user for the values, or to enter them on drstanfield.com/pages/roadmap."},{"name":"c.pdf","status":"failed","reason":"unreadable","hint":"The file could not be read as a document. A clearer scan or the original PDF usually works; the website’s upload is another route."}],"candidates":[{"id":"c1","kind":"measurement","metric":"ldl","value":2.8,"unit":"mmol/L","displayValue":"2.8","displayUnit":"mmol/L","recordedAt":"2026-08-20","confidence":"high","sourceFileName":"a.pdf","slot":{"state":"free"}}],"documents":[{"sourceFileName":"a.pdf","title":"Blood test results","type":"pathology_report","date":"2026-08-20"}],"unrecognized":[],"remaining":[],"next":"1 new value(s), 0 already recorded, 0 differ from the record, 1 document(s) to file (titles in documents). Show the user each candidate (value, unit, date, file) and document, then WAIT for their own answer, naming what to file; nothing is written to the record until they confirm.\\nThen call import_documents with commit: the receipt, accept (ids to file), replace (replaceable held_different ids the user asked to overwrite; permanent, never a non-replaceable id), and approval: the user’s own words, quoted, never a document’s. A commit with empty accept and replace files the documents alone, and is how a declined file stops being offered.\\n2 file(s) were not read: relay each file's hint to the user in plain words.","receipt":"<receipt>","receiptExpiresAt":"2026-09-02T11:00:00.000Z"}"`);
    expect(answer.structured).toEqual(JSON.parse(answer.text));
    // One call per readable file, a re-send for the answer that did not parse; files run three at a time.
    expect(sent.sort((x, y) => x.file.localeCompare(y.file))).toMatchInlineSnapshot(`
      [
        {
          "blocks": [
            "document",
          ],
          "file": "a.pdf",
          "maxTokens": 3072,
          "method": "POST",
          "model": "claude-haiku-5-5",
          "system": "1fe753a6d57d93b3",
          "url": "https://api.anthropic.com/v1/messages",
        },
        {
          "blocks": [
            "document",
          ],
          "file": "b.pdf",
          "maxTokens": 3072,
          "method": "POST",
          "model": "claude-haiku-5-5",
          "system": "1fe753a6d57d93b3",
          "url": "https://api.anthropic.com/v1/messages",
        },
        {
          "blocks": [
            "document",
          ],
          "file": "c.pdf",
          "maxTokens": 3072,
          "method": "POST",
          "model": "claude-haiku-5-5",
          "system": "1fe753a6d57d93b3",
          "url": "https://api.anthropic.com/v1/messages",
        },
        {
          "blocks": [
            "document",
          ],
          "file": "c.pdf",
          "maxTokens": 3072,
          "method": "POST",
          "model": "claude-haiku-5-5",
          "system": "1fe753a6d57d93b3",
          "url": "https://api.anthropic.com/v1/messages",
        },
      ]
    `);
    // Three files charged to the connection and the machine; one write each.
    const key = connectionKey(TOKEN);
    expect(importFiles.remaining(key)).toBe(IMPORT_FILES_PER_DAY - 3);
    expect(machineFiles.remaining('machine')).toBe(machineBefore - 3);
    expect(spendWrites(key, WRITES_PER_HOUR - 3)).toBe(true);
    expect(spendWrites(key, 1)).toBe(false);
  });

  it('pins the refusal texts that come before any model call', async () => {
    const sent = stubModel();
    const adapter = await folder();
    const missing = await call(adapter, { fileNames: ['nope.pdf'] });
    expect([missing.isError, missing.text]).toMatchInlineSnapshot(`
      [
        true,
        "“nope.pdf” is not an importable file in the folder root. Nothing was read. The folder holds: a.pdf, b.pdf, c.pdf.",
      ]
    `);
    const empty = await call(new MemoryAdapter(new MemoryCloud()), {});
    expect([empty.isError, empty.text]).toMatchInlineSnapshot(`
      [
        true,
        "There are no PDF, JPEG, PNG or ZIP files in the folder root (Apps/Health Plan by Dr Brad). Put the files there and ask again, or drop them into the chat, from any device. Nothing was read.",
      ]
    `);
    expect(sent).toEqual([]);
    expect(importFiles.remaining(connectionKey(TOKEN))).toBe(IMPORT_FILES_PER_DAY);
  });
});
