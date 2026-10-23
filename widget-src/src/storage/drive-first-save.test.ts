/** @vitest-environment jsdom */
/** US-10 AC4 / AC4a / US-32: independent first saves must not verify private cached ids;
 *  duplicate records reconcile, duplicate chat files keep first-match discovery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import {
  ConflictError, buildErasedFile, createEmptyFile, createMeasurement, DriveAdapter, DRIVE_FOLDER_NAME,
  driveFindFileId,
  RecordSession, ROADMAP_DOC, ROADMAP_FILE_NAME, SchemaTooNewError, StorageError, SyncManager,
  type RoadmapFile, type StorageAdapter,
} from '@roadmap/health-core';
import { GoogleDriveAdapter } from './drive';
import { ChatHistoryStore } from './chat-history-store';
import { webRecordHost } from './web-record-host';
import { describeStorageFailure } from '../../../packages/health-core/src/sync-manager';

const NOW = '2026-10-01T00:00:00.000Z';
const FOLDER = 'folder';
type Kind = 'hosted' | 'browser';
interface File { id: string; name: string; content: string; version: number; createdTime?: string; hiddenFor?: number }

/** Provider boundary only: real adapters, multipart uploads and SyncManager. */
class Drive {
  files: File[] = [];
  requests: string[] = [];
  createdBytes: string[] = [];
  pages?: Array<{ files: Array<{ id: string; createdTime?: string }>; nextPageToken?: string; incompleteSearch?: boolean }>;
  afterPatch?: (file: File) => void;
  patchResponseStatus?: number;
  createResponseStatus?: number;
  /** Search lags creates: a new file stays out of `files.list` for this many lookups. */
  listLag = 0;
  /** The changes feed (US-34): every PATCH lands here, as Drive reports it. */
  changes: Array<{ fileId: string }> = [];
  omitDates = false;
  loseCreateReply = false;
  onRequest?: (url: URL, method: string) => void;
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
    this.onRequest?.(url, method);
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      if (q.includes('mimeType=')) return Response.json({ files: [{ id: FOLDER, name: DRIVE_FOLDER_NAME }] });
      if (this.pages) return Response.json(this.pages[Number(url.searchParams.get('pageToken') ?? 0)]);
      const name = /name='([^']+)'/.exec(q)?.[1];
      const hits = this.files.filter((file) => file.name === name && !(file.hiddenFor && file.hiddenFor-- > 0));
      if (url.searchParams.get('orderBy') === 'createdTime') hits.sort((x, y) => (x.createdTime ?? NOW).localeCompare(y.createdTime ?? NOW));
      const limit = Number(url.searchParams.get('pageSize'));
      return Response.json({ files: hits.slice(0, limit).map(({ id, createdTime }) => ({ id, ...(this.omitDates ? {} : { createdTime: createdTime ?? NOW }) })) });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const text = await new Response(init!.body as BodyInit).text();
      const parts = text.split(/--rm_boundary_health_roadmap-*\r?\n?/).filter((part) => part.trim());
      const meta = JSON.parse(parts[0].split('\r\n\r\n')[1]) as { name: string };
      const content = parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '');
      if (this.createResponseStatus) return new Response('synthetic rejected create', { status: this.createResponseStatus });
      const file = { id: `file-${this.files.length + 1}`, name: meta.name, content, version: 1, hiddenFor: this.listLag };
      this.files.push(file);
      this.createdBytes.push(content);
      // Both creates land before either returns. No shared adapter or mutex.
      if (this.files.length === 2) this.releaseCreates?.();
      await this.createGate;
      if (this.loseCreateReply) throw new Error("synthetic lost create reply");
      return Response.json({ id: file.id, version: String(file.version) });
    }
    if (url.pathname === '/drive/v3/changes/startPageToken') return Response.json({ startPageToken: 't' });
    if (url.pathname === '/drive/v3/changes') return Response.json({ changes: this.changes.splice(0), newStartPageToken: 't' });
    const id = /\/files\/([^/]+)$/.exec(url.pathname)?.[1];
    const file = this.files.find((entry) => entry.id === id);
    if (file && method === 'GET') {
      return url.searchParams.get('alt') === 'media'
        ? new Response(file.content)
        : Response.json({ id: file.id, name: file.name, version: String(file.version), createdTime: file.createdTime ?? NOW, trashed: false });
    }
    if (!file && method === 'GET' && id) return new Response('not found', { status: 404 });
    if (file && method === 'PATCH' && url.pathname.startsWith('/upload/')) {
      file.content = String(init!.body);
      ++file.version;
      this.changes.push({ fileId: file.id });
      this.afterPatch?.(file);
      if (this.patchResponseStatus) return new Response('synthetic rejected response', { status: this.patchResponseStatus });
      return Response.json({ id: file.id, version: String(file.version) });
    }
    throw new Error(`Unexpected provider request: ${method} ${url.pathname}`);
  }
}

