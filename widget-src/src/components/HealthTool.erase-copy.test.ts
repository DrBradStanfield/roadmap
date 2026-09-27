/**
 * US-11 AC · what "Delete all my data" promises.
 *
 * The old confirm said the data would be "permanently delete[d]" and the
 * caveats arrived AFTER the click, in the post-erase alert — too late to be a
 * decision. The caveats now live in the confirm itself, and both strings drive
 * window.confirm/window.alert directly, so asserting them is equivalent to
 * asserting what the user reads.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ERASE_CONFIRM, ERASE_DONE, ERASE_DONE_CHAT_PENDING } from './HealthTool';

/** The erase strings as one build shows them. */
async function eraseCopyOn(shopify: boolean) {
  vi.resetModules();
  vi.doMock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: shopify, LOCAL_FIRST: true }));
  return import('./HealthTool');
}
/** ERASE_CONFIRM as one build shows it. */
async function eraseConfirmOn(shopify: boolean): Promise<string> {
  return (await eraseCopyOn(shopify)).ERASE_CONFIRM;
}
afterEach(() => { vi.doUnmock('../lib/build-flags'); vi.resetModules(); });

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

  // US-11: the erase cannot reach another device's browser storage. There the
  // blog chat bubble and the chatbot embed read the widget's copy of the
  // record, and keep sending it until the widget loads on that device and
  // finds the record erased (HealthTool loadData writes the copy empty).
  // Only the Shopify build has a bubble and an embed.
  it('US-11: on the Shopify build, names the chat bubble and embed on another device, which keep the old record until the widget loads there', async () => {
    const copy = await eraseConfirmOn(true);
    expect(copy).toMatch(/Six things this cannot reach/);
    expect(copy).toMatch(/5\. On another device, the blog chat bubble and the chatbot embed/);
    expect(copy).toMatch(/until the widget next loads there/i);
  });

  // US-15 AC7/AC8: the server keeps the widget chat's questions, and the blog
  // bubble's and the embed's questions and replies, for 30 days, and no erase
  // reaches them. Say so before the click. The clock is the last message: a
  // conversation's title (its first question's first words) is purged 30 days
  // after the conversation's updated_at, which every turn bumps
  // (app/lib/chat-purge-cron.server.ts).
  it('US-15 AC7/AC8: on the Shopify build, names every chat question and reply our server keeps for 30 days', async () => {
    const copy = await eraseConfirmOn(true);
    expect(copy).toContain(
      "6. Your chat questions (the widget, the blog chat bubble and the chatbot embed) and the bubble's and embed's replies. " +
        'Our server keeps them for 30 days after your last message in that chat.',
    );
    expect(copy).not.toMatch(/7\./);
    expect(copy).not.toMatch(/—/);
  });

  it('US-11: on the Pages build, which has no bubble or embed, keeps four items', async () => {
    const copy = await eraseConfirmOn(false);
    expect(copy).toMatch(/Four things this cannot reach/);
    expect(copy).toMatch(/4\. Backups made by the command-line tool/);
    expect(copy).not.toMatch(/chat bubble|chatbot embed|30 days|5\.|6\./);
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

  // The CLI's own backups do not last: an erase write keeps none, and every
  // later write prunes the copies that predate the erase epoch
  // (packages/health-core/src/file-adapter.ts). The confirm used to promise
  // they "stay beside the file" full stop.
  it('says the command-line backups last only until that tool next writes', () => {
    expect(ERASE_CONFIRM).toContain(
      'Backups made by the command-line tool stay beside the file until that tool next writes it.',
    );
    expect(ERASE_DONE).toContain('any command-line backups until that tool next writes the file');
    expect(ERASE_DONE_CHAT_PENDING).toContain('until that tool next writes the file');
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

  // US-11 AC5: the alert repeats the confirm, shorter. On the Shopify build
  // that includes items 5 and 6: the bubble and embed on another device, and
  // the chat our server keeps for 30 days.
  it('US-11 AC5: on the Shopify build, the alert repeats items 5 and 6, shorter', async () => {
    const { ERASE_CONFIRM: confirm, ERASE_DONE: done, ERASE_DONE_CHAT_PENDING: pending } = await eraseCopyOn(true);
    for (const alert of [done, pending]) {
      expect(alert).toContain('On another device, the blog chat bubble and the chatbot embed send your old record until the widget loads there.');
      expect(alert).toContain("Our server keeps your chat questions, and the bubble's and embed's replies, for 30 days after your last message.");
      expect(alert).not.toMatch(/—/);
      expect(alert.length).toBeLessThan(confirm.length);
    }
  });

  it('US-11 AC5: on the Pages build, the alert names no bubble, embed or server-kept chat', async () => {
    const { ERASE_CONFIRM: confirm, ERASE_DONE: done, ERASE_DONE_CHAT_PENDING: pending } = await eraseCopyOn(false);
    for (const alert of [done, pending]) {
      expect(alert).not.toMatch(/chat bubble|chatbot embed|30 days|our server/i);
      expect(alert).toMatch(/version history/i);
      expect(alert.length).toBeLessThan(confirm.length);
    }
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
