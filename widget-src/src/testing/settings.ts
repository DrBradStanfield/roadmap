// Test support: My health's settings (US-62 AC24) hold About you, the reminders,
// the record and Delete all my data behind the person button on desktop, in the
// Account tab on a phone (AC34). Imported by tests only.
import { fireEvent } from '@testing-library/react';

/** Opens the settings (a phone's Account tab), unless they are open already. */
export function openSettings(root: ParentNode = document): void {
  if (root.querySelector('.mh-settings')) return;
  const opener = root.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
    ?? [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(t => t.textContent === 'Account');
  if (!opener) throw new Error('No Settings button or Account tab on screen');
  fireEvent.click(opener);
}

/** Closes the settings: Done on desktop, the My health tab on a phone (US-62 AC34). */
export function closeSettings(root: ParentNode = document): void {
  const done = [...root.querySelectorAll<HTMLButtonElement>('.mh-settings button')].find(b => b.textContent === 'Done')
    ?? [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(t => t.textContent === 'My health');
  if (!done) throw new Error('No Done button or My health tab on screen');
  fireEvent.click(done);
}

/** Delete all my data, in the settings (opened first); throws while it is not there, so waitFor retries. */
export function deleteButton(root: ParentNode = document): HTMLElement {
  openSettings(root);
  const button = [...root.querySelectorAll<HTMLElement>('button')].find(b => b.textContent?.trim() === 'Delete all my data');
  if (!button) throw new Error('Delete all my data is not in Settings');
  return button;
}
