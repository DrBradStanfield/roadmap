/**
 * US-34 AC4 — holding a remote change that lands mid-typing.
 *
 * Re-running the load path replaces the demographics form's inputs, so a
 * change arriving on a half-entered height would take those keystrokes with
 * it. The change is held instead and applied on the save that carries the
 * edit up, so the page still catches up without a reload.
 */
export function createRemoteChangeRelay(apply: () => void) {
  let held = false;
  return {
    /** A remote change arrived. `formDirty`: the user is mid-edit. */
    arrived(formDirty: boolean): void {
      if (formDirty) held = true;
      else apply();
    },
    /** A profile save landed. Applies a change held back by a dirty form. */
    saved(): void {
      if (!held) return;
      held = false;
      apply();
    },
  };
}
