/**
 * US-35 · the hosted half of `import_documents`, piece by piece.
 *
 * What is pinned here: the type of a file is its bytes (AC4), a ZIP is opened
 * under caps that a bomb cannot talk its way past (AC5), and a receipt is a
 * plain UUID whose pending file carries a MAC bound to one connection, failing
 * closed on any tamper (AC7). The whole flow over a folder is `mcp.hosted.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
vi.mock('./product-events.server', async (importOriginal) => {
  const original = await importOriginal<typeof import('./product-events.server')>();
  return { ...original, recordServerEvent: vi.fn(async () => {}) };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
import * as Sentry from '@sentry/react-router';
import {
  hostedImporter,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ZIP_BYTES,
  MCP_IMPORT_BUDGET_MS,
  setImportSeams,
  sniff,
  unzip,
} from './mcp-import.server';
import { resourceUrl } from './mcp-config.server';
import { chargeWrites, connectionKey, IMPORT_FILES_PER_DAY, importFiles, resetMcpMemory, WRITES_PER_HOUR } from './mcp-grants.server';
import { seal } from './mcp-seal.server';
import { machineFiles } from './rate-limiter';
import { type ImportPayload, MAX_IMPORT_FILES_PER_CALL, MAX_RECEIPT_LENGTH, OUTPUTS, runToolOverSync } from '../../packages/health-core/src/mcp-tools';
import { recordSync } from '../../packages/health-core/src/roadmap-doc';
import { IMPORT_REFUSALS } from '../../packages/health-core/src/import-hints';
import { ROADMAP_FILE_NAME, StorageError } from '../../packages/health-core/src/adapter';
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';

/** The user's own words, quoted in every commit (US-35 AC7, 2026-10-07). */
const APPROVED = 'Yes, file them';
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\nendobj\n');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

beforeEach(() => {
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MCP_SEAL_KEYS;
});

describe('US-35 AC4 — type by magic bytes, never by name or declared mime', () => {
  it('names PDF, ZIP, JPEG and PNG, and nothing else', async () => {
    expect(sniff(PDF)).toBe('application/pdf');
    expect(sniff(new Uint8Array(await new JSZip().file('a.pdf', PDF).generateAsync({ type: 'uint8array' })))).toBe('application/zip');
    expect(sniff(JPEG)).toBe('image/jpeg');
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(new TextEncoder().encode('hello'))).toBeNull();
    expect(sniff(new Uint8Array(0))).toBeNull();
  });
});

describe('US-35 AC5 — a ZIP is opened under caps, by position, with a counted inflate', () => {
  async function zipOf(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  }

  it('keeps importable entries with their bytes and sniffed type, drops junk silently, names a nested zip', async () => {
    const bytes = await zipOf({
      'Blood tests/lipids.pdf': PDF,
      'scan.jpg': JPEG,
      '__MACOSX/._lipids.pdf': PDF,
      '.DS_Store': 'junk',
      'notes.txt': 'not a lab file',
      'inner.zip': await zipOf({ 'x.pdf': PDF }),
      'renamed.pdf': new TextEncoder().encode('plain text wearing a pdf name'),
    });
    const { entries, skipped } = await unzip(bytes);
    expect(entries.map((e) => [e.name, e.mimeType])).toEqual([
      ['Blood tests/lipids.pdf', 'application/pdf'],
      ['scan.jpg', 'image/jpeg'],
    ]);
    expect(skipped).toEqual([
      { name: 'inner.zip', reason: 'nested_zip' },
      { name: 'renamed.pdf', reason: 'unsupported' },
    ]);
  });

  it('takes at most MAX_IMPORT_FILES_PER_CALL entries and names the rest too_many', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_IMPORT_FILES_PER_CALL + 2; i++) files[`f${String(i).padStart(2, '0')}.pdf`] = PDF;
    const { entries, skipped } = await unzip(await zipOf(files));
    expect(entries).toHaveLength(MAX_IMPORT_FILES_PER_CALL);
    expect(skipped.map((s) => s.reason)).toEqual(['too_many', 'too_many']);
  });

  it('stops inflating an entry past the cap — a bomb never fills memory', async () => {
    // A highly compressible 6 MB entry: declared size is real here, and the
    // inflate is counted regardless of what the directory claims.
    const big = new Uint8Array(MAX_IMPORT_FILE_BYTES + 1024);
    big.set(PDF);
    const { entries, skipped } = await unzip(await zipOf({ 'bomb.pdf': big, 'ok.pdf': PDF }));
    expect(skipped).toEqual([{ name: 'bomb.pdf', reason: 'too_large' }]);
    expect(entries.map((e) => e.name)).toEqual(['ok.pdf']);
  });

  it('strips control characters from an entry name; a name is a label, not a path', async () => {
    const { entries } = await unzip(await zipOf({ 'evil\u0007\u007f.pdf': PDF }));
    expect(entries[0].name).toBe('evil.pdf');
  });
});

