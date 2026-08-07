import React, { useState } from 'react';

/**
 * ⓘ info tooltip — hover/focus (desktop) PLUS click/tap toggle (US-02).
 * The 2026-08 Clarity audit showed taps on these icons going dead: the CSS
 * :hover/:focus-within pattern gives mobile no reliable open path, and inside a
 * `<label htmlFor>` the label's activation behavior hijacked the tap into the
 * labelled control (Birth Month opened the month dropdown instead). The
 * click handler preventDefaults to cancel that label activation; links inside
 * the tooltip body are exempted so they still navigate.
 */
export function InfoTooltip({ ariaLabel, children }: { ariaLabel: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`bp-info-tooltip-wrap${open ? ' bp-info-tooltip-wrap--open' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={ariaLabel}
      aria-expanded={open}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return; // let tooltip links navigate
        e.preventDefault();
        e.stopPropagation();
        setOpen(o => !o);
      }}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
    >
      <span className="bp-info-icon" aria-hidden="true">&#9432;</span>
      <span className="bp-info-tooltip">{children}</span>
    </span>
  );
}
