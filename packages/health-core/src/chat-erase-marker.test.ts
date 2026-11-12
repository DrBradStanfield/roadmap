/**
 * The erase marker in chat-history.json (US-11 AC2h): an erase adds a
 * content-free tombstone with an `erase:` id, and a reply that starts a
 * conversation is saved only if the stored file holds no marker that was not
 * there when its question was asked. Older copies keep the marker: it is an
 * ordinary tombstone to them.
 */
import { describe, expect, it } from 'vitest';
import { ChatSession } from './chat-session';
import { ConflictError } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { mergeChatHistoryFiles, migrateChatHistoryFile, type ChatHistoryFile } from './chat-history';
import type { RecordHost, SyncStorage } from './record-host';
import type { ReadResult, WriteResult } from './adapter';

let clock = Date.parse('2026-11-12T10:00:00.000Z');
const base = (store: MemoryAdapter) => ({
  store, deviceId: () => 'phone', clock: { now: () => (clock += 1) },
  timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
  clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {},
});
const cloudHost = (store: MemoryAdapter) => ({
  ...base(store), tier: 'cloud',
  mirror: { adapter: new MemoryAdapter(), pending: { get: () => false, set: () => {}, clear: () => {} }, writesStopped: () => false, wipe: async () => {}, opened: () => {} },
}) as RecordHost;

class DeviceStore implements SyncStorage {
  files = new Map<string, { body: unknown; version: number }>();
  readSync(name: string): ReadResult {
    const f = this.files.get(name);
    return f ? { body: structuredClone(f.body), version: String(f.version) } : { body: null, version: null };
  }
  writeSync(name: string, body: object, expected: string | null): WriteResult {
    const f = this.files.get(name);
    if ((f ? String(f.version) : null) !== expected) throw new ConflictError('moved');
    const version = (f?.version ?? 0) + 1;
    this.files.set(name, { body: structuredClone(body), version });
    return { version: String(version) };
  }
  revision(name: string) { return this.files.has(name) ? String(this.files.get(name)!.version) : null; }
}
const deviceHost = (sync: DeviceStore) => ({
  ...base(new MemoryAdapter()), tier: 'device', sync, clearNamedFiles: () => {}, eraseFence: () => null,
}) as RecordHost;

type Stored = { conversations: Array<{ id: string; deleted?: boolean; title: string; messages: unknown[] }> };
const storedOf = (cloud: MemoryCloud) => JSON.parse(cloud.files.get('chat-history.json')!.json) as Stored;
const marksIn = (file: Stored) => file.conversations.filter((c) => c.id.startsWith('erase:'));
const liveIn = (file: Stored) => file.conversations.filter((c) => !c.deleted).map((c) => c.id);
const open = (cloud: MemoryCloud) => ChatSession.open(cloudHost(new MemoryAdapter(cloud)));
const ask = (s: ChatSession, id: string, askedMarks?: readonly string[], isNew = true) =>
  s.recordExchange({ conversationId: id, isNew, userText: `question ${id}`, assistantText: 'ok', askedMarks });

describe('US-11 AC2h: an erase writes a marker in its verified save', () => {
  it('adds one content-free, deleted marker beside the tombstones', async () => {
    const cloud = new MemoryCloud();
    const s = await open(cloud);
    await ask(s, 'c1');
    await s.eraseAll();
    const marks = marksIn(storedOf(cloud));
    expect(marks).toHaveLength(1);
    expect(marks[0]).toEqual({ id: expect.stringMatching(/^erase:[0-9a-f-]{36}$/), title: '', createdAt: expect.any(String), updatedAt: expect.any(String), deleted: true, messages: [] });
    expect(s.eraseMarks()).toEqual([marks[0].id]);
    expect(s.listConversations()).toEqual([]);
  });

  it('writes the marker when nothing else is stored', async () => {
    const cloud = new MemoryCloud();
    const s = await open(cloud);
    await s.eraseAll();
    expect(marksIn(storedOf(cloud))).toHaveLength(1);
    expect((await open(cloud)).eraseMarks()).toEqual(s.eraseMarks());
  });

  it('a second erase adds a second marker; both stay', async () => {
    const cloud = new MemoryCloud();
    await (await open(cloud)).eraseAll();
    await (await open(cloud)).eraseAll();
    expect(marksIn(storedOf(cloud))).toHaveLength(2);
    expect((await open(cloud)).eraseMarks()).toHaveLength(2);
  });

  it('the marker is written again when another writer replaced the erase', async () => {
    class OverwrittenOnce extends MemoryAdapter {
      stale: object | null = null;
      async write(name: string, body: object, expected: string | null, signal?: AbortSignal) {
        const result = await super.write(name, body, expected, signal);
        if (!this.stale) return result;
        const stale = this.stale;
        this.stale = null;
        return super.write(name, stale, result.version);
      }
    }
    const store = new OverwrittenOnce();
    const s = await ChatSession.open(cloudHost(store));
    await ask(s, 'c1');
    const before = (await store.read('chat-history.json')).body as { meta: { lamport: number } };
    store.stale = { ...before, meta: { ...before.meta, lamport: before.meta.lamport + 10 } };
    await s.eraseAll();
    const stored = (await store.read('chat-history.json')).body as Stored;
    expect(marksIn(stored)).toHaveLength(1);
    expect(liveIn(stored)).toEqual([]);
  });

  it('the device tier writes no marker: its erase removes the file', async () => {
    const sync = new DeviceStore();
    const s = await ChatSession.open(deviceHost(sync));
    await ask(s, 'c1');
    await s.eraseAll();
    expect(marksIn(sync.readSync('chat-history.json').body as Stored)).toEqual([]);
  });
});

