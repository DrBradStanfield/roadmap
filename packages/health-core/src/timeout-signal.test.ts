/**
 * US-09 AC13g: `timeoutSignal`, the deadline the cloud adapters set on their
 * own calls. The adapters are pinned through the real code in
 * widget-src/src/storage/old-safari-deadline.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { timeoutSignal } from './adapter';

const nativeTimeout = AbortSignal.timeout;

afterEach(() => {
  Object.defineProperty(AbortSignal, 'timeout', { value: nativeTimeout, configurable: true, writable: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('US-09 AC13g: timeoutSignal', () => {
  it('uses AbortSignal.timeout where the browser has it', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const signal = timeoutSignal(5_000);
    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(signal).toBe(timeout.mock.results[0].value);
  });

  it('without it (Safari 14/15), aborts at the same deadline, not before, as a TimeoutError', async () => {
    vi.useFakeTimers();
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true, writable: true });
    const signal = timeoutSignal(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe('TimeoutError');
  });
});
