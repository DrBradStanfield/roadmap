import React, { useState } from 'react';

/** React's onBlur bubbles: Tab from the icon to the link inside it is not leaving the tooltip (US-02 AC10). */
function focusLeaves(e: React.FocusEvent<HTMLElement>): boolean {
  return !e.currentTarget.contains(e.relatedTarget as Node | null);
}

/** Enter or Space on the icon itself; a key pressed on the link inside belongs to the link (US-02 AC10). */
function togglesTooltip(e: React.KeyboardEvent<HTMLElement>): boolean {
  return e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ');
}

/**
 * ⓘ info tooltip — hover/focus (desktop) PLUS click/tap toggle (US-02).
 * The 2026-08 Clarity audit showed taps on these icons going dead: the CSS
 * :hover/:focus-within pattern gives mobile no reliable open path, and inside a
 * `<label htmlFor>` the label's activation behavior hijacked the tap into the
 * labelled control (Birth Month opened the month dropdown instead). The
 * click handler preventDefaults to cancel that label activation; links inside
 * the tooltip body are exempted so they still navigate. The keyboard reaches
 * them too (US-02 AC10): see the two helpers below.
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
      onBlur={(e) => { if (focusLeaves(e)) setOpen(false); }}
      onKeyDown={(e) => { if (togglesTooltip(e)) { e.preventDefault(); setOpen(o => !o); } }}
    >
      <span className="bp-info-icon" aria-hidden="true">&#9432;</span>
      <span className="bp-info-tooltip">{children}</span>
    </span>
  );
}
