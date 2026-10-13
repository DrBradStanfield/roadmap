// Lp(a)'s unit, three ways on one control (US-05 AC2): where every other
// field has a two-way unit chip, Lp(a) has nmol/L | mg/dL | mg/L, the active
// unit highlighted. Shared by the blood-test matrix and the upload review.
// A radio group by keyboard: one tab stop, the checked unit; the arrow keys
// move and select, wrapping at either end.

import { useRef, type KeyboardEvent } from 'react';
import { LPA_UNITS, type LpaUnit } from '@roadmap/health-core';

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function LpaUnitControl({ unit, onChange }: { unit: LpaUnit; onChange: (unit: LpaUnit) => void }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = STEP[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (LPA_UNITS.indexOf(unit) + step + LPA_UNITS.length) % LPA_UNITS.length;
    buttons.current[next]?.focus();
    onChange(LPA_UNITS[next]);
  };
  return (
    <div className="bt-unit-segments" role="radiogroup" aria-label="Lp(a) unit" onKeyDown={onKeyDown}>
      {LPA_UNITS.map((u, i) => (
        <button
          key={u}
          ref={(el) => { buttons.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={u === unit}
          tabIndex={u === unit ? 0 : -1}
          className={`bt-unit-segment${u === unit ? ' bt-unit-segment--active' : ''}`}
          onClick={() => { if (u !== unit) onChange(u); }}
        >
          {u}
        </button>
      ))}
    </div>
  );
}
