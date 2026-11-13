/**
 * Lead TA-2 (test audit): no real writer saves a record whose last-write-wins
 * stamp is later than the record's own `meta.updatedAt`. Such a stamp is
 * clamped back by `migrateFile` (sanitizeStamp, migrate.ts) and can then lose
 * a tie it should have won (US-10 AC8). Found when a test helper wrote one
 * (PR 1587); this file asks whether any writer can.
 *
 * Each writer runs for real on a record whose every stamp sits AT its
 * `meta.updatedAt` (the tightest case), with the writer's clock an hour ahead
 * of the record and an hour behind it (another device's clock ran fast). The
 * RAW result is walked generically (stamp-anchor.test-helpers.ts), never the
 * migrated copy, which would hide a clamp.
 *
 * Here: health-core's own writers, which the web store, the iPhone engine, the
 * CLI and both MCP servers call; erase, merge and migrate; and the MCP tools
 * over the stdio server's FileAdapter and the hosted server's Dropbox REST
 * adapter. The web store, the engine doors and the CLI have their own files
 * (roadmap-store-stamp-anchor.test.ts, ios/engine/stamp-anchor.test.ts,
 * ios/engine/cloud.test.ts, tools/edit-record-stamp-anchor.test.ts).
 *
 * Test-only. Synthetic records, no network.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { importDeviceSamples } from './device-import';
import { DropboxAdapter } from './dropbox-rest';
import { buildErasedFile } from './erase';
import { FileAdapter } from './file-adapter';
import { importHealthRecords } from './health-records-import';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { mergeFiles } from './merge';
import { type ImportPayload, type ImportSurface } from './mcp-import';
import { MCP_TOOLS } from './mcp-tool-catalogue';
import { OUTPUTS, runToolOverSync, updateProfile } from './mcp-tools';
import { migrateFile } from './migrate';
import {
  addLabValue, appendLabValue, appendMeasurement, bulkAppendValues, correctValue, moveBloodTest, placeMeasurement, planBloodTestMove,
} from './record-edits';
import { recordSync } from './roadmap-doc';
import { createMeasurement, stableStringify, type RoadmapFile } from './roadmap-file';
import { setReminderOptIn, setScreening, stampProfile, upsertMedication, upsertSupplement } from './state-edits';
import { stampCount, stampedRecord, stampsAheadOfMeta } from './stamp-anchor.test-helpers';

const T0 = '2026-09-01T09:00:00.000Z';
const CLOCKS = { ahead: '2026-09-01T10:00:00.000Z', behind: '2026-09-01T08:00:00.000Z' } as const;
const DAY = '2026-08-20'; // stampedRecord's rows
const NEW_DAY = '2026-08-25';

/** stampedRecord at T0: every stamp equals `meta.updatedAt`. */
function base(): RoadmapFile {
  const file = stampedRecord(T0);
  expect(file.meta.updatedAt).toBe(T0);
  return file;
}

