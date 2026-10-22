/** @vitest-environment jsdom */
/** US-10 AC4 / US-32: independent first saves must not verify private cached ids. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import {
  ConflictError, buildErasedFile, createEmptyFile, createMeasurement, DriveAdapter, DRIVE_FOLDER_NAME,
  driveFindFileId,
  ROADMAP_DOC, ROADMAP_FILE_NAME, StorageError, SyncManager,
  type RoadmapFile, type StorageAdapter,
} from '@roadmap/health-core';
import { GoogleDriveAdapter } from './drive';

const NOW = '2026-10-01T00:00:00.000Z';
const FOLDER = 'folder';
type Kind = 'hosted' | 'browser';
interface File { id: string; name: string; content: string; version: number }

/** Provider boundary only: real adapters, multipart uploads and SyncManager. */
class Drive {
  files: File[] = [];
  requests: string[] = [];
  createdBytes: string[] = [];
  private releaseCreates?: () => void;
  private createGate?: Promise<void>;

  constructor(overlap = false) {
    // Node's fetch/Response need Node's Blob, not jsdom's DOM-only Blob.
    vi.stubGlobal('Blob', NodeBlob);
    if (overlap) this.createGate = new Promise<void>((resolve) => { this.releaseCreates = resolve; });
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => this.fetch(new URL(String(input)), init));
  }

  private async fetch(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      if (q.includes('mimeType=')) return Response.json({ files: [{ id: FOLDER, name: DRIVE_FOLDER_NAME }] });
      const name = /name='([^']+)'/.exec(q)?.[1];
      const hits = this.files.filter((file) => file.name === name);
      const limit = Number(url.searchParams.get('pageSize'));
      return Response.json({ files: hits.slice(0, limit).map(({ id }) => ({ id })) });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const text = await new Response(init!.body as BodyInit).text();
      const parts = text.split(/--rm_boundary_health_roadmap-*\r?\n?/).filter((part) => part.trim());
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1]) as { name: string };
      const content = parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '');
      const file = { id: `file-${this.files.length + 1}`, name: meta.name, content, version: 1 };
      this.files.push(file);
      this.createdBytes.push(content);
      // Both creates land before either returns. No shared adapter or mutex.
      if (this.files.length === 2) this.releaseCreates?.();
      await this.createGate;
      return Response.json({ id: file.id, version: String(file.version) });
    }
    const id = /\/files\/([^/]+)$/.exec(url.pathname)?.[1];
    const file = this.files.find((entry) => entry.id === id);
    if (file && method === 'GET') {
      return url.searchParams.get('alt') === 'media'
        ? new Response(file.content) : Response.json({ version: String(file.version) });
    }
    if (file && method === 'PATCH' && url.pathname.startsWith('/upload/')) {
      file.content = String(init!.body);
      return Response.json({ id: file.id, version: String(++file.version) });
    }
    throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
  }
}

