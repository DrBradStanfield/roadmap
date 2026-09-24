// Test support for the matrix suites (BloodTestTimeline.test.tsx,
// HealthTool.journey.test.tsx): the gestures a person makes on a matrix
// (US-03), as the browser reports them. Imported by tests only.

import { act, fireEvent } from '@testing-library/react';

/** A tap, as a finger or a mouse makes one: the press, the focus it gives, the release. */
export function press(el: HTMLElement): void {
  fireEvent.pointerDown(el);
  act(() => el.focus());
  fireEvent.pointerUp(el);
}

/** A tap into a cell, then a value typed in it. */
export function typeInto(input: HTMLInputElement, value: string): void {
  press(input);
  fireEvent.change(input, { target: { value } });
}

/** Keys typed into the cell that already has the focus, with no new tap:
 *  what iOS does after a tap on blank space leaves the focus where it was. */
export function typeWithoutTap(input: HTMLInputElement, value: string): void {
  fireEvent.input(input, { target: { value } });
}

/** Date a matrix's draft column by a press on its date, as the 2026-09-22 guest did. */
export function pickDraftDate(matrix: HTMLElement, day: string): void {
  const dateCell = matrix.querySelector('.bt-header-row .bt-cell-draft-date') as HTMLElement;
  fireEvent.pointerDown(dateCell); // Safari never gives the button focus
  fireEvent.pointerUp(dateCell);
  fireEvent.click(dateCell);
  const dateInput = dateCell.querySelector('input[type="date"]') as HTMLInputElement;
  act(() => dateInput.focus());
  fireEvent.change(dateInput, { target: { value: day } });
  act(() => dateInput.blur()); // iOS "Done"
}

/** A phone putting the page away (an app switch, or the tab closing). The
 *  page stays hidden until `showPage`, so whatever runs after the events
 *  still sees it hidden. */
export function hidePage(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
}

/** The page is back on screen. Safe to call when it never went away. */
export function showPage(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
}
