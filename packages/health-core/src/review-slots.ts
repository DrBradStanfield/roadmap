/**
 * Which upload reading takes a (test, day) slot, and when two readings are the
 * same result: the review's one precedence rule (US-12 AC12, AC14; US-13 AC3),
 * shared by the import review's groups (`import-review.ts`) and the website's
 * matrix (`review-matrix.ts` `place`), so the two cannot disagree. Pure.
 */
import { sameLabQuantity, sameValue, type LabQuantity } from './record-edits';
import type { Comparator } from './lab-limits';

/** One reading as a slot compares it: a core or vital value by its stored (SI)
 *  number, a lab by its quantity as printed or held. Both keep any comparator. */
export type Quantity = { valueSI: number; comparator?: Comparator } | { lab: LabQuantity };

/** The same result: a core value by stored number and comparator (its rounded
 *  display can hide a real difference, US-13 AC3), a lab by `sameLabQuantity`
 *  (each side converted by its own name, US-35 AC6). A limit and an exact
 *  value of one number are two results (US-12 AC20). */
export function sameReading(a: Quantity, b: Quantity): boolean {
  if ('valueSI' in a && 'valueSI' in b) return sameValue(a.valueSI, b.valueSI) && a.comparator === b.comparator;
  return 'lab' in a && 'lab' in b && sameLabQuantity(a.lab, b.lab);
}

/** A reading's rank in its slot: a report's own reading (no day of its own)
 *  first, then a dated previous column's, then an undated one's (US-12 AC12, AC14). */
export function readingRank(recordedAt: string | undefined, undated: string): 0 | 1 | 2 {
  return !recordedAt ? 0 : recordedAt === undated ? 2 : 1;
}

export interface SlotReading {
  /** The (test, day) slot, as the write keys it (`slotOfRow`). */
  slot: string;
  rank: 0 | 1 | 2;
  quantity: Quantity;
  /** Edited by the person: never "already saved", and never the same as another reading. */
  edited?: boolean;
  /** Save sends it (ticked, not cleared). An unsent reading never takes a slot. */
  sent: boolean;
}

/**
 * - saved: equal to the record's row in that slot.
 * - free: takes an empty slot.
 * - conflict: takes a slot the record holds a different value in.
 * - duplicate: the slot is taken by an equal reading of this upload.
 * - hidden: the slot is taken by a different reading of this upload.
 */
export type SlotPlace = 'saved' | 'free' | 'conflict' | 'duplicate' | 'hidden';

/**
 * Where each reading lands, in the input's order. Sent readings claim slots by
 * rank, then input order; a winner that only matched the record does not block
 * a differing reading of its own rank, which becomes the conflict (US-13 AC3).
 * An unsent reading is judged against the record alone and claims nothing:
 * unticking a winner frees its slot, and an unticked reading stays shown as
 * what ticking it would do to the record. `held` is the record's reading in a
 * slot, if any.
 */
export function placeReadings(readings: readonly SlotReading[], held: (slot: string) => Quantity | undefined): SlotPlacement[] {
  const claims = new Map<string, { rank: number; index: number; heldEqual: boolean }>();
  const places: SlotPlacement[] = new Array(readings.length);
  const order = readings.map((_, i) => i).sort((i, j) => readings[i].rank - readings[j].rank || i - j);
  for (const i of order) {
    const r = readings[i];
    const prev = held(r.slot);
    const equalHeld = !r.edited && !!prev && sameReading(r.quantity, prev);
    const winner = claims.get(r.slot);
    const blocked = r.sent && !!winner && !(winner.rank === r.rank && winner.heldEqual);
    if (!blocked && r.sent) claims.set(r.slot, { rank: r.rank, index: i, heldEqual: equalHeld });
    const w = winner && readings[winner.index];
    places[i] = equalHeld ? { place: 'saved' }
      : blocked && w ? { place: !r.edited && !w.edited && sameReading(r.quantity, w.quantity) ? 'duplicate' : 'hidden', winner: winner!.index }
        : { place: prev ? 'conflict' : 'free' };
  }
  return places;
}

/** Where one reading lands; `winner`: the input index of the reading that took
 *  the slot from a duplicate or hidden one. */
export interface SlotPlacement { place: SlotPlace; winner?: number }
