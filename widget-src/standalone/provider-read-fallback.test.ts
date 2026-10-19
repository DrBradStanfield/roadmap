/** US-09 AC13b: exercise real provider reads through the real boot fallback.
 * All records and HTTP responses are synthetic; no live provider is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, ROADMAP_FILE_NAME, StorageError, createEmptyFile, type StorageAdapter } from '@roadmap/health-core';
import { GitHubAdapter } from '../src/storage/github';
import { WebDavAdapter } from '../src/storage/webdav';
import { LocalStorageAdapter, isSyncPending } from '../src/storage';
import { RoadmapStore } from '../src/storage/roadmap-store';
import { startOnBackend } from './connect';

const captureException = vi.fn();
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: (...args: unknown[]) => captureException(...args) } }));
const providers = [
  ['github', () => new GitHubAdapter({ token: 'synthetic-token', owner: 'synthetic', repo: 'synthetic-private' })],
  ['self-host', () => new WebDavAdapter({ url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'synthetic' })],
] as const;
const init = async (adapter: StorageAdapter): Promise<void> => { await RoadmapStore.create(adapter); };

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, String(value)); },
    removeItem: (key: string) => { items.delete(key); },
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network forbidden'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  captureException.mockClear();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(providers)('%s record-read fallback (US-09 AC13b)', (backend, make) => {
  const reply = (body: unknown): Response => new Response(backend === 'github'
    ? JSON.stringify({ content: btoa(JSON.stringify(body)), sha: 'synthetic-version' })
    : JSON.stringify(body), { headers: { etag: 'synthetic-version' } });

  it('a successful read keeps the cloud record and its version', async () => {
    const file = createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00Z' });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply(file)));
    const adapter = make();
    expect(await adapter.read(ROADMAP_FILE_NAME)).toEqual({ body: file, version: 'synthetic-version' });
    const resolved = { backend, adapter };
    expect(await startOnBackend(resolved, init)).toBe(resolved);
    expect(isSyncPending()).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a missing file remains an empty cloud read, not an offline session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(null, { status: 404 })));
    const adapter = make();
    expect(await adapter.read(ROADMAP_FILE_NAME)).toEqual({ body: null, version: null });
    const resolved = { backend, adapter };
    expect(await startOnBackend(resolved, init)).toBe(resolved);
    expect(isSyncPending()).toBe(false);
  });

  it.each([401, 403])('an HTTP %s remains a StorageError and uses the existing fallback', async status => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('synthetic refusal', { status })));
    await expect(make().read(ROADMAP_FILE_NAME)).rejects.toBeInstanceOf(StorageError);
    expect((await startOnBackend({ backend, adapter: make() }, init)).backend).toBe('local');
    expect(isSyncPending()).toBe(true);
  });

  it.each(['shape', 'too-new'] as const)('a %s record is not treated as missing and retains the existing schema fallback', async kind => {
    const body = kind === 'shape' ? { synthetic: true } : { ...createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00Z' }), schemaVersion: 999 };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply(body)));
    expect((await make().read(ROADMAP_FILE_NAME)).body).toEqual(body);
    expect((await startOnBackend({ backend, adapter: make() }, init)).backend).toBe('local');
    expect(isSyncPending()).toBe(true);
  });

  it('invalid record JSON retains its corruption error, not an unreachable classification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(backend === 'github'
      ? JSON.stringify({ content: btoa('{'), sha: 'synthetic-version' }) : '{')));
    await expect(make().read(ROADMAP_FILE_NAME)).rejects.toThrow('not valid JSON');
    expect((await startOnBackend({ backend, adapter: make() }, init)).backend).toBe('local');
  });

  it('a programming error after the record read still escapes boot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply(createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00Z' }))));
    const defect = new TypeError('synthetic application defect');
    await expect(startOnBackend({ backend, adapter: make() }, async adapter => {
      await adapter.read(ROADMAP_FILE_NAME);
      throw defect;
    })).rejects.toBe(defect);
    expect(isSyncPending()).toBe(false);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a conflict from initialization retains the existing fallback, never becoming a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => reply(createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00Z' }))));
    const conflict = new ConflictError('synthetic moved version');
    const result = await startOnBackend({ backend, adapter: make() }, async adapter => {
      if (adapter.id === 'local') return init(adapter);
      await adapter.read(ROADMAP_FILE_NAME);
      throw conflict;
    });
    expect(result.backend).toBe('local');
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a body download that rejects selects the same local fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('synthetic severed body')); },
    }))));
    expect((await startOnBackend({ backend, adapter: make() }, init)).backend).toBe('local');
    expect(isSyncPending()).toBe(true);
  });

  it.each(['headers', 'body'] as const)('a stalled %s read is aborted at the shared 30-second deadline and boots locally', async phase => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
      return controller.signal;
    });
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      signal = options.signal ?? undefined;
      if (phase === 'headers') return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      });
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) { signal?.addEventListener('abort', () => controller.error(signal?.reason), { once: true }); },
      })));
    }));
    let settled = false;
    const boot = startOnBackend({ backend, adapter: make() }, init).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await boot).backend).toBe('local');
    expect(signal?.aborted).toBe(true);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(isSyncPending()).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
  it('a rejected fetch boots on the saved device copy and marks it for later sync', async () => {
    const local = await RoadmapStore.create(new LocalStorageAdapter());
    local.addMeasurement('weight', 80);
    await local.flush();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('synthetic network failure')));
    const result = await startOnBackend({ backend, adapter: make() }, init);
    expect(result.backend).toBe('local');
    expect(result.reconnect).toBe(backend);
    expect(result.adapter).toBeInstanceOf(LocalStorageAdapter);
    expect(isSyncPending()).toBe(true);
    const recovered = await RoadmapStore.create(result.adapter);
    expect(recovered.loadAllHistory().map(row => row.value)).toEqual([80]);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1]).toEqual({ tags: { area: 'cloud-sync', op: 'load', backend } });
    expect(captureException.mock.calls[0][0].message).not.toContain('synthetic network failure');
  });
});
