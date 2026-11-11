/**
 * US-34 AC4 — holding a remote change that lands mid-typing.
 *
 * Re-running the load path replaces the demographics form's inputs, so a
 * change arriving on a half-entered height would take those keystrokes with
 * it. The change is held instead and applied on the save that carries the
 * edit up, so the page still catches up without a reload.
 *
 * States:
 * - loading: the page has not shown its first read yet; a change arriving now
 *   would be overwritten by that read, so it waits (loading-held) and applies
 *   once the read is shown (`loaded`, survey R2);
 * - idle: nothing waits;
 * - held: a remote change waits for a clean form.
 * Every whole re-read of the record goes through here, so a held change is applied
 * once (survey R8). `apply(remote, counts)`: `remote` says the re-read takes in
 * another writer's change; `counts` (by default, `remote`) that it counts.
 * The late announcement of the erase the screen already shows is a remote
 * change that counts nothing (fix 4 2b-3 R1): a waiting change carries its
 * `counts`, and two waiting together count if either does. An erase the
 * screen does not show never enters: the erase machine hears and counts it,
 * and its read comes through `shows`.
 */
export function createRemoteChangeRelay<T>(apply: (remote: boolean, counts?: boolean) => T) {
  let state: { phase: 'loading' | 'idle' } | { phase: 'loading-held' | 'held'; counts: boolean } = { phase: 'loading' };
  const loading = () => state.phase === 'loading' || state.phase === 'loading-held';
  /** Whether a change waits, and if so whether it counts. */
  const waiting = (): boolean | null => ('counts' in state ? state.counts : null);
  const applyRemote = (counts: boolean) => (counts ? apply(true) : apply(true, false));
  return {
    /** A remote change arrived. `formDirty`: the user is mid-edit. `counts`: false for the late echo of an erase already shown. */
    arrived(formDirty: boolean, counts = true): void {
      const merged = counts || waiting() === true;
      if (loading()) { state = { phase: 'loading-held', counts: merged }; return; }
      if (formDirty) { state = { phase: 'held', counts: merged }; return; }
      state = { phase: 'idle' };
      applyRemote(merged); // this re-read is the one a held change waited for
    },
    /** The page has shown its first read: a change that arrived before it applies now. */
    loaded(): void {
      if (!loading()) return;
      const held = state.phase === 'loading-held' ? waiting() : null;
      state = { phase: 'idle' };
      if (held !== null) applyRemote(held);
    },
    /** A profile save landed. Applies a change held back by a dirty form. */
    saved(): void {
      if (state.phase !== 'held') return;
      const { counts } = state;
      state = { phase: 'idle' };
      applyRemote(counts);
    },
    /** The page re-reads the record for itself (an upload, a refused save): the re-read shows a held change too.
     *  Not before the first read is shown: that read would overwrite this one, so a waiting change waits for it. */
    reread(): T {
      if (loading()) return apply(false);
      // Ending a hold and counting are two things: an echo's hold ends here too, as another writer's change, uncounted.
      const held = state.phase === 'held';
      const counts = state.phase === 'held' && state.counts;
      state = { phase: 'idle' };
      return held ? applyRemote(counts) : apply(false);
    },
    /** The erase machine's read (another writer's erase, which never enters here): it shows a waiting change
     *  too, so the wait ends, uncounted; the machine counts the erase. Before the first read is shown it stays loading. */
    shows(): T {
      state = { phase: loading() ? 'loading' : 'idle' };
      return apply(false);
    },
  };
}
