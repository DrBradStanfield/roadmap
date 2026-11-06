// Test support: My health's settings (US-62 AC24) hold About you, the reminders,
// the record and Delete All My Data behind the person button. Imported by tests only.
import { fireEvent } from '@testing-library/react';

/** Opens the settings, unless they are open already. */
export function openSettings(root: ParentNode = document): void {
  if (root.querySelector('.mh-settings')) return;
  const person = root.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
  if (!person) throw new Error('No Settings button on screen');
  fireEvent.click(person);
}

/** Delete All My Data, in the settings (opened first); throws while it is not there, so waitFor retries. */
export function deleteButton(root: ParentNode = document): HTMLElement {
  openSettings(root);
  const button = [...root.querySelectorAll<HTMLElement>('button')].find(b => b.textContent?.trim() === 'Delete All My Data');
  if (!button) throw new Error('Delete All My Data is not in Settings');
  return button;
}