/** A writer's result is clean: a stamp sits past the file's clock nowhere. */
function expectNoStampAhead(written: unknown): void {
  expect(stampCount(written)).toBeGreaterThan(0);
  expect(stampsAheadOfMeta(written)).toEqual([]);
}

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`writer refused: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

describe('TA-2 helper: stampsAheadOfMeta', () => {
  it('names a field stamp, a row stamp and an opt-in stamp past meta.updatedAt, by path', () => {
    const file = base();
    file.profile.fieldStamps!.sex = { updatedAt: '2026-09-01T09:00:01.000Z', lamport: 1 };
    file.medications[0].updatedAt = '2026-09-01T09:00:01Z';
    file.reminderOptIn!.updatedAt = '2026-09-01T21:30:00+12:00'; // 09:30Z, spelled with an offset
    expect(stampsAheadOfMeta(file)).toEqual(['profile.fieldStamps.sex.updatedAt', 'medications[0].updatedAt', 'reminderOptIn.updatedAt']);
  });

  it('passes a stamp equal to meta.updatedAt as an instant, however it is spelled, and ignores meta itself', () => {
    const file = base();
    file.profile.updatedAt = '2026-09-01T21:00:00+12:00';
    expect(stampsAheadOfMeta(file)).toEqual([]);
    expect(stampCount(file)).toBeGreaterThan(5);
  });

  it('reports an unreadable meta.updatedAt', () => {
    expect(stampsAheadOfMeta({ meta: {}, profile: { updatedAt: T0 } })).toEqual(['meta.updatedAt']);
  });

  it('the clamp it guards is real: migrate rewinds a stamp past meta.updatedAt', () => {
    const file = base();
    file.medications[0].updatedAt = CLOCKS.ahead;
    expect(migrateFile(JSON.parse(JSON.stringify(file)), { deviceId: 'd', now: T0 }).medications[0].updatedAt).toBe(T0);
  });
});

/** health-core's writers, each as its callers call it. */
const WRITERS: Record<string, (file: RoadmapFile, now: string) => RoadmapFile> = {
  // CLI add, both MCP servers' add_measurement, the engine's add.
  appendMeasurement: (file, now) => ok(appendMeasurement(file, { metricType: 'weight', value: 80, recordedAt: NEW_DAY, now })).file,
  // The web store's addMeasurement and saveChangedMeasurements.
  placeMeasurement: (file, now) => ok(placeMeasurement(file, { metricType: 'waist', value: 90, recordedAt: NEW_DAY, now })).file,
  // CLI add for a lab test, add_lab_values.
  appendLabValue: (file, now) => ok(appendLabValue(file, { metricName: 'ferritin', value: 120, unit: 'ug/L', recordedAt: NEW_DAY, now })).file,
  // The web store's addLabValue, the engine's labAdd and labAddName.
  addLabValue: (file, now) => ok(addLabValue(file, { metricName: 'TSH', unit: 'mIU/L', value: 2.1, day: NEW_DAY }, now)).file,
  // Every correct path: web, CLI, correct_value, the engine.
  correctValue: (file, now) => ok(correctValue(file, { id: 'w1', newValue: 81, now })).file,
  // The web store's moveBloodTest.
  moveBloodTest: (file, now) => {
    const plan = planBloodTestMove(file, DAY, NEW_DAY, { now });
    if (!('rows' in plan)) throw new Error(plan.message);
    return ok(moveBloodTest(file, { from: DAY, to: NEW_DAY, expectedIds: plan.rows.map((r) => r.id), keep: {}, now })).file;
  },
  // Lab import saves: the web's bulk saves and the engine's labImport.
  bulkAppendValues: (file, now) => bulkAppendValues(file, [
    { kind: 'lab', metricName: 'hba1c', value: 40, unit: 'mmol/mol', recordedAt: NEW_DAY, source: 'lab_import' },
    { kind: 'lab', metricName: 'Ferritin', value: 85, unit: 'ug/L', recordedAt: NEW_DAY, source: 'lab_import' },
  ], now).file,
  'upsertMedication (edit)': (file, now) => upsertMedication(file, { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' }, now).file,
  'upsertMedication (new key)': (file, now) => upsertMedication(file, { medicationKey: 'ezetimibe', drugName: 'yes', doseValue: null, doseUnit: null }, now).file,
  'upsertSupplement (dose)': (file, now) => upsertSupplement(file, { supplementKey: 'vitamin_d', supplementName: 'Vitamin D', doseValue: 2000, doseUnit: 'IU', status: 'active' }, now).file,
  'upsertSupplement (stop)': (file, now) => upsertSupplement(file, { supplementKey: 'vitamin_d', supplementName: 'Vitamin D', doseValue: 1000, doseUnit: 'IU', status: 'stopped' }, now).file,
  'stampProfile (profile edit)': (file, now) => stampProfile(file, { heightCm: 180, birthMonth: null as unknown as undefined }, now),
  'stampProfile (unit switch)': (file, now) => stampProfile(file, { unitSystem: 'conventional' }, now),
  'stampProfile (Lp(a) unit)': (file, now) => stampProfile(file, { lpaUnit: 'mg/dL' }, now),
  'stampProfile (report email)': (file, now) => stampProfile(file, { reportEmailCaptured: true }, now),
  setScreening: (file, now) => setScreening(file, 'colorectal_last_date', '2025-03', now),
  'setReminderOptIn (cancel)': (file, now) => setReminderOptIn(file, { status: 'cancelled', token: 'test-token-good', email: 'a@example.com', provider: 'dropbox' }, now),
  // update_profile on both MCP servers, the engine's profile edit.
  updateProfile: (file, now) => {
    const outcome = updateProfile(file, { heightCm: 181, sex: 'male' }, now);
    if (outcome.status !== 'ok' || !outcome.file) throw new Error(outcome.text);
    return outcome.file;
  },
  // Apple Health samples (the engine's appleHealth edit).
  importDeviceSamples: (file, now) => importDeviceSamples(file, [
    { externalId: 'hk-1', metricType: 'weight', value: 80, measuredAt: `${NEW_DAY}T08:30:00+12:00` },
  ], { now, source: 'apple_health' }).file,
  // Apple Health Records (the engine's healthRecords edit).
  importHealthRecords: (file, now) => importHealthRecords(file, [{
    sourceId: 'src', resourceType: 'Observation', fhirVersion: '4.0.1', json: JSON.stringify({
      resourceType: 'Observation', id: 'hdl-1', status: 'final', effectiveDateTime: NEW_DAY, meta: { versionId: '1' },
      code: { coding: [{ system: 'http://loinc.org', code: '2085-9' }] },
      valueQuantity: { value: 1.3, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' },
    }),
  }], { now }).file,
};

describe('TA-2: health-core writers stamp nothing past meta.updatedAt', () => {
  for (const [clock, now] of Object.entries(CLOCKS)) {
    it.each(Object.keys(WRITERS))(`%s, writer clock ${clock} of the record`, (name) => {
      const before = base();
      const written = JSON.parse(JSON.stringify(WRITERS[name](before, now)));
      expect(stableStringify(written)).not.toBe(stableStringify(before)); // it wrote
      expectNoStampAhead(written);
    });
  }
});

describe('TA-2: erase, merge and migrate', () => {
  for (const [clock, now] of Object.entries(CLOCKS)) {
    it(`buildErasedFile, eraser clock ${clock} of the stored record`, () => {
      const stored = base();
      const erased = buildErasedFile({ stored, own: base(), device: null, ctx: { deviceId: 'eraser', now } });
      expect(erased.meta.eraseEpoch).toBe(1);
      expect(erased.reminderOptIn?.status).toBe('cancelled');
      expectNoStampAhead(JSON.parse(JSON.stringify(erased)));
      // The save merges it with the stored copy: that write is clean too.
      expectNoStampAhead(JSON.parse(JSON.stringify(mergeFiles(erased, stored, { deviceId: 'eraser', now }))));
    });

    it(`mergeFiles of two edited copies, merging clock ${clock}`, () => {
      const a = stampProfile(base(), { heightCm: 180 }, CLOCKS.ahead);
      const b = upsertMedication(base(), { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 5, doseUnit: 'mg' }, CLOCKS.behind).file;
      const merged = JSON.parse(JSON.stringify(mergeFiles(a, b, { deviceId: 'm', now })));
      expect(merged.profile.heightCm).toBe(180);
      expectNoStampAhead(merged);
    });

    it(`migrateFile of a legacy file with no meta and blood tests in measurements, reader clock ${clock}`, () => {
      const legacy = JSON.parse(JSON.stringify(base()));
      delete legacy.meta;
      legacy.measurements.push({ ...createMeasurement({ id: 'old-ldl', metricType: 'ldl', value: 3, recordedAt: '2026-08-01', createdAt: T0 }) });
      const migrated = migrateFile(legacy, { deviceId: 'r', now });
      expect(migrated.labValues.some((row) => row.core === true && row.recordedAt.startsWith('2026-08-01'))).toBe(true);
      expectNoStampAhead(JSON.parse(JSON.stringify(migrated)));
    });
  }
});

// ---------------------------------------------------------------------------
// The MCP tools, through runToolOverSync, over each server's adapter
// ---------------------------------------------------------------------------

/** The same five tool writes as the T9 pins, plus the two-phase file_results. */
function toolWrites(now: string): Record<string, (env: Env) => ReturnType<typeof runToolOverSync>> {
  const day = NEW_DAY;
  const options = (env: Env) => ({ importer: env.importer, latestDay: now.slice(0, 10), savedNote: () => 'saved' });
  return {
    add_measurement: (env) => runToolOverSync(env.sync, 'add_measurement', { metricType: 'weight', value: 80, recordedAt: day }, now, { latestDay: now.slice(0, 10) }),
    add_lab_values: (env) => runToolOverSync(env.sync, 'add_lab_values', { values: [{ metricName: 'tsh', value: 2.3, unit: 'mIU/L', recordedAt: day }] }, now, { latestDay: now.slice(0, 10) }),
    correct_value: (env) => runToolOverSync(env.sync, 'correct_value', { id: 'l1', newValue: 2.1 }, now, { latestDay: now.slice(0, 10) }),
    update_profile: (env) => runToolOverSync(env.sync, 'update_profile', { heightCm: 180 }, now, { latestDay: now.slice(0, 10) }),
    import_documents: async (env) => commitAll('import_documents', {}, env, now, options(env)),
    file_results: async (env) => commitAll('file_results', {
      sourceFileName: 'Results.pdf', classification: 'lab_report', collectedOn: day,
      values: [{ metric: 'Ferritin', printedName: 'Ferritin', value: 180, unit: 'ug/L' }],
    }, env, now, options(env)),
  };
}

async function commitAll(tool: 'import_documents' | 'file_results', args: unknown, env: Env, now: string, options: Parameters<typeof runToolOverSync>[4]) {
  const read = await runToolOverSync(env.sync, tool, args, now, options);
  expect(read.isError, read.text).toBe(false);
  const out = OUTPUTS[tool].parse(read.structured);
  return runToolOverSync(env.sync, tool, { commit: { receipt: out.receipt, accept: out.candidates.map((c) => c.id), replace: [], approval: 'yes, file them' } }, now, options);
}

interface Env {
  sync: ReturnType<typeof recordSync>;
  importer: ImportSurface;
  /** The record's bytes as stored, unmigrated. */
  raw(): unknown;
  writes(): number;
}

function importer(): ImportSurface {
  const pending = new Map<string, ImportPayload>();
  return {
    budgetMs: 10_000,
    maxCorrectionAgeDays: 90,
    async extract() {
      return { route: 'dropbox', remaining: [], files: [{
        name: 'folder-labs.pdf', contentHash: 'sha256-folder', mimeType: 'application/pdf', status: 'extracted',
        result: {
          classification: 'lab_report', reportDate: NEW_DAY, document: null, additionalValues: [], unrecognized: [],
          values: [{ metric: 'ferritin', valueSI: 120, displayValue: 120, displayUnit: 'ug/L', displaySystem: 'si', confidence: 'high' }],
        },
      }] };
    },
    async stash(payload) { pending.set(payload.id, payload); return { receipt: payload.id, expiresAt: '2026-09-02T10:00:00Z' }; },
    async open(commit) { return pending.get(commit.receipt) ?? { refusal: 'Unknown synthetic receipt.' }; },
    async discard(payload) { pending.delete(payload.id); },
  };
}

/** The stdio MCP server's and the CLI's adapter: the record as a file on disk. */
const dirs: string[] = [];
function onDisk(now: string): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ta2-'));
  dirs.push(dir);
  const path = join(dir, ROADMAP_FILE_NAME);
  writeFileSync(path, JSON.stringify(base()));
  let writes = 0;
  const adapter = new FileAdapter(path);
  const write = adapter.write.bind(adapter);
  adapter.write = (...args) => { writes += 1; return write(...args); };
  return { sync: recordSync(adapter, 'mcp-stdio', now), importer: importer(), raw: () => JSON.parse(readFileSync(path, 'utf8')), writes: () => writes };
}

/** The hosted MCP server's adapter: Dropbox's two content endpoints in memory. */
function inDropbox(now: string): Env {
  const box = { text: JSON.stringify(base()), rev: 1, writes: 0 };
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const arg = JSON.parse(new Headers(init?.headers).get('Dropbox-API-Arg') ?? '{}') as { path?: string; mode?: { '.tag': string; update?: string } };
    if (arg.path !== `/${ROADMAP_FILE_NAME}`) return new Response('unhandled', { status: 500 });
    if (url.endsWith('/files/download')) {
      return new Response(box.text, { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `r${box.rev}` }) } });
    }
    if (url.endsWith('/files/upload')) {
      if (arg.mode?.update !== `r${box.rev}`) return new Response('{"error_summary":"path/conflict/file/"}', { status: 409 });
      box.text = String(init?.body);
      box.rev += 1;
      box.writes += 1;
      return Response.json({ rev: `r${box.rev}` });
    }
    return new Response('unhandled', { status: 500 });
  });
  return { sync: recordSync(new DropboxAdapter('test-token-good'), 'mcp-hosted', now), importer: importer(), raw: () => JSON.parse(box.text), writes: () => box.writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TA-2: MCP tool writes over the stdio FileAdapter and the hosted Dropbox adapter', () => {
  it('the table covers every tool that writes the record', () => {
    const writers = MCP_TOOLS.filter((t) => !t.annotations.readOnlyHint && t.run !== 'record-free').map((t) => t.name).sort();
    expect(Object.keys(toolWrites(T0)).sort()).toEqual(writers);
  });

  for (const [surface, open] of [['stdio FileAdapter', onDisk], ['hosted Dropbox', inDropbox]] as const) {
    for (const [clock, now] of Object.entries(CLOCKS)) {
      it.each(Object.keys(toolWrites(now)))(`%s over the ${surface}, server clock ${clock} of the record`, async (tool) => {
        const env = open(now);
        const answer = await toolWrites(now)[tool](env);
        expect(answer.isError, answer.text).toBe(false);
        expect(env.writes()).toBeGreaterThan(0);
        expectNoStampAhead(env.raw());
      });
    }
  }
});

describe('TA-2: the in-memory adapter the tests above stand beside', () => {
  it('a SyncManager save of an edit is clean, its clock behind the record', async () => {
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(base()), version: 1 });
    const sync = recordSync(new MemoryAdapter(cloud), 'm', CLOCKS.behind);
    await sync.save(setScreening(await sync.load(), 'colorectal_last_date', '2025-03', CLOCKS.behind));
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(2);
    expectNoStampAhead(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json));
  });
});
