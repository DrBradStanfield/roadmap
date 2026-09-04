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
import {
  CHATGPT_FETCH_TIMEOUT_MS,
  fetchChatgptFile,
  hostedImporter,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ZIP_BYTES,
  sniff,
  unzip,
} from './mcp-import.server';
import { resourceUrl } from './mcp-config.server';
import { connectionKey, resetMcpMemory } from './mcp-grants.server';
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

  it('honours CHATGPT_FILE_HOSTS so a second host is one env change, not a deploy', async () => {
    process.env.CHATGPT_FILE_HOSTS = 'files.oaiusercontent.com, files.example.test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PDF)));
    expect('bytes' in (await fetchChatgptFile('https://files.example.test/x'))).toBe(true);
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
  async function stashed(surface: ReturnType<typeof surfaceFor>) {
    const answer = await surface.stash(PAYLOAD);
    if ('refusal' in answer) throw new Error(answer.refusal);
    return answer;
  }
  async function refusalOf(surface: ReturnType<typeof surfaceFor>, receipt: string, now = NOW) {
    const answer = await surface.open({ receipt, accept: [], replace: [] }, file, now);
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
    expect(await surface.open({ receipt, accept: [], replace: [] }, file, NOW)).toEqual(PAYLOAD);
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

  it('survives a key rotation: a receipt sealed under the previous key still opens', async () => {
    const surface = surfaceFor('connection-a');
    const { receipt } = await stashed(surface);
    process.env.MCP_SEAL_KEYS = `${Buffer.alloc(32, 8).toString('base64')},${Buffer.alloc(32, 7).toString('base64')}`;
    expect(await surface.open({ receipt, accept: [], replace: [] }, file, NOW)).toEqual(PAYLOAD);
    process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 8).toString('base64');
    expect(await refusalOf(surface, receipt)).toMatch(/not valid/);
  });
});
