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

  it('US-34 AC4 (PR 1155 review F2): a re-read the page makes before its first read is shown keeps the waiting change for that read: it applies once the read is shown, counted once', () => {
    const apply = vi.fn((remote: boolean) => remote);
    const relay = createRemoteChangeRelay(apply);

    relay.arrived(false);
    expect(relay.reread()).toBe(false); // the first read, still to come, would overwrite what this shows
    relay.loaded();
    relay.saved();
    expect(apply.mock.calls).toEqual([[false], [true]]);
  });

  it('survey R2: with no change before it, showing the first read applies nothing, and a later change applies at once', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);

    relay.loaded();
    expect(apply).not.toHaveBeenCalled();
    relay.arrived(false);
    expect(apply.mock.calls).toEqual([[true]]);
  });

  it('fix 4 2b-3: the erase machine\'s read (`shows`) ends a hold and counts nothing; the save that cleans the form reads nothing more', () => {
    const apply = vi.fn();
    const relay = ready(apply);
    relay.arrived(true);
    relay.shows();
    expect(apply.mock.calls).toEqual([[false]]);
    relay.saved();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('fix 4 2b-3: before the first read is shown, `shows` ends a wait but the relay stays loading: loaded reads nothing more, a later change still waits', () => {
    const apply = vi.fn();
    const relay = createRemoteChangeRelay(apply);
    relay.arrived(false); // loading-held
    relay.shows();
    relay.loaded();
    expect(apply.mock.calls).toEqual([[false]]);
    const early = vi.fn();
    const other = createRemoteChangeRelay(early);
    other.shows();
    other.arrived(false);
    expect(early.mock.calls).toEqual([[false]]); // the change waits for the first read
    other.loaded();
    expect(early.mock.calls).toEqual([[false], [true]]);
  });

  // fix 4 2b-3 R1/F2: the late echo of the erase the screen shows is a remote change that counts nothing.
  // apply(remote, counts): remote clears the answer mark (US-62 AC13); counts fires remote_change_applied.
  type Relay = ReturnType<typeof createRemoteChangeRelay<void>>;
  it.each<[string, boolean, (relay: Relay) => void, unknown[][]]>([
    ['a held echo waits, then the save that cleans the form applies it: clears, counts nothing', true,
      r => { r.arrived(true, false); r.saved(); }, [[true, false]]],
    ['a clean echo applies at once: clears, counts nothing', true, r => { r.arrived(false, false); }, [[true, false]]],
    ['an echo held with a plain change: one read, counted once', true, r => { r.arrived(true, false); r.arrived(true); r.saved(); }, [[true]]],
    ['a plain change held, then an echo: one read, counted once', true, r => { r.arrived(true); r.arrived(true, false); r.saved(); }, [[true]]],
    ['a held echo ended by a reread (an upload, a \'left\' re-read): clears, counts nothing', true,
      r => { r.arrived(true, false); r.reread(); }, [[true, false]]],
    ['a loading-held echo ended by loaded: clears, counts nothing', false, r => { r.arrived(false, false); r.loaded(); }, [[true, false]]],
    ['a held echo ended by saved: clears, counts nothing; a second save reads nothing', true,
      r => { r.arrived(true, false); r.saved(); r.saved(); }, [[true, false]]],
    ['a reread with nothing held: neither', true, r => { r.reread(); }, [[false]]],
  ])('F2: %s', (_name, loaded, steps, calls) => {
    const apply = vi.fn();
    const relay = loaded ? ready(apply) : createRemoteChangeRelay(apply);
    steps(relay);
    expect(apply.mock.calls).toEqual(calls);
  });
});
