// Mobile-only commit affordance. iOS numeric keypads have no Enter/Done key
// and tapping outside an input on a phone is awkward, so blur-based auto-save
// is unreliable on touch. Two variants share styling via the CSS in styles.css:
//   - `matrix`  → matrix header (.bt-commit-tick), one per dirty matrix.
//   - `inline`  → next to a longitudinal input (.commit-tick-inline), one per
//                 dirty field (weight, BP, PSA).
// `onMouseDown.preventDefault()` keeps focus on the input so the soft keypad
// stays up after the user taps the tick.

import type React from 'react';

interface CommitTickButtonProps {
  ariaLabel: string;
  onClick: () => void;
  variant?: 'inline' | 'matrix';
}

export function CommitTickButton({ ariaLabel, onClick, variant = 'inline' }: CommitTickButtonProps) {
  const className = variant === 'matrix' ? 'bt-commit-tick' : 'commit-tick-inline';
  const handleMouseDown = (e: React.MouseEvent) => e.preventDefault();
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onMouseDown={handleMouseDown}
      onClick={onClick}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3 7.5 L6 10.5 L11 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  );
}