describe('US-35 AC7 — the receipt is the pending file’s own UUID, and the MAC in that file binds it to one connection', () => {
  const NOW = '2026-09-02T10:00:00.000Z';
  const PAYLOAD: ImportPayload = { id: '1111aaaa-2222-4333-8444-5555555555bb', route: 'dropbox', createdAt: NOW, candidates: [], documents: [] };
  const PENDING = `imports/pending-${PAYLOAD.id}.json`;
  const file = createEmptyFile({ deviceId: 'test', now: NOW });

  /** The surface for one connection over one in-memory folder — the receipt is minted and opened here and nowhere else. */
  function surfaceFor(rt: string, cloud = new MemoryCloud(), clientId = 'c.test') {
    return hostedImporter({ token: { clientId, provider: 'dropbox', rt, exp: 0 }, adapter: new MemoryAdapter(cloud), client: 'claude', maxCorrectionAgeDays: 90 });
  }
  const deadline = () => Date.now() + MCP_IMPORT_BUDGET_MS;
  async function stashed(surface: ReturnType<typeof surfaceFor>) {
    const answer = await surface.stash(PAYLOAD, deadline());
    if ('refusal' in answer) throw new Error(answer.refusal);
    return answer;
  }
  async function refusalOf(surface: ReturnType<typeof surfaceFor>, receipt: string, now = NOW) {
    const answer = await surface.open({ receipt, accept: [], replace: [], approval: APPROVED }, file, now, deadline());
    return 'refusal' in answer ? answer.refusal : null;
  }
  const pendingOf = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(PENDING)!.json) as Record<string, unknown>;
  const editPending = (cloud: MemoryCloud, edit: (pending: Record<string, unknown>) => unknown) =>
    cloud.files.set(PENDING, { ...cloud.files.get(PENDING)!, json: JSON.stringify(edit(pendingOf(cloud))) });
  /** The whole hourly allowance is still there: nothing was charged. */
  const unchargedOn = (rt: string) => expect(chargeWrites(connectionKey({ rt }), WRITES_PER_HOUR)).toBeNull();

  beforeEach(() => resetMcpMemory());

  it('round-trips: the receipt is the payload id, the file is {v: 2, payload, issued, mac}, and it expires an hour after the extract', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    const { receipt, expiresAt } = await stashed(surface);
    // A plain UUID, nothing encoded: ChatGPT read the old sealed blob as a disguised payload (2026-10-07). The id
    // is readable off the wire on purpose now (the old "not readable" assertion retired): it was never a secret.
    expect(receipt).toBe(PAYLOAD.id);
    expect(receipt.length).toBeLessThanOrEqual(MAX_RECEIPT_LENGTH);
    expect(expiresAt).toBe('2026-09-02T11:00:00.000Z');
    expect(pendingOf(cloud)).toEqual({ v: 2, payload: PAYLOAD, issued: Date.parse(NOW) / 1000, mac: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(await surface.open({ receipt, accept: [], replace: [], approval: APPROVED }, file, NOW, deadline())).toEqual(PAYLOAD);
    // Still good at the last second of its hour.
    expect(await surface.open({ receipt, accept: [], replace: [], approval: APPROVED }, file, '2026-09-02T11:00:00.000Z', deadline())).toEqual(PAYLOAD);
  });

  it('a receipt naming no pending file is told so in words — committed, discarded or mistyped — and charges nothing', async () => {
    const surface = surfaceFor('connection-a');
    await stashed(surface);
    expect(await refusalOf(surface, '99999999-2222-4333-8444-555555555555')).toBe(
      'That receipt names no pending import: it was committed, discarded or mistyped. Nothing was written. Extract again if the user still wants it.',
    );
    unchargedOn('connection-a');
  });

  it('refuses anything that is not a lowercase UUID before it reads a file: uppercase, whitespace, a path, an old sealed blob, empty', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const read = vi.spyOn(adapter, 'read');
    const surface = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'connection-a', exp: 0 }, adapter, client: 'claude', maxCorrectionAgeDays: 90 });
    await stashed(surface);
    // This replaces the forged seal('import') case, retired 2026-10-07 with the sealed import blob itself: a path
    // never passes the UUID check, and an old blob's wire form is refused here even past the schema.
    const oldBlob = seal('state', { clientId: 'c.test', pad: 'x'.repeat(200) }, { clientId: 'c.test', resource: resourceUrl() });
    for (const receipt of [PAYLOAD.id.toUpperCase(), ` ${PAYLOAD.id}`, `${PAYLOAD.id}\n`, '../health-roadmap', oldBlob, '']) {
      expect(await refusalOf(surface, receipt), JSON.stringify(receipt)).toMatch(/not valid for this connection/);
    }
    expect(read).not.toHaveBeenCalled();
    unchargedOn('connection-a');
  });

  it('fails closed on a tampered payload, issue time or MAC, another connection or another client: not valid, nothing charged, the file kept', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    const { receipt } = await stashed(surface);
    const original = cloud.files.get(PENDING)!;
    const tampers: Array<(p: Record<string, unknown>) => unknown> = [
      (p) => ({ ...p, payload: { ...PAYLOAD, candidates: [{ id: 'c1' }] } }),
      (p) => ({ ...p, issued: (p.issued as number) + 3600 }), // an hour bought by editing the file
      (p) => ({ ...p, mac: (p.mac as string).replace(/^./, (c) => (c === '0' ? '1' : '0')) }),
      (p) => ({ ...p, mac: (p.mac as string).toUpperCase() }),
    ];
    for (const tamper of tampers) {
      editPending(cloud, tamper);
      expect(await refusalOf(surface, receipt), tamper.toString()).toMatch(/not valid for this connection/);
      cloud.files.set(PENDING, original);
    }
    expect(await refusalOf(surfaceFor('connection-b', cloud), receipt)).toMatch(/not valid for this connection/);
    expect(await refusalOf(surfaceFor('connection-a', cloud, 'c.other'), receipt)).toMatch(/not valid for this connection/);
    // `open` never deletes; the file is still there for the honest commit.
    expect(cloud.files.has(PENDING)).toBe(true);
    unchargedOn('connection-a');
    unchargedOn('connection-b');
    resetMcpMemory();
    expect(await surface.open({ receipt, accept: [], replace: [], approval: APPROVED }, file, NOW, deadline())).toEqual(PAYLOAD);
  });

  it('an hour and a second after the extract it has expired, in its own words', async () => {
    const surface = surfaceFor('connection-a');
    const { receipt } = await stashed(surface);
    expect(await refusalOf(surface, receipt, '2026-09-02T11:00:01.000Z')).toMatch(/has expired/);
    unchargedOn('connection-a');
  });

  it('a pending file from before 2026-10-07 (no `v`) is not readable; the name-based sweep below takes it', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    cloud.files.set(PENDING, { json: JSON.stringify(PAYLOAD), version: 1, modified: NOW });
    expect(await refusalOf(surface, PAYLOAD.id)).toMatch(/not readable/);
    unchargedOn('connection-a');
  });

  it('a v2 file with no payload is refused in words, never thrown (US-35 AC7)', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    cloud.files.set(PENDING, { json: JSON.stringify({ v: 2, issued: 1, mac: '0'.repeat(32) }), version: 1, modified: NOW });
    expect(await refusalOf(surface, PAYLOAD.id)).toMatch(/not readable/);
    unchargedOn('connection-a');
  });

  it('a planted v2 file nested too deep to serialise is refused in words, never thrown (US-35 AC7)', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    cloud.files.set(PENDING, { json: `{"v":2,"issued":1,"mac":"${'0'.repeat(32)}","payload":{"deep":${deep}}}`, version: 1, modified: NOW });
    expect(await refusalOf(surface, PAYLOAD.id)).toMatch(/not readable/);
    unchargedOn('connection-a');
    expect(cloud.files.has(PENDING)).toBe(true);
  });

  it('a forged UUID never charges: a planted v2 file with a made-up MAC is not ours', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    cloud.files.set(PENDING, { json: JSON.stringify({ v: 2, payload: PAYLOAD, issued: Date.parse(NOW) / 1000, mac: '0'.repeat(32) }), version: 1, modified: NOW });
    const answer = await surface.open({ receipt: PAYLOAD.id, accept: [], replace: ['c1'], approval: APPROVED }, file, NOW, deadline());
    expect('refusal' in answer && answer.refusal).toMatch(/not valid for this connection/);
    expect(cloud.files.has(PENDING)).toBe(true);
    unchargedOn('connection-a');
  });

  it('refuses an id the receipt does not carry BEFORE charging, so bogus replace ids cost nothing (AC10)', async () => {
    const surface = surfaceFor('connection-a');
    const { receipt } = await stashed(surface);
    const bogus = Array.from({ length: 300 }, (_, i) => `x${i}`);
    const answer = await surface.open({ receipt, accept: [], replace: bogus, approval: APPROVED }, file, NOW, deadline());
    expect('refusal' in answer && answer.refusal).toMatch(/not a candidate/);
    unchargedOn('connection-a');
  });

  it('survives a key rotation: a receipt signed under the previous key still opens, and dies with that key', async () => {
    const surface = surfaceFor('connection-a');
    const { receipt } = await stashed(surface);
    process.env.MCP_SEAL_KEYS = `${Buffer.alloc(32, 8).toString('base64')},${Buffer.alloc(32, 7).toString('base64')}`;
    expect(await surface.open({ receipt, accept: [], replace: [], approval: APPROVED }, file, NOW, deadline())).toEqual(PAYLOAD);
    process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 8).toString('base64');
    expect(await refusalOf(surface, receipt)).toMatch(/not valid/);
  });
});

