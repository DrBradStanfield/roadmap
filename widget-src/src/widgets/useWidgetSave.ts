// The waist-to-height widget's save queue (US-74 AC4): what each save may
// replace, what it does to the boxes after, and what it counts. Saves run one
// after another. Each is bound to what the person saw when it was asked for
// (review R2): a later save of the person's own does not make it a conflict,
// and a conflict found by an earlier one drops the field from any save asked
// before it, until the person types again. A valid entry that did not save
// goes with the next save (review R8). Nothing is said on the page about any of it (Brad 2026-11-18);
// a save resolves true only once every pending entry is kept, which the next-step link waits for.
import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { UnitSystem } from '@roadmap/health-core/units';
import { trackProductEvent } from '../lib/server-api';
import { recordDays, recordMeasured, resultsFor, saveMeasured, seenAfterFailure, seenNow, seenWith, type Seen } from './body-measures';
import { INPUT_OF, readBoxes, settle, type Boxes, type Field } from './boxes';

type Days = ReturnType<typeof recordDays>;

/** One page view, however many waist blocks it holds (Codex review 1871b R7): the blocks mounted now,
 *  and whether this view has counted its waist_widget_saved. The first block to mount starts a view. */
export const pageView = { mounted: 0, savedCounted: false };

export function useWidgetSave(args: {
  now: MutableRefObject<{ boxes: Boxes; system: UnitSystem }>;
  setBoxes: Dispatch<SetStateAction<Boxes>>;
  setDays: Dispatch<SetStateAction<Days>>;
}): (fields: readonly Field[]) => Promise<boolean> {
  const { now, setBoxes, setDays } = args;
  // What the person has seen of the record: all a save may replace (review A4, R5).
  const seen = useRef<Seen | null>(null);
  seen.current ??= seenNow();
  // Saves run one after another (handle of the queue, as useLongitudinalSave's savesRef).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Order of asking: each save's number, and per field the number after which
  // this page's own write, or a conflict, came (review R2).
  const asked = useRef(0);
  const ownAfter = useRef<Partial<Record<Field, number>>>({});
  const conflictAfter = useRef<Partial<Record<Field, number>>>({});
  // Valid entries a save could not keep: they go with the next save (review R8).
  const unsaved = useRef(new Set<Field>());
  // waist_widget_saved goes once per page view, once a waist is kept and a ratio exists (Brad 2026-11-18, review R9).
  const waistKept = useRef(false);

  return (fields) => {
    const { boxes: snapshot, system: unit } = now.current;
    const { values, entered } = readBoxes(snapshot, unit);
    const chosen = new Set([...fields, ...unsaved.current].filter((f) => entered.has(f) && values[INPUT_OF[f]] !== undefined));
    if (chosen.size === 0) return queue.current.then(() => unsaved.current.size === 0);
    const number = ++asked.current;
    const baseline = seen.current!;
    const run = async (): Promise<boolean> => {
      // A field a conflict refilled after this was asked is not this save's to write.
      for (const f of [...chosen]) if ((conflictAfter.current[f] ?? 0) > number) chosen.delete(f);
      if (chosen.size === 0) return unsaved.current.size === 0;
      // A field this page wrote after this was asked: its own row is what it expects.
      const own = new Set([...chosen].filter((f) => (ownAfter.current[f] ?? 0) > number));
      const base: Seen = { ...seenWith(baseline, own), pending: seen.current!.pending };
      // A save that throws ends as one the store could not keep.
      const outcome = await saveMeasured(values, chosen, base, unit).catch(() => ({ kind: 'failed' as const, staged: { saved: [], inserted: [] } }));
      if (outcome.kind === 'failed') {
        // The drafts stay for the next save; only the person's own entries count as seen (A3, A4).
        seen.current = seenAfterFailure(seen.current!, values, chosen, outcome.staged);
        for (const f of chosen) unsaved.current.add(f);
        return false;
      }
      const after = asked.current + 0.5;
      const refused = new Set(outcome.refused);
      const settled = new Set([...chosen].filter((f) => !refused.has(f)));
      for (const f of settled) unsaved.current.delete(f);
      for (const f of outcome.saved) ownAfter.current[f] = after;
      for (const f of outcome.changed) conflictAfter.current[f] = after;
      // Each settled box now holds the record's value, with its day, unless it
      // was typed in since this save began: that box is newer than the save (C6, R5).
      const record = recordMeasured(), days = recordDays();
      setBoxes((prev) => {
        const out = { ...prev };
        for (const f of settled) if (prev[f] === snapshot[f]) out[f] = settle(f, prev[f], record[INPUT_OF[f]], now.current.system);
        return out;
      });
      setDays((prev) => {
        const out = { ...prev };
        for (const f of ['weight', 'waist'] as const) if (settled.has(f)) out[f] = days[f];
        return out;
      });
      seen.current = { ...seenWith(seen.current!, settled), pending: undefined };
      if (outcome.saved.includes('waist')) waistKept.current = true;
      if (waistKept.current && !pageView.savedCounted && resultsFor(record, unit)?.whtr) {
        pageView.savedCounted = true;
        trackProductEvent('waist_widget_saved');
      }
      return unsaved.current.size === 0;
    };
    const next = queue.current.then(run);
    queue.current = next.catch(() => undefined);
    return next.catch(() => false);
  };
}

