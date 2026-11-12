// US-09 AC30 (lead A1 step e): LiveRefresh retries a failed cloud save at the
// moments it already owns: the page shows again (`visible`, trigger 'focus')
// and the device comes back online (`online`, trigger 'online'). At most one
// retry a minute per page, on the host clock; cloud tier only. Each retry
// that started a pass is reported once through the host, as
// `saveRetried({ trigger, outcome })` and nothing else.
import { describe, expect, it, vi } from 'vitest';
import { LiveRefresh } from './live-refresh';
import type { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { MemoryAdapter } from './memory-adapter';

const MINUTE = 60_000;

function rig(opts: { tier?: 'device' | 'cloud'; owed?: boolean; lands?: boolean } = {}) {
  let now = 5_000_000;
  const order: string[] = [];
  const reported: unknown[][] = [];
  const state = { owed: opts.owed ?? true, lands: opts.lands ?? true };
  const session = {
    lastRefreshAt: 0,
    seenRevision: null as string | null,
    // The real retry answers null when no retry is owed (retryOwed), and the
    // whole save's answer when it started one.
    retry: vi.fn(() => {
      order.push('retry');
      return state.owed ? Promise.resolve(state.lands) : null;
    }),
  };
  const reread = vi.fn(async () => { order.push('reread'); session.lastRefreshAt = now; });
  const base = {
    store: new MemoryAdapter(),
    clock: { now: () => now },
    timers: { set: () => 0, clear: () => {} },
    saveRetried: (...args: unknown[]) => void reported.push(args),
  };
  const host = (opts.tier === 'device'
    ? { ...base, tier: 'device', clearNamedFiles: () => {}, sync: { revision: () => 'r1', readSync: () => ({ body: null, version: null }), writeSync: () => ({ version: '' }) } }
    : { ...base, tier: 'cloud' }) as unknown as RecordHost;
  const live = new LiveRefresh(session as unknown as RecordSession, host, { reread, isVisible: () => true }) as LiveRefresh & { online(): void };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { live, session, reread, order, reported, state, settle, advance: (ms: number) => { now += ms; } };
}

describe('LiveRefresh retries a failed save (US-09 AC30, lead A1 step e)', () => {
  it('visible() retries before it re-reads', async () => {
    const r = rig();
    r.live.visible();
    expect(r.order).toEqual(['retry', 'reread']);
    await r.settle();
    expect(r.reported).toEqual([[{ trigger: 'focus', outcome: 'landed' }]]);
  });

  it('online() retries, then catches up as visible() does', async () => {
    const r = rig();
    r.live.online();
    expect(r.order).toEqual(['retry', 'reread']);
    await r.settle();
    expect(r.reported).toEqual([[{ trigger: 'online', outcome: 'landed' }]]);
  });

  it('a retry that fails again is reported as failed', async () => {
    const r = rig({ lands: false });
    r.live.online();
    await r.settle();
    expect(r.reported).toEqual([[{ trigger: 'online', outcome: 'failed' }]]);
  });

  it('a burst of online, visible and focus within a minute retries once', async () => {
    const r = rig({ lands: false });
    r.live.online();
    r.advance(1_000);
    r.live.visible();
    r.advance(MINUTE - 1_001);
    r.live.visible(); // a focus 59.999 s after the first retry
    await r.settle();
    expect(r.session.retry).toHaveBeenCalledTimes(1);
    expect(r.reported).toEqual([[{ trigger: 'online', outcome: 'failed' }]]);
  });

  it('a minute after the last retry, retries again', async () => {
    const r = rig({ lands: false });
    r.live.online();
    await r.settle();
    r.advance(MINUTE);
    r.live.visible();
    await r.settle();
    expect(r.session.retry).toHaveBeenCalledTimes(2);
    expect(r.reported).toEqual([[{ trigger: 'online', outcome: 'failed' }], [{ trigger: 'focus', outcome: 'failed' }]]);
  });

  it('never on the device tier: its refusals do not heal when the network comes back', async () => {
    const r = rig({ tier: 'device' });
    r.live.online();
    r.advance(MINUTE);
    r.live.visible();
    await r.settle();
    expect(r.session.retry).not.toHaveBeenCalled();
    expect(r.reported).toEqual([]);
  });

  it('reports nothing when no retry was owed (a clean session, or a refused grant)', async () => {
    const r = rig({ owed: false });
    r.live.online();
    r.advance(MINUTE);
    r.live.visible();
    await r.settle();
    expect(r.reported).toEqual([]);
    expect(r.reread).toHaveBeenCalled(); // the catch-up still reads
  });
});
