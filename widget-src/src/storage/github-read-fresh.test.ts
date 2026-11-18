/**
 * US-09 AC13i: the GitHub adapter's file read tells `fetch` not to use the
 * browser's HTTP cache (`cache: 'no-store'`). GitHub's Contents API marks an
 * answer `Cache-Control: private, max-age=60`, so inside that minute a second
 * read could be the first answer again, with the old sha. A save that read
 * the old sha was refused (409), read again, and got the same stored answer.
 *
 * The fetch here is a model, not a browser. It keeps a GET answer by URL and
 * hands it back to a later GET unless that GET says `cache: 'no-store'`; a PUT
 * GitHub accepts drops the kept answer. Synthetic values; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { recordSync } from '@roadmap/health-core/roadmap-doc';
import { createEmptyFile } from '@roadmap/health-core/roadmap-file';
import { GitHubAdapter } from './github';

const NOW = '2026-11-17T00:00:00.000Z';
const CONFIG = { token: 'test-token-good', owner: 'synthetic-owner', repo: 'synthetic-repo' };
const REPO = 'https://api.github.com/repos/synthetic-owner/synthetic-repo';
const base64 = (value: unknown) => btoa(JSON.stringify(value));
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** GitHub holding one record, behind the cache model described above. */
function gitHub() {
  const remote = { sha: 'sha-1', content: base64(createEmptyFile({ deviceId: 'device-b', now: NOW })), served: 0, puts: [] as number[] };
  const kept = new Map<string, string>();
  const fetchModel = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === REPO) return reply(200, { private: true });
    if (init?.method === 'PUT') {
      const sent = JSON.parse(String(init.body)) as { sha?: string; content: string };
      const status = sent.sha === remote.sha ? 200 : 409;
      remote.puts.push(status);
      if (status === 409) return reply(409, { message: 'synthetic: sha does not match' });
      Object.assign(remote, { sha: `${remote.sha}-saved`, content: sent.content });
      kept.delete(url);
      return reply(200, { content: { sha: remote.sha } });
    }
    const stored = kept.get(url);
    if (stored && init?.cache !== 'no-store') return reply(200, JSON.parse(stored));
    remote.served += 1;
    const answer = JSON.stringify({ sha: remote.sha, content: remote.content, encoding: 'base64', size: remote.content.length });
    if (init?.cache !== 'no-store') kept.set(url, answer);
    return reply(200, JSON.parse(answer), { 'Cache-Control': 'private, max-age=60, s-maxage=60' });
  });
  /** Another device saves: the file on GitHub gets a new sha. */
  const otherDeviceSaves = () => Object.assign(remote, { sha: 'sha-2', content: base64(createEmptyFile({ deviceId: 'device-c', now: NOW })) });
  return { remote, fetchModel, otherDeviceSaves };
}

beforeEach(() => {
  const local = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('US-09 AC13i: a GitHub read is not answered from the browser cache', () => {
  it('a second read inside the minute sees the sha another device saved in between', async () => {
    const { remote, fetchModel, otherDeviceSaves } = gitHub();
    vi.stubGlobal('fetch', fetchModel);
    const adapter = new GitHubAdapter(CONFIG);
    expect((await adapter.read(ROADMAP_FILE_NAME)).version).toBe('sha-1');
    otherDeviceSaves();
    const second = await adapter.read(ROADMAP_FILE_NAME);
    expect(second.version).toBe('sha-2');
    expect((second.body as { meta: { lastDeviceId: string } }).meta.lastDeviceId).toBe('device-c');
    expect(remote.served).toBe(2);
  });

  it('a save after another device saved reads the new sha and lands first time', async () => {
    const { remote, fetchModel, otherDeviceSaves } = gitHub();
    vi.stubGlobal('fetch', fetchModel);
    const sync = recordSync(new GitHubAdapter(CONFIG), 'device-a', NOW);
    const loaded = await sync.load();
    otherDeviceSaves();
    const saved = await sync.save(loaded);
    expect(saved.attempts).toBe(0);
    expect(remote.puts).toEqual([200]);
    expect(remote.sha).toBe('sha-2-saved');
  });

  it('the read keeps its headers, and the write sends no cache option', async () => {
    const { fetchModel } = gitHub();
    vi.stubGlobal('fetch', fetchModel);
    const adapter = new GitHubAdapter(CONFIG);
    const { version } = await adapter.read(ROADMAP_FILE_NAME);
    await adapter.write(ROADMAP_FILE_NAME, { synthetic: true }, version);
    const inits = fetchModel.mock.calls.map(([, init]) => ({ method: init?.method ?? 'GET', cache: init?.cache }));
    expect(inits).toEqual([{ method: 'GET', cache: 'no-store' }, { method: 'GET', cache: undefined }, { method: 'PUT', cache: undefined }]);
    const readHeaders = new Headers(fetchModel.mock.calls[0][1]?.headers);
    expect(readHeaders.get('Authorization')).toContain('test-token-good');
    expect(readHeaders.get('Accept')).toBe('application/vnd.github+json');
  });
});
