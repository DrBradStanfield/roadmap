/**
 * US-09 AC39: a Dropbox document upload has a deadline, the 5 minutes every
 * other provider's document upload already has (AC13e for GitHub and WebDAV,
 * `driveCreateFile` for Drive). Before, it was a bare `fetch`: an upload the
 * network stopped answering held the web upload's Save open for good (Discard
 * and a new upload are refused while a save runs). The iPhone's document
 * save calls the same upload. 5 minutes is long enough that a 10 MB original on a 1 Mbps
 * uplink (about 80 seconds) still lands. Synthetic HTTP and a fake clock, no
 * live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from './adapter';
import { DropboxAdapter, dropboxUploadDocument } from './dropbox-rest';

const UPLOAD_MS = 300_000;
const REF = 'Lab results/2024-06-01 report.pdf';
const bytes = () => new Uint8Array([37, 80, 68, 70]);

/** Each request gets `answer`'s reply. 'stall' hangs until the request's
 *  signal aborts, as a browser fetch does; with no signal it hangs for good.
 *  'offline' rejects as a dead network does. */
function provider(answer: 'stall' | 'offline' | Response) {
  const fetchMock = vi.fn((_url: string, init: RequestInit = {}) => {
    if (answer === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
    if (answer !== 'stall') return Promise.resolve(answer);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Runs `work` on the fake clock: still pending 1 ms before `ms`, settled at `ms`. */
async function failureAt(work: Promise<unknown>, ms: number): Promise<unknown> {
  let failure: unknown = 'pending';
  void work.then(() => { failure = 'resolved'; }, (error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(failure).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  return failure;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC39: a Dropbox document upload has a 5-minute deadline', () => {
  it('an upload that gets no answer fails at 5 minutes, not before', async () => {
    provider('stall');
    const failure = await failureAt(dropboxUploadDocument('token', REF, bytes()), UPLOAD_MS);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('Dropbox did not answer');
    // Issue #980: the bytes went out, so the upload may have landed, as a
    // Drive document create says (US-09 AC13d).
    expect((failure as StorageError).hint).toBe('The change may have landed. Read the record again before trying it a second time.');
  });

  it('the same through the adapter the web and the iPhone use to file an original', async () => {
    provider('stall');
    const adapter = new DropboxAdapter('token', { documents: 'write' });
    const failure = await failureAt(adapter.writeDocument(REF, new Blob([bytes()])), UPLOAD_MS);
    expect(failure).toBeInstanceOf(StorageError);
  });

  it('a dead network is a StorageError, not a bare TypeError', async () => {
    provider('offline');
    const failure = await dropboxUploadDocument('token', REF, bytes()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('Dropbox did not answer');
  });

  it('control: an answered upload still lands, and a refused one still names its status', async () => {
    const fetchMock = provider(new Response('{}', { status: 200 }));
    await expect(dropboxUploadDocument('token', REF, bytes())).resolves.toBeUndefined();
    const [url, init = {}] = fetchMock.mock.calls[0];
    expect(url).toBe('https://content.dropboxapi.com/2/files/upload');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Dropbox-API-Arg')).toContain('"mode":{".tag":"overwrite"}');
    provider(new Response('', { status: 507 }));
    const refused = await dropboxUploadDocument('token', REF, bytes()).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StorageError);
    expect((refused as StorageError).message).toBe('Dropbox document write failed (507).');
    expect((refused as StorageError).status).toBe(507);
  });
});