describe('US-35 AC7 / US-36 AC9 — a commit quotes the user’s approval, checked before anything is read or charged (ChatGPT, 2026-10-07)', () => {
  const NOW = '2026-09-02T10:00:00.000Z';
  const PAYLOAD: ImportPayload = { id: '1111aaaa-2222-4333-8444-5555555555cc', route: 'dropbox', createdAt: NOW, candidates: [], documents: [] };
  const PENDING = `imports/pending-${PAYLOAD.id}.json`;
  const file = createEmptyFile({ deviceId: 'test', now: NOW });
  const deadline = () => Date.now() + MCP_IMPORT_BUDGET_MS;
  const QUOTE = 'If the user has not yet answered in their own words, show them the candidates and end your turn. Otherwise commit again with the same receipt and approval set to the user’s own words approving these candidates, quoted from their message. Nothing was written.';

  beforeEach(() => resetMcpMemory());

  it('refuses a commit with no approval, or a blank one, before it reads the pending file or charges; the same receipt then commits with one', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const surface = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'connection-a', exp: 0 }, adapter, client: 'claude', maxCorrectionAgeDays: 90 });
    const stashed = await surface.stash(PAYLOAD, deadline());
    if ('refusal' in stashed) throw new Error(stashed.refusal);
    const read = vi.spyOn(adapter, 'read');
    for (const approval of [undefined, '', '   ', '\n\t']) {
      const commit = { receipt: stashed.receipt, accept: [], replace: [], ...(approval === undefined ? null : { approval }) };
      expect(await surface.open(commit, file, NOW, deadline()), JSON.stringify(approval)).toEqual({ refusal: QUOTE });
    }
    expect(read).not.toHaveBeenCalled();
    expect(cloud.files.has(PENDING)).toBe(true);
    expect(chargeWrites(connectionKey({ rt: 'connection-a' }), WRITES_PER_HOUR)).toBeNull();
    resetMcpMemory();
    expect(await surface.open({ receipt: stashed.receipt, accept: [], replace: [], approval: APPROVED }, file, NOW, deadline())).toEqual(PAYLOAD);
  });

  it('through the tool: no approval is refused in words, a 201-character one by the schema, and neither writes or spends the pending file', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    await adapter.write(ROADMAP_FILE_NAME, createEmptyFile({ deviceId: 'test', now: NOW }), null);
    const importer = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'connection-a', exp: 0 }, adapter, client: 'claude', maxCorrectionAgeDays: 90 });
    const stashed = await importer.stash(PAYLOAD, deadline());
    if ('refusal' in stashed) throw new Error(stashed.refusal);
    const call = (commit: Record<string, unknown>) => runToolOverSync(recordSync(adapter, 'mcp', NOW), 'file_results', { commit }, NOW, { importer });
    const before = cloud.files.get(ROADMAP_FILE_NAME);

    const bare = await call({ receipt: stashed.receipt, accept: [], replace: [] });
    expect(bare).toMatchObject({ isError: true, text: QUOTE });
    const long = await call({ receipt: stashed.receipt, accept: [], replace: [], approval: 'y'.repeat(201) });
    expect(long).toMatchObject({ isError: true, text: IMPORT_REFUSALS.commit });
    // Never echoed: the refusal does not carry the user's words back.
    expect(long.text).not.toContain('yyyy');
    expect(cloud.files.get(ROADMAP_FILE_NAME)).toBe(before);
    expect(cloud.files.has(PENDING)).toBe(true);

    const ok = await call({ receipt: stashed.receipt, accept: [], replace: [], approval: 'Yes, file the letter' });
    expect(ok.isError).toBe(false);
    expect(cloud.files.has(PENDING)).toBe(false);
  });

  it('never writes the user’s words anywhere: not into the record on a commit, not into the pending file on a refused one (adversarial review R7)', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    await adapter.write(ROADMAP_FILE_NAME, createEmptyFile({ deviceId: 'test', now: NOW }), null);
    const importer = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'connection-a', exp: 0 }, adapter, client: 'claude', maxCorrectionAgeDays: 90 });
    const call = (args: unknown) => runToolOverSync(recordSync(adapter, 'mcp', NOW), 'file_results', args, NOW, { importer, latestDay: '2026-09-02' });
    const proposed = await call({
      sourceFileName: 'labs.pdf', classification: 'lab_report', collectedOn: '2026-08-20',
      values: [{ metric: 'ldl', printedName: 'LDL Cholesterol', value: 2.8, unit: 'mmol/L' }],
    });
    expect(proposed.isError).toBe(false);
    const { receipt, candidates } = OUTPUTS.file_results.parse(proposed.structured);
    const marker = 'Yes file it qx9-approval-marker';
    // Refused after the words were read (an id not in the receipt): the pending file stays, without them.
    expect((await call({ commit: { receipt, accept: ['nope'], replace: [], approval: marker } })).isError).toBe(true);
    const pending = `imports/pending-${receipt}.json`;
    expect(cloud.files.get(pending)!.json).not.toContain('qx9-approval-marker');
    const filed = await call({ commit: { receipt, accept: candidates.map((c) => c.id), replace: [], approval: marker } });
    expect(filed.isError).toBe(false);
    expect(filed.text).not.toContain('qx9-approval-marker');
    expect((await adapter.read(ROADMAP_FILE_NAME)).body).toMatchObject({ measurements: [expect.objectContaining({ metricType: 'ldl' })] });
    for (const [name, stored] of cloud.files) expect(stored.json, name).not.toContain('qx9-approval-marker');
  });
});

