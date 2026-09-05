/**
 * US-35 · the hosted half of `import_documents`, piece by piece.
 *
 * What is pinned here: the type of a file is its bytes (AC4), a ZIP is opened
 * under caps that a bomb cannot talk its way past (AC5), the ChatGPT fetch
 * refuses everything but https on the allow-list with no redirects (AC4), and
 * a receipt is small, sealed, bound to one connection, and fails closed on
 * any tamper (AC7). The whole flow over a folder is `mcp.hosted.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { recordServerEvent } from './product-events.server';

vi.mock('./product-events.server', async (importOriginal) => {
  const original = await importOriginal<typeof import('./product-events.server')>();
  return { ...original, recordServerEvent: vi.fn(async () => {}) };
});
import {
  CHATGPT_FETCH_TIMEOUT_MS,
  fetchChatgptFile,
  hostedImporter,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ZIP_BYTES,
  MCP_IMPORT_BUDGET_MS,
  setImportSeams,
  sniff,
  unzip,
} from './mcp-import.server';
import { resourceUrl } from './mcp-config.server';
import { chargeWrites, connectionKey, resetMcpMemory, WRITES_PER_HOUR } from './mcp-grants.server';
import { hash, seal } from './mcp-seal.server';
import { type ImportPayload, MAX_IMPORT_FILES_PER_CALL, MAX_RECEIPT_LENGTH } from '../../packages/health-core/src/mcp-tools';
import { MemoryAdapter, MemoryCloud } from '../../packages/health-core/src/memory-adapter';
import { createEmptyFile } from '../../packages/health-core/src/roadmap-file';

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\nendobj\n');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

beforeEach(() => {
  process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 7).toString('base64');
  delete process.env.CHATGPT_FILE_HOSTS;
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
      { name: 'inner.zip', reason: 'unsupported' },
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

describe('US-35 AC4 — the ChatGPT file fetch', () => {
  it('refuses http, a foreign host, and the mobile chat_upload reference without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const url of ['http://files.oaiusercontent.com/x', 'https://evil.example/x', 'chat_upload://abc', 'javascript:alert(1)']) {
      const answer = await fetchChatgptFile(url);
      expect('refusal' in answer, url).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // The refused host is warned by hostname only — never the URL.
    expect(warn.mock.calls.every(([, host]) => typeof host === 'string' && !String(host).includes('/'))).toBe(true);
    warn.mockRestore();
  });

  it('fetches the allow-listed host with no redirects and a ten-second bound, and caps the bytes', async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, i: RequestInit) => {
      init = i;
      return new Response(PDF);
    }));
    const answer = await fetchChatgptFile('https://files.oaiusercontent.com/file-abc?sig=1');
    expect('bytes' in answer && [...answer.bytes]).toEqual([...PDF]);
    expect(init!.redirect).toBe('error');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(CHATGPT_FETCH_TIMEOUT_MS).toBe(10_000);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(MAX_IMPORT_ZIP_BYTES + 1))));
    const tooBig = await fetchChatgptFile('https://files.oaiusercontent.com/file-big');
    expect('refusal' in tooBig && tooBig.refusal).toMatch(/larger than/);
  });

  it('a redirect, a non-2xx and a timeout each come back as a refusal, never a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect('refusal' in (await fetchChatgptFile('https://files.oaiusercontent.com/x'))).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 410 })));
    expect('refusal' in (await fetchChatgptFile('https://files.oaiusercontent.com/x'))).toBe(true);
  });

  it('accepts OpenAI’s two host forms and refuses every look-alike — live 2026-09-05 the URL was a region-suffixed Azure blob', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PDF)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const url of [
      'https://files.oaiusercontent.com/file-abc?sig=1',
      'https://oaisdmntprnznorth.blob.core.windows.net/files/file-abc?sv=1&sig=2',
      'https://oaisdmntprn.blob.core.windows.net/x',
      'https://oaisdmntprn-west-2.blob.core.windows.net/x',
    ]) expect('bytes' in (await fetchChatgptFile(url)), url).toBe(true);
    for (const url of [
      'https://evil-oaisdmntprn.blob.core.windows.net/x',
      'https://oaisdmntprn.blob.core.windows.net.evil.com/x',
      'https://oaisdmntprnznorth.blob.core.windows.net.evil.com/x',
      'https://xoaisdmntprn.blob.core.windows.net/x',
      'https://oaisdmntprn.blob.core.windows.com/x',
      'https://files.oaiusercontent.com.evil.com/x',
      'http://oaisdmntprnznorth.blob.core.windows.net/x',
    ]) expect('refusal' in (await fetchChatgptFile(url)), url).toBe(true);
    // The family is whole hostnames: two accepted fetches per URL above, none for the refused.
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(4);
  });

  it('honours CHATGPT_FILE_HOSTS as extra exact hosts, so a third host is one env change, not a deploy', async () => {
    process.env.CHATGPT_FILE_HOSTS = 'files.oaiusercontent.com, files.example.test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PDF)));
    expect('bytes' in (await fetchChatgptFile('https://files.example.test/x'))).toBe(true);
    // The env adds; the built-in family stays.
    expect('bytes' in (await fetchChatgptFile('https://oaisdmntprnznorth.blob.core.windows.net/x'))).toBe(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect('refusal' in (await fetchChatgptFile('https://sub.files.example.test/x'))).toBe(true);
  });

  it('a dragged file that was not read is still counted: mcp_import chatgpt_refused, value-free (usage signal)', async () => {
    resetMcpMemory();
    vi.mocked(recordServerEvent).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const surface = hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt: 'rt', exp: 0 }, adapter: new MemoryAdapter(new MemoryCloud()), client: 'chatgpt', maxCorrectionAgeDays: 90 });
    const file = createEmptyFile({ deviceId: 'test', now: '2026-09-05T00:00:00.000Z' });
    const answer = await surface.extract(
      { file: { download_url: 'https://evil.example/secret-name.pdf?sig=abc', file_id: 'f1', file_name: 'my-clinic-letter.pdf' } },
      file, '2026-09-05T00:00:00.000Z', Date.now() + MCP_IMPORT_BUDGET_MS,
    );
    expect('refusal' in answer).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    const events = vi.mocked(recordServerEvent).mock.calls;
    expect(events).toEqual([['mcp_import', { route: 'chatgpt_refused', phase: 'extract', files: '0' }]]);
    expect(JSON.stringify(events)).not.toMatch(/secret-name|clinic-letter|evil\.example/);
  });
});

describe('US-35 AC7 — the receipt names the payload and binds it to one connection', () => {
  const NOW = '2026-09-02T10:00:00.000Z';
  const PAYLOAD: ImportPayload = { id: '11111111-2222-4333-8444-555555555555', route: 'dropbox', createdAt: NOW, candidates: [], documents: [] };
  const file = createEmptyFile({ deviceId: 'test', now: NOW });

  /** The surface for one connection over one in-memory folder — the receipt is minted and opened here and nowhere else. */
  function surfaceFor(rt: string, cloud = new MemoryCloud()) {
    return hostedImporter({ token: { clientId: 'c.test', provider: 'dropbox', rt, exp: 0 }, adapter: new MemoryAdapter(cloud), client: 'claude', maxCorrectionAgeDays: 90 });
  }
  const deadline = () => Date.now() + MCP_IMPORT_BUDGET_MS;
  async function stashed(surface: ReturnType<typeof surfaceFor>) {
    const answer = await surface.stash(PAYLOAD, deadline());
    if ('refusal' in answer) throw new Error(answer.refusal);
    return answer;
  }
  async function refusalOf(surface: ReturnType<typeof surfaceFor>, receipt: string, now = NOW) {
    const answer = await surface.open({ receipt, accept: [], replace: [] }, file, now, deadline());
    return 'refusal' in answer ? answer.refusal : null;
  }

  beforeEach(() => resetMcpMemory());

  it('round-trips, stays under the cap, is sealed, and expires an hour after the extract', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    const { receipt, expiresAt } = await stashed(surface);
    expect(receipt.length).toBeLessThan(MAX_RECEIPT_LENGTH);
    expect(expiresAt).toBe('2026-09-02T11:00:00.000Z');
    expect(receipt).not.toContain(PAYLOAD.id); // sealed: the id is not readable off the wire
    expect(await surface.open({ receipt, accept: [], replace: [] }, file, NOW, deadline())).toEqual(PAYLOAD);
  });

  it('fails closed: a changed byte, another connection, an expiry passed, an edited pending file, a shape that is not a receipt', async () => {
    const cloud = new MemoryCloud();
    const surface = surfaceFor('connection-a', cloud);
    const { receipt } = await stashed(surface);
    const [header, body] = receipt.split('.');
    expect(await refusalOf(surface, `${header}.${body.slice(0, -2)}xx`)).toMatch(/not valid/);
    expect(await refusalOf(surfaceFor('connection-b', cloud), receipt)).toMatch(/not valid/);
    expect(await refusalOf(surface, receipt, '2026-09-02T11:00:00.000Z')).toMatch(/not valid/);
    expect(await refusalOf(surface, 'not.a.receipt')).toMatch(/not valid/);
    expect(await refusalOf(surface, '')).toMatch(/not valid/);
    // A claims block sealed by us but naming a non-UUID id can never form a path.
    const forged = seal('import', { id: '../health-roadmap', exp: 2_000_000_000, conn: hash(connectionKey('connection-a')), sha256: 'x' }, { clientId: 'c.test', resource: resourceUrl() });
    expect(await refusalOf(surface, forged)).toMatch(/not valid/);
    // The pending file edited in the folder no longer matches the hash the receipt carries.
    const name = [...cloud.files.keys()].find((n) => n.startsWith('imports/'))!;
    cloud.files.set(name, { ...cloud.files.get(name)!, json: JSON.stringify({ ...PAYLOAD, candidates: [{ id: 'c1' }] }) });
    expect(await refusalOf(surface, receipt)).toMatch(/does not match/);
  });

  it('refuses an id the receipt does not carry BEFORE charging, so bogus replace ids cost nothing (AC10)', async () => {
    const surface = surfaceFor('connection-a');
    const { receipt } = await stashed(surface);
    const bogus = Array.from({ length: 300 }, (_, i) => `x${i}`);
    const answer = await surface.open({ receipt, accept: [], replace: bogus }, file, NOW, deadline());
    expect('refusal' in answer && answer.refusal).toMatch(/not a candidate/);
    // The whole hourly allowance is still there.
    expect(chargeWrites(connectionKey('connection-a'), WRITES_PER_HOUR)).toBeNull();
  });

  it('survives a key rotation: a receipt sealed under the previous key still opens', async () => {
    const surface = surfaceFor('connection-a');
    const { receipt } = await stashed(surface);
    process.env.MCP_SEAL_KEYS = `${Buffer.alloc(32, 8).toString('base64')},${Buffer.alloc(32, 7).toString('base64')}`;
    expect(await surface.open({ receipt, accept: [], replace: [] }, file, NOW, deadline())).toEqual(PAYLOAD);
    process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 8).toString('base64');
    expect(await refusalOf(surface, receipt)).toMatch(/not valid/);
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
    const answer = await atDeadline(surface.open({ receipt: stashed.receipt, accept: [], replace: [] }, file, NOW, deadline()));
    expect(answer).toEqual({ refusal: expect.stringMatching(/did not read in time/) });
    abortedOnce(seen);
    expect(chargeWrites(connectionKey('rt'), WRITES_PER_HOUR)).toBeNull();
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
    expect(seen[0]).toMatchObject({ attempts: 1, httpAttempts: 1 });
    expect(seen[0].timeoutMs).toBeLessThanOrEqual(MCP_IMPORT_BUDGET_MS);
  });
});
