// Numeric input cell shared by BloodTestTimeline (live matrix) and
// ReviewTable (upload review matrix). Fixed-height footer (status tick or
// error message) prevents the input from shifting when state changes.
//
// Visual is driven by .bt-cell-* classes — the parent passes wrapperClass
// to position the cell + signal mode (input / correcting / draft / review).

import type React from 'react';
import type { MetricType, UnitSystem } from '@roadmap/health-core';
import {
  blockBadNumericKeys,
  previewStatus,
  validateTypedValue,
} from '../lib/blood-test-cell';

export interface NumericInputCellProps {
  /** Omit for free-form rows (lab values not in the algorithm). Without a
   *  metric the cell skips validation + status preview and renders a plain
   *  input with an empty footer. */
  metric?: MetricType;
  display?: UnitSystem;
  value: string;
  onChange: (v: string) => void;
  /** Outer wrapper class (appended to bt-cell-value). */
  wrapperClass: string;
  /** Inner input class. Defaults to "bt-input". */
  inputClass?: string;
  /** Omit `sex` to suppress the live preview entirely. Pass sex to enable
   *  computing status from the typed value. */
  sex?: 'male' | 'female';
  showStatusPreview?: boolean;
  active?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  /** Caller-supplied error (e.g. save failure) — takes precedence over
   *  the local validation error so retry feedback is visible inline. */
  externalError?: string | null;
  onFocus?: () => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function NumericInputCell({
  metric, display, value, onChange,
  wrapperClass, inputClass = 'bt-input',
  sex, showStatusPreview = true,
  active, autoFocus, disabled, placeholder, ariaLabel, externalError,
  onFocus, onBlur, onKeyDown = blockBadNumericKeys,
}: NumericInputCellProps) {
  const validationError = metric && display ? validateTypedValue(metric, value, display).error : null;
  const error = externalError ?? validationError;
  const status = !showStatusPreview || error || !metric || !display
    ? null
    : previewStatus(metric, value, display, sex);
  return (
    <div className={`bt-cell-value ${wrapperClass}`}>
      <input
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
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={!!error}
        title={error ?? undefined}
        autoFocus={autoFocus}
        disabled={disabled}
        className={`${inputClass}${active ? ' bt-input-active' : ''}${error ? ' bt-input-error' : ''}`}
      />
      <div className="bt-cell-foot">
        {error
          ? <span className="bt-input-error-text">{error}</span>
          : <span className={`bt-status-tick bt-status-${status ?? 'none'}`}/>}
      </div>
    </div>
  );
}
