// The typed cells of the matrices (US-03): the blood-test draft column's,
// and a saved column's empty slot, which the vitals matrix shares.

import type { MetricType } from '@roadmap/health-core/units';
import { type CellUnit, type Grading, blockBadNumericKeys } from '../lib/blood-test-cell';
import { NumericInputCell } from './NumericInputCell';

interface DraftCellProps {
  metric: MetricType;
  display: CellUnit;
  grading: Grading;
  value: string;
  /** What the cell saves, graded instead of its shown text (an Lp(a) cell
   *  typed in another unit, US-05 AC2). */
  valueSI?: number;
  /** Why the typed value cannot be saved as it stands (`SAME_SLOT`). */
  error?: string | null;
  /** As BackfillCell's. */
  validationResult?: string | null;
  active: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onEnter: () => void;
  onChange: (v: string) => void;
}

export function DraftCell({ metric, display, grading, value, valueSI, error, validationResult, active, onFocus, onBlur, onEnter, onChange }: DraftCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      grading={grading}
      value={value}
      valueSI={valueSI}
      externalError={error}
      validationResult={validationResult}
      onChange={onChange}
      wrapperClass="bt-cell-input bt-cell-draft"
      active={active}
      placeholder="—"
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={e => {
        blockBadNumericKeys(e);
        if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
      }}
    />
  );
}

interface BackfillCellProps {
  metric: MetricType;
  display: CellUnit;
  value: string;
  /** Why the typed value cannot be saved as it stands (`SAME_SLOT`). */
  error?: string | null;
  /** The typed text's own check when it was typed in another unit (see
   *  NumericInputCell); omit to check the shown text. */
  validationResult?: string | null;
  active: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onEnter: () => void;
  onChange: (v: string) => void;
  /** Appends `bt-cell-pinned` (the 2nd-from-right column highlight). The
   *  blood-test matrix never pins a backfill cell; the vitals matrix does. */
  pinned?: boolean;
}

// StartingInfoVitals reuses the identical empty-slot input cell
// (one source of truth for backfill styling + key handling across both matrices).
export function BackfillCell({ metric, display, value, error, validationResult, active, onFocus, onBlur, onEnter, onChange, pinned }: BackfillCellProps) {
  return (
    <NumericInputCell
      metric={metric}
      display={display}
      value={value}
      externalError={error}
      validationResult={validationResult}
      onChange={onChange}
      wrapperClass={`bt-cell-backfill${pinned ? ' bt-cell-pinned' : ''}`}
      inputClass="bt-input bt-input-backfill"
      active={active}
      placeholder="—"
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={e => {
        blockBadNumericKeys(e);
        if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
      }}
    />
  );
}
