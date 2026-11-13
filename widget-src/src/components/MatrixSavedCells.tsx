// The saved cells every matrix shares: the saved-date header, the saved-value
// editor, the live region its messages go to, and the refusal words. Moved from
// BloodTestTimeline.tsx, which re-exports them.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { type Comparator, LIMIT_NOT_GRADED } from '@roadmap/health-core/lab-limits';
import type { MetricType } from '@roadmap/health-core/units';
import { formatLabValue, savedLabText } from '@roadmap/health-core/lab-series';
import { type GradeStatus, limitUngraded } from '@roadmap/health-core/row-grade';
import { MONTHS_SHORT } from '../lib/constants';
import type { CorrectFn } from '../lib/matrix-save';
import { flushRoadmapStoreSync } from '../lib/roadmap-data';
import { CLOSED, WAIT_MS, type ValueCellEvent, type ValueCellState, type Verdict, isOpen, messageOf, transition } from '../lib/value-cell-state';
import {
  type CellUnit,
  type Grading,
  blockBadNumericKeys,
  cellText,
  cellToSI,
  readTypedValue,
  readNumericCell,
  sameAsSaved,
  savedCellText,
  validateTypedValue,
} from '../lib/blood-test-cell';
import { NumericInputCell } from './NumericInputCell';
import { DraftDateCell } from './DraftDateCell';
import { MOVE_TITLE, type MoveHeaders } from './MoveTestPanel';

const MONTH_LABELS = MONTHS_SHORT.map(m => m.label);

// Exported so StartingInfoVitals can reuse the exact same saved-date header
// cell — keeps the two matrices pixel-identical without copy-paste drift.
// With `move`, a blood test's header picks the day to move it to (US-04
// AC5); the vitals keep the plain header, since vitals never move.
export function BatchDateCell({ date, pinned, move }: { date: string; pinned: boolean; move?: MoveHeaders }) {
  if (move) {
    return <DraftDateCell date={date} picked={move.picked?.from === date ? move.picked.to : undefined} disabled={move.held.has(date)}
      onChange={day => { if (day) move.onPick(date, day); }}
      className={`bt-cell-value bt-cell-date bt-cell-movable${pinned ? ' bt-cell-pinned' : ''}`}
      title={MOVE_TITLE} ariaLabel={MOVE_TITLE}/>;
  }
  const [day, year] = headerDay(date);
  return (
    <div className={`bt-cell-value bt-cell-date${pinned ? ' bt-cell-pinned' : ''}`}>
      <div className="bt-date-day">{day}</div>
      <div className="bt-date-year">{year}</div>
    </div>
  );
}

/** A saved column's header date: ["12 Mar", "'24"]. */
export function headerDay(date: string): [string, string] {
  const d = new Date(date + 'T00:00');
  return [`${d.getDate()} ${MONTH_LABELS[d.getMonth()]}`, `'${String(d.getFullYear()).slice(-2)}`];
}

interface ValueCellProps {
  /** A core metric: shown in `display` units and range-checked. Absent for a
   *  lab value, which is edited in the unit it is stored in. */
  metric?: MetricType;
  display?: CellUnit;
  /** Whom the editor's status preview grades for. Omit it, or pass null (a
   *  known minor, US-07 AC6), for no preview. */
  grading?: Grading;
  /** As stored: SI for a core metric, the stored unit for a lab value. */
  value: number;
  /** The value was printed as a limit, `value` its bound: shown with its
   *  symbol; the editor opens on the bound and saves an exact value (US-12 AC20). */
  comparator?: Comparator;
  /** A lab value's unit, shown in the cell (a series whose reports used more
   *  than one unit). */
  unit?: string;
  rowId?: string;
  status: GradeStatus;
  /** The value is a limit the rule leaves ungraded, from a caller that knows the plan (weight, waist,
   *  US-12 AC21); omitted, a blood test's (`limitUngraded` with the grading alone). */
  ungraded?: boolean;
  pinned: boolean;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onCorrect?: CorrectFn;
  /** Says a message in the matrix's live region (`useLiveRegion`). */
  say?: (message: string) => void;
}

