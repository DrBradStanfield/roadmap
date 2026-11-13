/**
 * Save as PDF's print state as one named state (US-18 AC6, US-09 AC19), changed
 * only through the pure `transition`. usePlanPrint (components/PlanPdf.tsx) sends
 * the events and runs the work: the report copy, the window, the event count.
 *
 * Phases, one try at a time (the capture's print and Save as PDF are never on
 * screen together, and Save as PDF is disabled while its own try runs):
 * - idle: nothing running. `blocked` is the button whose last window was refused,
 *   or null; it empties at each try and when the plan goes.
 * - drawing: the hidden report is drawn, inside the click, while getReportHtml copies it.
 * - building: the copy is made; the report is built and its window opened.
 * `via` is how the try started: Save as PDF ('save', its button reads Loading...)
 * or the capture's print ('capture'). `opened` (a window opened in this record)
 * goes through every phase, sticky until an erase forgets it.
 */

/** The button whose print window was refused: the note sits beside it. */
export type PdfButton = 'bottom' | 'capture';

export type PrintState =
  | { phase: 'idle'; blocked: PdfButton | null; opened: boolean }
  | { phase: 'drawing' | 'building'; at: PdfButton; via: 'save' | 'capture'; opened: boolean };

export type PrintEvent =
  | { type: 'press'; at: PdfButton; via: 'save' | 'capture' }
  | { type: 'copied' }
  | { type: 'built'; opened: boolean }
  | { type: 'planGone' }
  | { type: 'forget' };

export const PRINT_START: PrintState = { phase: 'idle', blocked: null, opened: false };

/** The same state back means the event changed nothing (a press while a try runs is refused). */
export function transition(state: PrintState, event: PrintEvent): PrintState {
  switch (event.type) {
    case 'press':
      return state.phase === 'idle' ? { phase: 'drawing', at: event.at, via: event.via, opened: state.opened } : state;
    case 'copied':
      return state.phase === 'drawing' ? { ...state, phase: 'building' } : state;
    case 'built':
      return state.phase === 'idle' ? state
        : { phase: 'idle', blocked: event.opened ? null : state.at, opened: state.opened || event.opened };
    case 'planGone':
      return state.phase === 'idle' && state.blocked ? { ...state, blocked: null } : state;
    case 'forget':
      return state.opened ? { ...state, opened: false } : state;
  }
}
