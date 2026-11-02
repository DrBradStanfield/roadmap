/**
 * US-09 AC13e: GitHub and WebDAV document reads and uploads, the GitHub sha
 * lookup, the WebDAV folder create and the WebDAV connect check use the same
 * `fetchOrFail` transport as the record (AC13b). A call that gets no answer
 * fails as a `StorageError`, and so does a dead network, instead of a bare
 * `TypeError` or a wait with no end. The small calls keep the 30-second bound;
 * a document read or upload gets 5 minutes, Drive's cap for an upload, so a
 * large original on a slow link is not cut at 30 seconds (drive-rest.ts).
 * Real adapters; synthetic HTTP and a fake clock, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from '@roadmap/health-core';
import { GitHubAdapter } from './github';
import { WebDavAdapter } from './webdav';

const REF = 'documents/2024-06-01 report #1.pdf';
const github = () => new GitHubAdapter({ token: 'synthetic-token', owner: 'synthetic', repo: 'synthetic-private' });
const webdav = () => new WebDavAdapter({ url: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'synthetic' });

type Answer = (url: string, init: RequestInit) => Response | 'stall' | 'offline';

/** Each request gets `answer`'s reply. 'stall' hangs until the request's
 *  signal aborts, as a browser fetch does; with no signal it hangs for good.
 *  'offline' rejects as a dead network does. */
function provider(answer: Answer) {
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const reply = answer(String(url), init);
    if (reply === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    if (reply === 'stall') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    return Promise.resolve(reply);
  }));
}
const isRepoCheck = (url: string) => url.endsWith('/repos/synthetic/synthetic-private');
const repoIsPrivate = () => new Response(JSON.stringify({ private: true }));

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, String(value)); },
    removeItem: (key: string) => { items.delete(key); },
  });
  vi.useFakeTimers();
  // The fake clock drives the shared deadline, as in provider-read-fallback.test.ts.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const SMALL_CALL_MS = 30_000;
const DOCUMENT_MS = 300_000;

/** Runs `work` on the fake clock: still pending 1 ms before `ms`, failed
 *  with a `StorageError` at `ms`. */
async function failsAtDeadline(work: () => Promise<unknown>, ms: number): Promise<void> {
  let failure: unknown = 'pending';
  void work().then(() => { failure = 'resolved'; }, (error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(failure).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  expect(failure).toBeInstanceOf(StorageError);
}

describe('GitHub documents (US-09 AC13e)', () => {
  it('a document read that never answers fails at 5 minutes', async () => {
    provider(() => 'stall');
    await failsAtDeadline(() => github().readDocument(REF), DOCUMENT_MS);
  });

  it('the legacy-path read after a 404 is bounded too', async () => {
    let calls = 0;
    provider(() => (calls++ === 0 ? new Response('', { status: 404 }) : 'stall'));
    await failsAtDeadline(() => github().readDocument(REF), DOCUMENT_MS);
    expect(calls).toBe(2);
  });

  it('a document upload that never answers fails at 5 minutes', async () => {
    provider((url) => (isRepoCheck(url) ? repoIsPrivate() : 'stall'));
    await failsAtDeadline(() => github().writeDocument(REF, new Blob(['synthetic'])), DOCUMENT_MS);
  });

  it('the sha lookup after a conflict fails at 30 s', async () => {
    provider((url, init) => {
      if (isRepoCheck(url)) return repoIsPrivate();
      return init.method === 'PUT' ? new Response('', { status: 422 }) : 'stall';
    });
    await failsAtDeadline(() => github().writeDocument(REF, new Blob(['synthetic'])), SMALL_CALL_MS);
  });

  it('a dead network is a StorageError, not a TypeError', async () => {
    provider(() => 'offline');
    await expect(github().readDocument(REF)).rejects.toBeInstanceOf(StorageError);
    provider((url) => (isRepoCheck(url) ? repoIsPrivate() : 'offline'));
    await expect(github().writeDocument(REF, new Blob(['synthetic']))).rejects.toBeInstanceOf(StorageError);
  });

  it('a document that answers still reads and uploads as before', async () => {
    provider((url, init) => {
      if (isRepoCheck(url)) return repoIsPrivate();
      if (init.method === 'PUT') return new Response('{}', { status: 201 });
      return new Response(JSON.stringify({ content: btoa('synthetic') }));
    });
    expect(await (await github().readDocument(REF)).text()).toBe('synthetic');
    await expect(github().writeDocument(REF, new Blob(['synthetic']))).resolves.toBeUndefined();
  });
});

describe('WebDAV documents and connect (US-09 AC13e)', () => {
  it('a document read that never answers fails at 5 minutes', async () => {
    provider(() => 'stall');
    await failsAtDeadline(() => webdav().readDocument(REF), DOCUMENT_MS);
  });

  it('the legacy-path read after a 404 is bounded too', async () => {
    let calls = 0;
    provider(() => (calls++ === 0 ? new Response('', { status: 404 }) : 'stall'));
    await failsAtDeadline(() => webdav().readDocument(REF), DOCUMENT_MS);
    expect(calls).toBe(2);
  });

  it('a document upload that never answers fails at 5 minutes', async () => {
    provider(() => 'stall');
    await failsAtDeadline(() => webdav().writeDocument(REF, new Blob(['synthetic'])), DOCUMENT_MS);
  });

  it('the folder create after a 409 fails at 30 s', async () => {
    provider((_url, init) => (init.method === 'MKCOL' ? 'stall' : new Response('', { status: 409 })));
    await failsAtDeadline(() => webdav().writeDocument(REF, new Blob(['synthetic'])), SMALL_CALL_MS);
  });

  it('the connect check that never answers fails at 30 s', async () => {
    provider(() => 'stall');
    await failsAtDeadline(() => webdav().connect(), SMALL_CALL_MS);
  });

  it('a dead network is a StorageError, not a TypeError', async () => {
    provider(() => 'offline');
    await expect(webdav().readDocument(REF)).rejects.toBeInstanceOf(StorageError);
    await expect(webdav().writeDocument(REF, new Blob(['synthetic']))).rejects.toBeInstanceOf(StorageError);
    await expect(webdav().connect()).rejects.toBeInstanceOf(StorageError);
  });

  it('a server that answers still reads, uploads and connects as before', async () => {
    let mkcol = 0;
    let puts = 0;
    provider((_url, init) => {
      if (init.method === 'PROPFIND') return new Response('', { status: 207 });
      if (init.method === 'MKCOL') { mkcol++; return new Response('', { status: 201 }); }
      if (init.method === 'PUT') return new Response('', { status: puts++ === 0 ? 409 : 201 });
      return new Response('synthetic', { headers: { 'Content-Type': 'application/pdf' } });
    });
    const blob = await webdav().readDocument(REF);
    expect(await blob.text()).toBe('synthetic');
    expect(blob.type).toBe('application/pdf'); // the viewer's type gate reads it (US-14 AC3)
    await expect(webdav().writeDocument(REF, new Blob(['synthetic']))).resolves.toBeUndefined();
    expect(mkcol).toBe(1);
    await expect(webdav().connect()).resolves.toBeUndefined();
  });
});
