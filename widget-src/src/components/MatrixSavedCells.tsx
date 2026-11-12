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
import type { CorrectStatus } from '../storage/roadmap-store';
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

/** What an editor closed by a unit switch says (US-05 AC2). */
const UNIT_CHANGED = 'The unit changed, so your edit was not saved. Type it again in the new unit.';
/** What an editor left for its own unit control says (US-05 AC2). */
const UNIT_FIRST = 'Not saved: choose the unit first, then type the value.';

/** What a refused correction says, wherever one is made. */
export const SAVE_ERRORS: Record<Exclude<Extract<CorrectStatus, string>, 'ok'>, string> = {
  changed: 'This value changed on another device, so your edit was not saved.',
  invalid: 'That value is outside the range this record takes.',
  error: 'Could not save. Check your connection and try again.',
};
/** A refusal's words: the engine's own when it gave them (US-21 AC26). */
export const saveErrorText = (status: Exclude<CorrectStatus, 'ok'>) => typeof status === 'string' ? SAVE_ERRORS[status] : status.refused;

// The saved-value editor, one for every matrix: the blood tests, the vitals
// (StartingInfoVitals) and the additional lab rows. Click a value to correct
// it in place: a FHIR correction, never an edit of the saved row.
export function ValueCell({
  metric, display, grading, value, comparator, unit, rowId, status, ungraded: callerUngraded, pinned, onActivate, onDeactivate, onCorrect, say,
}: ValueCellProps) {
  // `typed === null` ⇒ read-only; otherwise the in-place edit form is open.
  // One field replaces the old (editing, typed) pair — impossible state gone.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The row the editor opened on, which its correction names: the store
  // refuses it once another writer has replaced that row (US-04 AC1).
  const openedOn = useRef<string>();
  const blurTimerRef = useRef<number | null>(null);
  // A typed correction is saved only in the unit shown when the editor
  // opened, never across a unit change (US-05 AC2, US-04 AC1). The unit
  // shown then, and now: a save that runs late reads both.
  const openedIn = useRef<CellUnit>();
  const shownIn = useRef(display);
  shownIn.current = display;
  // The focus comes back to this cell when another device's switch closes
  // the editor that had it.
  const refocusRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Pointers down while the editor is open (as useSaveOnLeave tracks them),
  // and a click-away save that came due during a press: its click has not
  // run yet, so the save waits for the release, at most a second (a release
  // can be lost), and never past the page going away (adversary R5). Its own
  // submit then checks the unit. A press on a unit control that governs this
  // editor never gets that far: the press closes it (`leaveForUnit`).
  const pointersDown = useRef(new Set<number>());
  const leaveForUnitRef = useRef<() => void>();
  const afterRelease = useRef<(() => void) | null>(null);
  const editing = typed !== null;
  // The editor opens and closes, unmounted or not, through the matrix's
  // callbacks, each called once (US-05 AC3 counts the open Lp(a) editors).
  useEffect(() => {
    if (!editing) return;
    onActivate?.();
    const down = pointersDown.current;
    down.clear();
    // The save waiting for a release: a task on, or now.
    const runWaiting = (later: boolean) => {
      const save = afterRelease.current;
      if (!save) return;
      clearBlurTimer();
      if (later) blurTimerRef.current = window.setTimeout(save, 0);
      else save();
    };
    const onDown = (e: PointerEvent) => {
      if (governs(e.target)) leaveForUnitRef.current?.();
      else down.add(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      down.delete(e.pointerId);
      if (down.size === 0) runWaiting(true); // the click, and any switch it made, run first
    };
    const onHide = () => { if (document.visibilityState === 'hidden') runWaiting(false); };
    const onPageHide = () => runWaiting(false);
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
  }, [editing]);
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

  const clearBlurTimer = () => {
    afterRelease.current = null;
    if (blurTimerRef.current != null) {
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  };
  useEffect(() => clearBlurTimer, []); // also fires on unmount

  const core = metric && display ? { metric, display } : null;
  const initialDisplay = core ? cellText(core.metric, value, core.display) : formatLabValue(value);
  // What the cell shows: a limit with its symbol; a core limit its bound
  // decides nothing about is not graded, and says so (US-12 AC20).
  const shownValue = core ? savedCellText(core.metric, value, core.display, comparator) : savedLabText(value, comparator);
  const ungraded = callerUngraded ?? (!!core && limitUngraded(core.metric, status, { grading: grading ?? null, plan: null }, { value, comparator }));
  const canCorrect = !!(rowId && onCorrect);

  const beginEdit = () => {
    if (!canCorrect || saving) return;
    // Cancel any pending blur-cancel from a previous cell — otherwise it
    // would fire after this cell mounts and clobber our active state.
    clearBlurTimer();
    setSaveError(null);
    openedOn.current = rowId;
    openedIn.current = display;
    setTyped(initialDisplay);
  };

  const cancel = () => {
    clearBlurTimer();
    setTyped(null);
    setSaveError(null);
  };
  // Leaving for a unit control that governs this editor (US-05 AC2, US-04
  // AC1): the number typed is in a unit the user is about to change, so the
  // editor closes unsaved and says so, at the press, before any click can
  // switch the unit; a save's wait for the release once ran past a held
  // press (adversary R1, 2026-10-13). An editor nobody typed in loses
  // nothing: it closes silently.
  const leaveForUnit = () => {
    if (saving) return;
    cancel();
    openedOn.current = undefined; // a late blur's save, from a handler of the render before, has no row

    if (typed !== initialDisplay) setSaveError(UNIT_FIRST);
  };
  leaveForUnitRef.current = leaveForUnit;
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
    if (typed === null) return;
    const hadFocus = document.activeElement === inputRef.current;
    cancel();
    if (saving) return;
    setSaveError(UNIT_CHANGED);
    refocusRef.current = hadFocus;
  }, [display]);
  // Each message is said in the matrix's live region too.
  useEffect(() => { if (saveError) say?.(saveError); }, [saveError]);

  // Text the editor cannot save: outside the metric's range, or no number.
  const unusable = (text: string) => text === initialDisplay ? false : core
    ? !!validateTypedValue(core.metric, text, core.display).error
    : readNumericCell(text) === undefined;

  const submit = async () => { clearBlurTimer(); // an armed click-away save would ask a second time
    const opened = openedOn.current;
    if (!opened || !onCorrect || typed === null) return;
    // The unit changed since the editor opened: the text is in the old one.
    if (shownIn.current !== openedIn.current) { cancel(); setSaveError(UNIT_CHANGED); return; }
    // An emptied editor is a change of mind: it closes and writes nothing.
    if (typed.trim() === '' || typed === initialDisplay) { cancel(); return; }
    if (unusable(typed)) return;
    const parsed = (core ? readTypedValue(core.metric, typed, core.display) : readNumericCell(typed))!;
    const newValue = core ? cellToSI(core.metric, parsed, core.display) : parsed;
    if (sameAsSaved(parsed, initialDisplay, newValue, value)) { cancel(); return; }
    setSaving(true);
    setSaveError(null);
    const status = await onCorrect(opened, newValue);
    setSaving(false);
    // A value replaced meanwhile closes the editor, and the cell says the
    // edit went; any other failure keeps it open for a retry.
    if (status === 'ok' || status === 'changed') cancel();
    if (status !== 'ok') setSaveError(saveErrorText(status));
  };

  if (typed !== null) {
    return (
      <NumericInputCell
        metric={core?.metric}
        display={core?.display}
        grading={grading}
        value={typed}
        validationResult={typed === initialDisplay ? null : undefined}
        onChange={v => { setSaveError(null); setTyped(v); }}
        externalError={saveError}
        wrapperClass={`bt-cell-input bt-cell-correcting${pinned ? ' bt-cell-pinned' : ''}`}
        active
        autoFocus
        disabled={saving}
        inputRef={inputRef}
        onKeyDown={e => {
          blockBadNumericKeys(e);
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        onBlur={e => {
          // The focus going to this row's own unit control (Tab): never arm
          // the save. A press closed the editor already.
          if (ownUnitControl(e.relatedTarget)) return leaveForUnit();
          // Save on click-away when the typed value passes validation —
          // matches the Enter key. If the value is invalid we revert
          // rather than leaving a half-open form with no focus.
          // 150ms defer lets clicks on adjacent affordances intercept.
          const leave = () => {
            if (saving || typed === null) return;
            if (unusable(typed)) cancel();
            else void submit();
          };
          // Due while a pointer is down, the save waits for its release, a
          // second at most.
          blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = null;
            if (pointersDown.current.size === 0) return leave();
            afterRelease.current = leave;
            blurTimerRef.current = window.setTimeout(() => {
              afterRelease.current = null;
              leave();
            }, 1000);
          }, 150);
        }}
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
      {saveError
        ? <span className="bt-input-error-text">{saveError}</span>
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
        if (el && refocusRef.current) { refocusRef.current = false; el.focus(); }
      }}
      className={`bt-cell-value bt-cell-clickable${pinned ? ' bt-cell-pinned' : ''}`}
      onClick={beginEdit}
      title={ungraded ? `${LIMIT_NOT_GRADED} Click to correct this value` : 'Click to correct this value'}
    >
      {shown}
    </button>
  );
}