describe('US-35 AC7 — extract then commit, end to end through hostedImporter', () => {
  const NOW = '2026-09-02T10:00:00.000Z';
  const report = {
    classification: 'lab_report' as const, reportDate: '2026-08-20',
    values: [{ metric: 'ldl', valueSI: 2.8, displayValue: 2.8, displayUnit: 'mmol/L', displaySystem: 'si' as const, confidence: 'high' as const }],
    additionalValues: [], unrecognized: [], document: null,
  };

  beforeEach(() => resetMcpMemory());
  afterEach(() => setImportSeams(null));

  it('the extract answers a UUID receipt, the commit files the accepted value and spends the pending file; a second commit finds nothing', async () => {
    const cloud = new MemoryCloud();
    cloud.docs.set('labs.pdf', new Blob([PDF]));
    const adapter = new MemoryAdapter(cloud);
    await adapter.write(ROADMAP_FILE_NAME, createEmptyFile({ deviceId: 'test', now: NOW }), null);
    setImportSeams({ extract: async () => report });
    const call = (args: unknown) => runToolOverSync(recordSync(adapter, 'mcp', NOW), 'import_documents', args, NOW, {
      importer: hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'connection-a', exp: 0 }, adapter, client: 'claude', maxCorrectionAgeDays: 90 }),
    });

    const extract = await call({});
    expect(extract.isError).toBe(false);
    const data = OUTPUTS.import_documents.parse(extract.structured);
    expect(data.receipt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(cloud.files.has(`imports/pending-${data.receipt}.json`)).toBe(true);

    const commit = await call({ commit: { receipt: data.receipt, accept: ['c1'], replace: [], approval: APPROVED } });
    expect(commit.isError).toBe(false);
    const stored = (await adapter.read(ROADMAP_FILE_NAME)).body as ReturnType<typeof createEmptyFile>;
    expect(stored.measurements).toEqual([expect.objectContaining({ metricType: 'ldl', value: 2.8, source: 'lab_import' })]);
    expect(cloud.files.has(`imports/pending-${data.receipt}.json`)).toBe(false);

    const again = await call({ commit: { receipt: data.receipt, accept: ['c1'], replace: [], approval: APPROVED } });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('names no pending import');
  });
});

