// Numeric input cell shared by BloodTestTimeline (live matrix) and
// ReviewTable (upload review matrix). Fixed-height footer (status tick or
// error message) prevents the input from shifting when state changes.
//
// Visual is driven by .bt-cell-* classes — the parent passes wrapperClass
// to position the cell + signal mode (input / correcting / draft / review).

import { useId } from 'react';
import type React from 'react';
import { commaQuestion } from '@roadmap/health-core/parseNumber';
import { LIMIT_NOT_GRADED, type Comparator } from '@roadmap/health-core/lab-limits';
import { limitUngraded, savedStatus } from '@roadmap/health-core/row-grade';
import type { MetricType } from '@roadmap/health-core/units';
import { describedBy } from '../lib/aria';
import { useRangeWait } from '../lib/useRangeWait';
import {
  type CellUnit,
  type Grading,
  blockBadNumericKeys,
  numericCellText,
  hasNumericSyntax,
  mayStillFit,
  readNumericCell,
  NUMERIC_SYNTAX_GUIDANCE,
  comparatorSymbol,
  previewStatus,
  validateTypedValue,
} from '../lib/blood-test-cell';

export interface NumericInputCellProps {
  /** Omit for free-form rows (lab values not in the algorithm). Without a
   *  metric the cell has no range or status preview; it only asks about an
   *  ambiguous comma ("1,234", US-02 AC7). */
  metric?: MetricType;
  display?: CellUnit;
  value: string;
  /** Grade this SI value instead of the typed text: a review cell saves the
   *  extracted value while untouched, not one re-derived from its rounded
   *  display, and after a unit toggle the number typed in the other unit. */
  valueSI?: number;
  onChange: (v: string) => void;
  /** Outer wrapper class (appended to bt-cell-value). */
  wrapperClass: string;
  /** Inner input class. Defaults to "bt-input". */
  inputClass?: string;
  /** Whom the live status preview grades the value for. Omit it, or pass
   *  null (a known minor, US-07 AC6), for no preview. */
  grading?: Grading;
  active?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Ids of visible text that describes the input. The label stays
   *  value-free; values are heard from that text (US-13 AC10). */
  ariaDescribedBy?: string;
  /** Caller-supplied error (e.g. save failure) — takes precedence over
   *  the local validation error so retry feedback is visible inline. */
  externalError?: string | null;
  /** Canonical validation for an untouched stored/extracted value, or the
   *  review's edited quantity. Undefined uses local text/range validation. */
  validationResult?: string | null;
  onFocus?: () => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Shown under the input, inside the cell (a review cell's own unit, US-35 AC6). */
  note?: React.ReactNode;
  /** The value is a printed limit, its bound in the input: the symbol shows
   *  before it, and it is graded only when the bound decides (US-12 AC20).
   *  The caller drops it once the text is edited, which makes it exact. */
  comparator?: Comparator;
}

export function NumericInputCell({
  metric, display, value, valueSI, onChange,
  wrapperClass, inputClass = 'bt-input',
  grading,
  active, autoFocus, disabled, placeholder, ariaLabel, ariaDescribedBy, externalError, validationResult,
  onFocus, onBlur, onKeyDown = blockBadNumericKeys, inputRef, note, comparator,
}: NumericInputCellProps) {
  const errorId = useId();
  const limitId = useId();
  const ungradedId = useId();
  const checked = metric && display ? validateTypedValue(metric, value, display) : null;
  const validationError = validationResult !== undefined ? validationResult
    : value !== '' && !hasNumericSyntax(value) ? NUMERIC_SYNTAX_GUIDANCE
    : checked ? checked.error
    : commaQuestion(value) ?? (value !== '' && readNumericCell(value) === undefined ? 'Enter a number' : null);
  // US-02 AC9: a range error more digits could still fix waits ("4" on the way to 45 cm).
  const rangeWait = useRangeWait();
  const waits = !!validationError && rangeWait.waits('cell', value);
  const error = externalError ?? (waits ? null : validationError);
  const status = !grading || error || waits || !metric || !display
    ? null
    : valueSI !== undefined ? savedStatus(metric, valueSI, comparator, grading)
    : comparator ? null : previewStatus(metric, value, display, grading);
  const ungraded = !!metric && valueSI !== undefined && limitUngraded(metric, status, { grading: grading ?? null, plan: null }, { value: valueSI, comparator });
  const insertText = (input: HTMLInputElement, text: string) => {
    onChange(numericCellText(value.slice(0, input.selectionStart ?? value.length)
      + text + value.slice(input.selectionEnd ?? value.length)));
  };
  const input = (
    <input
      ref={inputRef}
      // type="text" not "number" — number inputs strip comma decimals in
      // European locales before parseLocalisedNumber can normalise them.
      type="text"
      inputMode="decimal"
      pattern="[0-9.,]*"
      // `size={1}` shrinks the input's intrinsic min-content on iOS
      // WebKit (default `size=20` ≈ 280px) so flex-basis dominates.
      // Without it, an all-empty row balloons in `width: max-content`
      // calculations and stretches the matrix scroll width.
      size={1}
      value={value}
      // Keep ambiguous syntax invalid instead of joining numeric tokens.
      onChange={e => {
        const text = numericCellText(e.target.value);
        rangeWait.typed('cell', text, !!checked && mayStillFit(text, checked.range.min, checked.range.max));
        onChange(text);
      }}
      // Read before a text input removes spreadsheet line separators.
      onPaste={e => {
        e.preventDefault();
        insertText(e.currentTarget, e.clipboardData.getData('text'));
      }}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        e.preventDefault();
        insertText(e.currentTarget, e.dataTransfer.getData('text'));
      }}
      onKeyDown={e => { if (e.key === 'Enter') rangeWait.settle(); onKeyDown(e); }}
      onFocus={onFocus}
      onBlur={e => { rangeWait.settle(); onBlur?.(e); }}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={!!error}
      // The visible error, not a title: a title is captured with the page (US-13 AC10).
      aria-describedby={describedBy(comparator && limitId, ariaDescribedBy, ungraded && ungradedId, error && errorId)}
      autoFocus={autoFocus}
      disabled={disabled}
      className={`${inputClass}${active ? ' bt-input-active' : ''}${error ? ' bt-input-error' : ''}`}
    />
  );
  return (
    <div className={`bt-cell-value ${wrapperClass}`} title={ungraded ? LIMIT_NOT_GRADED : undefined}>
      {/* A printed limit's symbol before its bound (US-12 AC20). One tree
          either way, so the edit that drops the symbol keeps the input, and its focus. */}
      <span className={comparator ? 'bt-cell-limit-row' : 'bt-cell-input-row'}>
        {comparator && <span id={limitId} className="bt-cell-limit">{comparatorSymbol(comparator)}</span>}
        {input}
      </span>
      {note}
      {ungraded && <span id={ungradedId} className="hr-sr-only">{LIMIT_NOT_GRADED}</span>}
      <div className="bt-cell-foot">
        {error
          ? <span id={errorId} className="bt-input-error-text">{error}</span>
          : <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>}
      </div>
    </div>
  );
}
