/**
 * US-34 AC1a: the rule a cloud watch loop applies when it takes a fresh
 * cursor. Drive's loop is pinned through the real adapter in
 * widget-src/src/storage/drive-watch.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { catchUpAfterFailure } from './adapter';

describe('US-34 AC1a: catchUpAfterFailure', () => {
  it('asks for one re-read after a failure', () => {
    const onChange = vi.fn();
    catchUpAfterFailure(3_000, new AbortController().signal, onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
    catchUpAfterFailure(1, new AbortController().signal, onChange); // any wait at all means a failure came before
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('asks nothing on a clean start or after a success', () => {
    const onChange = vi.fn();
    catchUpAfterFailure(0, new AbortController().signal, onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('asks nothing once the watch is aborted', () => {
    const onChange = vi.fn();
    const stop = new AbortController();
    stop.abort();
    catchUpAfterFailure(3_000, stop.signal, onChange);
    expect(onChange).not.toHaveBeenCalled();
  });
});
