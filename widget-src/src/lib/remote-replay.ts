/**
 * US-34 AC4 — holding a remote change that lands mid-typing.
 *
 * Re-running the load path replaces the demographics form's inputs, so a
 * change arriving on a half-entered height would take those keystrokes with
 * it. The change is held instead and applied on the save that carries the
 * edit up, so the page still catches up without a reload.
 *
 * Two states: idle, or held (a remote change waits for a clean form). Every
 * re-read of the record goes through here, so a held change is applied once
 * (survey R8). `apply(remote)`: `remote` says the re-read takes in another
 * writer's change.
 */
export function createRemoteChangeRelay<T>(apply: (remote: boolean) => T) {
  let state: 'idle' | 'held' = 'idle';
  return {
    /** A remote change arrived. `formDirty`: the user is mid-edit. */
    arrived(formDirty: boolean): void {
      state = formDirty ? 'held' : 'idle';
      if (!formDirty) apply(true); // this re-read is the one a held change waited for
    },
    /** A profile save landed. Applies a change held back by a dirty form. */
    saved(): void {
      if (state === 'idle') return;
      state = 'idle';
      apply(true);
    },
    /** The page re-reads the record for itself (an upload, a refused save): the re-read shows a held change too. */
    reread(): T {
      const remote = state === 'held';
      state = 'idle';
      return apply(remote);
    },
  };
}