function adapter(kind: Kind): StorageAdapter {
  if (kind === 'hosted') return new DriveAdapter('synthetic');
  // Each adapter captures its own config before any save; persisted ids cannot
  // act as cross-device coordination. No token exchange or live provider call.
  localStorage.setItem('health_roadmap_gdrive', JSON.stringify({ folderId: FOLDER, folderName: DRIVE_FOLDER_NAME }));
  localStorage.setItem('health_roadmap_gdrive_tokens', JSON.stringify({ accessToken: 'synthetic', expiresAt: Date.now() + 3_600_000 }));
  return new GoogleDriveAdapter({ clientId: 'synthetic', scope: 's', redirectUri: 'https://example.test/', exchangeUrl: 'https://example.test/exchange' });
}
function manager(storage: StorageAdapter, device: string) {
  return new SyncManager(storage, device, ROADMAP_DOC, { now: () => NOW });
}
function record(id: string): RoadmapFile {
  const file = createEmptyFile({ deviceId: id, now: NOW });
  file.measurements.push(createMeasurement({ id, metricType: id === 'A' ? 'weight' : 'waist', value: 80, recordedAt: NOW, createdAt: NOW }));
  return file;
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('US-10 AC4 — ambiguous first-save discovery', () => {
  it.each<[Kind, Kind]>([['hosted', 'hosted'], ['browser', 'browser'], ['hosted', 'browser']])(
    '%s + %s do not report success by verifying separate cached file ids', async (left, right) => {
      const drive = new Drive(true);
      const a = manager(adapter(left), 'A');
      const b = manager(adapter(right), 'B');
      const results = await Promise.allSettled([a.save(record('A')), b.save(record('B'))]);
      expect(drive.files).toHaveLength(2); // the provider permits duplicate names
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      for (const result of results) {
        if (result.status !== 'rejected') throw new Error('Expected an ambiguous save failure');
        expect(result.reason).toBeInstanceOf(StorageError);
        expect(result.reason.hint).toContain('may already have landed');
      }
      await expect(manager(adapter('hosted'), 'fresh').load()).rejects.toBeInstanceOf(StorageError);
      await expect(manager(adapter('browser'), 'fresh').load()).rejects.toBeInstanceOf(StorageError);
      expect(drive.files.map((file) => file.content)).toEqual(drive.createdBytes);
      expect(drive.files.map((file) => (JSON.parse(file.content) as RoadmapFile).measurements[0].id).sort()).toEqual(['A', 'B']);
      expect(drive.requests.some((request) => /^(PATCH|DELETE) /.test(request))).toBe(false);
    },
  );

  it.each<Kind>(['hosted', 'browser'])('%s refuses a different discovered id even when its version matches', async (kind) => {
    const drive = new Drive();
    const a = adapter(kind);
    await manager(a, 'A').save(record('A'));
    const read = await a.read(ROADMAP_FILE_NAME);
    // A cached-id verification fix must not turn a version belonging to one
    // file into permission to overwrite a different newly discovered file.
    drive.files[0] = { id: 'replacement', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('B')) };
    const before = drive.files[0].content;
    await expect(a.write(ROADMAP_FILE_NAME, record('A'), read.version)).rejects.toBeInstanceOf(ConflictError);
    expect(drive.files[0].content).toBe(before);
  });

  it.each<Kind>(['hosted', 'browser'])('%s binds each returned version to its file despite an intervening replacement read', async (kind) => {
    const drive = new Drive();
    const a = adapter(kind);
    await manager(a, 'A').save(record('A'));
    const original = await a.read(ROADMAP_FILE_NAME);
    drive.files[0] = { id: 'replacement', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('B')) };
    const replacement = await a.read(ROADMAP_FILE_NAME);
    expect((replacement.body as RoadmapFile).measurements[0].id).toBe('B');
    const before = drive.files[0].content;
    await expect(a.write(ROADMAP_FILE_NAME, original.body as object, original.version)).rejects.toBeInstanceOf(ConflictError);
    expect(drive.files[0].content).toBe(before);
    await expect(a.write(ROADMAP_FILE_NAME, replacement.body as object, replacement.version)).resolves.toBeDefined();
  });

  it.each<Kind>(['hosted', 'browser'])('%s allows interleaved independent document reads and writes on one adapter', async (kind) => {
    const drive = new Drive();
    drive.files.push(
      { id: 'record', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('A')) },
      { id: 'chat', name: 'chat-history.json', version: 1, content: JSON.stringify({ turns: [] }) },
    );
    const a = adapter(kind);
    const health = await a.read(ROADMAP_FILE_NAME);
    const chat = await a.read('chat-history.json');
    await expect(a.write(ROADMAP_FILE_NAME, health.body as object, health.version)).resolves.toBeDefined();
    await expect(a.write('chat-history.json', { turns: ['synthetic'] }, chat.version)).resolves.toBeDefined();
    expect(JSON.parse(drive.files[1].content)).toEqual({ turns: ['synthetic'] });
  });

  it.each<Kind>(['hosted', 'browser'])('%s refuses cached reads and writes once a duplicate appears', async (kind) => {
    const drive = new Drive();
    const a = adapter(kind);
    await manager(a, 'A').save(record('A'));
    const read = await a.read(ROADMAP_FILE_NAME);
    const erased = buildErasedFile({ stored: record('A'), own: record('A'), device: null, ctx: { deviceId: 'eraser', now: NOW } });
    drive.files.push({ id: 'erased-copy', name: ROADMAP_FILE_NAME, content: JSON.stringify(erased), version: 1 });
    const before = drive.files.map((file) => file.content);
    await expect(a.read(ROADMAP_FILE_NAME)).rejects.toBeInstanceOf(StorageError);
    await expect(a.write(ROADMAP_FILE_NAME, record('B'), read.version)).rejects.toBeInstanceOf(StorageError);
    await expect(manager(a, 'eraser').save(erased)).rejects.toBeInstanceOf(StorageError);
    expect(drive.files.map((file) => file.content)).toEqual(before);
    expect(drive.requests.some((request) => /^(PATCH|DELETE) /.test(request))).toBe(false);
  });

  it.each<Kind>(['hosted', 'browser'])('%s still merges edits and preserves a listed erase on a unique record', async (kind) => {
    const drive = new Drive();
    const a = manager(adapter(kind), 'A');
    const b = manager(adapter(kind), 'B');
    await a.save(record('A'));
    const both = (await b.save(record('B'))).file;
    expect(both.measurements.map((row) => row.id).sort()).toEqual(['A', 'B']);
    const erased = buildErasedFile({ stored: both, own: both, device: null, ctx: { deviceId: 'eraser', now: NOW } });
    await a.save(erased);
    await b.save(both); // stale rows must not resurrect
    const fresh = await manager(adapter(kind), 'fresh').load();
    expect(fresh.measurements).toEqual([]);
    expect(fresh.meta.eraseEpoch).toBe(1);
    expect(fresh.erasedRows?.ids).toEqual(['A', 'B']);
    expect(drive.files).toHaveLength(1);
    expect(drive.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
  });

  it('keeps same-named uploaded document orphan reads supported', async () => {
    const drive = new Drive();
    drive.files.push(
      { id: 'doc-1', name: 'scan.pdf', content: 'synthetic PDF bytes', version: 1 },
      { id: 'doc-2', name: 'scan.pdf', content: 'synthetic PDF bytes', version: 1 },
    );
    expect(await (await adapter('browser').readDocument('scan.pdf')).text()).toBe('synthetic PDF bytes');
  });

  it.each([{ nextPageToken: 'more' }, { incompleteSearch: true }])('refuses an incomplete record lookup: %j', async (extra) => {
    const fetch = vi.fn(async (_input: string | URL) => Response.json({ files: [{ id: 'one' }], ...extra }));
    vi.stubGlobal('fetch', fetch);
    await expect(driveFindFileId('synthetic', ROADMAP_FILE_NAME, undefined, undefined, true)).rejects.toBeInstanceOf(StorageError);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('pageSize')).toBe('2');
    expect(url.searchParams.get('fields')).toContain('nextPageToken');
    expect(url.searchParams.get('fields')).toContain('incompleteSearch');
  });

  it.each<Kind>(['hosted', 'browser'])('%s still saves and discovers a unique record', async (kind) => {
    const drive = new Drive();
    const saved = await manager(adapter(kind), 'A').save(record('A'));
    expect(saved.attempts).toBe(0);
    const fresh = await manager(adapter(kind), 'fresh').load();
    expect(fresh.measurements.map((row) => row.id)).toEqual(['A']);
    expect(drive.files).toHaveLength(1);
  });
});
