// US-04 AC5: move a saved blood test to the day it was really drawn. A saved
// column's date header picks the day; picking writes nothing (iOS fires the
// date input's change while its wheel spins). It opens this panel, which
// names every value that moves and asks about each clash. The page owns one
// move for both matrices (InputPanel); only the Move button writes.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  METRIC_LABELS, METRIC_TO_FIELD, isCoreRow, labValueLabel, savedLabText,
  type FileLabValue, type FileMeasurement, type MetricType, type MoveKeep, type MovePlan, type MoveRejection, type UnitSystem,
} from '@roadmap/health-core';
import { cellLabel, savedCellText, type CellUnit } from '../lib/blood-test-cell';
import { lpaRowsToCheck, useLpaKept, useLpaUnit } from '../lib/lpa-unit';
import type { MoveOutcome } from '../storage/roadmap-store';
import { SAVE_ERRORS, headerDay, useLiveRegion } from './BloodTestTimeline';

type Row = FileMeasurement | FileLabValue;

/** The record's side of a move: HealthTool's, which re-reads the record after one. */
export interface MoveTestApi {
  preview: (from: string, to: string) => MovePlan | MoveRejection | null;
  move: (from: string, to: string, expectedIds: string[], keep: MoveKeep) => Promise<MoveOutcome>;
}

/** What a matrix's saved headers take from the page's one move. A matrix
 *  calls `onHeld(day, true)` when a day starts holding typed text or an open
 *  editor and `onHeld(day, false)` when it stops, once per hold. */
export interface MoveHeaders {
  onPick: (from: string, to: string) => void;
  picked: { from: string; to: string } | null;
  held: ReadonlySet<string>;
  onHeld: (day: string, held: boolean) => void;
}

export const MOVE_TITLE = "Change this test's date";
export const MOVE_TYPED = 'Save or clear the values you typed in this column first.';
export const MOVE_CHANGED = 'This test changed on another device, so nothing moved.';
export const MOVE_LPA = "First answer the question about this test's Lp(a) result, just above.";

/** "21 Feb '24", as the column headers read. */
const shortDay = (day: string) => headerDay(day).join(' ');

/** Typed text or an open editor on the day the test moves to (US-04 AC5b). */
export const moveTypedOn = (day: string) => `Save or clear the values you typed on ${shortDay(day)} first.`;

/** Why the press writes nothing, or null: a column the move reads holds typed
 *  text or an open editor, the test's own day (AC5) or the new day (AC5b), where
 *  the moved row would fill the slot a typed value waits in. */
function typedHold(from: string, to: string, isHeld: (day: string) => boolean): string | null {
  if (isHeld(from)) return MOVE_TYPED;
  return isHeld(to) ? moveTypedOn(to) : null;
}

/** The core test a row is, or null for an extra lab row: a core blood test is a flagged lab row (US-66 AC1). */
const coreOf = (row: Row): MetricType | null => ('metricName' in row && isCoreRow(row) ? row.metricName as MetricType : null);

const nameOf = (row: Row) => {
  const metric = coreOf(row);
  return metric ? METRIC_LABELS[metric] ?? metric : labValueLabel((row as FileLabValue).metricName);
};

function refusalText(refusal: MoveRejection): string {
  switch (refusal.reason) {
    case 'same-day': return 'The test is already on that day.';
    case 'future-date': return 'That day has not happened yet.';
    case 'invalid-date': return 'That is not a date.';
    case 'empty-day': return 'No blood test is saved on that day.';
    case 'duplicate-slot': {
      const row = refusal.existing!;
      return `This test has two values for ${nameOf(row)} on ${shortDay(row.recordedAt.slice(0, 10))}. Correct one first.`;
    }
    default: return refusal.message;
  }
}

/**
 * The page's one move: the headers both matrices take, and the panel with the
 * line that says how the move went. Holds are counted here, and `held` changes
 * only when a day starts or stops holding, so a memoised lab group does not
 * re-render as each editor opens and closes. Without `api` the headers stay plain.
 */
export function useMoveTest({ api, unitSystem, unitOverrides, bloodTestHistory, labValues }: {
  api?: MoveTestApi; unitSystem: UnitSystem; unitOverrides?: Record<string, UnitSystem>;
  /** The record the page holds: the panel's plan is read again when it changes. */
  bloodTestHistory: unknown; labValues: unknown;
}): { headers?: MoveHeaders; panel: ReactNode } {
  const [picked, setPicked] = useState<{ from: string; to: string } | null>(null);
  const counts = useRef(new Map<string, number>());
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [say, status] = useLiveRegion('bt-move-status');
  // The status line shows from the first pick on, so the page carries no empty line before then.
  const [asked, setAsked] = useState(false);

  const onPick = useCallback((from: string, to: string) => { setAsked(true); setPicked({ from, to }); }, []);
  const onHeld = useCallback((day: string, holds: boolean) => {
    counts.current.set(day, (counts.current.get(day) ?? 0) + (holds ? 1 : -1));
    setHeld(prev => {
      const now = (counts.current.get(day) ?? 0) > 0;
      if (now === prev.has(day)) return prev;
      const next = new Set(prev);
      if (now) next.add(day); else next.delete(day);
      return next;
    });
  }, []);
  const headers = useMemo(() => (api ? { onPick, picked, held, onHeld } : undefined), [api, onPick, picked, held, onHeld]);
  const panel = <>
    {picked && api && (
      <MoveTestPanel key={`${picked.from}>${picked.to}`} from={picked.from} to={picked.to} api={api}
        unitSystem={unitSystem} unitOverrides={unitOverrides} bloodTestHistory={bloodTestHistory} labValues={labValues}
        isHeld={day => (counts.current.get(day) ?? 0) > 0} onClose={() => setPicked(null)} say={say}/>
    )}
    {asked && status}
  </>;
  return { headers, panel };
}

