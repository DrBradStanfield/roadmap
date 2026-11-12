/**
 * Lead T9: pins that the hosted MCP's `savedNote` (app/lib/mcp.server.ts),
 * which does not read the save's `warning`, never has a warning to read.
 *
 * Of the REST adapters only Google Drive returns one, and only for a write
 * that passes an unreadable copy's hold (drive-rest.ts, `writeDriveRecord`).
 * The hold lets through only a write whose eraseEpoch is past every readable
 * copy's, which is an erase.
 *
 * Pin 1: a tool write over a Drive record with one unreadable copy is
 * refused, writes nothing, and its answer carries no warning.
 * Pin 2: no MCP tool's write raises the record's eraseEpoch.
 *
 * Test-only. Synthetic records and a fake Drive in memory, no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { createCoreRow } from './blood-tests';
import { DriveAdapter } from './drive-rest';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { MCP_TOOLS, OUTPUTS, runToolOverSync, type ExtractedFile, type ImportPayload, type ImportSurface } from './mcp-tools';
import { recordSync, ROADMAP_DOC } from './roadmap-doc';
import { createEmptyFile, createMeasurement, CURRENT_SCHEMA_VERSION, type RoadmapFile } from './roadmap-file';
import { describeStorageFailure, isStorageFailure } from './sync-manager';

const NOW = '2026-09-01T09:00:00.000Z';
const TODAY = NOW.slice(0, 10);
const EPOCH = 3;
const SAVED = 'Saved to the user’s Google Drive.';
/** Words of drive-rest's ERASE_KEPT_COPY text. */
const KEPT_COPY = 'the erase left it untouched';

/** A readable record at erase counter EPOCH, holding one weight and one LDL row made after the erase. */
function record(): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'synthetic', now: NOW });
  file.meta = { ...file.meta, eraseEpoch: EPOCH, erasedAt: '2026-01-01T00:00:00.000Z' };
  Object.assign(file.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem: 'si' });
  file.measurements.push(createMeasurement({
    id: 'w1', metricType: 'weight', value: 82, recordedAt: '2026-07-05',
    createdAt: '2026-07-05T08:00:00Z', source: 'manual',
  }));
  file.labValues.push(createCoreRow({
    id: 'm1', metric: 'ldl', value: 3.4, recordedAt: '2026-07-14',
    createdAt: '2026-07-14T08:00:00Z', source: 'lab_import',
  }));
  return file;
}

// ---------------------------------------------------------------------------
// Pin 1 — Drive, with one unreadable copy
// ---------------------------------------------------------------------------

/**
 * Drive v3 in memory, holding two copies of the record. Only the calls a
 * record read and write make are answered; anything else is a 500, so an
 * unexpected request fails the test. Every upload is counted.
 */
class TwoCopyDrive {
  files = new Map<string, { content: string; version: number }>();
  uploads: string[] = [];

  constructor(readable: string, unreadable: string) {
    this.files.set('copy-a', { content: readable, version: 1 });
    this.files.set('copy-b', { content: unreadable, version: 1 });
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => this.handle(new URL(String(input)), init));
  }

  private async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    if (url.pathname.startsWith('/upload/')) {
      this.uploads.push(`${method} ${url.pathname}`);
      return new Response('unexpected upload', { status: 500 });
    }
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = decodeURIComponent(url.searchParams.get('q') ?? '');
      if (!q.includes(`name='${ROADMAP_FILE_NAME}'`)) return new Response('unhandled', { status: 500 });
      return Response.json({ files: [...this.files.keys()].map((id) => ({ id })) });
    }
    const id = /\/drive\/v3\/files\/([^/?]+)$/.exec(url.pathname)?.[1];
    const file = id ? this.files.get(id) : undefined;
    if (!file || method !== 'GET') return new Response('unhandled', { status: 500 });
    if (url.searchParams.get('alt') === 'media') return new Response(file.content);
    if (url.searchParams.get('fields') === 'version') return Response.json({ version: String(file.version) });
    return new Response('unhandled', { status: 500 });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The unreadable copy, and words of the hold's refusal it should meet. */
