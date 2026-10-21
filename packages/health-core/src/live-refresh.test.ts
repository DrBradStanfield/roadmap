/**
 * The US-34 live re-read in the engine, as the iPhone app will drive it:
 * visible()/hidden() from the scene phase, pushed() from the store's change
 * signal, timers and clock from the host. The widget's live-refresh tests pin
 * the same rules through the DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import { LiveRefresh } from './live-refresh';
import { REMOTE_POLL_MS, REMOTE_THROTTLE_MS, type RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import { MemoryAdapter } from './memory-adapter';

function rig(opts: { tier?: 'device' | 'cloud'; watch?: boolean; revision?: () => string | null } = {}) {
  let now = 1_000_000;
  let visible = true;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextId = 0;
  let watching = 0;
  let onChange: (() => void) | null = null;
  const session = { lastRefreshAt: 0, seenRevision: 'r1' as string | null };
  const reread = vi.fn(async () => { session.lastRefreshAt = now; });
  const base = {
    store: new MemoryAdapter(),
    clock: { now: () => now },
    timers: {
      set: (run: () => void, ms: number) => { timers.set(nextId, { at: now + ms, run }); return nextId++; },
      clear: (id: unknown) => void timers.delete(id as number),
    },
    ...(opts.watch ? { watch: (fn: () => void) => { watching++; onChange = fn; return () => { watching--; onChange = null; }; } } : {}),
    ...(opts.revision ? { sync: { revision: opts.revision, readSync: () => ({ body: null, version: null }), writeSync: () => ({ version: '' }) } } : {}),
  };
  const host = (opts.tier === 'device'
    ? { ...base, tier: 'device', clearNamedFiles: () => {} }
    : { ...base, tier: 'cloud' }) as unknown as RecordHost;
  const live = new LiveRefresh(session as unknown as RecordSession, host, { reread, isVisible: () => visible });
  /** Move the clock on, running every timer that falls due, in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = end;
  };
  return {
    live, reread, session, timers, advance,
    setVisible: (v: boolean) => { visible = v; },
    push: () => onChange?.(),
    watching: () => watching,
  };
}

describe('LiveRefresh (US-34)', () => {
  it('polls every minute while visible, and reads nothing while hidden (AC1)', () => {
    const r = rig();
    r.live.start();
    r.advance(REMOTE_POLL_MS);
    expect(r.reread).toHaveBeenCalledTimes(1);
    r.setVisible(false);
    r.live.hidden();
    r.advance(2 * REMOTE_POLL_MS);
    expect(r.reread).toHaveBeenCalledTimes(1);
    r.setVisible(true);
    r.advance(REMOTE_POLL_MS);
    expect(r.reread).toHaveBeenCalledTimes(2);
    r.live.stop();
    expect(r.timers.size).toBe(0);
  });

  it('runs no poll when the store has a change signal, and reads on a push (AC1)', () => {
    const r = rig({ watch: true });
    r.live.start();
    expect(r.watching()).toBe(1);
    expect(r.timers.size).toBe(0);
    r.push();
    expect(r.reread).toHaveBeenCalledTimes(1);
  });

  it('holds a push the throttle swallowed until the window is out', () => {
    const r = rig({ watch: true });
    r.live.start();
    r.push();
    r.advance(1_000);
    r.push(); // inside the window: waits, never dropped
    expect(r.reread).toHaveBeenCalledTimes(1);
    r.advance(REMOTE_THROTTLE_MS);
    expect(r.reread).toHaveBeenCalledTimes(2);
  });

  it('drops a cloud watch while hidden and takes it up on return; the catch-up waits out the throttle', () => {
    const r = rig({ watch: true });
    r.live.start();
    r.push();
    r.setVisible(false);
    r.live.hidden();
    expect(r.watching()).toBe(0);
    r.setVisible(true);
    r.live.visible();
    expect(r.watching()).toBe(1);
    // It read within the window just before hiding: the catch-up is queued, not dropped.
    expect(r.reread).toHaveBeenCalledTimes(1);
    r.advance(REMOTE_THROTTLE_MS);
    expect(r.reread).toHaveBeenCalledTimes(2);
  });

  it('keeps the device tier watching while hidden, and skips a return when the stored revision has not moved (AC6)', () => {
    let revision = 'r1';
    const r = rig({ tier: 'device', watch: true, revision: () => revision });
    r.setVisible(false);
    r.live.start();
    expect(r.watching()).toBe(1);
    r.live.hidden();
    expect(r.watching()).toBe(1);
    r.setVisible(true);
    r.live.visible();
    expect(r.reread).not.toHaveBeenCalled();
    revision = 'r2';
    r.advance(REMOTE_THROTTLE_MS);
    r.live.visible();
    expect(r.reread).toHaveBeenCalledTimes(1);
  });

  it('ignores a push while hidden', () => {
    const r = rig({ tier: 'device', watch: true });
    r.live.start();
    r.setVisible(false);
    r.push();
    expect(r.reread).not.toHaveBeenCalled();
  });
});
