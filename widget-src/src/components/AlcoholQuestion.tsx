/**
 * US-60: "Do you drink alcohol?" The plan's "Reduce alcohol intake" card
 * carries a Dismiss button that asks it in a small dialog. The answer goes to
 * the profile through the form's own write path (HealthTool's input change,
 * then the profile autosave). Web has no Starting Info row for it (US-60, Brad 2026-11-02).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { REDUCE_ALCOHOL_ID, type AlcoholAnswer, type Suggestion } from '@roadmap/health-core';

/** The two answers to the card's first question. */
const ALCOHOL_OPTIONS: ReadonlyArray<{ value: AlcoholAnswer; label: string }> = [
  { value: 'none', label: "I don't drink" },
  { value: 'drinks', label: 'I drink' },
];

/** US-60 AC3: the card's question, with the answer the profile holds now and
 *  the title My data's profile section shows (`profileTitle`, lib/profile-title.ts). */
export type AlcoholQuestion = { answer?: AlcoholAnswer; onAnswer: (answer: AlcoholAnswer) => void; section: string };

/** Shown in the dialog's place after "I still drink", which saves nothing. */
export const stillDrinkLine = (section: string) => `This stays on your plan because the advice applies to anyone who drinks. You can change your answer in ${section}.`;

/**
 * The Dismiss for `reduce-alcohol` (US-60 AC3), or null. Unanswered, it asks
 * "Do you drink alcohol?"; a drinker is asked "Do you still drink alcohol?".
 * An answer goes into the form on the click and saves through the profile's
 * debounced autosave, which keeps the erase the screen showed then (US-16 AC2a);
 * "I don't drink" and "I've stopped" take the card off the plan at once.
 */
export function alcoholDismiss(suggestion: Suggestion, question?: AlcoholQuestion) {
  return suggestion.id === REDUCE_ALCOHOL_ID && question ? <AlcoholDismiss drinks={question.answer === 'drinks'} onChoose={question.onAnswer} section={question.section} /> : null;
}

/** The Dismiss button and its question. */
function AlcoholDismiss({ drinks, onChoose, section }: { drinks: boolean; onChoose: (answer: AlcoholAnswer) => void; section: string }) {
  // 'stays': "I still drink" was chosen, and the dialog says why the card stays.
  const [open, setOpen] = useState<false | 'ask' | 'stays'>(false);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const choose = (choice: AlcoholAnswer) => { setOpen(false); onChoose(choice); };
  // The dialog's buttons; a null answer is "I still drink", which saves nothing.
  // iOS twin: AlcoholQuestion.choices (PlanCardView.swift).
  const choices: Array<{ label: string; answer: AlcoholAnswer | null }> = drinks
    ? [{ label: "I've stopped", answer: 'none' }, { label: 'I still drink', answer: null }]
    : ALCOHOL_OPTIONS.map(({ value, label }) => ({ label, answer: value }));

  return (
    <>
      <button type="button" className="suggestion-dismiss no-print" onClick={(e) => { e.stopPropagation(); setOpen('ask'); }}>
        Dismiss
      </button>
      {/* Portaled: the plan card is transformed on hover and as it enters, and
          .health-tool is transformed, either of which would pin a fixed backdrop
          to it (the upload modal does the same). */}
      {open && createPortal(
        <div className="upload-modal-backdrop no-print" data-clarity-mask="true"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="upload-modal alcohol-dialog" role="dialog" aria-modal="true" aria-labelledby="alcohol-dialog-title">
            {open === 'stays' ? (
              <>
                <p id="alcohol-dialog-title" className="alcohol-dialog-note">{stillDrinkLine(section)}</p>
                <button ref={firstRef} type="button" className="upload-btn-primary" onClick={() => setOpen(false)}>OK</button>
              </>
            ) : (
              <>
                <h3 id="alcohol-dialog-title" className="alcohol-dialog-title">{drinks ? 'Do you still drink alcohol?' : 'Do you drink alcohol?'}</h3>
                <div className="alcohol-dialog-actions">
                  {choices.map(({ label, answer }, i) => (
                    <button key={label} ref={i === 0 ? firstRef : undefined} type="button" className="upload-btn-primary"
                      onClick={() => (answer ? choose(answer) : setOpen('stays'))}>{label}</button>
                  ))}
                </div>
                <button type="button" className="upload-connect-skip" onClick={() => setOpen(false)}>Cancel</button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