describe('US-11 AC2i: an erase tombstones every conversation in the file it writes', () => {
  /** The next armed read answers with what the file held when it was asked, after `during` runs. */
  class HoldNextRead extends MemoryAdapter {
    during: (() => Promise<void>) | null = null;
    async read(name: string, signal?: AbortSignal) {
      const answer = await super.read(name, signal);
      const during = this.during;
      this.during = null;
      if (during) await during();
      return answer;
    }
  }

  it('a conversation another device saves between the erase read and its write is erased', async () => {
    const cloud = new MemoryCloud();
    const store = new HoldNextRead(cloud);
    const a = await ChatSession.open(cloudHost(store));
    const b = await open(cloud);
    store.during = () => ask(b, 'from-b');
    await a.eraseAll();
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect(cloud.files.get('chat-history.json')!.json).not.toMatch(/question from-b/);
    expect((await open(cloud)).listConversations()).toEqual([]);
  });

  it('a conversation that lands over the erase write is erased by its retry', async () => {
    // Drive: the erase writes, then another device's upload, read before it, lands on top.
    class OverwrittenBy extends MemoryAdapter {
      after: (() => Promise<void>) | null = null;
      async write(name: string, body: object, expected: string | null, signal?: AbortSignal) {
        const result = await super.write(name, body, expected, signal);
        const after = this.after;
        this.after = null;
        if (after) await after();
        return result;
      }
    }
    const cloud = new MemoryCloud();
    const store = new OverwrittenBy(cloud);
    const a = await ChatSession.open(cloudHost(store));
    await ask(a, 'mine');
    const b = await open(cloud);
    const staleB = structuredClone(storedOf(cloud)) as unknown as ChatHistoryFile;
    store.after = async () => {
      await ask(b, 'from-b'); // b's save merges a's erase in, so put a pre-erase copy with b's conversation on top
      const now = storedOf(cloud) as unknown as ChatHistoryFile;
      const fromB = now.conversations.find((c) => c.id === 'from-b')!;
      const over = { ...staleB, meta: { ...staleB.meta, lamport: 999 }, conversations: [...staleB.conversations, fromB] };
      const version = cloud.files.get('chat-history.json')!.version;
      await new MemoryAdapter(cloud).write('chat-history.json', over, String(version));
    };
    await a.eraseAll();
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect((await open(cloud)).listConversations()).toEqual([]);
  });
});

