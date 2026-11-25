/**
 * A1-6 (US-09 AC13e, AC13g, AC39): the one deadline policy every cloud call
 * reads. The numbers are the ones the call sites carried before; each site's
 * own pin lives beside it (timeout-signal, dropbox-document-upload-deadline,
 * drive-rest, document-fetch-deadline, old-safari-deadline tests). Fake clock,
 * synthetic HTTP, no live provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOrFail } from './adapter';
import { TRANSFER_DEADLINE_MS, documentUploadMs, timeoutDeadline } from './transfer-deadline';

describe('A1-6: the deadline for each kind of call is the number its callers had', () => {
  it('30 s a call, 5 min a document, 5 s a token refresh, 10 s an account email', () => {
    expect(TRANSFER_DEADLINE_MS).toEqual({ call: 30_000, document: 300_000, tokenRefresh: 5_000, accountEmail: 10_000 });
  });

  it("a Drive upload's bound grows 1 s per 10 KB from 30 s, capped at 5 min", () => {
    expect(documentUploadMs(2_000)).toBe(30_000);
    expect(documentUploadMs(1_000_000)).toBe(130_000);
    expect(documentUploadMs(10 * 1024 * 1024)).toBe(300_000);
  });
});

describe('A1-6: the deadline aborts the request itself', () => {
  /** The signal each request was given, and a way to answer the latest one. */
  let signals: AbortSignal[];
  let answer: (res: Response) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on the real clock; this one runs on the fake clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('synthetic deadline', 'TimeoutError')), ms);
      return controller.signal;
    });
    signals = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
      signals.push(init.signal!);
      answer = resolve;
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('a document transfer that gets no answer is aborted at 5 min, not before', async () => {
    let outcome: unknown = 'pending';
    fetchOrFail('Dropbox', 'https://example.test/doc', { timeoutMs: TRANSFER_DEADLINE_MS.document })
      .then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(TRANSFER_DEADLINE_MS.document - 1);
    expect(signals[0].aborted).toBe(false);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect((outcome as Error).message).toBe('Dropbox did not answer');
  });

  it('an answer 1 ms inside the deadline succeeds', async () => {
    const pending = fetchOrFail('Dropbox', 'https://example.test/doc', { timeoutMs: TRANSFER_DEADLINE_MS.document });
    await vi.advanceTimersByTimeAsync(TRANSFER_DEADLINE_MS.document - 1);
    answer(new Response('{"ok":true}', { status: 200 }));
    const res = await pending;
    expect(await res.json()).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(signals[0].aborted).toBe(true); // the timer fired after; the call had already settled
  });

  it('with no kind named, a call gets 30 s', async () => {
    let outcome: unknown = 'pending';
    fetchOrFail('GitHub', 'https://example.test/file').then(() => { outcome = 'resolved'; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(TRANSFER_DEADLINE_MS.call - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect((outcome as Error).message).toBe('GitHub did not answer');
  });

  it('timeoutDeadline on its own aborts at its number, and clear stops it on old Safari', async () => {
    const native = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    try {
      const fired = timeoutDeadline(TRANSFER_DEADLINE_MS.tokenRefresh);
      const cleared = timeoutDeadline(TRANSFER_DEADLINE_MS.tokenRefresh);
      cleared.clear();
      await vi.advanceTimersByTimeAsync(TRANSFER_DEADLINE_MS.tokenRefresh);
      expect(fired.signal.aborted).toBe(true);
      expect(cleared.signal.aborted).toBe(false);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: native, configurable: true, writable: true });
    }
  });
});