describe('US-35 AC7 — a consumed pending file is deleted at once, and a delete that fails is only counted', () => {
  const NOW = '2026-09-02T10:00:00.000Z';
  const PAYLOAD: ImportPayload = { id: '11111111-2222-4333-8444-555555555555', route: 'dropbox', createdAt: NOW, candidates: [], documents: [] };
  const deadline = () => Date.now() + MCP_IMPORT_BUDGET_MS;
  const pendingIn = (cloud: MemoryCloud) => [...cloud.files.keys()].filter((n) => n.startsWith('imports/pending-'));

  beforeEach(() => { resetMcpMemory(); vi.mocked(Sentry.captureMessage).mockClear(); });

  it('the commit takes the file it consumed, by its own name', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const removed: string[] = [];
    const remove = adapter.remove!.bind(adapter);
    adapter.remove = async (name, signal) => { removed.push(name); return remove(name, signal); };
    const surface = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'rt', exp: 0 }, adapter, client: 'claude', maxCorrectionAgeDays: 90 });

    const stashed = await surface.stash(PAYLOAD, deadline());
    if ('refusal' in stashed) throw new Error(stashed.refusal);
    expect(pendingIn(cloud)).toHaveLength(1);

    // What `runImport` does at the end of a commit — the only caller there is.
    await surface.discard(PAYLOAD, deadline());
    expect(removed).toEqual([`imports/pending-${PAYLOAD.id}.json`]);
    expect(pendingIn(cloud)).toHaveLength(0);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('sweeps an abandoned pending file on the NEXT stash — every route, not just the Dropbox extract', async () => {
    // `file_results` and every Drive user never call `extract`, so a sweep that
    // lived there never reached them. `stash` is the one door all three share.
    for (const route of ['dropbox', 'assistant'] as const) {
      const cloud = new MemoryCloud();
      const old = { json: '{}', version: 1, modified: '2026-09-02T07:30:00.000Z' }; // 2.5 h before NOW
      cloud.files.set('imports/pending-abandoned.json', old);
      cloud.files.set('imports/pending-recent.json', { ...old, modified: '2026-09-02T09:30:00.000Z' }); // 30 min: its receipt may still be live
      cloud.files.set('imports/notes.json', old); // the user's own file, however old, is never ours to take
      const surface = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'rt', exp: 0 }, adapter: new MemoryAdapter(cloud), client: 'claude', maxCorrectionAgeDays: 90 });

      const stashed = await surface.stash({ ...PAYLOAD, route }, deadline());
      if ('refusal' in stashed) throw new Error(stashed.refusal);
      expect(cloud.files.has('imports/pending-abandoned.json'), route).toBe(false);
      expect(cloud.files.has('imports/pending-recent.json'), route).toBe(true);
      expect(cloud.files.has('imports/notes.json'), route).toBe(true);
      expect(pendingIn(cloud), route).toContain(`imports/pending-${PAYLOAD.id}.json`);
    }
  });

  it('a delete that fails does not fail the call — it is one count, naming no file', async () => {
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.remove = async () => { throw new Error('dropbox said no'); };
    const surface = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'rt', exp: 0 }, adapter, client: 'claude', maxCorrectionAgeDays: 90 });

    await expect(surface.discard(PAYLOAD, deadline())).resolves.toBeUndefined();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(Sentry.captureMessage).mock.calls[0];
    expect(`${message}${JSON.stringify(options)}`).not.toMatch(new RegExp(`${PAYLOAD.id}|imports/|dropbox said no`));
  });
});

