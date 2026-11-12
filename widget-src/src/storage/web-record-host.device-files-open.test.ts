/**
 * @vitest-environment jsdom
 *
 * US-09 AC2c: a page that may not write this device's health files does not
 * read them either, chat history included. The web's device-tier host answers
 * `deviceFilesOpen` with the same rule its write gate uses. Each page is a
 * fresh module graph over the one localStorage, as browser tabs are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const BACKEND_KEY = 'health_roadmap_backend';
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
const GUEST_TEXT = 'SYNTHETIC_GUEST_QUESTION';

/** A fresh page, loaded with the device's log-off id and chosen store as they are now. */
async function page() {
  vi.resetModules();
  return {
    local: await import('./local-storage-adapter'),
    host: await import('./web-record-host'),
    chat: await import('./chat-history-store'),
  };
}

/** A log-off on another page: a new log-off id, the named files cleared (the
 *  erase fence moves), and no store chosen. */
async function logOffOnAnotherPage(): Promise<void> {
  const other = await page();
  localStorage.setItem(LOG_OFF_ID_KEY, 'id-after');
  other.local.clearLocalNamedFiles();
  localStorage.removeItem(BACKEND_KEY);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('US-09 AC2c: the device-tier host opens this device\'s files only while the page may write them', () => {
  it('a fallback page is open until a log-off on another page stops it', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox'); // a cloud chosen: this device-tier page is its fallback
    const { local, host } = await page();
    const h = host.webRecordHost(new local.LocalStorageAdapter());
    if (h.tier !== 'device') throw new Error('expected the device tier');
    expect(h.deviceFilesOpen?.()).toBe(true);
    await logOffOnAnotherPage();
    expect(h.deviceFilesOpen?.()).toBe(false);
  });

  it('a guest page with no log-off since it loaded is open', async () => {
    const { local, host } = await page();
    const h = host.webRecordHost(new local.LocalStorageAdapter());
    if (h.tier !== 'device') throw new Error('expected the device tier');
    expect(h.deviceFilesOpen?.()).toBe(true);
  });

  it('a stopped fallback page lists none of the conversations a later guest page saves', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    const a = await page();
    const stopped = await a.chat.ChatHistoryStore.create(new a.local.LocalStorageAdapter());
    await logOffOnAnotherPage();

    const guest = await page();
    const store = await guest.chat.ChatHistoryStore.create(new guest.local.LocalStorageAdapter());
    await store.recordExchange({ conversationId: 'guest-1', isNew: true, userText: GUEST_TEXT, assistantText: 'Synthetic answer' });
    expect(localStorage.getItem('health_roadmap_file_v2:chat-history.json')).toContain(GUEST_TEXT); // the guest's save landed

    expect(stopped.listConversations()).toEqual([]);
    expect(stopped.getMessages('guest-1')).toEqual([]);
  });
});
