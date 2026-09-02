/**
 * US-34 AC4 — a remote change that lands on a dirty form is HELD, not dropped.
 *
 * HealthTool has no test harness, so the decision this makes lives here as a
 * pure relay and the component only wires it up.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRemoteChangeRelay } from './remote-replay';

describe('US-34 AC4 — createRemoteChangeRelay', () => {
  it('applies a change that arrives on a clean form', () => {
    const apply = vi.fn();
    createRemoteChangeRelay(apply).arrived(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('holds a change that arrives mid-typing, and replays it once the edit is saved', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.arrived(true);
    expect(apply).not.toHaveBeenCalled();

    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('replays a held change once, however many saves follow', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.arrived(true);
    relay.saved();
    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a save when no change was held', () => {
    const apply = vi.fn();
    createRemoteChangeRelay(apply).saved();
    expect(apply).not.toHaveBeenCalled();
  });

  it('collapses several changes held during one edit into a single replay', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.arrived(true);
    relay.arrived(true);
    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
