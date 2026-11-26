// A day picker for the web upload list (web list PR 2): one named button that opens the native date picker, and the
// picker's own input beside it, hidden from the tab order and from assistive tech, so nothing interactive nests (the
// grid's DraftDateCell nests its input in its button). An empty picker shows the words it is given, never a day that
// reads as picked. A full date is handed on; an emptied one goes to `onClear` when given, else is ignored, as the grid
// treats a letter's cleared date (unknown) and a lab day's (ignored).
import { useRef } from 'react';

export function ListDatePicker({ value, shown, empty, name, describedBy, disabled, at, onDay, onClear }: {
  /** The input's day, YYYY-MM-DD, or '' for none. */
  value: string;
  /** What the button shows: the day in words, or what to pick; `id` makes it the button's description. */
  shown: { text: string; id: string };
  empty: boolean;
  /** Its name: fixed words, or `by` the ids of text on the page that name it (record text never sits in an attribute). */
  name: string | { by: string };
  describedBy?: string;
  disabled: boolean;
  /** The blocker key this picker removes (UploadList's focus on a refused Save). */
  at?: string;
  onDay: (day: string) => void;
  onClear?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // As DraftDateCell opens its picker; a browser without showPicker (Safari before 16) gets the click too (S9).
  const open = () => {
    const el = input.current;
    try { if (el?.showPicker) return el.showPicker(); } catch { /* the click below */ }
    el?.click();
  };
  return (
    <span className="upload-list-picker" data-at={at}>
      <button type="button" className={`upload-list-picker-button${empty ? ' upload-list-picker-button--empty' : ''}`}
        // The name replaces the button's content, so the day it shows is read as its description (adversary F6).
        aria-label={typeof name === 'string' ? name : undefined} aria-labelledby={typeof name === 'string' ? undefined : name.by} aria-describedby={[shown.id, describedBy].filter(Boolean).join(' ')} disabled={disabled} onClick={open}>
        <span id={shown.id}>{shown.text}</span>
      </button>
      <input ref={input} type="date" tabIndex={-1} aria-hidden="true" className="bt-date-hidden-icon" value={value} disabled={disabled}
        onChange={(e) => { if (e.target.value) onDay(e.target.value); else onClear?.(); }} />
    </span>
  );
}