describe('US-11 AC2h: a new conversation is saved only under the erase marks it was asked under', () => {
  it('is not saved when an erase wrote a marker after the question was asked', async () => {
    const cloud = new MemoryCloud();
    const b = await open(cloud);
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll(); // another device
    await ask(b, 'late', asked);
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect(cloud.files.get('chat-history.json')!.json).not.toMatch(/question late/);
    expect(b.listConversations()).toEqual([]);
    expect((await open(cloud)).listConversations()).toEqual([]);
    await ask(b, 'late', asked, false); // a follow-up on the refused conversation
    expect(liveIn(storedOf(cloud))).toEqual([]);
  });

  it('is saved when no erase came after the question', async () => {
    const cloud = new MemoryCloud();
    await (await open(cloud)).eraseAll(); // an older erase, read before the question
    const b = await open(cloud);
    await ask(b, 'fresh', b.eraseMarks());
    expect(liveIn(storedOf(cloud))).toEqual(['fresh']);
    expect(b.listConversations().map((c) => c.id)).toEqual(['fresh']);
  });

  it('is saved when no marks are given (a caller that does not ask under marks)', async () => {
    const cloud = new MemoryCloud();
    const b = await open(cloud);
    await (await open(cloud)).eraseAll();
    await ask(b, 'plain');
    expect(liveIn(storedOf(cloud))).toEqual(['plain']);
  });

  it('a follow-up in a conversation saved before the erase stays erased', async () => {
    const cloud = new MemoryCloud();
    const b = await open(cloud);
    await ask(b, 'c1', b.eraseMarks());
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll();
    await ask(b, 'c1', asked, false);
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect(cloud.files.get('chat-history.json')!.json).not.toMatch(/question c1/);
  });

  it('a follow-up with no erase in between is saved', async () => {
    const cloud = new MemoryCloud();
    const b = await open(cloud);
    await ask(b, 'c1', b.eraseMarks());
    await ask(b, 'c1', b.eraseMarks(), false);
    expect((await open(cloud)).getMessages('c1')).toHaveLength(4);
  });

  it('the check runs again when the save retries after a conflict', async () => {
    class ConflictOnce extends MemoryAdapter {
      before: (() => Promise<void>) | null = null;
      async write(name: string, body: object, expected: string | null, signal?: AbortSignal) {
        const before = this.before;
        this.before = null;
        if (before) { await before(); throw new ConflictError('moved'); }
        return super.write(name, body, expected, signal);
      }
    }
    const cloud = new MemoryCloud();
    const store = new ConflictOnce(cloud);
    const b = await ChatSession.open(cloudHost(store));
    const asked = b.eraseMarks();
    store.before = async () => { await (await open(cloud)).eraseAll(); };
    await ask(b, 'raced', asked);
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect(b.listConversations()).toEqual([]);
  });

  it('a refused conversation is not sent by a later save, even when its own save failed', async () => {
    class FailAfterRead extends MemoryAdapter {
      fail = false;
      async write(name: string, body: object, expected: string | null, signal?: AbortSignal) {
        if (this.fail) { this.fail = false; throw new Error('upload failed'); }
        return super.write(name, body, expected, signal);
      }
    }
    const cloud = new MemoryCloud();
    const store = new FailAfterRead(cloud);
    const b = await ChatSession.open(cloudHost(store));
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll();
    store.fail = true;
    await expect(ask(b, 'late', asked)).rejects.toThrow('upload failed');
    await ask(b, 'next'); // a save asked under no marks
    expect(liveIn(storedOf(cloud))).toEqual(['next']);
    expect(cloud.files.get('chat-history.json')!.json).not.toMatch(/question late/);
  });

  it('device tier: the same check runs in its read-merge-write', async () => {
    const sync = new DeviceStore();
    const b = await ChatSession.open(deviceHost(sync));
    const asked = b.eraseMarks();
    const at = '2026-11-12T09:00:00.000Z';
    sync.writeSync('chat-history.json', {
      schemaVersion: 1, meta: { createdAt: at, updatedAt: at, lastDeviceId: 'web', lamport: 1 },
      conversations: [{ id: 'erase:00000000-0000-4000-8000-000000000001', title: '', createdAt: at, updatedAt: at, deleted: true, messages: [] }],
    }, null);
    await ask(b, 'late', asked);
    expect(liveIn(sync.readSync('chat-history.json').body as Stored)).toEqual([]);
    expect(b.listConversations()).toEqual([]);
  });
});

