/**
 * US-09 AC13c: a GitHub record over the Contents API's 1 MB inline limit is
 * not "absent".
 *
 * For a file between 1 and 100 MB the API answers 200 with `content: ""`,
 * `encoding: "none"` and the real sha (GitHub REST docs, "Get repository
 * content"; this adapter's own LIMIT note). read() used to return
 * `{ body: null, version: sha }`; the core reads a null body as "never saved",
 * so the next save PUT a near-empty record over the real one with the matching
 * sha. The read now fails closed, which selects AC13's on-device fallback.
 * Synthetic data, stubbed fetch, no network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { ROADMAP_DOC, StorageError, SyncManager } from '@roadmap/health-core';
import { GitHubAdapter } from './github';
import { ChatHistoryStore } from './chat-history-store';

const CONFIG = { token: 'synthetic-token', owner: 'synthetic', repo: 'synthetic-private' };

function makeStorage(): Storage {
  const s = new Map<string, string>();
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<Response>>;

/** The repo is private; the stored file answers with `contents` (a GET body). */
function stubContents(contents: Record<string, unknown>): FetchMock {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/contents/')) {
      const body = init?.method === 'PUT' ? { content: { sha: 's2' } } : contents;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ private: true }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const LARGE = { name: 'health-roadmap.json', sha: 's1', size: 1_200_000, content: '', encoding: 'none' };
const puts = (fetchMock: FetchMock) => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
const now = '2026-10-28T00:00:00.000Z';

describe('GitHubAdapter on a record over 1 MB (US-09 AC13c)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fails the read with a storage failure instead of returning an empty body', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    stubContents(LARGE);
    await expect(new GitHubAdapter(CONFIG).read('health-roadmap.json')).rejects.toBeInstanceOf(StorageError);
  });

  it('fails on the size alone when the encoding field is absent', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    stubContents({ ...LARGE, encoding: undefined });
    await expect(new GitHubAdapter(CONFIG).read('health-roadmap.json')).rejects.toBeInstanceOf(StorageError);
  });

  it('fails on the encoding alone when the size field is absent', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    stubContents({ ...LARGE, size: undefined });
    await expect(new GitHubAdapter(CONFIG).read('health-roadmap.json')).rejects.toBeInstanceOf(StorageError);
  });

  it('a load does not hand back a blank record in place of the real one', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    stubContents(LARGE);
    const sync = new SyncManager(new GitHubAdapter(CONFIG), 'dev', ROADMAP_DOC, { now: () => now });
    await expect(sync.load()).rejects.toBeInstanceOf(StorageError);
  });

  it('a save never overwrites the large file it could not read', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    const fetchMock = stubContents(LARGE);
    const sync = new SyncManager(new GitHubAdapter(CONFIG), 'dev', ROADMAP_DOC, { now: () => now });
    await expect(sync.save(ROADMAP_DOC.migrate(null, { deviceId: 'dev', now }))).rejects.toThrow();
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('a chat history over 1 MB does not open as empty and is never written over', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    const fetchMock = stubContents({ ...LARGE, name: 'chat-history.json' });
    await expect(ChatHistoryStore.create(new GitHubAdapter(CONFIG))).rejects.toBeInstanceOf(StorageError);
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it('control: a normal file with its size and base64 content still reads its body', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    const json = JSON.stringify({ hello: 'synthetic' });
    stubContents({ name: 'health-roadmap.json', sha: 's3', size: json.length, content: btoa(json), encoding: 'base64' });
    await expect(new GitHubAdapter(CONFIG).read('health-roadmap.json')).resolves.toEqual({ body: { hello: 'synthetic' }, version: 's3' });
  });

  it('control: an empty file of size 0 still reads as no record', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    stubContents({ name: 'health-roadmap.json', sha: 's0', size: 0, content: '', encoding: 'base64' });
    await expect(new GitHubAdapter(CONFIG).read('health-roadmap.json')).resolves.toEqual({ body: null, version: 's0' });
  });
});
