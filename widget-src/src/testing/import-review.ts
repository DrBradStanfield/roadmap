// Test support for the upload review suites: the review hides the values it is
// sure about behind "Show all" (US-13 AC13). A suite about the matrix itself
// opens it first, as a person would, to reach every cell. Imported by tests only.

import { fireEvent, screen, waitFor } from '@testing-library/react';

/** Taps "Show all N" when the review hides values; a no-op when it hides none. */
export function showAllValues(): void {
  // `hidden`: a review the modal hides (Close keeps it, US-12 AC5) still holds its button.
  const button = screen.queryByRole('button', { name: /^Show all \d+$/, hidden: true });
  if (button) fireEvent.click(button);
  // The documents Save files sit behind one row too (US-13 AC14): a suite about their cards opens it.
  const documents = screen.queryByRole('button', { name: /(letter or document|letters and documents) will be saved$/, hidden: true });
  if (documents?.getAttribute('aria-expanded') === 'false') fireEvent.click(documents);
}

/** `showAllValues` after a render, passing the render's result through. */
export function showingAll<T>(rendered: T): T {
  showAllValues();
  return rendered;
}

/** Waits for the review to open, shows every value, then finds the (first) cell holding `value`. */
export async function findReviewValue(value: string): Promise<HTMLElement> {
  return (await findAllReviewValues(value))[0];
}

/** `findReviewValue` for a value several files hold. */
export async function findAllReviewValues(value: string): Promise<HTMLElement[]> {
  // The review shows while files are still read (US-12 AC26): wait for the value itself, not the summary.
  await screen.findByText(/^(\d+ files?\b|Everything here)/, { selector: '.review-summary' });
  return waitFor(() => {
    showAllValues();
    return screen.getAllByDisplayValue(value);
  });
}