function MoveTestPanel({ from, to, api, unitSystem, unitOverrides, bloodTestHistory, labValues, isHeld, onClose, say }: {
  from: string; to: string; api: MoveTestApi; unitSystem: UnitSystem; unitOverrides?: Record<string, UnitSystem>;
  bloodTestHistory: unknown; labValues: unknown;
  isHeld: (day: string) => boolean; onClose: () => void; say: (message: string) => void;
}) {
  const [answers, setAnswers] = useState<MoveKeep>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lpaUnit] = useLpaUnit(unitSystem);
  useLpaKept(); // the check's "keep as saved" answer frees Move
  const plan = useMemo(() => api.preview(from, to), [api, from, to, bloodTestHistory, labValues]);
  // On a phone the panel opens below the whole table, out of sight of the header just tapped.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { panelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }, [from, to]);
  if (!plan) return null;
  const refused = !('rows' in plan);

  const unitOf = (metric: MetricType): CellUnit => (metric === 'lpa' ? lpaUnit : unitOverrides?.[METRIC_TO_FIELD[metric]] ?? unitSystem);
  const valueOf = (row: Row) => {
    const metric = coreOf(row);
    if (!metric) return `${savedLabText(row.value, row.comparator)} ${(row as FileLabValue).unit}`;
    const unit = unitOf(metric);
    return `${savedCellText(metric, row.value, unit, row.comparator)} ${cellLabel(metric, unit)}`;
  };

  const body = (p: MovePlan) => {
    const matched = new Set(p.matches.map(c => c.moving.id));
    const count = p.rows.length === 1 ? '1 value moves.' : `${p.rows.length} values move.`;
    return <>
      <p>{`Move the blood test from ${shortDay(from)} to ${shortDay(p.to)}? ${count}`}</p>
      <ul className="bt-move-rows">
        {p.rows.map(row => (
          <li key={row.id}>{`${nameOf(row)} ${valueOf(row)}`}{matched.has(row.id) && ' (already there, same value)'}</li>
        ))}
      </ul>
      {p.documentDated && <p className="lpa-check-note">The uploaded report keeps its own date.</p>}
      {p.clashes.map(({ moving, held }) => (
        <fieldset key={held.id} className="bt-move-clash">
          <legend>{`${nameOf(moving)} on ${shortDay(p.to)}:`}</legend>
          <label><input type="radio" name={`move-${held.id}`} checked={answers[held.id] === 'held'}
            onChange={() => setAnswers(a => ({ ...a, [held.id]: 'held' }))}/>{` keep ${valueOf(held)} (already there)`}</label>
          <label><input type="radio" name={`move-${held.id}`} checked={answers[held.id] === 'moving'}
            onChange={() => setAnswers(a => ({ ...a, [held.id]: 'moving' }))}/>{` use ${valueOf(moving)} (moving)`}</label>
        </fieldset>
      ))}
    </>;
  };

  // The Lp(a) check reads a row's createdAt, which the moved row would lose (adversary R1).
  // A moved Lp(a) row is a core lab row; the check reads it as the measurement it was (US-66 AC9).
  const lpaWaits = !refused && lpaRowsToCheck(plan.rows.filter(r => coreOf(r) === 'lpa').map(r => ({ ...r, metricType: 'lpa' })), unitSystem).length > 0;
  const answered = !refused && plan.clashes.every(c => answers[c.held.id]);

  const press = async () => {
    if (refused) return;
    // Typed since the picker opened, or on the new day: nothing is written (Codex R2).
    const typed = typedHold(from, plan.to, isHeld);
    if (typed) { onClose(); say(typed); return; }
    setSaving(true);
    setError(null);
    const keep = Object.fromEntries(plan.clashes.map(c => [c.held.id, answers[c.held.id]]));
    const outcome = await api.move(from, plan.to, plan.rows.map(r => r.id), keep);
    setSaving(false);
    if (outcome.status === 'ok') { say(`Moved to ${shortDay(plan.to)}.`); onClose(); }
    else if (outcome.status === 'changed') { say(MOVE_CHANGED); onClose(); }
    else setError(outcome.status === 'invalid' ? refusalText(outcome.refusal) : SAVE_ERRORS.error);
  };

  return (
    <div ref={panelRef} className="screening-notice bt-move-panel">
      {refused ? <p>{refusalText(plan)}</p> : body(plan)}
      {lpaWaits && <p className="lpa-check-note">{MOVE_LPA}</p>}
      {error && <p className="alr-add-notice">{error}</p>}
      <div className="alr-add-actions">
        {!refused && <button type="button" className="alr-add-save" disabled={saving || !answered || lpaWaits} onClick={() => void press()}>Move</button>}
        <button type="button" className="alr-add-cancel" disabled={saving} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