const UNREADABLE: Array<[string, string, string]> = [
  ['damaged JSON', '{"schemaVersion": 3, "meta": {"eraseEpoch": 2', 'saving is paused'],
  ['a newer schema', JSON.stringify({ ...record(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 }), 'written by a newer version of the app'],
];

describe('Lead T9 pin 1: a hosted tool write over a Drive record with an unreadable copy', () => {
  it.each(UNREADABLE)('with %s, is refused, writes nothing, and carries no warning', async (_label, unreadable, refusal) => {
    const drive = new TwoCopyDrive(JSON.stringify(record()), unreadable);
    const before = new Map([...drive.files].map(([id, f]) => [id, { ...f }]));
    const warnings: Array<string | undefined> = [];
    // As app/lib/mcp.server.ts builds it: recordSync over the adapter, and a savedNote.
    const sync = recordSync(new DriveAdapter('test-token-good'), 'mcp', NOW);
    const call = runToolOverSync(sync, 'add_measurement', { metricType: 'weight', value: 80, recordedAt: TODAY }, NOW, {
      latestDay: TODAY,
      savedNote: (warning) => {
        warnings.push(warning);
        return SAVED;
      },
    });

    const error = await call.then(() => null, (e: unknown) => e);
    // The hosted server words a storage failure as its refusal.
    expect(error).not.toBeNull();
    expect(isStorageFailure(error)).toBe(true);
    const failed = describeStorageFailure(error, 'The record in Google Drive');
    const answer = `${failed.message}. ${failed.hint}`;
    expect(answer).toContain(refusal);
    expect(answer).not.toContain(KEPT_COPY);
    expect(answer).not.toContain('Saved');
    expect(warnings).toEqual([]);
    expect(drive.uploads).toEqual([]);
    expect(drive.files).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Pin 2 — no tool raises eraseEpoch
// ---------------------------------------------------------------------------

const folderFile: ExtractedFile = {
  name: 'folder-labs.pdf', contentHash: 'sha256-folder', mimeType: 'application/pdf', status: 'extracted',
  result: {
    classification: 'lab_report', reportDate: '2026-08-20', document: null, additionalValues: [], unrecognized: [],
    values: [{ metric: 'ferritin', valueSI: 120, displayValue: 120, displayUnit: 'ug/L', displaySystem: 'si', confidence: 'high' }],
  },
};

function memoryRecord() {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(record()), version: 1 });
  const sync = recordSync(new MemoryAdapter(cloud), 'mcp', NOW);
  const pending = new Map<string, ImportPayload>();
  const importer: ImportSurface = {
    budgetMs: 10_000,
    maxCorrectionAgeDays: 90,
    async extract() { return { route: 'dropbox', remaining: [], files: [folderFile] }; },
    async stash(payload) { pending.set(payload.id, payload); return { receipt: payload.id, expiresAt: '2026-09-01T10:00:00Z' }; },
    async open(commit) { return pending.get(commit.receipt) ?? { refusal: 'Unknown synthetic receipt.' }; },
    async discard(payload) { pending.delete(payload.id); },
  };
  const saved = () => ROADMAP_DOC.migrate(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json), { deviceId: 'check', now: NOW });
  const version = () => cloud.files.get(ROADMAP_FILE_NAME)!.version;
  return { sync, importer, saved, version };
}

/** An import tool's read phase, then its commit of every candidate. */
async function readThenCommit(tool: 'import_documents' | 'file_results', args: unknown, env: ReturnType<typeof memoryRecord>) {
  const options = { importer: env.importer, latestDay: TODAY, savedNote: () => SAVED };
  const read = await runToolOverSync(env.sync, tool, args, NOW, options);
  expect(read.isError, read.text).toBe(false);
  const out = OUTPUTS[tool].parse(read.structured);
  return runToolOverSync(env.sync, tool, { commit: { receipt: out.receipt, accept: out.candidates.map((c) => c.id), replace: [], approval: 'yes, file them' } }, NOW, options);
}

/**
 * Every tool in MCP_TOOLS that writes the record, each run once with valid
 * arguments. Left out: read_record and get_plan (read-only) and
 * report_feedback (record-free; runToolOverSync throws if one returns a file).
 */
const WRITES: Record<string, (env: ReturnType<typeof memoryRecord>) => ReturnType<typeof runToolOverSync>> = {
  add_measurement: (env) => runToolOverSync(env.sync, 'add_measurement', { metricType: 'weight', value: 80, recordedAt: TODAY }, NOW, { latestDay: TODAY }),
  add_lab_values: (env) => runToolOverSync(env.sync, 'add_lab_values', { values: [{ metricName: 'tsh', value: 2.3, unit: 'mIU/L', recordedAt: TODAY }] }, NOW, { latestDay: TODAY }),
  correct_value: (env) => runToolOverSync(env.sync, 'correct_value', { id: 'm1', newValue: 2.1 }, NOW, { latestDay: TODAY }),
  update_profile: (env) => runToolOverSync(env.sync, 'update_profile', { heightCm: 180 }, NOW, { latestDay: TODAY }),
  import_documents: (env) => readThenCommit('import_documents', {}, env),
  file_results: (env) => readThenCommit('file_results', {
    sourceFileName: 'Results.pdf', classification: 'lab_report', collectedOn: '2026-08-20',
    values: [{ metric: 'Ferritin', printedName: 'Ferritin', value: 180, unit: 'ug/L' }],
  }, env),
};

describe('Lead T9 pin 2: no MCP tool write raises the record’s eraseEpoch', () => {
  it('the table covers every tool that is not read-only or record-free', () => {
    const writers = MCP_TOOLS.filter((t) => !t.annotations.readOnlyHint && t.run !== 'record-free').map((t) => t.name).sort();
    expect(Object.keys(WRITES).sort()).toEqual(writers);
  });

  it.each(Object.keys(WRITES))('%s saves and leaves eraseEpoch where it was', async (tool) => {
    const env = memoryRecord();
    expect(env.saved().meta.eraseEpoch).toBe(EPOCH);
    const answer = await WRITES[tool](env);
    expect(answer.isError, answer.text).toBe(false);
    expect(env.version()).toBeGreaterThan(1); // it wrote
    expect(env.saved().meta.eraseEpoch).toBe(EPOCH);
  });
});
