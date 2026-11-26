import type React from 'react';

/** Enter or Space on the row itself opens it; a key on its Delete button is left to the button. */
export function opensRow(e: React.KeyboardEvent): boolean {
  return e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ');
}
