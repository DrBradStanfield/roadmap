// Numeric input cell shared by BloodTestTimeline (live matrix) and
// ReviewTable (upload review matrix). Fixed-height footer (status tick or
// error message) prevents the input from shifting when state changes.
//
// Visual is driven by .bt-cell-* classes — the parent passes wrapperClass
// to position the cell + signal mode (input / correcting / draft / review).

import { useId } from 'react';
import type React from 'react';
import { commaQuestion, type MetricType } from '@roadmap/health-core';
import { describedBy } from '../lib/aria';
import {
  type CellUnit,
  type Grading,
  blockBadNumericKeys,
  numericCellText,
  hasNumericSyntax,
  readNumericCell,
  NUMERIC_SYNTAX_GUIDANCE,
  previewStatus,
  statusOf,
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
}

export function NumericInputCell({
  metric, display, value, valueSI, onChange,
  wrapperClass, inputClass = 'bt-input',
  grading,
  active, autoFocus, disabled, placeholder, ariaLabel, ariaDescribedBy, externalError, validationResult,
  onFocus, onBlur, onKeyDown = blockBadNumericKeys, inputRef, note,
}: NumericInputCellProps) {
  const errorId = useId();
  const validationError = validationResult !== undefined ? validationResult
    : value !== '' && !hasNumericSyntax(value) ? NUMERIC_SYNTAX_GUIDANCE
    : metric && display ? validateTypedValue(metric, value, display).error
    : commaQuestion(value) ?? (value !== '' && readNumericCell(value) === undefined ? 'Enter a number' : null);
  const error = externalError ?? validationError;
  const status = !grading || error || !metric || !display
    ? null
    : valueSI !== undefined ? statusOf(metric, valueSI, grading) : previewStatus(metric, value, display, grading);
  const insertText = (input: HTMLInputElement, text: string) => {
    onChange(numericCellText(value.slice(0, input.selectionStart ?? value.length)
      + text + value.slice(input.selectionEnd ?? value.length)));
  };
  return (
    <div className={`bt-cell-value ${wrapperClass}`}>
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
        onChange={e => onChange(numericCellText(e.target.value))}
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
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={!!error}
        // The visible error, not a title: a title is captured with the page (US-13 AC10).
        aria-describedby={describedBy(ariaDescribedBy, error && errorId)}
        autoFocus={autoFocus}
        disabled={disabled}
        className={`${inputClass}${active ? ' bt-input-active' : ''}${error ? ' bt-input-error' : ''}`}
      />
      {note}
      <div className="bt-cell-foot">
        {error
          ? <span id={errorId} className="bt-input-error-text">{error}</span>
          : <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>}
      </div>
    </div>
  );
}
