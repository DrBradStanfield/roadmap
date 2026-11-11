/**
 * The erase machine against the real merge (untangle fix 4; US-16 AC2a,
 * US-09 AC23; Codex R1, adversary F1): the merge's erase choice is no order
 * on the identity strings. At one epoch, when only one side lists its rows,
 * the merge takes the unlisted erase's erasedAt, which can be the earlier.
 * Whatever pair it meets, the screen must end at the identity the store
 * holds: on a read, an arrival, an arrival held then loaded, and this tab's
 * erase ending with another writer's erase overtaking it.
 */
import { describe, it, expect } from 'vitest';
import { mergeFiles } from '@roadmap/health-core/merge';
import { eraseIdentityOf } from '@roadmap/health-core/record-session';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { initialEraseState, transition, type EraseEvent, type EraseState } from './erase-machine';

const OPTS = { deviceId: 'dev_merge', now: '2026-11-11T12:00:00Z' };
const LATE = '2026-10-21T00:00:00.001Z';
const EARLY = '2026-09-01T00:00:00.001Z';

/** An erase at `epoch`, at `erasedAt`, listing its rows or not (an old app's erase lists none). */
function erased(epoch: number, erasedAt: string | null, lists: boolean): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' });
  file.meta.eraseEpoch = epoch;
  if (erasedAt) file.meta.erasedAt = erasedAt;
  if (lists) {
    file.schemaVersion = 2;
    file.erasedRows = { fromEpoch: epoch, ids: [`row-${epoch}-${erasedAt}`] };
  }
  return file;
}

/** [pair, this tab's copy, the other writer's copy, whose erase the merge keeps].
 *  A pair the merge settles on this tab's copy is trivial for the own-end case:
 *  the erase ends at its own identity, and nothing of the other writer's shows. */
const pairs: Array<[string, RoadmapFile, RoadmapFile, 'theirs' | 'mine (trivial)']> = [
  ['listed (late) meets unlisted (early), one epoch', erased(1, LATE, true), erased(1, EARLY, false), 'theirs'],
  ['unlisted (early) meets listed (late), one epoch', erased(1, EARLY, false), erased(1, LATE, true), 'mine (trivial)'],
  ['unlisted (late) meets listed (early), one epoch', erased(1, LATE, false), erased(1, EARLY, true), 'mine (trivial)'],
  ['both listed, one epoch', erased(1, LATE, true), erased(1, EARLY, true), 'mine (trivial)'],
  ['neither listed, one epoch', erased(1, EARLY, false), erased(1, LATE, false), 'theirs'],
  ['a lower epoch meets a higher', erased(1, LATE, true), erased(2, EARLY, false), 'theirs'],
  ['a higher epoch meets a lower', erased(2, EARLY, false), erased(1, LATE, true), 'mine (trivial)'],
];

function run(state: EraseState, events: EraseEvent[]): EraseState {
  for (const event of events) state = transition(state, event).state;
  return state;
}
const idle = (shown: string): EraseState => run(initialEraseState(shown), [{ type: 'loaded' }]);

describe('erase machine through the real merge: the screen ends at the store\'s identity (Codex R1)', () => {
  it('the case is real: a listing erase meeting an unlisted one at its epoch ends at the EARLIER erasedAt', () => {
    const merged = mergeFiles(erased(1, LATE, true), erased(1, EARLY, false), OPTS);
    expect(merged.meta.erasedAt).toBe(EARLY);
  });

  describe.each(pairs)('%s (the merge keeps %s)', (_pair, mine, theirs, kept) => {
    const before = eraseIdentityOf(mine);
    const store = eraseIdentityOf(mergeFiles(mine, theirs, OPTS));

    it('the merge keeps the erase named', () => {
      expect(store).toBe(eraseIdentityOf(kept === 'theirs' ? theirs : mine));
    });

    it('read', () => {
      expect(run(idle(before), [{ type: 'read', identity: store }]).shown).toBe(store);
    });

    it('arrived, then its read', () => {
      const step = transition(idle(before), { type: 'arrived', identity: store });
      expect(step.effects).toEqual([{ type: 'read' }]);
      expect(run(step.state, [{ type: 'read', identity: store }]).shown).toBe(store);
    });

    it('held while loading, then loaded and its read', () => {
      const state = run(initialEraseState(before), [{ type: 'arrived', identity: store }, { type: 'loaded' }, { type: 'read', identity: store }]);
      expect(state.phase).toBe('idle');
      expect(state.shown).toBe(store);
    });

    it('this tab\'s erase (mine) ends, the other writer\'s (theirs) overtaking it', () => {
      // The page showed the record before any erase. The other erase arrived
      // during this one; when the flush's merge moved the identity again,
      // REMOTE_CHANGED said so before the erase resolved.
      const pre = eraseIdentityOf(createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' }));
      const other = eraseIdentityOf(theirs);
      const arrivals: EraseEvent[] = [{ type: 'arrived', identity: other }, ...(store === other || store === before ? [] : [{ type: 'arrived', identity: store } as const])];
      const state = run(idle(pre), [{ type: 'own-start' }, ...arrivals]);
      const end = transition(state, { type: 'own-end', identity: store, message: 'erase done (test text)' });
      expect(end.state.phase).toBe('idle');
      expect(end.state.shown).toBe(store);
      // The other writer's rows are read, and its erase counted, exactly when the store ends at it.
      const fired = end.effects.filter(e => e.type === 'read' || e.type === 'count-remote-change').map(e => e.type);
      expect(fired).toEqual(store === other ? ['read', 'count-remote-change'] : []);
    });
  });
});
