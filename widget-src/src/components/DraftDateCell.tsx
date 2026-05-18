// Compact date-picker cell: button labelled "DD Mon / 'YY" + calendar icon
// that opens the native date picker. Shared by BloodTestTimeline's draft
// column and ReviewTable's matrix-column + document-card date inputs.

import { useRef } from 'react';
import { MONTHS_SHORT } from '../lib/constants';

const MONTH_LABELS = MONTHS_SHORT.map(m => m.label);

export interface DraftDateCellProps {
  /** ISO YYYY-MM-DD. Pass YYYY-MM-01 + needsDay when the day is unknown. */
  date: string;
  onChange: (date: string) => void;
  /** Render "—" instead of the day digit to flag a placeholder day. */
  needsDay?: boolean;
  ariaLabel?: string;
}

export function DraftDateCell({ date, onChange, needsDay, ariaLabel }: DraftDateCellProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  const d = new Date(date + 'T00:00');
  const day = d.getDate();
  const mon = MONTH_LABELS[d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  const open = () => {
    try { (ref.current as any)?.showPicker?.(); }
    catch { ref.current?.click(); }
  };
  return (
    <button type="button" onClick={open}
            title={needsDay ? 'Pick the exact day' : 'Click to change date'}
            className={`bt-cell-value bt-cell-draft-date${needsDay ? ' bt-cell-draft-date-incomplete' : ''}`}>
      <span className="bt-date-day">{needsDay ? '—' : day} {mon}</span>
      <div className="bt-draft-date-year-row">
        <span className="bt-date-year">'{yr}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="bt-draft-date-icon">
          <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
          <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="currentColor" strokeWidth="1.3"/>
          <line x1="5" y1="2" x2="5" y2="4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <line x1="11" y1="2" x2="11" y2="4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </div>
      <input ref={ref} type="date" value={date}
             onChange={e => onChange(e.target.value)}
             className="bt-date-hidden-icon"
             aria-label={ariaLabel ?? 'Choose date'}/>
    </button>
  );
}