/** A polite live region (`role="status"`, a p) that says every message, a
 *  repeat too: it is cleared, then set a task later, so the page changes
 *  each time (Codex R2, adversary R3). A non-breaking space holds it while it
 *  says nothing: the storefront theme hides `div:empty`, and may hide
 *  `p:empty`. Each matrix renders one for its cells' messages
 *  (`bt-cell-messages`, hidden on screen: each message shows in its cell;
 *  US-04 AC1, US-05 AC2), on the page from the first render so a screen
 *  reader hears the first. Hands back how to say one, and the region. */
export function useLiveRegion(className: string): [(message: string) => void, ReactElement] {
  const [said, setSaid] = useState('');
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const say = useCallback((message: string) => {
    window.clearTimeout(timer.current);
    setSaid('');
    timer.current = window.setTimeout(() => setSaid(message), 0);
  }, []);
  // Focusable from script only: the Lp(a) check moves the focus here when its notice goes.
  return [say, <p className={className} role="status" tabIndex={-1}>{said || '\u00a0'}</p>];
}

/** What a matrix says when a save did not all land (US-03 AC4). */
export const SAVE_FAILED = 'Some values did not save. Try again.';

export { SAVE_ERRORS, saveErrorText } from '../lib/value-cell-state';

// The saved-value editor, one for every matrix: the blood tests, the vitals
// (StartingInfoVitals) and the additional lab rows. Click a value to correct
// it in place: a FHIR correction, never an edit of the saved row. Its modes
// are one named state (lib/value-cell-state.ts): this cell sends the events,
// measuring each one's facts as it sends it, and runs the effects.
export function ValueCell({
  metric, display, grading, value, comparator, unit, rowId, status, ungraded: callerUngraded, pinned, onActivate, onDeactivate, onCorrect, say,
}: ValueCellProps) {
  const [state, setState] = useState<ValueCellState>(CLOSED);
  // The machine's own copy, read by listeners and timers between renders.
  const machine = useRef(state);
  // The unit shown now: a save that runs late compares it with the unit the
  // editor opened in (US-05 AC2, US-04 AC1).
  const shownIn = useRef(display);
  shownIn.current = display;
  const inputRef = useRef<HTMLInputElement>(null);
  // Pointers down while the editor is open (as useSaveOnLeave tracks them):
  // a click-away save due during a press waits for the release. A press on a
  // unit control that governs this editor never gets that far: the press
  // closes it (`leaveForUnit`).
  const pointersDown = useRef(new Set<number>());
  // This render's handlers, for the listeners and timers set up before it.
  const latest = useRef<{ leaveForUnit: () => void; verdict: (how: 'enter' | 'leave') => Verdict; onCorrect?: CorrectFn }>();

  // The click-away save's one timer, armed for each blurPending state as the
  // machine enters it and cleared as it leaves it: 150 ms, so a click on the
  // cell's neighbours runs first; a second at most for a held press's
  // release (a release can be lost); a task after the release, so its click,
  // and any switch it made, runs first.
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const send = useCallback((event: ValueCellEvent) => {
    const { state: next, effects } = transition(machine.current, event);
    if (next !== machine.current) {
      machine.current = next;
      setState(next);
      window.clearTimeout(timer.current);
      if (next.kind === 'blurPending') timer.current = window.setTimeout(() => sendLeave(next.wait), WAIT_MS[next.wait]);
    }
    for (const { row, value: corrected } of effects) {
      void latest.current?.onCorrect?.(row, corrected).then(result => send({ type: 'result', status: result }));
    }
  }, []);
  /** A click-away wait ran out, or the page is going away: sent with what the text would save now. */
  const sendLeave = (due: 'delay' | 'press' | 'release' | 'hidden') => {
    const verdict = latest.current!.verdict('leave');
    send(due === 'delay' ? { type: 'delayDue', pressed: pointersDown.current.size > 0, verdict }
      : due === 'press' ? { type: 'pressCapDue', verdict }
      : due === 'release' ? { type: 'releaseDue', verdict }
      : { type: 'pageHidden', verdict });
  };

  const open = isOpen(state);
  // The editor opens and closes, unmounted or not, through the matrix's
  // callbacks, each called once (US-05 AC3 counts the open Lp(a) editors).
  useEffect(() => {
    if (!open) return;
    onActivate?.();
    const down = pointersDown.current;
    down.clear();
    const onDown = (e: PointerEvent) => {
      if (governs(e.target)) latest.current?.leaveForUnit();
      else down.add(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      down.delete(e.pointerId);
      if (down.size === 0) send({ type: 'released' });
    };
    // A click-away save already asked for runs as the page goes away (it
    // never comes due in a hidden tab), and is written at once: the page's
    // own flush ran before this listener (Codex R1). Text left in an open
    // editor is not saved (US-04 AC1).
    // An ordering patch until one hide path stages every cell, then flushes once (H92).
    const hidden = () => { sendLeave('hidden'); flushRoadmapStoreSync(); };
    const onHide = () => { if (document.visibilityState === 'hidden') hidden(); };
    const onPageHide = hidden;
    const listeners = [['pointerdown', onDown], ['pointerup', onUp], ['pointercancel', onUp]] as const;
    for (const [type, listener] of listeners) document.addEventListener(type, listener, true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      onDeactivate?.();
    };
  }, [open]);
  // Whether `target` is in this row's own unit control.
  const ownUnitControl = (target: EventTarget | null) => {
    const control = target instanceof Element ? target.closest('[data-unit-control]') : null;
    return !!control && !!inputRef.current?.closest('.bt-row')?.contains(control);
  };
  // Whether `target` is in a unit control that can change this editor's
  // unit: its row's own, or the page's (`data-unit-control="all"`), which
  // changes every core metric's but never a lab value's.
  const governs = (target: EventTarget | null) => ownUnitControl(target)
    || (!!metric && target instanceof Element && !!target.closest('[data-unit-control="all"]'));

  const core = metric && display ? { metric, display } : null;
  const initialDisplay = core ? cellText(core.metric, value, core.display) : formatLabValue(value);
  // What the cell shows: a limit with its symbol; a core limit its bound
  // decides nothing about is not graded, and says so (US-12 AC20).
  const shownValue = core ? savedCellText(core.metric, value, core.display, comparator) : savedLabText(value, comparator);
  const ungraded = callerUngraded ?? (!!core && limitUngraded(core.metric, status, { grading: grading ?? null, plan: null }, { value, comparator }));
  const canCorrect = !!(rowId && onCorrect);

  // Leaving for a unit control that governs this editor (US-05 AC2, US-04
  // AC1): the number typed is in a unit the user is about to change, so the
  // editor closes unsaved and says so, at the press, before any click can
  // switch the unit; a save's wait for the release once ran past a held
  // press (adversary R1, 2026-10-13). An editor nobody typed in loses
  // nothing: it closes silently.
  const leaveForUnit = () => {
    const now = machine.current;
    send({ type: 'leftForUnit', edited: isOpen(now) && now.typed !== initialDisplay });
  };
  // A unit switch while the editor is open never saves the typed text
  // (US-05 AC2, US-04 AC1): a user who types 40 and then clicks mg/dL
  // means "this number is in mg/dL", and saving 40 in the old unit is the
  // falsely reassuring error. It closes the editor, as Escape does, clears
  // any click-away save, waiting or not, and says so; a save already
  // running (Enter) reports its own result. The focus stays where the
  // browser put it, except that it comes back to the cell from an editor
  // that had it (another device's switch).
  // Re-expressing the text in the new unit rounded twice: a saved 124.4 shown
  // "49.8" mg/dL came back "125" nmol/L and saved 125. A layout effect, so no
  // keystroke or timer reads the text in the new unit first.
  useLayoutEffect(() => {
    if (isOpen(machine.current)) send({ type: 'unitSwitched', hadFocus: document.activeElement === inputRef.current });
  }, [display]);
  // Each message is said in the matrix's live region too.
  const message = messageOf(state);
  useEffect(() => { if (message) say?.(message); }, [message]);

  // Text the editor cannot save: outside the metric's range, or no number.
  const unusable = (text: string) => text === initialDisplay ? false : core
    ? !!validateTypedValue(core.metric, text, core.display).error
    : readNumericCell(text) === undefined;

  // What the open editor's text would save now. A leave closes on a text it
  // cannot save, never leaving a half-open form; Enter checks the unit first.
  const verdict = (how: 'enter' | 'leave'): Verdict => {
    const now = machine.current;
    if (!isOpen(now)) return 'unchanged';
    const { typed } = now;
    if (how === 'leave' && unusable(typed)) return 'unusable';
    // The unit changed since the editor opened: the text is in the old one.
    if (shownIn.current !== now.unit) return 'unitChanged';
    // An emptied editor is a change of mind: it closes and writes nothing.
    if (typed.trim() === '' || typed === initialDisplay) return 'unchanged';
    if (unusable(typed)) return 'unusable';
    const parsed = (core ? readTypedValue(core.metric, typed, core.display) : readNumericCell(typed))!;
    const newValue = core ? cellToSI(core.metric, parsed, core.display) : parsed;
    return sameAsSaved(parsed, initialDisplay, newValue, value) ? 'unchanged' : { save: newValue };
  };
  latest.current = { leaveForUnit, verdict, onCorrect };

  if (open) {
    return (
      <NumericInputCell
        metric={core?.metric}
        display={core?.display}
        grading={grading}
        value={state.typed}
        validationResult={state.typed === initialDisplay ? null : undefined}
        onChange={text => send({ type: 'typed', text })}
        externalError={message ?? null}
        wrapperClass={`bt-cell-input bt-cell-correcting${pinned ? ' bt-cell-pinned' : ''}`}
        active
        autoFocus
        disabled={state.kind === 'saving'}
        inputRef={inputRef}
        onKeyDown={e => {
          blockBadNumericKeys(e);
          if (e.key === 'Enter') { e.preventDefault(); send({ type: 'submitted', how: 'enter', verdict: verdict('enter') }); }
          if (e.key === 'Escape') { e.preventDefault(); send({ type: 'escape' }); }
        }}
        // Back within the click-away window: the pending save, timed or
        // waiting on a release, is cancelled; Enter or the next leave saves
        // the text as it is then (US-04 AC1, H40).
        onFocus={() => send({ type: 'focused' })}
        // The focus going to this row's own unit control (Tab) never arms the
        // save; a press closed the editor already. Any other leave arms the
        // click-away save, which matches Enter.
        onBlur={e => ownUnitControl(e.relatedTarget) ? leaveForUnit() : send({ type: 'blurred' })}
      />
    );
  }

  const shown = (
    <>
      <span className="bt-value-num num">
        {shownValue}
        {unit && <span className="alr-cell-unit">{unit}</span>}
      </span>
      {ungraded && <span className="hr-sr-only">{LIMIT_NOT_GRADED}</span>}
      {message
        ? <span className="bt-input-error-text">{message}</span>
        : <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>}
    </>
  );

  if (!canCorrect) {
    return <div className={`bt-cell-value${pinned ? ' bt-cell-pinned' : ''}`} title={ungraded ? LIMIT_NOT_GRADED : undefined}>{shown}</div>;
  }

  return (
    <button
      type="button"
      ref={el => {
        if (el && state.kind === 'closed' && state.refocus) { el.focus(); send({ type: 'refocused' }); }
      }}
      className={`bt-cell-value bt-cell-clickable${pinned ? ' bt-cell-pinned' : ''}`}
      onClick={() => send({ type: 'opened', row: rowId!, unit: display, text: initialDisplay })}
      title={ungraded ? `${LIMIT_NOT_GRADED} Click to correct this value` : 'Click to correct this value'}
    >
      {shown}
    </button>
  );
}
