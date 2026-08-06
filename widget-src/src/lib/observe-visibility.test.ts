import { describe, it, expect, vi, afterEach } from 'vitest';
import { observeVisibility } from './observe-visibility';

// Regression: Sentry 7625508570 — iOS/macOS Lockdown Mode removes
// IntersectionObserver, and the bare `new IntersectionObserver(...)` in the
// chat surfaces threw "Can't find variable: IntersectionObserver", crashing
// the whole site-chat React tree. The helper must degrade to "visible".

const el = {} as Element;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('observeVisibility', () => {
  it('reports visibility changes via IntersectionObserver when available', () => {
    let ioCallback: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeIO {
      constructor(cb: typeof ioCallback) { ioCallback = cb; }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);

    const onChange = vi.fn();
    const stop = observeVisibility(el, onChange, { threshold: 0.1 });

    expect(observe).toHaveBeenCalledWith(el);
    expect(onChange).not.toHaveBeenCalled();

    ioCallback([{ isIntersecting: true }]);
    expect(onChange).toHaveBeenLastCalledWith(true);

    ioCallback([{ isIntersecting: false }]);
    expect(onChange).toHaveBeenLastCalledWith(false);

    stop();
    expect(disconnect).toHaveBeenCalled();
  });

  it('treats the element as immediately visible when IntersectionObserver is missing (Lockdown Mode)', () => {
    vi.stubGlobal('IntersectionObserver', undefined);

    const onChange = vi.fn();
    const stop = observeVisibility(el, onChange);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(() => stop()).not.toThrow();
  });
});
