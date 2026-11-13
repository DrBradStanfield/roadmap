// The Lp(a) unit check under the blood-test matrix (US-05 AC3).

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { type UnitSystem, reportedToCanonical, UNIT_DEFS } from '@roadmap/health-core/units';
import { healthInputSchema } from '@roadmap/health-core/validation';
import { formatShortDate } from '../lib/constants';
import type { CorrectFn } from '../lib/matrix-save';
import { LPA_CHECK_COOL_MS, LPA_CHECK_START, transition } from '../lib/lpa-check-machine';
import { keepLpaAsIs, lpaRowsToCheck, type LpaCheck } from '../lib/lpa-unit';
import { trackProductEvent } from '../lib/server-api';
import { useLiveRegion } from './MatrixSavedCells';

// US-05 AC3: one question per Lp(a) row typed while the US field was labelled
// mg/L (lpaRowsToCheck), under the matrix's last row, Lp(a). The user answers
// with a number and its unit, so a row stored right (a connector's 120 nmol/L)
// has an honest answer that writes nothing. "My report says <typed> mg/dL",
// "... nmol/L" or "... mg/L" is a correction at today's factor, as a
// click-to-correct makes one (US-04), offered only when the record takes its
// value. A report above 300 mg/dL saves the record's ceiling, 750 nmol/L.
// "Neither", or any answer that would save what is stored, keeps the row and
// is remembered on this device.
type ReportUnit = 'mg/dL' | 'nmol/L' | 'mg/L';
const LPA_MAX = UNIT_DEFS.lpa.validationRange.si.max;

