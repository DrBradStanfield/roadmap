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
 * once (survey R8). `apply(remote)`: `remote` says the re-read takes in
 * another writer's change.
 */
export function createRemoteChangeRelay<T>(apply: (remote: boolean) => T) {
  let state: 'loading' | 'loading-held' | 'idle' | 'held' = 'loading';
  const loading = () => state === 'loading' || state === 'loading-held';
  return {
    /** A remote change arrived. `formDirty`: the user is mid-edit. */
    arrived(formDirty: boolean): void {
      if (loading()) { state = 'loading-held'; return; }
      state = formDirty ? 'held' : 'idle';
      if (!formDirty) apply(true); // this re-read is the one a held change waited for
    },
    /** The page has shown its first read: a change that arrived before it applies now. */
    loaded(): void {
      if (!loading()) return;
      const waiting = state === 'loading-held';
      state = 'idle';
      if (waiting) apply(true);
    },
    /** A profile save landed. Applies a change held back by a dirty form. */
    saved(): void {
      if (state !== 'held') return;
      state = 'idle';
      apply(true);
    },
    /** The page re-reads the record for itself (an upload, a refused save): the re-read shows a held change too.
     *  Not before the first read is shown: that read would overwrite this one, so a waiting change waits for it. */
    reread(): T {
      if (loading()) return apply(false);
      const remote = state === 'held';
      state = 'idle';
      return apply(remote);
    },
  };
}