describe('US-35 AC5 — every I/O in the call is aborted at the deadline, not abandoned', () => {
  const NOW = '2026-09-02T10:00:00.000Z';
  const file = createEmptyFile({ deviceId: 'test', now: NOW });
  const PAYLOAD: ImportPayload = { id: '11111111-2222-4333-8444-555555555555', route: 'dropbox', createdAt: NOW, candidates: [], documents: [] };
  const token = { clientId: 'c.test', provider: 'dropbox' as const, rt: 'rt', exp: 0 };
  const deadline = () => Date.now() + MCP_IMPORT_BUDGET_MS;

  /** An adapter method that answers only when its signal aborts — a provider that took the socket and went quiet. */
  function hang(seen: AbortSignal[]) {
    return (...args: unknown[]) => new Promise<never>((_, reject) => {
      const signal = args.at(-1) as AbortSignal;
      seen.push(signal);
      signal.throwIfAborted();
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  }
  function surfaceOver(adapter: MemoryAdapter) {
    return hostedImporter({ token, adapter, client: 'claude', maxCorrectionAgeDays: 90 });
  }
  /** The call, with the clock run to the deadline while it waits. */
  async function atDeadline<T>(pending: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(MCP_IMPORT_BUDGET_MS);
    return pending;
  }
  /** The hung call was rejected by its own signal — aborted, not left running. */
  function abortedOnce(seen: AbortSignal[]) {
    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(true);
    expect((seen[0].reason as Error).name).toBe('TimeoutError');
  }

  beforeEach(() => { resetMcpMemory(); vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
  afterEach(() => { vi.useRealTimers(); setImportSeams(null); });

  it('a listing that never answers: refused at the deadline, the list call aborted, no model call', async () => {
    const seen: AbortSignal[] = [];
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.list = hang(seen);
    const seam = vi.fn();
    setImportSeams({ extract: seam });
    const bundle = await atDeadline(surfaceOver(adapter).extract({}, file, NOW, deadline()));
    expect(bundle).toEqual({ refusal: expect.stringMatching(/did not list in time/) });
    abortedOnce(seen);
    expect(seam).not.toHaveBeenCalled();
  });

  it('a download that never answers is skipped for time, the download aborted, no model call', async () => {
    const seen: AbortSignal[] = [];
    const cloud = new MemoryCloud();
    cloud.docs.set('labs.pdf', new Blob([PDF]));
    const adapter = new MemoryAdapter(cloud);
    adapter.readDocument = hang(seen);
    const seam = vi.fn();
    setImportSeams({ extract: seam });
    const bundle = await atDeadline(surfaceOver(adapter).extract({}, file, NOW, deadline()));
    expect('files' in bundle && bundle.files).toEqual([{ name: 'labs.pdf', status: 'skipped', reason: 'time' }]);
    // What time cut off is `remaining`, so the assistant is told to ask again for it (AC2).
    expect('remaining' in bundle && bundle.remaining).toEqual(['labs.pdf']);
    abortedOnce(seen);
    expect(seam).not.toHaveBeenCalled();
  });

  it('a deadline already passed starts nothing and refuses', async () => {
    const seam = vi.fn();
    setImportSeams({ extract: seam });
    const bundle = await surfaceOver(new MemoryAdapter(new MemoryCloud())).extract({}, file, NOW, Date.now());
    expect(bundle).toEqual({ refusal: expect.stringMatching(/did not list in time/) });
    expect(seam).not.toHaveBeenCalled();
  });

  it('the pending-file write is aborted at the deadline and the extract refused', async () => {
    const seen: AbortSignal[] = [];
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.write = hang(seen);
    const answer = await atDeadline(surfaceOver(adapter).stash(PAYLOAD, deadline()));
    expect(answer).toEqual({ refusal: expect.stringMatching(/could not be parked/) });
    abortedOnce(seen);
  });

  it('the commit’s read of the pending file is aborted at the deadline and refused, nothing charged', async () => {
    const cloud = new MemoryCloud();
    const adapter = new MemoryAdapter(cloud);
    const surface = surfaceOver(adapter);
    const stashed = await surface.stash(PAYLOAD, deadline());
    if ('refusal' in stashed) throw new Error(stashed.refusal);
    const seen: AbortSignal[] = [];
    adapter.read = hang(seen);
    const answer = await atDeadline(surface.open({ receipt: stashed.receipt, accept: [], replace: [], approval: APPROVED }, file, NOW, deadline()));
    expect(answer).toEqual({ refusal: expect.stringMatching(/did not read in time/) });
    abortedOnce(seen);
    expect(chargeWrites(connectionKey({ rt: 'rt' }), WRITES_PER_HOUR)).toBeNull();
  });

  it('the commit’s delete is aborted at the deadline; the call still answers and the sweep takes the file later', async () => {
    const seen: AbortSignal[] = [];
    const adapter = new MemoryAdapter(new MemoryCloud());
    adapter.remove = hang(seen);
    await expect(atDeadline(surfaceOver(adapter).discard(PAYLOAD, deadline()))).resolves.toBeUndefined();
    abortedOnce(seen);
  });

  it('hands the model call what is left of the budget and no retry, inner or outer', async () => {
    const cloud = new MemoryCloud();
    cloud.docs.set('labs.pdf', new Blob([PDF]));
    const surface = surfaceOver(new MemoryAdapter(cloud));
    const seen: Array<{ timeoutMs: number; attempts: number; httpAttempts: number }> = [];
    setImportSeams({ extract: async (_pages, opts) => {
      seen.push(opts);
      return { classification: 'other', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: null };
    } });
    await surface.extract({}, file, NOW, deadline());
    expect(seen).toHaveLength(1);
    // Metadata only for a letter: the connector files no text, so it asks for none (AC5).
    expect(seen[0]).toMatchObject({ attempts: 1, httpAttempts: 1, documentMode: 'metadata' });
    expect(seen[0].timeoutMs).toBeLessThanOrEqual(MCP_IMPORT_BUDGET_MS);
  });

  it('a model call that timed out hands the file’s day charge back — machine and connection counters both (AC10)', async () => {
    const cloud = new MemoryCloud();
    cloud.docs.set('labs.pdf', new Blob([PDF]));
    const surface = surfaceOver(new MemoryAdapter(cloud));
    const key = connectionKey({ rt: 'rt' });
    machineFiles.reset();
    setImportSeams({ extract: async () => { throw new DOMException('signal timed out', 'TimeoutError'); } });
    const bundle = await surface.extract({}, file, NOW, deadline());
    expect('files' in bundle && bundle.files[0]).toMatchObject({ status: 'failed', reason: 'time' });
    expect(importFiles.remaining(key)).toBe(IMPORT_FILES_PER_DAY);
    expect(machineFiles.remaining('machine')).toBe(machineFiles.remaining('never-spent'));
    // A read that failed for any other reason stays charged: the model did the work.
    setImportSeams({ extract: async () => { throw new Error('boom'); } });
    await surface.extract({}, file, NOW, deadline());
    expect(importFiles.remaining(key)).toBe(IMPORT_FILES_PER_DAY - 1);
  });

  it('a file refused for quota or allowance is charged on no counter: no model call was made (AC10)', async () => {
    const cloud = new MemoryCloud();
    cloud.docs.set('labs.pdf', new Blob([PDF]));
    const surface = surfaceOver(new MemoryAdapter(cloud));
    const key = connectionKey({ rt: 'rt' });
    machineFiles.reset();
    const seam = vi.fn();
    setImportSeams({ extract: seam });
    const machineBefore = machineFiles.remaining('machine');
    // The hourly write allowance is spent: the file's day charge must not stand on either counter.
    expect(chargeWrites(key, WRITES_PER_HOUR)).toBeNull();
    let bundle = await surface.extract({}, file, NOW, deadline());
    expect('files' in bundle && bundle.files[0]).toMatchObject({ status: 'failed', reason: 'allowance' });
    expect(importFiles.remaining(key)).toBe(IMPORT_FILES_PER_DAY);
    expect(machineFiles.remaining('machine')).toBe(machineBefore);
    // The connection's day quota is spent: the machine's cap is not charged for a file it never read.
    resetMcpMemory();
    expect(importFiles.take(key, IMPORT_FILES_PER_DAY)).toBe(true);
    bundle = await surface.extract({}, file, NOW, deadline());
    expect('files' in bundle && bundle.files[0]).toMatchObject({ status: 'failed', reason: 'quota' });
    expect(machineFiles.remaining('machine')).toBe(machineBefore);
    expect(seam).not.toHaveBeenCalled();
  });

  it('ZIP entries cut off by time on the folder route come back as the ZIP’s own name in remaining, so fileNames = remaining reads them next time (AC2)', async () => {
    // JSZip inflates on real timers; only the clock is faked here, which is all the deadline reads.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const zip = new JSZip();
    zip.file('labs/a.pdf', PDF);
    zip.file('labs/b.pdf', new Uint8Array([...PDF, 1]));
    zip.file('labs/c.pdf', new Uint8Array([...PDF, 2]));
    const cloud = new MemoryCloud();
    cloud.docs.set('bundle.zip', new Blob([new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))]));
    const surface = surfaceOver(new MemoryAdapter(cloud));
    // The first entry's model call runs the clock out; the entries behind it are skipped for time.
    setImportSeams({ extract: async () => { await vi.advanceTimersByTimeAsync(MCP_IMPORT_BUDGET_MS); throw new DOMException('signal timed out', 'TimeoutError'); } });
    const cut = await surface.extract({}, file, NOW, deadline());
    if (!('files' in cut)) throw new Error(cut.refusal);
    expect(cut.files.map((f) => [f.name, f.status, f.reason])).toEqual([
      ['labs/a.pdf', 'failed', 'time'], ['labs/b.pdf', 'skipped', 'time'], ['labs/c.pdf', 'skipped', 'time'],
    ]);
    // An entry's inner path is not a file in the folder root: naming it would make the next call refuse whole.
    expect(cut.remaining).toEqual(['bundle.zip']);
    const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: null };
    setImportSeams({ extract: async () => letter });
    const again = await surface.extract({ fileNames: cut.remaining }, file, NOW, deadline());
    if (!('files' in again)) throw new Error(again.refusal);
    expect(again.files.map((f) => [f.name, f.status])).toEqual([['labs/a.pdf', 'extracted'], ['labs/b.pdf', 'extracted'], ['labs/c.pdf', 'extracted']]);
  });
});

describe('US-35 AC13 / AC9 — what the surface answers when a file cannot be read', () => {
  const NOW = '2026-09-02T10:00:00.000Z';
  const file = createEmptyFile({ deviceId: 'test', now: NOW });
  const token = { clientId: 'c.test', provider: 'dropbox' as const, rt: 'rt', exp: 0 };
  const deadline = () => Date.now() + MCP_IMPORT_BUDGET_MS;
  function surfaceOver(adapter: MemoryAdapter) {
    return hostedImporter({ token, adapter, client: 'chatgpt', maxCorrectionAgeDays: 90 });
  }
  const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: null };
  beforeEach(() => { resetMcpMemory(); vi.clearAllMocks(); });
  afterEach(() => setImportSeams(null));

  it('a folder with nothing it reads refuses in words naming the folder and the four types, before any model call', async () => {
    const cloud = new MemoryCloud();
    cloud.docs.set('notes.txt', new Blob([new Uint8Array(3)]));
    const seam = vi.fn();
    setImportSeams({ extract: seam });
    expect(await surfaceOver(new MemoryAdapter(cloud)).extract({}, file, NOW, deadline())).toEqual({ refusal: IMPORT_REFUSALS.emptyFolder });
    expect(seam).not.toHaveBeenCalled();
  });

  it('a download the provider refuses with 401/403 is rethrown as the StorageError it is, so the route answers with the reconnect hint (finding 15)', async () => {
    const cloud = new MemoryCloud();
    cloud.docs.set('labs.pdf', new Blob([PDF]));
    const adapter = new MemoryAdapter(cloud);
    adapter.readDocument = async () => { throw new StorageError('Dropbox download failed (401)', undefined, undefined, 401); };
    await expect(surfaceOver(adapter).extract({}, file, NOW, deadline())).rejects.toMatchObject({ name: 'StorageError', status: 401 });
    // Any other download failure is that file's own problem, not the connection's.
    adapter.readDocument = async () => { throw new Error('socket hang up'); };
    const bundle = await surfaceOver(adapter).extract({}, file, NOW, deadline());
    expect('files' in bundle && bundle.files).toEqual([{ name: 'labs.pdf', status: 'failed', reason: 'unreadable' }]);
  });

  it('Sentry gets a fixed message and the error class only — never the parse error’s text, which quotes the document (AC9)', async () => {
    const cloud = new MemoryCloud();
    cloud.docs.set('labs.pdf', new Blob([PDF]));
    const zodLike = Object.assign(new Error("Invalid enum value. Received 'ldl 3.4 mmol/L SECRET-PATIENT'"), { name: 'ZodError' });
    setImportSeams({ extract: async () => { throw zodLike; } });
    const bundle = await surfaceOver(new MemoryAdapter(cloud)).extract({}, file, NOW, deadline());
    expect('files' in bundle && bundle.files[0]).toMatchObject({ status: 'failed', reason: 'unreadable' });
    const calls = (Sentry.captureException as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const [captured, context] = calls[0] as [Error, Record<string, unknown>];
    expect(captured).not.toBe(zodLike);
    expect(captured.message).toBe('import_documents: extraction failed');
    expect(captured.name).toBe('ZodError');
    expect(context).toEqual({ tags: { feature: 'mcp_import', errorName: 'ZodError' }, extra: { kind: 'application/pdf' } });
    expect(JSON.stringify([captured.message, captured.name, captured.stack, context])).not.toMatch(/SECRET|Received|3\.4/);
  });

  it('a ZIP flows through extract(): entries in order under the same file, each typed, charged and hashed; junk and a nested zip named (AC5)', async () => {
    const zip = new JSZip();
    zip.file('labs/2026-a.pdf', PDF);
    zip.file('labs/scan.jpg', JPEG);
    zip.file('labs/inner.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    zip.file('__MACOSX/._x.pdf', PDF);
    zip.file('labs/notes.txt', new Uint8Array(2));
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    const cloud = new MemoryCloud();
    cloud.docs.set('bundle.zip', new Blob([bytes]));
    cloud.docs.set('a.pdf', new Blob([PDF]));
    const kinds: string[] = [];
    setImportSeams({ extract: async (pages) => { kinds.push(pages[0].type); return letter; } });
    const key = connectionKey({ rt: 'rt' });
    const bundle = await surfaceOver(new MemoryAdapter(cloud)).extract({}, file, NOW, deadline());
    if (!('files' in bundle)) throw new Error(bundle.refusal);
    // The listing's order: a.pdf, then the ZIP's entries flattened in the archive's order, then what it skipped.
    expect(bundle.files.map((f) => [f.name, f.status, f.reason])).toEqual([
      ['a.pdf', 'extracted', undefined],
      ['labs/2026-a.pdf', 'extracted', undefined],
      ['labs/scan.jpg', 'extracted', undefined],
      ['labs/inner.zip', 'skipped', 'nested_zip'],
    ]);
    expect(bundle.files.slice(0, 3).map((f) => [f.mimeType, f.contentHash?.slice(0, 7)])).toEqual([
      ['application/pdf', 'sha256-'], ['application/pdf', 'sha256-'], ['image/jpeg', 'sha256-'],
    ]);
    expect(kinds.sort()).toEqual(['image', 'pdf', 'pdf']);
    expect(importFiles.remaining(key)).toBe(IMPORT_FILES_PER_DAY - 3);
    expect(bundle.remaining).toEqual([]);
  });
});
