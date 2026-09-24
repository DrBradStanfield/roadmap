// What is typed into a matrix is a DRAFT until the user commits it (US-03
// AC5; the commit gestures are useSaveOnLeave's). The draft column, and the
// empty cells of saved columns typed into, keyed by their day. It is kept on
// this device exactly as typed, so a reload, or a phone putting the page
// away, loses nothing and writes nothing; a cell leaves it only once the
// store has taken its value. Shared by BloodTestTimeline and
// StartingInfoVitals.

import { useEffect, useRef, useState } from 'react';
import { localDay, type UnitSystem } from '@roadmap/health-core';
import { DRAFTS_CLEARED_EVENT, safeGetItem, safeRemoveItem, safeSetItem } from './storage';
import type { SaveTask } from './matrix-save';

type Typed<K extends string> = Partial<Record<K, string>>;
/** The rows a cell expects under its slots (`SaveTask.expected`). */
type Expected = SaveTask['expected'];

/** This load of the page. A draft restored by the next load was not typed on
 *  it, and a matrix built again on this one (a phone turned) keeps it. */
const PAGE = Math.random().toString(36).slice(2);

/** What a draft keeps about a typed cell beside its text: the unit it was
 *  typed in, where a unit switch keeps the quantity (the vitals, US-05); the
 *  rows the page showed under its slots when the user began typing there,
 *  kept until the cell is emptied, never retaken by typing again (US-03 AC2);
 *  the load of the page it was typed on; and why a commit refused its value,
 *  until it is typed into again. */
interface CellMeta { unit?: UnitSystem; expected?: Expected; typedOn?: string; refused?: string }

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
 * cell's slots on that day, by metric (null: empty). `cellOf(key)`: the cell
 * a key is typed into, when one cell takes two (a blood pressure's halves);
 * its keys share one expectation.
 */
export function useMatrixDraft<K extends string>(storageKey: string, record: {
  onScreen: (column: string, key: K) => boolean;
  rowsUnder: (day: string, key: K) => Expected;
  cellOf?: (key: K) => string;
}) {
  const [state, setState] = useState<MatrixDraft<K>>(() => loadDraft<K>(storageKey) ?? EMPTY);
  const { onScreen, rowsUnder, cellOf = (key: K) => key } = record;
  const date = dayOf(state);
  const { values } = state.draft;
  const idOf = ([column, key]: CellRef<K>) => `${column ?? 'new'}|${cellOf(key)}`;
  const metaOf = (cell: CellRef<K>): CellMeta | undefined => state.meta[idOf(cell)];

  useEffect(() => {
    if (holdsAny(state.draft.values) || holdsAny(state.backfills)) safeSetItem(storageKey, JSON.stringify(state));
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
    /** What the user typed into a cell, verbatim, and the unit it is in when
     *  a unit switch must keep the quantity. */
    type: (cell: CellRef<K>, typed: string, unit?: UnitSystem) => setState((s) => set(s, cell, typed, (was) => ({
      unit, expected: was?.expected ?? rowsUnder(cell[0] ?? dayOf(s), cell[1]), typedOn: PAGE,
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
    /** The rows a cell expects under its slots, for its commit to name
     *  (`SaveTask.expected`): what the page showed when the user began
     *  typing there. None known: empty slots. */
    expected: (cell: CellRef<K>): Expected => metaOf(cell)?.expected ?? {},
    /** Typed on this load of the page. A draft restored from the device
     *  stands in for the record only once the user types into it (US-03 AC6). */
    typedHere: (cell: CellRef<K>) => metaOf(cell)?.typedOn === PAGE,
    /** Two cells for one slot (US-03 AC3): the draft's `key`, and the same
     *  cell of the saved column on the draft's day, both typed and shown. */
    clashes: (key: K) => !!values[key] && !!state.backfills[date]?.[key] && onScreen(date, key),
    /** A draft cell whose slots hold other rows on the page than it expects
     *  (US-03 AC2): shown as the clash, and never standing in for the record.
     *  The store refuses its write whatever the page shows. */
    taken: (key: K) => {
      const expected = metaOf([null, key])?.expected;
      return !!values[key] && Object.entries(rowsUnder(date, key)).some(([metric, id]) => id !== (expected?.[metric] ?? null));
    },
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

/**
 * Keep the form's copy of the draft, which the plan and the chat read, to the
 * values that may stand in for the record there (US-03 AC6): `values` maps
 * each field to its value, or to undefined to leave it to the record. Only a
 * field that changed is sent. A matrix leaving the page takes back what it
 * sent, and one mounting sends it again: a phone turned across 768 px builds
 * the whole form again.
 */
export function useDraftMirror<F extends string>(values: Array<[F, number | undefined]>, send: (field: F, value: number | undefined) => void): void {
  const sent = useRef(new Map<F, number | undefined>());
  useEffect(() => {
    for (const [field, value] of values) {
      if (sent.current.get(field) === value) continue;
      sent.current.set(field, value);
      send(field, value);
    }
  });
  useEffect(() => () => {
    for (const [field, value] of sent.current) if (value !== undefined) send(field, undefined);
    sent.current.clear();
  }, [send]);
}
