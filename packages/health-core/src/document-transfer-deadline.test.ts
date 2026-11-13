/**
 * US-09 AC51 (A1-6, owner's answers 2026-11-13): every document download gets
 * the `document` deadline (5 minutes), as GitHub and WebDAV reads already do
 * (AC13e). The Drive download had none and dropped the caller's signal; the
 * Dropbox download had the 30-second call bound. A stalled upload on every
 * provider says the change may have landed (AC13d), in the one existing
 * string. Synthetic HTTP and a fake clock, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from './adapter';
import { DriveAdapter, driveDownloadDocument, driveUploadDocument } from './drive-rest';
import { DropboxAdapter, dropboxDownload, dropboxUploadDocument } from './dropbox-rest';

const DOCUMENT_MS = 300_000;
const LANDED = 'The change may have landed. Read the record again before trying it a second time.';

/** Answers a Drive file lookup with one id, a Dropbox or Drive bytes request
 *  with `bytes` (or a stall), and everything else with a stall that ends
 *  only when the request's signal aborts, as a browser fetch does. */
function provider(bytes: 'stall' | (() => Response)) {
  const signals: AbortSignal[] = [];
  const answers: Array<(res: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    if (String(url).includes('/files?q=')) return Promise.resolve(new Response(JSON.stringify({ files: [{ id: 'f1' }] })));
    if (bytes !== 'stall') return Promise.resolve(bytes());
    signals.push(init.signal!);
    return new Promise<Response>((resolve, reject) => {
      answers.push(resolve);
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }));
  return { signals, answer: (res: Response) => answers[answers.length - 1](res) };
}

/** `work` on the fake clock: still pending 1 ms before `ms`, settled at `ms`. */
async function outcomeAt(work: Promise<unknown>, ms: number): Promise<unknown> {
  let outcome: unknown = 'pending';
  void work.then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; });
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(outcome).toBe('pending');
  await vi.advanceTimersByTimeAsync(1);
  return outcome;
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

describe('US-09 AC51: a Drive document download has the 5-minute document deadline', () => {
  it('a download that gets no answer is aborted at 5 minutes, not before', async () => {
    const { signals } = provider('stall');
    const failure = await outcomeAt(driveDownloadDocument('token', 'a.pdf', 'folder'), DOCUMENT_MS);
    expect(signals[0].aborted).toBe(true);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('Google Drive did not answer');
  });

  it('an answer 1 ms inside the deadline is read', async () => {
    const drive = provider('stall');
    const pending = driveDownloadDocument('token', 'a.pdf', 'folder');
    await vi.advanceTimersByTimeAsync(DOCUMENT_MS - 1);
    drive.answer(new Response('pdf bytes'));
    expect(await (await pending).text()).toBe('pdf bytes');
  });

  it("the adapter passes the caller's signal through (US-35 AC5): it aborts the download at the caller's own time", async () => {
    const { signals } = provider('stall');
    const adapter = new DriveAdapter('token', { documents: 'write' });
    // The document folder is found before the download starts.
    (adapter as unknown as { documentFolder: () => Promise<string> }).documentFolder = async () => 'folder';
    const caller = new AbortController();
    setTimeout(() => caller.abort(new DOMException('caller deadline', 'TimeoutError')), 40_000);
    const failure = await outcomeAt(adapter.readDocument('Lab results/a.pdf', caller.signal), 40_000);
    expect(signals[0].aborted).toBe(true);
    expect((failure as Error).message).toBe('Google Drive did not answer');
  });
});

describe("US-09 AC51, US-35 AC5: the caller's signal also ends the Drive folder discovery before the download (Codex R1)", () => {
  it('with every request stalled, a fresh adapter fails at the caller\'s 1 s, not at 30 s', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit = {}) => {
      signals.push(init.signal!);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));
    const caller = new AbortController();
    setTimeout(() => caller.abort(new DOMException('caller deadline', 'TimeoutError')), 1_000);
    const failure = await outcomeAt(new DriveAdapter('token', { documents: 'write' }).readDocument('Lab results/a.pdf', caller.signal), 1_000);
    expect(failure).toBeInstanceOf(StorageError);
    expect((failure as Error).message).toBe('Google Drive did not answer');
    expect((failure as StorageError).hint).not.toBe(LANDED); // a read wrote nothing
    expect(signals).toHaveLength(1); // still in the folder lookup: the download never started
  });
});

describe('US-09 AC51: a Dropbox document download has the 5-minute document deadline (was 30 s)', () => {
  it('a download that gets no answer is aborted at 5 minutes, not at 30 s', async () => {
    const { signals } = provider('stall');
    const failure = await outcomeAt(dropboxDownload('token', 'id:one'), DOCUMENT_MS);
    expect(signals[0].aborted).toBe(true);
    expect((failure as Error).message).toBe('Dropbox did not answer');
  });

  it('through the adapter, a caller with a shorter deadline still ends it at its own time', async () => {
    provider('stall');
    const caller = new AbortController();
    setTimeout(() => caller.abort(new DOMException('caller deadline', 'TimeoutError')), 40_000);
    const failure = await outcomeAt(new DropboxAdapter('token').readDocument('id:one', caller.signal), 40_000);
    expect((failure as Error).message).toBe('Dropbox did not answer');
  });
});

describe('US-09 AC13d, AC51: a stalled document upload says it may have landed (Dropbox, Drive)', () => {
  it('Dropbox', async () => {
    provider('stall');
    const failure = await outcomeAt(dropboxUploadDocument('token', 'Lab results/a.pdf', new Uint8Array([1])), DOCUMENT_MS);
    expect((failure as StorageError).hint).toBe(LANDED);
  });

  it('Drive', async () => {
    provider('stall');
    const failure = await outcomeAt(driveUploadDocument('token', 'a.pdf', new Blob(['x']), 'folder'), 30_000);
    expect((failure as StorageError).hint).toBe(LANDED);
  });
});
