/**
 * US-34 AC4 — holding a remote change that lands mid-typing.
 *
 * Re-running the load path replaces the demographics form's inputs, so a
 * change arriving on a half-entered height would take those keystrokes with
 * it. The change is held instead and applied when the next profile save
 * settles, landed or refused, so the page still catches up without a reload
 * (AC8: a refused value rides through the re-read with its error).
 *
 * States:
 * - loading: the page has not shown its first read yet; a change arriving now
 *   would be overwritten by that read, so it waits (loading-held) and applies
 *   once the read is shown (`loaded`, survey R2);
 * - idle: nothing waits;
 * - held: a remote change waits for the next profile save to settle.
 * Every whole re-read of the record goes through here, so a held change is applied
 * once (survey R8). `apply(remote, counts)`: `remote` says the re-read takes in
 * another writer's change; `counts` (by default, `remote`) that it counts.
 * The late announcement of the erase the screen already shows is a remote
 * change that counts nothing (fix 4 2b-3 R1): a waiting change carries its
 * `counts`, and two waiting together count if either does. An erase the
 * screen does not show never enters: the erase machine hears and counts it,
 * and its read comes through `shows`.
 *
 * Changed only through the pure `transition`; the relay sends each method as an event and runs the read
 * the step asks for.
 */
export type HoldState = { phase: 'loading' | 'idle' } | { phase: 'loading-held' | 'held'; counts: boolean };

export type HoldEvent =
  /** A remote change arrived. `formDirty`: the user is mid-edit. `counts`: false for the late echo of an erase already shown. */
  | { type: 'arrived'; formDirty: boolean; counts: boolean }
  /** The page has shown its first read: a change that arrived before it applies now. */
  | { type: 'loaded' }
  /** A profile save settled: landed, had a value refused, or found nothing to save (US-34 AC8). Applies a change
   *  held back by a dirty form; a refused value rides through the re-read. */
  | { type: 'settled' }
  /** The page re-reads the record for itself (an upload, a refused save): the re-read shows a held change too.
   *  Not before the first read is shown: that read would overwrite this one, so a waiting change waits for it. */
  | { type: 'reread' }
  /** The erase machine's read (another writer's erase, which never enters here): it shows a waiting change
   *  too, so the wait ends, uncounted; the machine counts the erase. Before the first read is shown it stays loading. */
  | { type: 'shows' };

/** The read a step asks for: the page's own (no remote change), another writer's that counts, or one that counts nothing. */
export type HoldRead = 'own' | 'remote' | 'uncounted';

export interface HoldStep { state: HoldState; read: HoldRead | null }

const IDLE: HoldState = { phase: 'idle' };
const remoteRead = (counts: boolean): HoldRead => (counts ? 'remote' : 'uncounted');
const isLoading = (state: HoldState) => state.phase === 'loading' || state.phase === 'loading-held';

export function transition(state: HoldState, event: HoldEvent): HoldStep {
  switch (event.type) {
    case 'arrived': {
      // Two changes waiting together count if either does.
      const counts = event.counts || ('counts' in state && state.counts);
      if (isLoading(state)) return { state: { phase: 'loading-held', counts }, read: null };
      if (event.formDirty) return { state: { phase: 'held', counts }, read: null };
      return { state: IDLE, read: remoteRead(counts) }; // this re-read is the one a held change waited for
    }
    case 'loaded':
      if (state.phase === 'loading-held') return { state: IDLE, read: remoteRead(state.counts) };
      return { state: state.phase === 'loading' ? IDLE : state, read: null };
    case 'settled':
      return state.phase === 'held' ? { state: IDLE, read: remoteRead(state.counts) } : { state, read: null };
    case 'reread':
      if (isLoading(state)) return { state, read: 'own' };
      // Ending a hold and counting are two things: an echo's hold ends here too, as another writer's change, uncounted.
      return { state: IDLE, read: state.phase === 'held' ? remoteRead(state.counts) : 'own' };
    case 'shows':
      return { state: isLoading(state) ? { phase: 'loading' } : IDLE, read: 'own' };
  }
}

export function createRemoteChangeRelay<T>(apply: (remote: boolean, counts?: boolean) => T) {
  let state: HoldState = { phase: 'loading' };
  const run = (read: HoldRead): T => {
    switch (read) {
      case 'own': return apply(false);
      case 'remote': return apply(true);
      case 'uncounted': return apply(true, false);
    }
  };
  const send = (event: HoldEvent): HoldRead | null => {
    const step = transition(state, event);
    state = step.state;
    return step.read;
  };
  const sendAndRun = (event: HoldEvent): void => { const read = send(event); if (read !== null) run(read); };
  return {
    arrived(formDirty: boolean, counts = true): void { sendAndRun({ type: 'arrived', formDirty, counts }); },
    loaded(): void { sendAndRun({ type: 'loaded' }); },
    settled(): void { sendAndRun({ type: 'settled' }); },
    // reread and shows always ask for a read (the table test pins it).
    reread(): T { return run(send({ type: 'reread' }) ?? 'own'); },
    shows(): T { return run(send({ type: 'shows' }) ?? 'own'); },
  };
}
