import { useState } from 'react';

/**
 * US-02 AC9: a range error waits while the number being typed could still
 * reach the range ("19" on the way to 190); leaving the field or pressing
 * Enter shows it. One rule for the plain fields, the grid cells and the
 * blood-pressure pair. After each keystroke the field says whether more
 * typing could still fix it (`mayStillFit`, or the field's own rule);
 * `waits` then holds back that field's error, and only for the text typed:
 * a unit switch shows another number, judged at once.
 */
export function useRangeWait() {
  const [held, setHeld] = useState<{ key: string; text: string } | null>(null);
  return {
    typed: (key: string, text: string, couldFit: boolean) => setHeld(couldFit ? { key, text } : null),
    settle: () => setHeld(null),
    waits: (key: string, text?: string) => held?.key === key && (text === undefined || text === held.text),
  };
}
