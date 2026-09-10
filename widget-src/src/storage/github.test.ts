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
import type { Mock } from 'vitest';
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

/**
 * The same guard, on the write path. Resuming a saved connection builds a bare
 * `new GitHubAdapter()` and never calls connect(), so a repo connected before
 * the check existed — or made public afterwards — would keep receiving the
 * record. Every write funnels through write()/writeDocument(), so both check
 * visibility once per adapter instance before the first PUT.
 */
type FetchMock = Mock<[string, RequestInit?], Promise<Response>>;

/** Routes by URL: the repo endpoint answers visibility, contents answers PUTs. */
function stubFetch(isPrivate: unknown, repoStatus = 200): FetchMock {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/contents/')) {
      const body = init?.method === 'PUT' ? { content: { sha: 'newsha' } } : { content: '', sha: 'oldsha' };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (repoStatus !== 200) return new Response('', { status: repoStatus });
    return repoResponse(isPrivate);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock: FetchMock, kind: 'repo' | 'put') =>
  fetchMock.mock.calls.filter(([url, init]) =>
    kind === 'put' ? init?.method === 'PUT' : !url.includes('/contents/'),
  );

describe('GitHubAdapter writes — the guard on a resumed connection', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A connection saved before the check existed: no connect() call, ever. */
  const resumed = () => {
    vi.stubGlobal('localStorage', makeStorage({ [CONFIG_KEY]: JSON.stringify(CONFIG) }));
    return new GitHubAdapter();
  };

  it('refuses to write to a public repo, and sends no PUT', async () => {
    const fetchMock = stubFetch(false);
    const adapter = resumed();

    await expect(adapter.write('health-roadmap.json', { a: 1 }, null)).rejects.toThrow(/repository is public/i);
    expect(calls(fetchMock, 'put')).toHaveLength(0);
  });

  it('checks visibility once, then writes, when the repo is private', async () => {
    const fetchMock = stubFetch(true);
    const adapter = resumed();

    await expect(adapter.write('health-roadmap.json', { a: 1 }, null)).resolves.toEqual({ version: 'newsha' });
    expect(calls(fetchMock, 'repo')).toHaveLength(1);
    expect(calls(fetchMock, 'put')).toHaveLength(1);
  });

  it('does not re-check on the second write', async () => {
    const fetchMock = stubFetch(true);
    const adapter = resumed();

    await adapter.write('health-roadmap.json', { a: 1 }, null);
    await adapter.write('health-roadmap.json', { a: 2 }, 'newsha');

    expect(calls(fetchMock, 'repo')).toHaveLength(1);
    expect(calls(fetchMock, 'put')).toHaveLength(2);
  });

  it('fires one visibility GET for two concurrent first writes', async () => {
    const fetchMock = stubFetch(true);
    const adapter = resumed();

    await Promise.all([
      adapter.write('health-roadmap.json', { a: 1 }, null),
      adapter.writeDocument('documents/lab.pdf', new Blob(['x'])),
    ]);

    expect(calls(fetchMock, 'repo')).toHaveLength(1);
  });

  it('gates writeDocument the same way', async () => {
    const fetchMock = stubFetch(false);
    const adapter = resumed();

    await expect(adapter.writeDocument('documents/lab.pdf', new Blob(['x']))).rejects.toThrow(/repository is public/i);
    expect(calls(fetchMock, 'put')).toHaveLength(0);
  });

  it('fails closed on a failed visibility GET, and re-checks on the next write', async () => {
    const fetchMock = stubFetch(true, 500);
    const adapter = resumed();

    await expect(adapter.write('health-roadmap.json', { a: 1 }, null)).rejects.toBeInstanceOf(StorageError);
    expect(calls(fetchMock, 'put')).toHaveLength(0);

    // Transient: the memo is cleared, so the next write asks again and proceeds.
    stubFetch(true);
    await expect(adapter.write('health-roadmap.json', { a: 1 }, null)).resolves.toEqual({ version: 'newsha' });
  });

  it('leaves reads ungated', async () => {
    const fetchMock = stubFetch(false);
    const adapter = resumed();

    await adapter.read('health-roadmap.json');
    expect(calls(fetchMock, 'repo')).toHaveLength(0);
  });
});
