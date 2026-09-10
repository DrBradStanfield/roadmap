/**
 * GitHub connect — the public-repo guard.
 *
 * The GitHub backend is the only one where the destination can be world
 * readable: a fine-grained PAT on a PUBLIC repo passes every check the connect
 * flow used to make (token valid, repo reachable), and the first write then
 * publishes the health record to the internet. So connect() reads
 * `private` off the repo response and refuses anything that is not true —
 * before the config is persisted, so a refused repo leaves nothing behind to
 * reconnect from.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StorageError } from '@roadmap/health-core';
import { GitHubAdapter } from './github';

const CONFIG = { token: 'ghp_test', owner: 'octocat', repo: 'health' };
const CONFIG_KEY = 'health_roadmap_github';

function makeStorage(seed: Record<string, string> = {}): Storage {
  const s = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

/** The repo endpoint's answer, with only the field the guard reads varying. */
const repoResponse = (isPrivate: unknown) =>
  new Response(JSON.stringify({ full_name: 'octocat/health', private: isPrivate }), { status: 200 });

describe('GitHubAdapter.connect — refuses a public repo', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    ['public', false],
    ['field missing', undefined],
    ['string "false"', 'false'],
  ])('throws and saves nothing when the repo is %s', async (_label, isPrivate) => {
    vi.stubGlobal('localStorage', makeStorage());
    vi.stubGlobal('fetch', vi.fn(async () => repoResponse(isPrivate)));

    const adapter = new GitHubAdapter(CONFIG);
    await expect(adapter.connect()).rejects.toBeInstanceOf(StorageError);
    await expect(adapter.connect()).rejects.toThrow(/repository is public/i);
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('saves the config when the repo is private', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    vi.stubGlobal('fetch', vi.fn(async () => repoResponse(true)));

    const adapter = new GitHubAdapter(CONFIG);
    await adapter.connect();

    expect(JSON.parse(localStorage.getItem(CONFIG_KEY)!)).toEqual(CONFIG);
    expect(adapter.isConnected()).toBe(true);
  });

  it('still rejects a bad token before it ever looks at visibility', async () => {
    vi.stubGlobal('localStorage', makeStorage());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const adapter = new GitHubAdapter(CONFIG);
    await expect(adapter.connect()).rejects.toThrow(/rejected the token/i);
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });
});
