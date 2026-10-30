// Compact "DD Mon / 'YY" button + calendar icon that opens the native date
// picker.

import { useRef } from 'react';
import { MONTHS_SHORT } from '../lib/constants';

const MONTH_LABELS = MONTHS_SHORT.map(m => m.label);

export interface DraftDateCellProps {
  /** ISO YYYY-MM-DD. Pass YYYY-MM-01 + needsDay when the day is unknown. */
  date: string;
  onChange: (date: string) => void;
  /** No day chosen yet: "—" for the day, and the picker starts EMPTY.
   *  Picking a prefilled picker's own day fires no change, so the day it
   *  was filled with could never be chosen (US-13 AC8). */
  needsDay?: boolean;
  /** With needsDay, a line shown instead of the date ("Pick a day in Jun 2024"). */
  placeholder?: string;
  ariaLabel?: string;
  /** A first line above the date. The matrices say "New", so the draft
   *  column never reads as a second copy of a saved column's date. */
  label?: string;
  /** A saved column's header (US-04 AC5): its own classes and title, and the
   *  day picked so far, which the picker holds while the header still shows
   *  the saved date. */
  className?: string;
  title?: string;
  picked?: string;
  disabled?: boolean;
}

export function DraftDateCell({ date, onChange, needsDay, placeholder, ariaLabel, label, className, title, picked, disabled }: DraftDateCellProps) {
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
    <button type="button" onClick={open} disabled={disabled}
            title={title ?? (needsDay ? 'Pick the exact day' : 'Click to change date')}
            className={className ?? `bt-cell-value bt-cell-draft-date${needsDay ? ' bt-cell-draft-date-incomplete' : ''}`}>
      {label && <span className="bt-draft-label">{label}</span>}
      <span className="bt-date-day">{needsDay && placeholder ? placeholder : `${needsDay ? '—' : day} ${mon}`}</span>
      <div className="bt-draft-date-year-row">
        {!(needsDay && placeholder) && <span className="bt-date-year">'{yr}</span>}
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="bt-draft-date-icon">
          <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
          <line x1="2" y1="6.5" x2="14" y2="6.5" stroke="currentColor" strokeWidth="1.3"/>
          <line x1="5" y1="2" x2="5" y2="4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <line x1="11" y1="2" x2="11" y2="4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </div>
      <input ref={ref} type="date" value={needsDay ? '' : picked ?? date} disabled={disabled}
             onChange={e => onChange(e.target.value)}
             className="bt-date-hidden-icon"
             aria-label={ariaLabel ?? 'Choose date'}/>
    </button>
  );
}
