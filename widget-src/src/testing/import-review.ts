// Test support for the upload review suites: the review hides the values it is
// sure about behind "Show all" (US-13 AC13). A suite about the matrix itself
// opens it first, as a person would, to reach every cell. Imported by tests only.

import { fireEvent, screen, waitFor } from '@testing-library/react';

/** Taps "Show all N" when the review hides values; a no-op when it hides none. */
export function showAllValues(): void {
  // `hidden`: a review the modal hides (Close keeps it, US-12 AC5) still holds its button.
  const button = screen.queryByRole('button', { name: /^Show all \d+$/, hidden: true });
  if (button) fireEvent.click(button);
}

/** `showAllValues` after a render, passing the render's result through. */
export function showingAll<T>(rendered: T): T {
  showAllValues();
  return rendered;
}

/** A file the list read with nothing to say: its plain status, not a reason. */
const READ_STATUS = 'Read';

/** The reason the upload gives for one file, or null when it names none: the list's Files block (each file's status
 *  beyond a plain read, and its notices) or a screen's notices list ("Files to check"), joined in page order. */
export function reasonFor(name: string): string | null {
  const items = [...document.querySelectorAll('.upload-list-files li, [aria-label="Files to check"] li')]
    .filter((li) => li.textContent!.startsWith(name));
  const reasons = items.map((li) => li.textContent!.slice(name.length).trim()).filter((r) => r && r !== READ_STATUS);
  return reasons.length ? reasons.join(' | ') : null;
}

/** The list's "Not saved" section as drawn, its heading and its lines (the iPhone's, US-12 AC19), or null. */
export function notSaved(): { title: string; lines: string[] } | null {
  const section = document.querySelector('.upload-list-not-saved');
  return section && { title: section.querySelector('h4')!.textContent!, lines: [...section.querySelectorAll('li')].map((li) => li.textContent!) };
}

/** Waits for the review to open, shows every value, then finds the (first) cell holding `value`. */
export async function findReviewValue(value: string): Promise<HTMLElement> {
  return (await findAllReviewValues(value))[0];
}

/** `findReviewValue` for a value several files hold. */
export async function findAllReviewValues(value: string): Promise<HTMLElement[]> {
  // The list's summary, the engine's words: "1 file: 1 lab report", or all known (US-13 AC26).
  await screen.findByText(/^(\d+ files?\b|Everything here)/, { selector: '.review-summary' });
  // The list shows while files are read: its rows come as each file is read (US-12 AC26).
  return waitFor(() => {
    showAllValues();
    return screen.getAllByDisplayValue(value);
  });
}
