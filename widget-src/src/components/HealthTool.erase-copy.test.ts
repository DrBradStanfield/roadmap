/**
 * US-11 AC · what "Delete all my data" promises.
 *
 * The old confirm said the data would be "permanently delete[d]" and the
 * caveats arrived AFTER the click, in the post-erase alert — too late to be a
 * decision. The caveats now live in the confirm itself, and both strings drive
 * window.confirm/window.alert directly, so asserting them is equivalent to
 * asserting what the user reads.
 */
import { describe, it, expect } from 'vitest';
import { ERASE_CONFIRM, ERASE_DONE, ERASE_DONE_CHAT_PENDING } from './HealthTool';

describe('erase confirm copy (US-11)', () => {
  it('names what is erased: the record and the chat history', () => {
    expect(ERASE_CONFIRM).toMatch(/health record/i);
    expect(ERASE_CONFIRM).toMatch(/chat history/i);
  });

  it('names, BEFORE the click, each copy an erase cannot reach', () => {
    expect(ERASE_CONFIRM).toMatch(/documents you uploaded/i);   // already in their folder
    expect(ERASE_CONFIRM).toMatch(/imports\/pending-\*\.json/); // connector candidates
    expect(ERASE_CONFIRM).toMatch(/version history/i);
    expect(ERASE_CONFIRM).toMatch(/GitHub/);
    expect(ERASE_CONFIRM).toMatch(/backup/i);                   // command-line tool
  });

  // The old sentence said the kept row means "a later re-enrolment does not
  // restart them". It does not: enrolByEmail REFILLS a tombstone's schedule on
  // the next optin (app/lib/reminder-v2.server.ts). The kept row only stops a
  // second welcome email. Pin the corrected sentence, not just /address/.
  it('says reminders stop, and says what the kept row actually does', () => {
    expect(ERASE_CONFIRM).toMatch(/reminders are turned off/i);
    expect(ERASE_CONFIRM).toContain(
      'The row on our server keeps your address for 90 days, so a later enrolment of that address does not send a second welcome email',
    );
    expect(ERASE_CONFIRM).toContain(
      'anyone who enrols the address again restarts the schedule, and each email carries the off link',
    );
    expect(ERASE_CONFIRM).toMatch(/Google/);
  });

  it('never claims the kept row stops reminders from restarting', () => {
    expect(ERASE_CONFIRM).not.toMatch(/does not restart/i);
  });

  it('still says the erase itself cannot be undone', () => {
    expect(ERASE_CONFIRM).toMatch(/cannot be undone/i);
  });

  it('is plain: no em dashes in either string', () => {
    expect(ERASE_CONFIRM).not.toMatch(/—/);
    expect(ERASE_DONE).not.toMatch(/—/);
  });

  it('the post-erase alert stays consistent with the confirm, and shorter', () => {
    expect(ERASE_DONE).toMatch(/chat history/i);
    expect(ERASE_DONE).toMatch(/version history/i);
    expect(ERASE_DONE.length).toBeLessThan(ERASE_CONFIRM.length);
  });

  // deleteUserData() swallows a failed chat erase so an unreachable cloud can
  // never trap a user's data on their device. The alert must not then claim
  // the chat history is gone: it reports the flag the caller was handed.
  it('has a variant for the erase that could not reach the chat history', () => {
    expect(ERASE_DONE_CHAT_PENDING).toMatch(/health record is deleted/i);
    expect(ERASE_DONE_CHAT_PENDING).toMatch(/chat history could not be reached/i);
    expect(ERASE_DONE_CHAT_PENDING).toMatch(/erased on your next chat/i);
    expect(ERASE_DONE_CHAT_PENDING).not.toMatch(/chat history (?:and|are|is) deleted/i);
    expect(ERASE_DONE_CHAT_PENDING).not.toMatch(/—/);
  });
});