describe('US-11 AC2h: a refused conversation stays refused in every later save', () => {
  /** Reads and writes that fail while armed; `during` runs inside the next read. */
  class Flaky extends MemoryAdapter {
    failReads = 0;
    failWrites = 0;
    during: (() => void) | null = null;
    async read(name: string, signal?: AbortSignal) {
      if (this.failReads > 0) { this.failReads--; throw new Error('read failed'); }
      const answer = await super.read(name, signal);
      const during = this.during;
      this.during = null;
      during?.();
      return answer;
    }
    async write(name: string, body: object, expected: string | null, signal?: AbortSignal) {
      if (this.failWrites > 0) { this.failWrites--; throw new Error('upload failed'); }
      return super.write(name, body, expected, signal);
    }
  }

  it('its save failed on the read: a follow-up save does not send it', async () => {
    const cloud = new MemoryCloud();
    const store = new Flaky(cloud);
    const b = await ChatSession.open(cloudHost(store));
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll();
    store.failReads = 1;
    await expect(ask(b, 'late', asked)).rejects.toThrow('read failed');
    await ask(b, 'late', undefined, false); // a follow-up asked under no marks
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect(cloud.files.get('chat-history.json')!.json).not.toMatch(/question late/);
    expect(b.listConversations()).toEqual([]);
  });

  it('its save failed on the read: another conversation\'s save does not send it', async () => {
    const cloud = new MemoryCloud();
    const store = new Flaky(cloud);
    const b = await ChatSession.open(cloudHost(store));
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll();
    store.failReads = 1;
    await expect(ask(b, 'late', asked)).rejects.toThrow('read failed');
    await ask(b, 'next'); // a save asked under no marks
    expect(liveIn(storedOf(cloud))).toEqual(['next']);
  });

  it('a save already on its way when it is asked does not send it', async () => {
    const cloud = new MemoryCloud();
    const store = new Flaky(cloud);
    const b = await ChatSession.open(cloudHost(store));
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll();
    let late: Promise<void> | null = null;
    store.during = () => {
      late = ask(b, 'late', asked); // lands in this copy while the other save reads
      store.failReads = 1; // and its own save never reads
    };
    await ask(b, 'other');
    await expect(late!).rejects.toThrow('read failed');
    expect(liveIn(storedOf(cloud))).toEqual(['other']);
    expect(cloud.files.get('chat-history.json')!.json).not.toMatch(/question late/);
  });

  it('a follow-up in a thread the file does not hold is refused under a new mark', async () => {
    // The website chat: a server thread this copy has not saved (isNew false).
    const cloud = new MemoryCloud();
    const b = await open(cloud);
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll();
    await ask(b, 'server-thread', asked, false);
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect(b.listConversations()).toEqual([]);
  });

  it('a follow-up in a thread the file does not hold is saved with no new mark', async () => {
    const cloud = new MemoryCloud();
    await (await open(cloud)).eraseAll();
    const b = await open(cloud);
    await ask(b, 'server-thread', b.eraseMarks(), false);
    expect(liveIn(storedOf(cloud))).toEqual(['server-thread']);
    expect(b.listConversations()).toMatchObject([{ id: 'server-thread', title: 'Chat' }]);
  });

  it('the refusing save brings the mark in, so the next new conversation is saved', async () => {
    const cloud = new MemoryCloud();
    const b = await open(cloud);
    const asked = b.eraseMarks();
    await (await open(cloud)).eraseAll();
    const mark = marksIn(storedOf(cloud))[0].id;
    await ask(b, 'late', asked);
    expect(b.eraseMarks()).toEqual([mark]);
    await ask(b, 'next', b.eraseMarks());
    expect(liveIn(storedOf(cloud))).toEqual(['next']);
  });

  it('a refused conversation takes no place under the cap', async () => {
    const cloud = new MemoryCloud();
    const b = await open(cloud);
    const asked = b.eraseMarks();
    const at = (i: number) => new Date(Date.parse('2026-11-12T09:00:00.000Z') + i * 1000).toISOString();
    const kept = Array.from({ length: 50 }, (_, i) => ({ id: `kept-${i}`, title: `t${i}`, createdAt: at(i), updatedAt: at(i), messages: [] }));
    const mark = { id: 'erase:00000000-0000-4000-8000-000000000002', title: '', createdAt: at(0), updatedAt: at(0), deleted: true, messages: [] };
    await new MemoryAdapter(cloud).write('chat-history.json', {
      schemaVersion: 1, meta: { createdAt: at(0), updatedAt: at(60), lastDeviceId: 'other', lamport: 5 }, conversations: [mark, ...kept],
    }, null);
    await ask(b, 'late', asked);
    expect(liveIn(storedOf(cloud)).sort()).toEqual(kept.map((c) => c.id).sort());
  });
});

describe('US-11 AC2i: an erase removes what the file holds when it is written', () => {
  it('a conversation only the erase\'s first write saw stays erased after an overwrite', async () => {
    // Device B saves "from-b" after the erase read the file; the erase's write
    // tombstones it; a stale copy without it lands on top (Drive). The retry
    // writes the tombstone again, so B, still holding it live, cannot bring it back.
    class Raced extends MemoryAdapter {
      reads = 0;
      beforeSecondRead: (() => Promise<void>) | null = null;
      onWrite: (() => Promise<void>) | null = null;
      async read(name: string, signal?: AbortSignal) {
        const hook = this.reads++ === 1 ? this.beforeSecondRead : null;
        if (hook) { this.beforeSecondRead = null; await hook(); }
        return super.read(name, signal);
      }
      async write(name: string, body: object, expected: string | null, signal?: AbortSignal) {
        const result = await super.write(name, body, expected, signal);
        const hook = this.onWrite;
        this.onWrite = null;
        if (hook) await hook();
        return result;
      }
    }
    const cloud = new MemoryCloud();
    const store = new Raced(cloud);
    const a = await ChatSession.open(cloudHost(store));
    await ask(a, 'mine');
    const b = await open(cloud);
    const stale = structuredClone(storedOf(cloud)) as unknown as ChatHistoryFile;
    store.reads = 0;
    store.beforeSecondRead = () => ask(b, 'from-b'); // after the erase read, before its save reads
    store.onWrite = async () => {
      const version = cloud.files.get('chat-history.json')!.version;
      await new MemoryAdapter(cloud).write('chat-history.json', { ...stale, meta: { ...stale.meta, lamport: 999 } }, String(version));
    };
    await a.eraseAll();
    expect(liveIn(storedOf(cloud))).toEqual([]);
    await ask(b, 'from-b', undefined, false); // B, still holding it live, saves again
    expect(liveIn(storedOf(cloud))).toEqual([]);
    expect((await open(cloud)).listConversations()).toEqual([]);
  });
});

