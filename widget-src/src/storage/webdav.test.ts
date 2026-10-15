// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  createEmptyFile,
  createMeasurement,
  ROADMAP_DOC,
  ROADMAP_FILE_NAME,
  SyncManager,
  type RoadmapFile,
} from '@roadmap/health-core';
import { WebDavAdapter } from './webdav';

const NOW = '2026-10-01T12:00:00.000Z';
const CONFIG = { url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'not-a-real-credential' };

function copy(id: string, metricType: string, value: number): RoadmapFile {
  const file = createEmptyFile({ deviceId: id, now: NOW });
  file.measurements.push(createMeasurement({ id, metricType, value, recordedAt: NOW, createdAt: NOW }));
  return file;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('WebDavAdapter concurrency (US-10 AC4)', () => {
  it('two first saves keep both rows when one create lands after the other has verified', async () => {
    let stored: RoadmapFile | null = null;
    let revision = 0;
    let releaseB!: () => void;
    let bReached!: () => void;
    const reached = new Promise<void>((resolve) => { bReached = resolve; });
    const gate = new Promise<void>((resolve) => { releaseB = resolve; });
    const putHeaders: Headers[] = [];
    let conflicts = 0;
    // Only the HTTP boundary is faked: the real adapter, merge, and retry loop run.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as RoadmapFile;
        const headers = new Headers(init.headers);
        putHeaders.push(headers);
        if (putHeaders.length === 1) { bReached(); await gate; }
        if ((headers.has('if-match') && headers.get('if-match') !== `"${revision}"`)
          || (headers.get('if-none-match') === '*' && stored !== null)) {
          conflicts++;
          return new Response('', { status: 412 });
        }
        stored = body;
        revision++;
        return new Response('', { status: 201, headers: { ETag: `"${revision}"` } });
      }
      return stored === null
        ? new Response('', { status: 404 })
        : new Response(JSON.stringify(stored), { headers: { ETag: `"${revision}"` } });
    }));
    const a = new SyncManager(new WebDavAdapter(CONFIG), 'A', ROADMAP_DOC, { now: () => NOW });
    const b = new SyncManager(new WebDavAdapter(CONFIG), 'B', ROADMAP_DOC, { now: () => NOW });
    const savingB = b.save(copy('B', 'ldl', 3));
    await reached; // B read 404; its PUT has not landed.
    let savedA;
    try {
      savedA = await a.save(copy('A', 'weight', 80));
    } finally {
      releaseB();
    }
    const savedB = await savingB;
    const final = (await new WebDavAdapter(CONFIG).read(ROADMAP_FILE_NAME)).body as RoadmapFile;
    expect(final.measurements.map((m) => m.id).sort()).toEqual(['A', 'B']);
    expect(savedA.attempts).toBe(0);
    expect(savedB.attempts).toBe(1);
    expect(savedB.file.measurements.map((m) => m.id).sort()).toEqual(['A', 'B']);
    expect(conflicts).toBe(1);
    expect(putHeaders.map((h) => [h.get('if-none-match'), h.get('if-match')]))
      .toEqual([['*', null], ['*', null], [null, '"1"']]);
  });

  it('a 404 reads as missing and creates with If-None-Match', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 201, headers: { ETag: '"1"' } }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new WebDavAdapter(CONFIG);
    const read = await adapter.read(ROADMAP_FILE_NAME);
    expect(read).toEqual({ body: null, version: null });
    await expect(adapter.write(ROADMAP_FILE_NAME, {}, read.version)).resolves.toEqual({ version: '"1"' });
    const headers = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers);
    expect(headers.get('if-none-match')).toBe('*');
    expect(headers.has('if-match')).toBe(false);
  });

  it('an existing ETag is carried into If-Match for updates', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { headers: { ETag: '"1"' } }))
      .mockResolvedValueOnce(new Response('', { headers: { ETag: '"2"' } }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new WebDavAdapter(CONFIG);
    const read = await adapter.read(ROADMAP_FILE_NAME);
    expect(read.version).toBe('"1"');
    await expect(adapter.write(ROADMAP_FILE_NAME, {}, read.version)).resolves.toEqual({ version: '"2"' });
    const headers = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers);
    expect(headers.get('if-match')).toBe('"1"');
    expect(headers.has('if-none-match')).toBe(false);
  });

  it('a stale update returning 412 remains a retryable conflict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 412 })));
    await expect(new WebDavAdapter(CONFIG).write(ROADMAP_FILE_NAME, {}, '"1"')).rejects.toBeInstanceOf(ConflictError);
  });

  it.each(['{}', '', 'null'])('an existing no-ETag resource (%j) stays last-write-wins', async (text) => {
    const putHeaders: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const headers = new Headers(init.headers);
        putHeaders.push(headers);
        // This resource already exists, even when its parsed body is null.
        if (headers.has('if-none-match')) return new Response('', { status: 412 });
        return new Response('');
      }
      return new Response(init?.method === 'HEAD' ? '' : text);
    }));
    const adapter = new WebDavAdapter(CONFIG);
    const read = await adapter.read(ROADMAP_FILE_NAME);
    expect(read.version).toBe('');
    const written = await adapter.write(ROADMAP_FILE_NAME, {}, read.version);
    expect(written.version).toBe(''); // PUT and fallback HEAD expose no ETag.
    await expect(adapter.write(ROADMAP_FILE_NAME, {}, written.version)).resolves.toEqual({ version: '' });
    expect(putHeaders.map((h) => [h.get('if-none-match'), h.get('if-match')]))
      .toEqual([[null, null], [null, null]]);
  });

  it('a create without a PUT ETag can still obtain its update token from HEAD', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(new Response('', { headers: { ETag: '"1"' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new WebDavAdapter(CONFIG).write(ROADMAP_FILE_NAME, {}, null)).resolves.toEqual({ version: '"1"' });
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('HEAD');
  });
});
