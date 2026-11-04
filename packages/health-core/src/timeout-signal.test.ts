/**
 * US-09 AC13g: `timeoutDeadline`, the deadline the cloud adapters set on their
 * own calls. The adapters are pinned through the real code in
 * widget-src/src/storage/old-safari-deadline.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchOrFail, timeoutDeadline } from './adapter';

const nativeTimeout = AbortSignal.timeout;

afterEach(() => {
  Object.defineProperty(AbortSignal, 'timeout', { value: nativeTimeout, configurable: true, writable: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('US-09 AC13g: timeoutDeadline', () => {
  it('uses AbortSignal.timeout where the browser has it', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { signal } = timeoutDeadline(5_000);
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(signal).toBe(timeout.mock.results[0].value);
  });

  it('without it (Safari 14/15), aborts at the same deadline, not before, as a TimeoutError', async () => {
    vi.useFakeTimers();
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    const { signal } = timeoutDeadline(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe('TimeoutError');
  });

  it('without it, clear frees the timer and the signal never aborts', async () => {
    vi.useFakeTimers();
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    const { signal, clear } = timeoutDeadline(5_000);
    expect(vi.getTimerCount()).toBe(1);
    clear();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(false);
  });
});

// Review of #788 (Brad, 2026-11-04, finding 2): fetchOrFail kept its own
// feature check and ran with no deadline on Safari 14/15.
describe('US-09 AC13g: fetchOrFail without AbortSignal.timeout (Safari 14/15)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives up at 30 s, not before, when the provider never answers', async () => {
    vi.useFakeTimers();
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    let outcome: unknown = 'pending';
    fetchOrFail('Dropbox', 'https://example.test/file').then(() => { outcome = 'resolved'; }, (e: unknown) => { outcome = e; });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect((outcome as Error).message).toBe('Dropbox did not answer');
  });

  it('frees its deadline timer once the answer and its body are in', async () => {
    vi.useFakeTimers();
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));

    const res = await fetchOrFail('Dropbox', 'https://example.test/file');
    expect(await res.json()).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('US-09 AC13g: fetchOrFail with a caller\'s own signal', () => {
  const nativeAny = AbortSignal.any;
  afterEach(() => {
    Object.defineProperty(AbortSignal, 'any', { value: nativeAny, configurable: true, writable: true });
    vi.unstubAllGlobals();
  });
  const hung = () => vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  }));

  it('with AbortSignal.any, a caller signal that never fires still meets the bound', async () => {
    vi.useFakeTimers();
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    vi.stubGlobal('fetch', hung());
    let outcome: unknown = 'pending';
    fetchOrFail('Dropbox', 'https://example.test/file', { signal: new AbortController().signal, timeoutMs: 1_000 })
      .then(() => { outcome = 'resolved'; }, (e: unknown) => { outcome = e; });

    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect((outcome as Error).message).toBe('Dropbox did not answer');
  });

  it('without AbortSignal.any or .timeout (Safari 14/15), the caller\'s own signal ends the call at once', async () => {
    vi.useFakeTimers();
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    vi.stubGlobal('fetch', hung());
    const caller = new AbortController();
    let outcome: unknown = 'pending';
    fetchOrFail('Dropbox', 'https://example.test/file', { signal: caller.signal })
      .then(() => { outcome = 'resolved'; }, (e: unknown) => { outcome = e; });
    caller.abort(new DOMException('caller gave up', 'AbortError'));

    await vi.advanceTimersByTimeAsync(0);
    expect((outcome as Error).message).toBe('Dropbox did not answer');
    expect(vi.getTimerCount()).toBe(0);
  });
});
