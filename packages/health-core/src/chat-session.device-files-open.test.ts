/**
 * US-09 AC2c: a page that may not write this device's health files does not
 * read them either, chat history included. The device host says so through
 * `deviceFilesOpen`, read at each use; a host that leaves it out is open.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatSession } from './chat-session';
import { ConflictError, type ReadResult, type WriteResult } from './adapter';
import { MemoryAdapter } from './memory-adapter';
import type { RecordHost, SyncStorage } from './record-host';

let clock = Date.parse('2026-11-13T10:00:00.000Z');

/** A synchronous device store, as localStorage is on the web, with spies on both paths. */
class DeviceStore implements SyncStorage {
  files = new Map<string, { body: unknown; version: number }>();
  readSync = vi.fn((name: string): ReadResult => {
    const f = this.files.get(name);
    return f ? { body: structuredClone(f.body), version: String(f.version) } : { body: null, version: null };
  });
  writeSync = vi.fn((name: string, body: object, expected: string | null): WriteResult => {
    const f = this.files.get(name);
    if ((f ? String(f.version) : null) !== expected) throw new ConflictError('moved');
    const version = (f?.version ?? 0) + 1;
    this.files.set(name, { body: structuredClone(body), version });
    return { version: String(version) };
  });
  revision(name: string) { return this.files.has(name) ? String(this.files.get(name)!.version) : null; }
}

/** `open` undefined: the host leaves the member out, as the iPhone's do. */
function host(sync: DeviceStore, state: { fence: string | null; open?: boolean }, omit = false): RecordHost {
  return {
    store: new MemoryAdapter(), deviceId: () => 'laptop', clock: { now: () => (clock += 1) },
    timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
    clearOffFileData: () => {},
    tier: 'device', sync, clearNamedFiles: () => {}, eraseFence: () => state.fence,
    ...(omit ? {} : { deviceFilesOpen: () => state.open !== false }),
  } as RecordHost;
}

const exchange = (s: ChatSession, id: string, text = 'synthetic question') =>
  s.recordExchange({ conversationId: id, isNew: true, userText: text, assistantText: 'synthetic answer' });

/** Another page saves a conversation to the device's file. */
async function otherPageSaves(sync: DeviceStore, id: string) {
  await exchange(await ChatSession.open(host(sync, { fence: 'g2' }, true)), id);
}

const ids = (s: ChatSession) => s.listConversations().map((c) => c.id).sort();

describe('US-09 AC2c: a page that may not write this device\'s chat file does not read it', () => {
  it.each([
    { name: 'closed', open: false, reads: false, shows: [] as string[] },
    { name: 'open', open: true, reads: true, shows: ['other'] },
  ])('when the erase fence moves on a $name page, it reads the file: $reads', async ({ open, reads, shows }) => {
    const sync = new DeviceStore();
    const state = { fence: 'g1', open: true };
    const page = await ChatSession.open(host(sync, state));
    await exchange(page, 'mine');
    state.fence = 'g2';
    state.open = open;
    sync.files.clear();
    await otherPageSaves(sync, 'other');
    sync.readSync.mockClear();
    expect(ids(page)).toEqual(shows);
    expect(sync.readSync.mock.calls.length > 0).toBe(reads);
  });

  it('a page that becomes closed after a re-read drops what it re-read and reads no more', async () => {
    const sync = new DeviceStore();
    const state = { fence: 'g1', open: true };
    const page = await ChatSession.open(host(sync, state));
    state.fence = 'g2';
    await otherPageSaves(sync, 'other');
    expect(ids(page)).toEqual(['other']); // re-read while open
    state.open = false;
    sync.readSync.mockClear();
    expect(ids(page)).toEqual([]);
    expect(page.getMessages('other')).toEqual([]);
    expect(sync.readSync).not.toHaveBeenCalled();
    await otherPageSaves(sync, 'later');
    state.fence = 'g3';
    sync.readSync.mockClear();
    expect(ids(page)).toEqual([]);
    expect(sync.readSync).not.toHaveBeenCalled();
  });

  it('a closed page keeps the turn it makes in its own list, and neither reads nor writes the file for it', async () => {
    const sync = new DeviceStore();
    await otherPageSaves(sync, 'other');
    const state = { fence: 'g2', open: true };
    const page = await ChatSession.open(host(sync, state));
    state.open = false;
    sync.readSync.mockClear();
    sync.writeSync.mockClear();
    await expect(exchange(page, 'now', 'synthetic follow-up')).resolves.toBeUndefined();
    expect(ids(page)).toEqual(['now']);
    expect(page.getMessages('now').map((m) => m.role)).toEqual(['user', 'assistant']);
    await expect(page.deleteConversation('now')).resolves.toBeUndefined();
    await expect(page.eraseAll()).resolves.toBeUndefined();
    expect(sync.readSync).not.toHaveBeenCalled();
    expect(sync.writeSync).not.toHaveBeenCalled();
    expect(sync.files.get('chat-history.json')!.version).toBe(1); // the other page's save, untouched
  });

  it('a page closed at open starts empty and reads nothing', async () => {
    const sync = new DeviceStore();
    await otherPageSaves(sync, 'other');
    sync.readSync.mockClear();
    const page = await ChatSession.open(host(sync, { fence: 'g2', open: false }));
    expect(ids(page)).toEqual([]);
    expect(sync.readSync).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'leaves the member out', omit: true },
    { name: 'stays open', omit: false },
  ])('a page whose host $name opens, refreshes and saves through the file', async ({ omit }) => {
    const sync = new DeviceStore();
    await otherPageSaves(sync, 'other');
    const state = { fence: 'g2', open: true };
    const page = await ChatSession.open(host(sync, state, omit));
    expect(ids(page)).toEqual(['other']);
    await exchange(page, 'mine');
    state.fence = 'g3';
    await otherPageSaves(sync, 'later');
    expect(ids(page)).toEqual(['later', 'mine', 'other']);
    expect(sync.writeSync).toHaveBeenCalled();
    const stored = sync.files.get('chat-history.json')!.body as { conversations: Array<{ id: string }> };
    expect(stored.conversations.map((c) => c.id).sort()).toEqual(['later', 'mine', 'other']);
  });
});
