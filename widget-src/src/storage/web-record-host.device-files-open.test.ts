/**
 * @vitest-environment jsdom
 *
 * US-09 AC2c: a page that may not write this device's health files does not
 * read them either, chat history included. The web's device-tier host answers
 * `deviceFilesOpen` with the same rule its write gate uses. Each page is a
 * fresh module graph over the one localStorage, as browser tabs are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMeasurement } from '@roadmap/health-core/roadmap-file';

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
    record: await import('@roadmap/health-core/record-session'),
  };
}

type Page = Awaited<ReturnType<typeof page>>;
type Session = Awaited<ReturnType<Page['record']['RecordSession']['open']>>;

/** A record session on this page's device store, with a spy on every read of it. */
async function openRecord(p: Page) {
  const store = new p.local.LocalStorageAdapter();
  const readSync = vi.spyOn(store, 'readSync');
  const session = await p.record.RecordSession.open(p.host.webRecordHost(store));
  return { session, readSync };
}

const addWeight = (session: Session, id: string) => session.edit((f) => {
  f.measurements.push(createMeasurement({ id, metricType: 'weight', value: 80, recordedAt: '2026-11-12', createdAt: '2026-11-13T09:00:00.000Z' }));
});
const ids = (session: Session) => session.file.measurements.map((m) => m.id).sort();

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

describe('US-09 AC2c: a device page that may not write this device\'s record reads none of it', () => {
  it('a stopped fallback page reads none of the record a later guest page saves, whether it re-reads, flushes or saves', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox'); // a cloud chosen: this device-tier page is its fallback
    const stopped = await openRecord(await page());
    await logOffOnAnotherPage();

    const guest = await openRecord(await page());
    addWeight(guest.session, 'guest-row');
    await guest.session.flush();
    expect(localStorage.getItem('health_roadmap_file_v2')).toContain('guest-row'); // the guest's save landed

    stopped.readSync.mockClear();
    expect(await stopped.session.refreshFromRemote()).toBe(false);
    addWeight(stopped.session, 'stopped-row');
    stopped.session.flushSync();
    await expect(stopped.session.flush()).rejects.toThrow();
    expect(stopped.readSync).not.toHaveBeenCalled();
    expect(ids(stopped.session)).toEqual(['stopped-row']);
    expect(stopped.session.saveStatus).toBe('not-saved');
    expect(localStorage.getItem('health_roadmap_file_v2')).not.toContain('stopped-row');
  });

  it('a page that opens after a log-off on another page shows an empty record that saves nothing; a reload reads the record', async () => {
    const guest = await openRecord(await page());
    addWeight(guest.session, 'guest-row');
    await guest.session.flush();

    const late = await page(); // loaded before the log-off, its record opened after it
    await logOffOnAnotherPage();
    const closed = await openRecord(late);
    expect(closed.readSync).not.toHaveBeenCalled();
    expect(ids(closed.session)).toEqual([]);
    addWeight(closed.session, 'closed-row');
    await expect(closed.session.flush()).rejects.toThrow();
    expect(closed.session.saveStatus).toBe('not-saved');
    expect(localStorage.getItem('health_roadmap_file_v2')).not.toContain('closed-row');

    const reloaded = await openRecord(await page()); // a guest, no log-off since it loaded
    expect(ids(reloaded.session)).toEqual(['guest-row']);
  });

  it('a fallback page hears another page\'s change only while it may write here; a cloud page always hears its own', async () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    const p = await page();
    const heard = vi.fn();
    const stop = p.host.webRecordHost(new p.local.LocalStorageAdapter()).watch!(heard);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(heard).toHaveBeenCalledTimes(1);
    await logOffOnAnotherPage();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();

    let fire = () => {};
    const cloud = { id: 'dropbox', watch: (_name: string, onChange: () => void) => { fire = onChange; } };
    const cloudHeard = vi.fn();
    p.host.webRecordHost(cloud as never).watch!(cloudHeard);
    fire();
    expect(cloudHeard).toHaveBeenCalledTimes(1);
  });
});
