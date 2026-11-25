// What is typed into a matrix is a DRAFT until the user commits it (US-03
// AC5; the commit gestures are useSaveOnLeave's). The draft column, and the
// empty cells of saved columns typed into, keyed by their day. It is kept on
// this device exactly as typed, so a reload, or a phone putting the page
// away, loses nothing and writes nothing; a cell leaves it only once the
// store has taken its value. Shared by BloodTestTimeline and
// StartingInfoVitals.

import { useEffect, useState } from 'react';
import { isLpaUnit } from '@roadmap/health-core/cell-unit';
import { localDay } from '@roadmap/health-core/merge';
import type { LpaUnit, UnitSystem } from '@roadmap/health-core/units';
import type { CellUnit } from './blood-test-cell';
import { DRAFTS_CLEARED_EVENT, ownLogOffHasBegun, pageOnChosenRecord, safeGetItem, safeRemoveItem, safeSetItem } from './storage';
import type { SaveTask } from './matrix-save';

type Typed<K extends string> = Partial<Record<K, string>>;
/** The rows a cell expects under its slots (`SaveTask.expected`). */
type Expected = SaveTask['expected'];

/** This load of the page. A unit chosen on it re-reads only the cells typed
 *  by hand on it (`restamp`), never a draft restored by the next load; a
 *  matrix built again on this one (a phone turned) keeps the mark. */
const PAGE = Math.random().toString(36).slice(2);

/** What a draft keeps about a typed cell beside its text: the unit it was
 *  typed in, so a unit system the record brings never re-reads it (US-04
 *  AC1; an Lp(a) cell keeps its unit's label, US-05 AC2); the
 *  rows the page showed under its slots when the user began typing there,
 *  kept until the cell is emptied, never retaken by typing again (US-03 AC2);
 *  the load the user last typed into it by hand, never the chat's
 *  (`restamp`); and why a commit refused its value, until it is typed into
 *  again. */
interface CellMeta { unit?: CellUnit; expected?: Expected; byHand?: string; refused?: string }

export interface MatrixDraft<K extends string> {
  /** `date` is kept only when the user picked it: an unpicked draft column is
   *  today's, on every load (US-03 AC1). */
  draft: { date?: string; values: Typed<K> };
  backfills: Record<string, Typed<K>>;
  meta: Record<string, CellMeta>;
}

/** A cell: in the draft column (`column` null), or a saved column's empty
 *  cell, `column` being that column's day. */
export type CellRef<K extends string> = [column: string | null, key: K];

const EMPTY = { draft: { values: {} }, backfills: {}, meta: {} };
const holdsAny = (cells: object) => Object.values(cells).some(Boolean);
const holdsText = (state: MatrixDraft<string>) => holdsAny(state.draft.values) || holdsAny(state.backfills);
const isDay = (day: unknown): day is string => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
const isObject = (v: unknown): v is object => !!v && typeof v === 'object';
const dayOf = (state: MatrixDraft<string>) => state.draft.date ?? localDay(new Date());

/** The draft this device kept, or null. The storage is untrusted: anything
 *  not shaped like a draft is ignored. */
function loadDraft<K extends string>(storageKey: string): MatrixDraft<K> | null {
  try {
    const kept = JSON.parse(safeGetItem(storageKey) ?? 'null');
    if (!isObject(kept)) return null;
    const { draft, backfills, meta } = kept as Partial<MatrixDraft<K>>;
    return {
      draft: { date: isDay(draft?.date) ? draft.date : undefined, values: isObject(draft?.values) ? draft.values : {} },
      backfills: isObject(backfills) ? backfills : {},
      meta: isObject(meta) ? meta : {},
    };
  } catch {
    return null;
  }
}

/** `state` with one key of a cell set to `typed`, the cell's meta (`id`)
 *  made by `meta` from what it was. A cell with nothing typed in it leaves
 *  the draft, meta and all. */
function withCell<K extends string>(
  state: MatrixDraft<K>, [column, key]: CellRef<K>, typed: string, id: string, sameCell: (k: K) => boolean,
  meta: (was: CellMeta | undefined) => CellMeta,
): MatrixDraft<K> {
  const cells: Typed<K> = { ...(column === null ? state.draft.values : state.backfills[column]) };
  if (typed) cells[key] = typed;
  else delete cells[key];
  const metas = { ...state.meta };
  if ((Object.keys(cells) as K[]).some(sameCell)) metas[id] = meta(metas[id]);
  else delete metas[id];
  if (column === null) return { ...state, draft: { ...state.draft, values: cells }, meta: metas };
  const backfills = { ...state.backfills };
  if (holdsAny(cells)) backfills[column] = cells;
  else delete backfills[column];
  return { ...state, backfills, meta: metas };
}