describe('US-11 AC2h: every reader and merge keeps the marker, deleted', () => {
  const ctx = { deviceId: 'd', now: '2026-11-12T11:00:00.000Z' };
  const at = '2026-11-12T09:00:00.000Z';
  const marker = { id: 'erase:00000000-0000-4000-8000-000000000001', title: '', createdAt: at, updatedAt: at, deleted: true, messages: [] };
  const live = { id: 'c1', title: 'kept words', createdAt: at, updatedAt: at, messages: [{ id: 'u-1', role: 'user', content: 'q', createdAt: at }] };
  const withMarker = migrateChatHistoryFile({ schemaVersion: 1, meta: { createdAt: at, updatedAt: at, lastDeviceId: 'new', lamport: 3 }, conversations: [marker] }, ctx);
  // An older client's copy: written before the erase, so it has no marker but a higher clock.
  const older = migrateChatHistoryFile({ schemaVersion: 1, meta: { createdAt: at, updatedAt: at, lastDeviceId: 'old', lamport: 9 }, conversations: [live] }, ctx);

  it('migrate reads it unchanged', () => {
    expect(withMarker.conversations).toEqual([marker]);
  });

  for (const [name, local, remote] of [['older copy as local', older, withMarker], ['older copy as remote', withMarker, older]] as const) {
    it(`merge keeps it deleted and empty (${name})`, () => {
      const merged = mergeChatHistoryFiles(local, remote, ctx);
      expect(merged.conversations.find((c) => c.id === marker.id)).toEqual(marker);
      expect(merged.conversations.find((c) => c.id === 'c1')?.deleted).toBeUndefined();
    });
  }

  it('an older copy holding the marker id live cannot bring it back', () => {
    const revived = migrateChatHistoryFile({ ...older, conversations: [{ ...marker, deleted: false, title: 'x', updatedAt: ctx.now, messages: live.messages }] }, ctx);
    const merged = mergeChatHistoryFiles(revived, withMarker, ctx);
    expect(merged.conversations.find((c) => c.id === marker.id)).toMatchObject({ deleted: true, title: '', messages: [] });
  });

  it('the session lists and reads nothing for it', async () => {
    const cloud = new MemoryCloud();
    await new MemoryAdapter(cloud).write('chat-history.json', mergeChatHistoryFiles(older, withMarker, ctx), null);
    const s = await open(cloud);
    expect(s.listConversations().map((c) => c.id)).toEqual(['c1']);
    expect(s.getMessages(marker.id)).toEqual([]);
    expect(s.eraseMarks()).toEqual([marker.id]);
  });
});

describe('US-11 AC2h: a device erase ends the checks for the conversations it removed', () => {
  it('a conversation whose save failed is no longer pending once a device erase removes it', async () => {
    class RefusingStore extends DeviceStore {
      refuse = false;
      writeSync(name: string, body: object, expected: string | null): WriteResult {
        if (this.refuse) throw new Error('write refused');
        return super.writeSync(name, body, expected);
      }
    }
    const sync = new RefusingStore();
    const fence = { now: null as string | null };
    const b = await ChatSession.open({ ...deviceHost(sync), eraseFence: () => fence.now } as RecordHost);
    const pending = () => [...(b as unknown as { pending: Map<string, unknown> }).pending.keys()];
    sync.refuse = true;
    await expect(ask(b, 'late', b.eraseMarks())).rejects.toThrow('write refused');
    expect(pending()).toEqual(['late']);
    sync.refuse = false;
    sync.files.clear(); // the device erase removes the file
    fence.now = 'erased-1';
    expect(b.listConversations()).toEqual([]);
    expect(pending()).toEqual([]);
  });
});
