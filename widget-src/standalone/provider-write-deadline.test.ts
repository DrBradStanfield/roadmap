/** US-09 AC13d: a GitHub or WebDAV record save that never answers is bounded.
 * Real adapters, store and sync manager; synthetic HTTP only, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_DOC, ROADMAP_FILE_NAME, StorageError, SyncManager, createEmptyFile } from '@roadmap/health-core';
import { GitHubAdapter } from '../src/storage/github';
import { WebDavAdapter } from '../src/storage/webdav';
import { LocalStorageAdapter, isSyncPending } from '../src/storage';
import { RoadmapStore } from '../src/storage/roadmap-store';

const captureException = vi.fn();
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: (...args: unknown[]) => captureException(...args) } }));
const providers = [
  ['github', () => new GitHubAdapter({ token: 'synthetic-token', owner: 'synthetic', repo: 'synthetic-private' })],
  ['self-host', () => new WebDavAdapter({ url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'synthetic' })],
] as const;
const empty = () => createEmptyFile({ deviceId: 'synthetic-device', now: '2026-01-01T00:00:00Z' });

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, String(value)); },
    removeItem: (key: string) => { items.delete(key); },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  captureException.mockClear();
  vi.useFakeTimers();
  // The fake clock drives the shared deadline, as in provider-read-fallback.test.ts.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(providers)('%s record save that never answers (US-09 AC13d)', (backend, make) => {
  /** Reads answer at once; the stalled request hangs until its signal aborts,
   *  as a browser fetch does. With no signal it hangs for good. */
  function stall(stalled: (url: string, init: RequestInit) => boolean) {
    let stored = JSON.stringify(empty());
    let version = 0;
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
      if (stalled(url, init)) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      if (url.endsWith('/repos/synthetic/synthetic-private')) return Promise.resolve(new Response(JSON.stringify({ private: true })));
      if (init.method === 'PUT') {
        const sent = JSON.parse(String(init.body)) as { content?: string };
        stored = backend === 'github' ? atob(sent.content!) : String(init.body);
        version++;
        return Promise.resolve(new Response(JSON.stringify({ content: { sha: `v${version}` } }), { status: 201, headers: { etag: `v${version}` } }));
      }
      return Promise.resolve(new Response(backend === 'github'
        ? JSON.stringify({ content: btoa(stored), sha: `v${version}` })
        : stored, { headers: { etag: `v${version}` } }));
    }));
  }
  const isPut = (_url: string, init: RequestInit) => init.method === 'PUT';

  it('fails at the 30-second deadline and says the change may have landed', async () => {
    stall(isPut);
    let settled = false;
    const saving = new SyncManager(make(), 'synthetic-device', ROADMAP_DOC).save(empty())
      .then(() => 'saved', (error: unknown) => error)
      .finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const failure = await saving;
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as StorageError).hint).toContain('may have landed');
  });

  it('a stalled save fails, keeps the edit on the device and lets the next save through', async () => {
    let stalling = true;
    stall((url, init) => stalling && isPut(url, init));
    const store = await RoadmapStore.create(make());
    store.addMeasurement('ldl', 3.2, '2024-06-01T09:00:00.000Z');
    let outcome = '';
    const flushing = store.flush().then(() => { outcome = 'saved'; }, () => { outcome = 'failed'; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(outcome).toBe('failed');
    await flushing;
    expect(isSyncPending()).toBe(true);
    const device = await RoadmapStore.create(new LocalStorageAdapter());
    expect(device.loadAllHistory().map(row => row.value)).toEqual([3.2]);
    expect(captureException).toHaveBeenCalled();
    stalling = false;
    store.addMeasurement('hdl', 1.4, '2024-06-01T09:00:00.000Z');
    await expect(store.flush()).resolves.toBeUndefined();
  });

  if (backend === 'github') {
    it('the privacy check before the save is bounded too', async () => {
      stall((url) => url.endsWith('/repos/synthetic/synthetic-private'));
      let failure: unknown;
      void make().write(ROADMAP_FILE_NAME, empty(), null).catch((error: unknown) => { failure = error; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(failure).toBeInstanceOf(StorageError);
    });
  } else {
    it('the ETag lookup after the save is bounded too, and the save still succeeds', async () => {
      vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit = {}) => init.method === 'HEAD'
        ? new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); })
        : Promise.resolve(new Response('', { status: 201 }))));
      let written: unknown;
      void make().write(ROADMAP_FILE_NAME, empty(), null).then((result) => { written = result; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(written).toEqual({ version: '' });
    });
  }
});
