/**
 * US-60: "Do you drink alcohol?" The plan's "Reduce alcohol intake" card
 * carries a Dismiss button that asks it in a small dialog. The answer goes to
 * the profile through the form's own write path (HealthTool's input change,
 * then the profile autosave), so About you shows it and can change it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { REDUCE_ALCOHOL_ID, type AlcoholAnswer, type Suggestion } from '@roadmap/health-core';

/** About you's choices; '' is "Not answered", which clears the answer. */
export const ALCOHOL_OPTIONS: ReadonlyArray<{ value: AlcoholAnswer | ''; label: string }> = [
  { value: '', label: 'Not answered' },
  { value: 'none', label: "I don't drink" },
  { value: 'drinks', label: 'I drink' },
];

/**
 * The Dismiss for `reduce-alcohol` (US-60 AC3), or null: `onAnswer` is absent
 * once the question is answered, so "I drink" leaves the card with no Dismiss.
 * The answer goes into the form on the click and saves through the profile's
 * debounced autosave, which keeps the erase the screen showed then (US-16 AC2a);
 * "I don't drink" takes the card off the plan at once.
 */
export function alcoholDismiss(suggestion: Suggestion, onAnswer?: (answer: AlcoholAnswer) => void) {
  return suggestion.id === REDUCE_ALCOHOL_ID && onAnswer ? <AlcoholDismiss onChoose={onAnswer} /> : null;
}

/** The Dismiss button and its question. */
function AlcoholDismiss({ onChoose }: { onChoose: (answer: AlcoholAnswer) => void }) {
  const [open, setOpen] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const choose = (choice: AlcoholAnswer) => { setOpen(false); onChoose(choice); };

  return (
    <>
      <button type="button" className="suggestion-dismiss no-print" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        Dismiss
      </button>
      {/* Portaled: the plan sits in a transformed Swiper slide on phones, which
          would pin a fixed backdrop to the slide (the upload modal does the same). */}
      {open && createPortal(
        <div className="upload-modal-backdrop no-print" data-clarity-mask="true"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="upload-modal alcohol-dialog" role="dialog" aria-modal="true" aria-labelledby="alcohol-dialog-title">
            <h3 id="alcohol-dialog-title" className="alcohol-dialog-title">Do you drink alcohol?</h3>
            <div className="alcohol-dialog-actions">
              <button ref={firstRef} type="button" className="upload-btn-primary" onClick={() => choose('none')}>I don't drink</button>
              <button type="button" className="upload-btn-primary" onClick={() => choose('drinks')}>I drink</button>
            </div>
            <button type="button" className="upload-connect-skip" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
