/**
 * US-34 AC4 — a remote change that lands on a dirty form is HELD, not dropped.
 *
 * HealthTool has no test harness, so the decision this makes lives here as a
 * pure relay and the component only wires it up.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRemoteChangeRelay } from './remote-replay';

/** A relay whose page has shown its first read. */
const ready = <T,>(apply: (remote: boolean) => T) => { const relay = createRemoteChangeRelay(apply); relay.loaded(); return relay; };

describe('US-34 AC4 — createRemoteChangeRelay', () => {
  it('applies a change that arrives on a clean form', () => {
    const apply = vi.fn();
    ready(apply).arrived(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('holds a change that arrives mid-typing, and replays it once the edit is saved', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived(true);
    expect(apply).not.toHaveBeenCalled();

    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('replays a held change once, however many saves follow', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived(true);
    relay.saved();
    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a save when no change was held', () => {
    const apply = vi.fn();
    ready(apply).saved();
    expect(apply).not.toHaveBeenCalled();
  });

  it('collapses several changes held during one edit into a single replay', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived(true);
    relay.arrived(true);
    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('US-11 AC6: a held change, then one applied at once (an erase from another device), applies once; the save after finds nothing held', () => {
    const apply = vi.fn();
    const relay = ready(apply);

    relay.arrived(true);
    relay.arrived(false);
    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('survey R8: a re-read the page makes for itself while a change is held takes it in, once; the save after finds nothing held', () => {
    const apply = vi.fn((remote: boolean) => remote);
    const relay = ready(apply);

    relay.arrived(true);
    expect(relay.reread()).toBe(true);
    relay.saved();
    expect(apply.mock.calls).toEqual([[true]]);
  });

  it('survey R8: a re-read with nothing held takes in no remote change', () => {
    const apply = vi.fn((remote: boolean) => remote);
    const relay = ready(apply);

    expect(relay.reread()).toBe(false);
    relay.saved();
    expect(apply.mock.calls).toEqual([[false]]);
  });

  it('survey R2: a change arriving before the page has shown its first read waits, then applies once when it has, whatever the form', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.arrived(false);
    relay.saved();
    expect(apply).not.toHaveBeenCalled();
    relay.loaded();
    relay.loaded();
    relay.saved();
    expect(apply.mock.calls).toEqual([[true]]);
  });

  it('survey R2: with no change before it, showing the first read applies nothing, and a later change applies at once', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.loaded();
    expect(apply).not.toHaveBeenCalled();
    relay.arrived(false);
    expect(apply.mock.calls).toEqual([[true]]);
  });
});