function adapter(kind: Kind, fileIds?: Record<string, string>): StorageAdapter {
  if (kind === 'hosted') return new DriveAdapter('synthetic');
  // Each adapter captures its own config before any save; persisted ids cannot
  // act as cross-device coordination. No token exchange or live provider call.
  localStorage.setItem('health_roadmap_gdrive', JSON.stringify({ folderId: FOLDER, folderName: DRIVE_FOLDER_NAME, fileIds }));
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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('US-10 AC4 — ambiguous first-save discovery', () => {
  it.each<[Kind, Kind]>([['hosted', 'hosted'], ['browser', 'browser'], ['hosted', 'browser']])(
    '%s + %s converge forced concurrent first creates onto one canonical union', async (left, right) => {
      const drive = new Drive(true);
      const a = manager(adapter(left), 'A');
      const b = manager(adapter(right), 'B');
      const results = await Promise.allSettled([a.save(record('A')), b.save(record('B'))]);
      expect(drive.files).toHaveLength(2); // the provider permits duplicate names
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      const fresh = await manager(adapter('hosted'), 'fresh').load();
      expect(fresh.measurements.map((row) => row.id).sort()).toEqual(['A', 'B']);
      expect(JSON.parse(drive.files[0].content).measurements.map((row: {id: string}) => row.id).sort()).toEqual(['A', 'B']);
      expect(drive.files[1].content).toBe(drive.createdBytes[1]);
      expect(drive.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
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

  it.each<Kind>(['hosted', 'browser'])('%s merges duplicate erasure but rejects a stale discovery token', async (kind) => {
    const drive = new Drive();
    const a = adapter(kind);
    await manager(a, 'A').save(record('A'));
    const read = await a.read(ROADMAP_FILE_NAME);
    const erased = buildErasedFile({ stored: record('A'), own: record('A'), device: null, ctx: { deviceId: 'eraser', now: NOW } });
    drive.files.push({ id: 'erased-copy', createdTime: '2026-10-02T00:00:00.000Z', name: ROADMAP_FILE_NAME, content: JSON.stringify(erased), version: 1 });
    const before = drive.files.map((file) => file.content);
    const merged = await a.read(ROADMAP_FILE_NAME);
    expect((merged.body as RoadmapFile).measurements).toEqual([]);
    await expect(a.write(ROADMAP_FILE_NAME, record('B'), read.version)).rejects.toBeInstanceOf(ConflictError);
    await expect(manager(a, 'eraser').save(erased)).resolves.toBeDefined();
    await manager(a, 'stale').save(record('A'));
    expect((await manager(a, 'fresh').load()).measurements).toEqual([]);
    expect(drive.files[1].content).toBe(before[1]);
    expect(drive.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
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

  it.each<Kind>(['hosted', 'browser'])('%s loads all pages read-only, dedupes IDs, and saves to oldest then id', async (kind) => {
    const drive = new Drive();
    drive.files = [
      { id: 'z', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('A')) },
      { id: 'b', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('B')) },
      { id: 'a', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('C')) },
    ];
    drive.pages = [
      { files: [], nextPageToken: '1' },
      { files: [{ id: 'z', createdTime: '2026-10-02T00:00:00Z' }], nextPageToken: '2' },
      { files: [{ id: 'b', createdTime: NOW }, { id: 'a', createdTime: NOW }, { id: 'z', createdTime: '2026-10-02T00:00:00Z' }] },
    ];
    const a = adapter(kind);
    const loaded = await manager(a, 'reader').load();
    expect(loaded.measurements.map((row) => row.id).sort()).toEqual(['A', 'B', 'C']);
    expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
    expect(drive.requests.filter((request) => request.includes('?q=')).every((request) => !decodeURIComponent(request).includes('in parents'))).toBe(true);
    const before = drive.files.map((file) => file.content);
    const saved = await manager(a, 'writer').save(loaded);
    expect(saved.file.measurements).toHaveLength(3);
    expect(drive.files[0].content).toBe(before[0]);
    expect(drive.files[1].content).toBe(before[1]);
    expect(JSON.parse(drive.files[2].content).measurements).toHaveLength(3);
  });

  it.each<Kind>(['hosted', 'browser'])('%s accepts a single result after an empty first page', async (kind) => {
    const drive = new Drive();
    drive.files = [{ id: 'one', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('A')) }];
    drive.pages = [{ files: [], nextPageToken: '1' }, { files: [{ id: 'one', createdTime: NOW }] }];
    expect((await manager(adapter(kind), 'reader').load()).measurements.map((row) => row.id)).toEqual(['A']);
  });

  it.each<Kind>(['hosted', 'browser'])('%s deterministically falls back to ID if creation metadata is absent', async (kind) => {
    const drive = new Drive(); drive.omitDates = true;
    drive.files = ['z', 'a'].map((id) => ({ id, name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record(id)) }));
    await manager(adapter(kind), 'writer').save(record('B'));
    expect(drive.files[0].version).toBe(1);
    expect(drive.files[1].version).toBe(2);
  });

  it.each<Kind>(['hosted', 'browser'])('%s refuses incomplete, looping, failed, or invalid-metadata discovery without mutations', async (kind) => {
    for (const pages of [
      [{ files: [], incompleteSearch: true }],
      [{ files: [], nextPageToken: '1' }, { files: [], nextPageToken: '1' }],
      [{ files: [{ id: 'x', createdTime: 'not-a-date' }] }],
    ]) {
      const drive = new Drive(); drive.pages = pages;
      await expect(manager(adapter(kind), 'reader').load()).rejects.toBeInstanceOf(StorageError);
      expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
    }
  });

  it.each<Kind>(['hosted', 'browser'])('%s refuses a malformed or future-schema loser before any write', async (kind) => {
    for (const content of ['{broken', JSON.stringify({ ...record('B'), schemaVersion: 999 }), JSON.stringify({ schemaVersion: 2, measurements: 'not-a-list' })]) {
      const drive = new Drive();
      drive.files = [
        { id: 'a', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('A')) },
        { id: 'z', name: ROADMAP_FILE_NAME, version: 1, content },
      ];
      await expect(manager(adapter(kind), 'writer').save(record('C'))).rejects.toBeDefined();
      expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
    }
  });

  it.each<Kind>(['hosted', 'browser'])('%s conflicts on a changed loser or newly visible copy and rereads before merging', async (kind) => {
    const drive = new Drive();
    drive.files = ['a', 'z'].map((id) => ({ id, name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record(id)) }));
    const a = adapter(kind);
    const read = await a.read(ROADMAP_FILE_NAME);
    drive.files[1].version++;
    await expect(a.write(ROADMAP_FILE_NAME, read.body as object, read.version)).rejects.toBeInstanceOf(ConflictError);
    const second = await a.read(ROADMAP_FILE_NAME);
    drive.files.push({ id: 'new', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('new')) });
    await expect(a.write(ROADMAP_FILE_NAME, second.body as object, second.version)).rejects.toBeInstanceOf(ConflictError);
    expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
    const saved = await manager(a, 'writer').save(record('B'));
    expect(saved.file.measurements.map((row) => row.id).sort()).toEqual(['B', 'a', 'new', 'z']);
  });

  it.each<Kind>(['hosted', 'browser'])('%s cannot mask canonical lost rows or low lamport with a healthy loser', async (kind) => {
    for (const mode of ['rows', 'lamport']) {
      const drive = new Drive();
      const both = ROADMAP_DOC.merge(record('A'), record('B'), { deviceId: 'fixture', now: NOW });
      drive.files = ['a', 'z'].map((id) => ({ id, name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(both) }));
      drive.afterPatch = (file) => {
        const corrupted = JSON.parse(file.content) as RoadmapFile;
        if (mode === 'rows') corrupted.measurements = [];
        else corrupted.meta.lamport = 0;
        file.content = JSON.stringify(corrupted);
      };
      const a = adapter(kind);
      await expect(manager(a, 'writer').save(both)).rejects.toMatchObject({ message: expect.stringContaining('5 attempts'), hint: expect.stringContaining('may have landed') });
      expect(drive.requests.filter((request) => request.startsWith('PATCH '))).toHaveLength(5);
      expect(drive.files[1].content).toBe(JSON.stringify(both));
    }
  });

  it.each<Kind>(['hosted', 'browser'])('%s stops pre-aborted reads and saves before provider mutation', async (kind) => {
    const drive = new Drive();
    const abort = new AbortController(); abort.abort();
    await expect(adapter(kind).read(ROADMAP_FILE_NAME, abort.signal)).rejects.toBeDefined();
    await expect(manager(adapter(kind), 'writer').save(record('A'), abort.signal)).rejects.toBeDefined();
    expect(drive.requests).toEqual([]);
  });

  it.each<Kind>(['hosted', 'browser'])('%s reports uncertainty when an existing PATCH lands but its response is lost', async (kind) => {
    const drive = new Drive();
    drive.files = [{ id: 'one', name: ROADMAP_FILE_NAME, content: JSON.stringify(record('A')), version: 1 }];
    const before = drive.files[0].content;
    drive.afterPatch = () => { throw new Error('synthetic severed PATCH response'); };
    const failure = await manager(adapter(kind), 'writer').save(record('B')).then(() => null, (error: unknown) => error);
    expect(drive.files[0].content).not.toBe(before);
    expect(JSON.parse(drive.files[0].content).measurements.map((row: { id: string }) => row.id).sort()).toEqual(['A', 'B']);
    expect(drive.requests.filter((request) => request.startsWith('PATCH '))).toHaveLength(1);
    const told = describeStorageFailure(failure, 'Google Drive');
    expect(`${told.message} ${told.hint}`).not.toMatch(/nothing was (written|changed)/i);
    expect(told.hint).toContain('may already have landed');
  });

  it.each<Kind>(['hosted', 'browser'])('%s keeps the provider status on an auth-refused record write or create (US-10 AC4a)', async (kind) => {
    for (const [status, existing] of [[401, true], [403, true], [401, false]] as const) {
      const drive = new Drive();
      if (existing) {
        drive.files = [{ id: 'one', name: ROADMAP_FILE_NAME, content: JSON.stringify(record('A')), version: 1 }];
        drive.patchResponseStatus = status;
      } else drive.createResponseStatus = status;
      const failure = await manager(adapter(kind), 'writer').save(record('B')).then(() => null, (error: unknown) => error);
      // iOS refreshes the token on a 401 and the page says "reconnect": both read the status.
      expect(failure).toBeInstanceOf(StorageError);
      expect(failure).toMatchObject({ status });
      expect(describeStorageFailure(failure, 'Google Drive').hint).toContain('Reconnect');
    }
  });

  it.each<Kind>(['hosted', 'browser'])('%s remembers a landed concurrent create through four later pre-upload conflicts', async (kind) => {
    const drive = new Drive();
    drive.onRequest = (url, method) => {
      if (method === 'GET' && url.pathname === '/drive/v3/files' && drive.createdBytes.length === 1 && drive.files.length === 1) {
        drive.files.push({ id: 'concurrent', name: ROADMAP_FILE_NAME, content: JSON.stringify(record('B')), version: 1 });
      }
    };
    const real = adapter(kind);
    let writes = 0;
    const decorated: StorageAdapter = Object.create(real);
    decorated.read = (...args) => real.read(...args);
    decorated.write = (...args) => {
      if (++writes > 1) return Promise.reject(new ConflictError('synthetic later pre-upload conflict'));
      return real.write(...args);
    };
    const failure = await manager(decorated, 'writer').save(record('A')).then(() => null, (error: unknown) => error);
    expect(writes).toBe(5);
    expect(drive.files).toHaveLength(2);
    expect(drive.files[0].content).toBe(drive.createdBytes[0]);
    expect(JSON.parse(drive.files[0].content).measurements.map((row: { id: string }) => row.id)).toEqual(['A']);
    expect(drive.requests.filter((request) => request.startsWith('POST '))).toHaveLength(1);
    expect(drive.requests.some((request) => request.startsWith('PATCH '))).toBe(false);
    const told = describeStorageFailure(failure, 'Google Drive');
    expect(`${told.message} ${told.hint}`).not.toMatch(/nothing was (written|changed)/i);
    expect(told.hint).toContain('may have landed');
  });

  it.each<Kind>(['hosted', 'browser'])('%s acknowledges a possibly landed create when its reply is lost', async (kind) => {
    const drive = new Drive(); drive.loseCreateReply = true;
    await expect(manager(adapter(kind), 'writer').save(record('A'))).rejects.toMatchObject({ hint: expect.stringContaining('may already have landed') });
    expect(drive.files).toHaveLength(1);
  });

  it.each<Kind>(['hosted', 'browser'])('%s uses the existing merge for profiles, unknown fields and correction chains', async (kind) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
    const drive = new Drive();
    const left = record('A'); const right = record('B');
    left.profile = { heightCm: 180, updatedAt: NOW, lamport: 1 };
    right.profile = { birthYear: 1970, updatedAt: NOW, lamport: 1 };
    Object.assign(left, { futureExtension: { left: true } });
    Object.assign(right, { otherExtension: { right: true } });
    right.measurements.push({ ...left.measurements[0], id: 'corrected', value: 81, correctsId: 'A', createdAt: '2026-10-01T00:01:00.000Z' });
    drive.files = [
      { id: 'z', name: ROADMAP_FILE_NAME, content: JSON.stringify(right), version: 1 },
      { id: 'a', name: ROADMAP_FILE_NAME, content: JSON.stringify(left), version: 1 },
    ];
    const context = { deviceId: 'drive-record-discovery', now: NOW };
    const expected = ROADMAP_DOC.merge(ROADMAP_DOC.migrate(left, context), ROADMAP_DOC.migrate(right, context), context);
    const read = await adapter(kind).read(ROADMAP_FILE_NAME);
    expect(read.body).toEqual(expected);
    expect((read.body as RoadmapFile).measurements.find((row) => row.id === 'A')?.status).toBe('entered-in-error');
    expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
  });

  it.each<Kind>(['hosted', 'browser'])('%s retains legitimate unlisted rows after duplicate erasure and a stale save', async (kind) => {
    const drive = new Drive(); const stale = record('A');
    const erased = buildErasedFile({ stored: stale, own: stale, device: null, ctx: { deviceId: 'eraser', now: NOW } });
    drive.files = [
      { id: 'a', name: ROADMAP_FILE_NAME, content: JSON.stringify(erased), version: 1 },
      { id: 'z', name: ROADMAP_FILE_NAME, content: JSON.stringify(stale), version: 1 },
    ];
    const unlisted = record('B'); unlisted.measurements.push(...stale.measurements);
    const saved = await manager(adapter(kind), 'writer').save(unlisted);
    expect(saved.file.measurements.map((row) => row.id)).toEqual(['B']);
    expect((await manager(adapter(kind), 'reader').load()).measurements.map((row) => row.id)).toEqual(['B']);
    expect(JSON.parse(drive.files[1].content).measurements.map((row: {id: string}) => row.id)).toEqual(['A']);
  });

  it.each<Kind>(['hosted', 'browser'])('%s stops cancellation during pages and body downloads without mutating Drive', async (kind) => {
    for (const phase of ['pages', 'body']) {
      const drive = new Drive(); const abort = new AbortController();
      drive.files = [{ id: 'one', name: ROADMAP_FILE_NAME, content: JSON.stringify(record('A')), version: 1 }];
      drive.pages = [{ files: [], nextPageToken: '1' }, { files: [{ id: 'one', createdTime: NOW }] }];
      drive.onRequest = (url) => {
        if ((phase === 'pages' && url.searchParams.get('pageToken') === '1') || (phase === 'body' && url.searchParams.get('alt') === 'media')) abort.abort();
      };
      await expect(adapter(kind).read(ROADMAP_FILE_NAME, abort.signal)).rejects.toBeDefined();
      expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
    }
  });

  it.each<Kind>(['hosted', 'browser'])('%s reports uncertainty when cancelled after upload before verification', async (kind) => {
    const drive = new Drive(); const abort = new AbortController();
    drive.files = [{ id: 'one', name: ROADMAP_FILE_NAME, content: JSON.stringify(record('A')), version: 1 }];
    drive.afterPatch = () => abort.abort();
    await expect(manager(adapter(kind), 'writer').save(record('B'), abort.signal)).rejects.toMatchObject({ hint: expect.stringContaining('may already have landed') });
    expect(drive.files[0].version).toBe(2);
    expect(drive.requests.filter((request) => request.startsWith('PATCH '))).toHaveLength(1);
  });

  it.each<Kind>(['hosted', 'browser'])('%s refuses a malformed continuation token instead of silently truncating enumeration', async (kind) => {
    const drive = new Drive();
    drive.pages = [{ files: [], nextPageToken: 0 } as unknown as NonNullable<Drive['pages']>[number]];
    await expect(manager(adapter(kind), 'reader').load()).rejects.toBeInstanceOf(StorageError);
    expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
  });

  it('keeps same-named uploaded document orphan reads supported', async () => {
    const drive = new Drive();
    drive.files.push(
      { id: 'doc-1', name: 'scan.pdf', content: 'synthetic PDF bytes', version: 1 },
      { id: 'doc-2', name: 'scan.pdf', content: 'synthetic PDF bytes', version: 1 },
    );
    expect(await (await adapter('browser').readDocument('scan.pdf')).text()).toBe('synthetic PDF bytes');
  });

  it('keeps first-match lookup for named files, even with a next page (US-10 AC4a)', async () => {
    const fetch = vi.fn(async (_input: string | URL) => Response.json({ files: [{ id: 'one' }], nextPageToken: 'more' }));
    vi.stubGlobal('fetch', fetch);
    await expect(driveFindFileId('synthetic', 'chat-history.json')).resolves.toBe('one');
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('pageSize')).toBe('1');
  });

  it.each<Kind>(['hosted', 'browser'])('%s still saves and discovers a unique record', async (kind) => {
    const drive = new Drive();
    const saved = await manager(adapter(kind), 'A').save(record('A'));
    expect(saved.attempts).toBe(0);
    const fresh = await manager(adapter(kind), 'fresh').load();
    expect(fresh.measurements.map((row) => row.id)).toEqual(['A']);
    expect(drive.files).toHaveLength(1);
  });

  it.each<Kind>(['hosted', 'browser'])('%s reads, saves and erases chat beside a duplicate chat-history.json (US-10 AC4a)', async (kind) => {
    const drive = new Drive();
    const first = await ChatHistoryStore.create(adapter(kind));
    await first.recordExchange({ conversationId: 'c1', isNew: true, userText: 'synthetic question', assistantText: 'synthetic answer' });
    const chat = drive.files.find((file) => file.name === 'chat-history.json')!;
    // The same race as the record's: a second device's first save made a copy.
    drive.files.push({ ...chat, id: 'chat-copy' });
    const store = await ChatHistoryStore.create(adapter(kind));
    expect(store.listConversations().map((conv) => conv.id)).toEqual(['c1']);
    await store.recordExchange({ conversationId: 'c2', isNew: true, userText: 'second question', assistantText: 'second answer' });
    expect((await ChatHistoryStore.create(adapter(kind))).listConversations().map((conv) => conv.id).sort()).toEqual(['c1', 'c2']);
    await store.eraseAll();
    expect((await ChatHistoryStore.create(adapter(kind))).listConversations()).toEqual([]);
    expect(drive.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
  });

  it.each<Kind>(['hosted', 'browser'])('%s confirms a first create by its id when search lags, and never creates twice (US-10 AC4a)', async (kind) => {
    const drive = new Drive(); drive.listLag = 50;
    const a = manager(adapter(kind), 'A');
    await expect(a.save(record('A'))).resolves.toMatchObject({ attempts: 0 });
    const both = ROADMAP_DOC.merge(record('A'), record('B'), { deviceId: 'fixture', now: NOW });
    await expect(a.save(both)).resolves.toBeDefined();
    expect(drive.requests.filter((request) => request.startsWith('POST '))).toHaveLength(1);
    expect(drive.files).toHaveLength(1);
    expect(JSON.parse(drive.files[0].content).measurements.map((row: { id: string }) => row.id).sort()).toEqual(['A', 'B']);
  });

  it('browser watch follows the record copies, not a stale cached losing id (US-34 AC1, US-10 AC4a)', async () => {
    const drive = new Drive();
    drive.files = [
      { id: 'winner', name: ROADMAP_FILE_NAME, version: 1, createdTime: '2026-09-01T00:00:00.000Z', content: JSON.stringify(record('A')) },
      { id: 'loser', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('B')) },
    ];
    const browser = adapter('browser', { [ROADMAP_FILE_NAME]: 'loser' });
    await browser.read(ROADMAP_FILE_NAME); // the session's open
    await manager(adapter('hosted'), 'other-device').save(record('C'));
    expect(drive.changes).toEqual([{ fileId: 'winner' }]);
    const onChange = vi.fn(); const stop = new AbortController();
    browser.watch!(ROADMAP_FILE_NAME, onChange, stop.signal);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    stop.abort();
  });

  it.each<Kind>(['hosted', 'browser'])('%s reads the healthy copies past a damaged or newer-schema one, and refuses only saves (US-10 AC4a)', async (kind) => {
    const cases: Array<[string, new (...args: never[]) => Error]> = [
      ['{broken', StorageError],
      [JSON.stringify({ schemaVersion: 2, measurements: 'not-a-list' }), StorageError],
      [JSON.stringify({ ...record('B'), schemaVersion: 999 }), SchemaTooNewError],
    ];
    for (const [content, refusal] of cases) {
      const drive = new Drive();
      drive.files = [
        { id: 'a', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('A')) },
        { id: 'z', name: ROADMAP_FILE_NAME, version: 1, content },
      ];
      const loaded = await manager(adapter(kind), 'reader').load();
      expect(loaded.measurements.map((row) => row.id)).toEqual(['A']);
      const failure = await manager(adapter(kind), 'writer').save(record('C')).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(refusal);
      const told = describeStorageFailure(failure, 'Google Drive');
      expect(`${told.message} ${told.hint}`).toMatch(refusal === SchemaTooNewError ? /newer version/ : /Nothing was written/);
      expect(drive.requests.every((request) => request.startsWith('GET '))).toBe(true);
    }
  });

  it.each<Kind>(['hosted', 'browser'])('%s lets "Delete all my data" through past an unreadable copy, with a warning, and keeps ordinary saves refused (US-10 AC4a)', async (kind) => {
    for (const content of ['{broken', JSON.stringify({ ...record('B'), schemaVersion: 999 })]) {
      const drive = new Drive();
      drive.files = [
        { id: 'a', name: ROADMAP_FILE_NAME, version: 1, content: JSON.stringify(record('A')) },
        { id: 'z', name: ROADMAP_FILE_NAME, version: 1, content },
      ];
      const session = await RecordSession.open(webRecordHost(adapter(kind)));
      const result = await session.deleteAllData();
      expect(result).toMatchObject({ success: true, warning: expect.stringMatching(/left it untouched/) });
      expect(result.warning).toMatch(/delete it in Google Drive/i);
      const winner = JSON.parse(drive.files[0].content) as RoadmapFile;
      expect(winner.measurements).toEqual([]);
      expect(winner.meta.eraseEpoch).toBe(1);
      expect(drive.files[1].content).toBe(content);
      expect(drive.requests.some((request) => request.startsWith('DELETE '))).toBe(false);
      // An ordinary save after the erase is still refused, and writes nothing.
      const patches = drive.requests.filter((request) => request.startsWith('PATCH ')).length;
      await expect(manager(adapter(kind), 'writer').save(record('C'))).rejects.toBeDefined();
      expect(drive.requests.filter((request) => request.startsWith('PATCH '))).toHaveLength(patches);
      localStorage.clear();
    }
  });

  it.each<Kind>(['hosted', 'browser'])('%s picks the oldest of two chat copies, so every device reads the same one (US-10 AC4a)', async (kind) => {
    const drive = new Drive();
    const seed = await ChatHistoryStore.create(adapter(kind));
    await seed.recordExchange({ conversationId: 'old', isNew: true, userText: 'synthetic question', assistantText: 'synthetic answer' });
    const older = drive.files.find((file) => file.name === 'chat-history.json')!;
    older.createdTime = '2026-09-01T00:00:00.000Z';
    const newer = { ...older, id: 'chat-newer', createdTime: '2026-10-01T00:00:00.000Z', content: older.content.replace(/"old"/g, '"new"') };
    drive.files = [newer, ...drive.files.filter((file) => file !== older), older];
    localStorage.clear();
    const store = await ChatHistoryStore.create(adapter(kind));
    expect(store.listConversations().map((conv) => conv.id)).toEqual(['old']);
    const lookups = drive.requests.filter((request) => decodeURIComponent(request).includes("name='chat-history.json'"));
    expect(lookups.at(-1)).toContain('orderBy=createdTime');
  });
});