/**
 * `record` is what the matrix shows of the record. `onScreen(column, key)`:
 * whether a saved column's cell is shown for typing, that is, the column is
 * there and its slot still empty; one filled elsewhere since (the draft
 * outlives the page) is not, and what was typed into it is left in the draft,
 * never committed. `rowsUnder(day, key)`: the rows the page shows under the
 * cell's slots on that day, by metric (null: empty). `cellOf(key)`: the
 * cell a key is typed into, when one cell takes two (a blood pressure's
 * halves); its keys share one expectation. `legacyUnit(key)`: the unit a restored cell kept
 * before cells carried their unit is stamped with as it is restored: this
 * device's units as the page started, before the record's applied
 * (useUnits' `startUnitOf`). A best guess: the units its last visit showed,
 * unless another tab changed this device's since the cell was typed, or a
 * load since applied the record's units without mounting the matrix.
 */
export function useMatrixDraft<K extends string>(storageKey: string, record: {
  onScreen: (column: string, key: K) => boolean;
  rowsUnder: (day: string, key: K) => Expected;
  cellOf?: (key: K) => string;
  legacyUnit?: (key: K) => CellUnit | undefined;
}) {
  const { onScreen, rowsUnder, cellOf = (key: K) => key, legacyUnit } = record;
  const idOf = ([column, key]: CellRef<K>) => `${column ?? 'new'}|${cellOf(key)}`;
  const [state, setState] = useState<MatrixDraft<K>>(() => {
    // Only a page on the chosen record restores its draft (US-11 AC6): any other may be showing another record.
    const kept = pageOnChosenRecord() ? loadDraft<K>(storageKey) : null;
    if (!kept) return EMPTY;
    const meta = { ...kept.meta };
    for (const [column, cells] of [[null, kept.draft.values] as const, ...Object.entries(kept.backfills)]) {
      for (const [key, typed] of Object.entries(isObject(cells) ? cells : {}) as Array<[K, unknown]>) {
        const id = idOf([column, key]);
        const unit = legacyUnit?.(key);
        if (typed && unit && !meta[id]?.unit) meta[id] = { ...meta[id], unit };
      }
    }
    return { ...kept, meta };
  });
  const date = dayOf(state);
  const { values } = state.draft;
  const metaOf = (cell: CellRef<K>): CellMeta | undefined => state.meta[idOf(cell)];
  /** A draft cell whose slots hold other rows on the page than it expects
   *  (US-03 AC2): shown as the clash. The store refuses its write whatever
   *  the page shows. */
  const taken = (key: K) => {
    const expected = metaOf([null, key])?.expected;
    return !!values[key] && Object.entries(rowsUnder(date, key)).some(([metric, id]) => id !== (expected?.[metric] ?? null));
  };

  useEffect(() => {
    // After a log-off this page began, the device was wiped, so a stale draft
    // goes (US-09 AC2e). Any other page off the record this browser has chosen
    // (a log-off elsewhere since it loaded, a sign-in or switch in another tab,
    // or a page still loading) keeps typed values on screen only and leaves the
    // key alone: it may hold the chosen record's draft (US-11 AC6, AC2c).
    if (ownLogOffHasBegun()) { safeRemoveItem(storageKey); return; }
    if (!pageOnChosenRecord()) return;
    if (holdsText(state)) safeSetItem(storageKey, JSON.stringify(state));
    else safeRemoveItem(storageKey);
  }, [storageKey, state]);

  // An erase, made here or taken in from another device, clears the drafts
  // on the device (US-11 AC6). A matrix on screen drops its own copy too, or
  // its next keystroke would write the draft back and its next leave commit
  // it into the new record.
  useEffect(() => {
    const drop = () => setState(EMPTY);
    window.addEventListener(DRAFTS_CLEARED_EVENT, drop);
    return () => window.removeEventListener(DRAFTS_CLEARED_EVENT, drop);
  }, []);

  /** `state` with `typed` in a cell; `meta` makes its meta from what it was. */
  const set = (s: MatrixDraft<K>, cell: CellRef<K>, typed: string, meta: (was: CellMeta | undefined) => CellMeta) =>
    withCell(s, cell, typed, idOf(cell), (k) => cellOf(k) === cellOf(cell[1]), meta);

  return {
    draft: { date, values },
    backfills: state.backfills,
    /** Any typed text kept, valid or not, restored or displaced: what the
     *  phone's "Unsaved values" cue reports (US-62 AC11). */
    holdsText: holdsText(state),
    /** What the user typed into a cell, verbatim, and the unit it is in when
     *  a unit switch must keep the quantity. `byHand` false: the chat filled
     *  it, and the user has not typed into it since. */
    type: (cell: CellRef<K>, typed: string, unit?: CellUnit, byHand = true) => setState((s) => set(s, cell, typed, (was) => ({
      unit, expected: was?.expected ?? rowsUnder(cell[0] ?? dayOf(s), cell[1]), byHand: byHand ? PAGE : undefined,
    }))),
    /** The day the user picked. Anything else is never taken: iOS's Reset
     *  hands back '', and the column keeps its day. Another day is another
     *  slot: the cells typed in the column expect what the page shows there. */
    setDate: (day: string) => {
      if (!isDay(day)) return;
      setState((s) => {
        const meta = { ...s.meta };
        if (day !== dayOf(s)) {
          for (const key of Object.keys(s.draft.values) as K[]) meta[idOf([null, key])] = { ...meta[idOf([null, key])], expected: rowsUnder(day, key) };
        }
        return { ...s, draft: { ...s.draft, date: day }, meta };
      });
    },
    unitOf: (cell: CellRef<K>): UnitSystem | undefined => {
      const unit = metaOf(cell)?.unit;
      return unit === 'si' || unit === 'conventional' ? unit : undefined;
    },
    /** The Lp(a) unit a cell was typed in (US-05 AC2). None: typed before
     *  this was kept, so its unit is unknown. */
    lpaUnitOf: (cell: CellRef<K>): LpaUnit | undefined => {
      const unit = metaOf(cell)?.unit;
      return isLpaUnit(unit) ? unit : undefined;
    },
    /** A unit chosen on this page says what the numbers typed are in (US-05
     *  AC2): every cell of `key` the user typed by hand on this load of the
     *  page, in `from`, the unit shown until now, is read in `to` from here
     *  on, its text kept. Every other cell keeps its stamp and its quantity,
     *  its number shown again in the new unit (adversary R2, clinical
     *  ruling): one the chat filled, one restored from the device, one typed
     *  in another unit, and one with no unit kept, which stays without. A
     *  save takes a cell out of the draft, its mark with it. */
    restamp: (key: K, from: CellUnit, to: CellUnit) => setState((s) => {
      const meta = { ...s.meta };
      for (const column of [null, ...Object.keys(s.backfills)]) {
        const id = idOf([column, key]);
        if (meta[id]?.unit === from && meta[id]?.byHand === PAGE) meta[id] = { ...meta[id], unit: to };
      }
      return { ...s, meta };
    }),
    /** The rows a cell expects under its slots, for its commit to name
     *  (`SaveTask.expected`): what the page showed when the user began
     *  typing there. None known: empty slots. */
    expected: (cell: CellRef<K>): Expected => metaOf(cell)?.expected ?? {},
    /** Two cells for one slot (US-03 AC3): the draft's `key`, and the same
     *  cell of the saved column on the draft's day, both typed and shown. */
    clashes: (key: K) => !!values[key] && !!state.backfills[date]?.[key] && onScreen(date, key),
    taken,
    /** A commit's answer (US-03 AC4), each cell sent with why it was
     *  refused, or undefined: the saved cells leave the draft, and each
     *  refused one stays, with why, until it is typed into again. An emptied
     *  draft column goes back to today. */
    settle: (answers: Array<[CellRef<K>, string | undefined]>) => setState((s) => {
      const next = answers.reduce((acc, [cell, refused]) => (refused
        ? { ...acc, meta: { ...acc.meta, [idOf(cell)]: { ...acc.meta[idOf(cell)], refused } } }
        : set(acc, cell, '', (was) => was ?? {})), s);
      return holdsAny(next.draft.values) ? next : { ...next, draft: { values: next.draft.values } };
    }),
    /** Why the cell's value was refused, until it is typed into again. */
    refusal: (cell: CellRef<K>) => metaOf(cell)?.refused ?? null,
  };
}

