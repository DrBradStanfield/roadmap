// @vitest-environment jsdom
/**
 * US-10 AC14 (H92): the one page-hide path. Every stage runs, each
 * in its own try, then the store writes once, then the entrypoint's after-hook,
 * on a hidden page only. The pins of what reaches disk are in
 * components/HealthTool.page-hide.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flush = vi.hoisted(() => vi.fn());
vi.mock('./roadmap-data', () => ({ flushRoadmapStoreSync: flush }));
const captured = vi.hoisted(() => vi.fn());
vi.mock('./sentry', () => ({ Sentry: { captureException: captured } }));

import { afterPageHide, onPageHide } from './page-hide';

const leaves: Array<() => void> = [];
const on = <T extends () => void>(leave: T) => { leaves.push(leave); return leave; };

function hidden() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}
const pagehide = () => window.dispatchEvent(new Event('pagehide'));
const beforeunload = () => window.dispatchEvent(new Event('beforeunload'));

beforeEach(() => { flush.mockReset(); captured.mockReset(); });
afterEach(() => {
  for (const leave of leaves.splice(0)) leave();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('US-10 AC14 (H92): one page-hide path', () => {
  it('runs every stage, then one flush, then the after-hook, in that order', () => {
    const order: string[] = [];
    flush.mockImplementation(() => order.push('flush'));
    on(afterPageHide(() => order.push('after')));
    on(onPageHide(() => order.push('page')));
    on(onPageHide(() => order.push('cell')));
    hidden();
    expect(order).toEqual(['page', 'cell', 'flush', 'after']);
  });

  it.each([['a hidden visibilitychange', hidden], ['pagehide', pagehide], ['beforeunload', beforeunload]] as const)(
    'one hide flushes the store once, however many stages (%s)', (_, event) => {
      const stages = [vi.fn(), vi.fn(), vi.fn()];
      for (const stage of stages) on(onPageHide(stage));
      on(afterPageHide(() => {}));
      event();
      expect(flush).toHaveBeenCalledTimes(1);
      for (const stage of stages) expect(stage).toHaveBeenCalledTimes(1);
    },
  );

  it('a stage that throws does not stop the others or the flush; the throw is reported', () => {
    const error = new Error('Synthetic test: stage failed');
    const later = vi.fn();
    on(onPageHide(() => { throw error; }));
    on(onPageHide(later));
    expect(() => pagehide()).not.toThrow();
    expect(later).toHaveBeenCalledWith(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(later.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]);
    expect(captured).toHaveBeenCalledWith(error, { tags: { area: 'page-hide' } });
  });

  it('tells a stage whether the page is closing (beforeunload, pagehide) or only hidden', () => {
    const stage = vi.fn();
    on(onPageHide(stage));
    beforeunload(); pagehide(); hidden();
    expect(stage.mock.calls).toEqual([[true], [true], [false]]);
  });

  it('pagehide alone, with no page mounted, still flushes; the after-hook waits for a hidden page', () => {
    const after = vi.fn();
    on(afterPageHide(after)); // the entrypoint only, as before HealthTool mounts
    pagehide();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    hidden();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('a visibilitychange while the page still shows does nothing', () => {
    const stage = vi.fn();
    on(onPageHide(stage));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(stage).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('a stage that leaves the path no longer runs; with nothing left, a hide does nothing', () => {
    const stays = vi.fn();
    const goes = vi.fn();
    const leaveStays = onPageHide(stays);
    const leaveGoes = onPageHide(goes);
    leaveGoes();
    pagehide();
    expect([stays.mock.calls.length, goes.mock.calls.length, flush.mock.calls.length]).toEqual([1, 0, 1]);
    leaveStays();
    leaveGoes(); // a second leave changes nothing
    pagehide();
    expect([stays.mock.calls.length, flush.mock.calls.length]).toEqual([1, 1]);
  });
});