function LpaChecks({ rows, unitSystem, onCorrect, waiting }: {
  rows: ApiMeasurement[]; unitSystem: UnitSystem; onCorrect: CorrectFn; waiting: boolean;
}) {
  const [answered, setAnswered] = useState<string[]>([]);
  // Saving, then a rest after every outcome (lib/lpa-check-machine.ts).
  const [{ answering, refusals }, dispatch] = useReducer(transition, LPA_CHECK_START);
  useEffect(() => {
    if (answering.phase !== 'cooling') return;
    const timer = window.setTimeout(() => dispatch({ type: 'cooled' }), LPA_CHECK_COOL_MS);
    return () => window.clearTimeout(timer);
  }, [answering]);
  // What the last answer did, said in a region that outlives its notice: on
  // the page from the first question, so an answer is heard, and kept once
  // the last notice goes.
  const [say, status] = useLiveRegion('lpa-check-status');
  const [asked, setAsked] = useState(false);
  // Where the focus goes once the answer's render lands (its notice may have gone).
  const focusFrom = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const checks = useMemo(
    () => lpaRowsToCheck(rows, unitSystem).filter(check => !answered.includes(check.row.id)),
    [rows, unitSystem, answered]);

  useLayoutEffect(() => {
    const target = focusFrom.current;
    focusFrom.current = null;
    target?.()?.focus();
  });

  // A report in nmol/L, clean of float noise (12 significant digits).
  const nmolOf = (typed: number, unit: ReportUnit) => Number(reportedToCanonical('lpa', typed, unit)!.valueSI.toPrecision(12));
  // What an answer writes, as its button says: mg/dL past the ceiling saves the ceiling.
  const saves = (typed: number, unit: ReportUnit) => unit === 'mg/dL' ? Math.min(nmolOf(typed, unit), LPA_MAX) : nmolOf(typed, unit);

  const answer = async (event: React.MouseEvent, { row, typed }: LpaCheck, index: number, unit: ReportUnit | 'keep') => {
    if (event.detail > 1) return; // the second click of a double click
    const root = event.currentTarget.closest('.bt-timeline')!;
    const notice = (i: number) => root.querySelectorAll<HTMLElement>('.lpa-check')[i];
    // After an answer the focus goes to the next notice, else to the Lp(a)
    // row's latest value, else the matrix heading; after a refusal it can retry, back to its
    // own notice (a button disabled while saving drops the focus). Never to the page.
    const focusOn = () => {
      const cells = root.querySelectorAll<HTMLElement>('[data-metric="lpa"] .bt-cell-clickable');
      return notice(index) ?? cells[cells.length - 1] ?? root.querySelector<HTMLElement>('.bt-timeline-title');
    };
    // An answer that would save what is stored writes nothing: kept.
    const kept = unit === 'keep' || saves(typed, unit) === Number(row.value.toPrecision(12));
    if (kept) {
      keepLpaAsIs(row.id);
      dispatch({ type: 'kept' });
    } else {
      dispatch({ type: 'correcting', rowId: row.id });
      const status = await onCorrect(row.id, saves(typed, unit));
      if (status === 'changed') {
        // Replaced on another device: the page re-reads the record and the
        // notice goes, so the reason is said where it outlives it (adversary
        // R8), and the focus goes to the next notice or there (adversary R5).
        say(CHECK_CHANGED);
        focusFrom.current = () => notice(index + 1) ?? root.querySelector<HTMLElement>('.lpa-check-status');
      } else focusFrom.current = focusOn;
      dispatch({ type: 'settled', status });
      if (status !== 'ok') return;
    }
    // Names the result's day, so a second answer in a row reads differently.
    const day = formatShortDate(row.recordedAt);
    say(kept ? `Kept the result from ${day} as saved.` : `Saved the result from ${day}.`);
    trackProductEvent('lpa_check_answered', { answer: kept ? 'keep' : unit }); // after the outcome; the label, never a value
    focusFrom.current = focusOn;
    setAnswered(ids => [...ids, row.id]);
  };

  const notices = checks.map((check, index) => {
    const offered = (['mg/dL', 'nmol/L', 'mg/L'] as const)
      .filter(unit => healthInputSchema.shape.lpa.safeParse(saves(check.typed, unit)).success);
    const over = nmolOf(check.typed, 'mg/dL') > LPA_MAX;
    const label = (unit: ReportUnit) => `My report says ${check.typed} ${unit}` + (unit === 'nmol/L' ? ''
      : unit === 'mg/dL' && over ? ` (saves ${LPA_MAX} nmol/L, the highest value this tool records)`
        : ` (saves ${saves(check.typed, unit)} nmol/L)`);
    return (
    <div key={check.row.id} className="screening-notice lpa-check" tabIndex={-1}>
      <p>
        {`Please check this Lp(a) result from ${formatShortDate(check.row.recordedAt)}. It is saved as`
          + ` ${check.row.value.toFixed(0)} nmol/L. Between 6 September and 13 October this box was labelled mg/L,`
          + ' so a number copied from a lab report may have been saved wrongly. What does your lab report say?'}
      </p>
      <div className="alr-add-actions">
        {offered.map(unit => (
          <button key={unit} type="button" className="alr-add-cancel" disabled={answering.phase !== 'idle' || waiting}
            onClick={e => void answer(e, check, index, unit)}>{label(unit)}</button>
        ))}
        <button type="button" className="alr-add-cancel" disabled={answering.phase !== 'idle' || waiting}
          onClick={e => void answer(e, check, index, 'keep')}>Neither of these (keep as saved)</button>
        {waiting && <span className="lpa-check-wait">Finish editing the Lp(a) value first.</span>}
      </div>
      {over && <p className="lpa-check-note">This tool records Lp(a) up to 300 mg/dL (750 nmol/L).
        If your report shows a higher number, that result is very high: please discuss it with your doctor.</p>}
      <p className="lpa-check-note">You can also correct any value by clicking it in the table.</p>
      {/* A p, never a div: the storefront theme hides an empty div (div:empty). */}
      <p className="alr-add-notice lpa-check-note" aria-live="polite">{refusals[check.row.id] || '\u00a0'}</p>
    </div>
    );
  });
  if (checks.length > 0 && !asked) setAsked(true);
  return <>{notices}{asked && status}</>;
}

/** What the check says when another device replaced the result it was answering (US-05 AC3). */
const CHECK_CHANGED = 'This result changed on another device. Nothing was saved.';

export { LpaChecks };
