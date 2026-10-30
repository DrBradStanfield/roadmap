/**
 * The chat history session in the engine (US-11 AC2, AC2b, AC3b; US-15
 * AC14), over a cloud host and a device host with an erase fence. The
 * widget's chat-history tests pin the same rules through the web host.
 */
import { describe, expect, it } from 'vitest';
import { ChatSession } from './chat-session';
import { ConflictError, type ReadResult, type WriteResult } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import type { RecordHost, SyncStorage } from './record-host';

let clock = Date.parse('2026-10-21T10:00:00.000Z');
const base = (store: MemoryAdapter) => ({
  store, deviceId: () => 'phone', clock: { now: () => (clock += 1) },
  timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'other', report: () => {},
  clearOffFileData: () => {},
});
const cloudHost = (store: MemoryAdapter) => ({
  ...base(store), tier: 'cloud',
  mirror: { adapter: new MemoryAdapter(), pending: { get: () => false, set: () => {}, clear: () => {} }, writesStopped: () => false, wipe: async () => {}, opened: () => {} },
}) as RecordHost;

/** A synchronous device store, as localStorage is on the web. */
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
const deviceHost = (sync: DeviceStore, fence: { value: string | null }) => ({
  ...base(new MemoryAdapter()), tier: 'device', sync, clearNamedFiles: () => {}, eraseFence: () => fence.value,
}) as RecordHost;

const exchange = (s: ChatSession, id: string, text = 'hello') =>
  s.recordExchange({ conversationId: id, isNew: true, userText: text, assistantText: 'ok' });

describe('ChatSession on a cloud', () => {
  it('saves an exchange, titles it from the first message, and reads it back', async () => {
    const cloud = new MemoryCloud();
    const s = await ChatSession.open(cloudHost(new MemoryAdapter(cloud)));
    await exchange(s, 'c1', 'my ldl is 3.2');
    const again = await ChatSession.open(cloudHost(new MemoryAdapter(cloud)));
    expect(again.listConversations().map((c) => [c.id, c.title])).toEqual([['c1', 'my ldl is 3.2']]);
    expect(again.getMessages('c1').map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('keeps a delete made while an earlier save was in the air (US-11 AC2b)', async () => {
    class SlowFirst extends MemoryAdapter {
      held = true;
      release!: () => void;
      gate = new Promise<void>((r) => { this.release = r; });
      async write(name: string, body: object, expected: string | null) {
        const result = await super.write(name, body, expected);
        if (this.held) { this.held = false; await this.gate; }
        return result;
      }
    }
    const store = new SlowFirst();
    const s = await ChatSession.open(cloudHost(store));
    const first = exchange(s, 'c1');
    await new Promise((r) => setTimeout(r, 0));
    await exchange(s, 'c2');
    await s.deleteConversation('c1');
    store.release();
    await first;
    expect(s.listConversations().map((c) => c.id)).toEqual(['c2']);
  });

  it('eraseAll tombstones every conversation, titles and messages blanked (US-11 AC2)', async () => {
    const cloud = new MemoryCloud();
    const s = await ChatSession.open(cloudHost(new MemoryAdapter(cloud)));
    await exchange(s, 'c1', 'private words');
    await s.eraseAll();
    const file = JSON.parse(cloud.files.get('chat-history.json')!.json);
    expect(file.conversations).toEqual([expect.objectContaining({ id: 'c1', deleted: true, title: '', messages: [] })]);
  });
});

describe('ChatSession on the device tier', () => {
  it('drops its pre-erase copy when the erase fence moves, and never writes those conversations back (US-11 AC3b)', async () => {
    const sync = new DeviceStore();
    const fence = { value: 'g1' };
    const stale = await ChatSession.open(deviceHost(sync, fence));
    await exchange(stale, 'old', 'before the erase');
    // The erase: the named files go and the fence moves.
    sync.files.clear();
    fence.value = 'g2';
    expect(stale.listConversations()).toEqual([]);
    await exchange(stale, 'old', 'late answer'); // an answer for an erased conversation
    await exchange(stale, 'fresh', 'after the erase');
    expect(stale.listConversations().map((c) => c.id)).toEqual(['fresh']);
    expect((sync.readSync('chat-history.json').body as { conversations: Array<{ id: string }> }).conversations.map((c) => c.id)).toEqual(['fresh']);
  });

  it('merges with what another page wrote, synchronously', async () => {
    const sync = new DeviceStore();
    const fence = { value: null };
    const a = await ChatSession.open(deviceHost(sync, fence));
    const b = await ChatSession.open(deviceHost(sync, fence));
    await exchange(a, 'a1');
    await exchange(b, 'b1');
    const c = await ChatSession.open(deviceHost(sync, fence));
    expect(c.listConversations().map((x) => x.id).sort()).toEqual(['a1', 'b1']);
  });
});

describe('US-52 AC6 / US-15 AC7: a saved conversation keeps each question above its answer', () => {
  it('reads question, answer, question, answer after a second exchange', async () => {
    const sync = new DeviceStore();
    const fence = { value: null };
    const s = await ChatSession.open(deviceHost(sync, fence));
    await s.recordExchange({ conversationId: 'c1', isNew: true, userText: 'q1', assistantText: 'a1' });
    await s.recordExchange({ conversationId: 'c1', isNew: false, userText: 'q2', assistantText: 'a2' });
    const again = await ChatSession.open(deviceHost(sync, fence));
    expect(again.getMessages('c1').map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });

  it('reads a file saved in the old answer-first order question first, before any new save', async () => {
    const sync = new DeviceStore();
    const at = '2026-10-21T08:00:00.000Z';
    sync.writeSync('chat-history.json', {
      schemaVersion: 1,
      meta: { createdAt: at, updatedAt: at, lastDeviceId: 'd', lamport: 1 },
      conversations: [{ id: 'old', title: 'q1', createdAt: at, updatedAt: at, messages: [
        { id: 'a-1', role: 'assistant', content: 'a1', createdAt: at },
        { id: 'u-1', role: 'user', content: 'q1', createdAt: at },
      ] }],
    }, null);
    const s = await ChatSession.open(deviceHost(sync, { value: null }));
    expect(s.getMessages('old').map((m) => m.content)).toEqual(['q1', 'a1']);
  });
});

describe('US-10 AC10: the 50-conversation cap evicts by the merged copy', () => {
  const seed = async (s: ChatSession) => { for (let i = 0; i < 50; i++) await exchange(s, `c${String(i).padStart(2, '0')}`); };
  const hosts = {
    cloud: () => { const cloud = new MemoryCloud(); return () => cloudHost(new MemoryAdapter(cloud)); },
    device: () => { const store = new DeviceStore(); const fence = { value: null }; return () => deviceHost(store, fence); },
  };

  for (const [tier, shared] of Object.entries(hosts)) {
    it(`${tier}: a conversation another page just continued survives this page's new one`, async () => {
      const host = shared();
      await seed(await ChatSession.open(host()));
      const laptop = await ChatSession.open(host()); // opened, then left open
      const phone = await ChatSession.open(host());
      await phone.recordExchange({ conversationId: 'c00', isNew: false, userText: 'a follow-up', assistantText: 'ok' });
      await exchange(laptop, 'new');
      const ids = (await ChatSession.open(host())).listConversations().map((c) => c.id);
      expect(ids).toHaveLength(50);
      expect(ids).toContain('c00');
      expect(ids).toContain('new');
      expect(ids).not.toContain('c01'); // the oldest by the merged copy goes
      expect(laptop.listConversations().map((c) => c.id)).toEqual(ids);
    });

    it(`${tier}: with no other page, a new conversation past 50 still evicts the oldest`, async () => {
      const host = shared();
      const s = await ChatSession.open(host());
      await seed(s);
      await exchange(s, 'new');
      const ids = (await ChatSession.open(host())).listConversations().map((c) => c.id);
      expect(ids).toHaveLength(50);
      expect(ids).not.toContain('c00');
      expect(s.listConversations().map((c) => c.id)).toEqual(ids);
    });

    it(`${tier}: continuing a conversation in a file already over 50 brings it back to 50`, async () => {
      const host = shared();
      const at = (i: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60_000).toISOString();
      const conversations = Array.from({ length: 51 }, (_, i) => ({
        id: `c${String(i).padStart(2, '0')}`, title: 't', createdAt: at(i), updatedAt: at(i),
        messages: [{ id: `m${i}`, role: 'user', content: 'q', createdAt: at(i) }],
      }));
      const raw = { schemaVersion: 1, meta: { createdAt: at(0), updatedAt: at(50), lastDeviceId: 'old', lamport: 1 }, conversations };
      const h = host(); // a file left over the cap (an older app, or two devices at once)
      if (h.tier === 'device') h.sync.writeSync('chat-history.json', raw, null);
      else await h.store.write('chat-history.json', raw, null);
      const s = await ChatSession.open(host());
      expect(s.listConversations()).toHaveLength(51);
      await s.recordExchange({ conversationId: 'c10', isNew: false, userText: 'a follow-up', assistantText: 'ok' });
      const ids = (await ChatSession.open(host())).listConversations().map((c) => c.id);
      expect(ids).toHaveLength(50);
      expect(ids[0]).toBe('c10');
      expect(ids).not.toContain('c00');
    });
  }
});

describe('US-10 AC10: conversations saved in the same millisecond keep their file order', () => {
  it('lists equal updatedAt in file order, and the cap evicts the later of them first', async () => {
    const at = (i: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60_000).toISOString();
    // c00..c49 at distinct times; t1 and t2 tie with each other at the oldest time.
    const row = (id: string, t: number) => ({ id, title: 't', createdAt: at(t), updatedAt: at(t), messages: [{ id: `m-${id}`, role: 'user', content: 'q', createdAt: at(t) }] });
    const conversations = [row('t1', 0), row('t2', 0), ...Array.from({ length: 49 }, (_, i) => row(`c${String(i + 1).padStart(2, '0')}`, i + 1))];
    const store = new DeviceStore();
    store.writeSync('chat-history.json', { schemaVersion: 1, meta: { createdAt: at(0), updatedAt: at(49), lastDeviceId: 'old', lamport: 1 }, conversations }, null);
    const host = () => deviceHost(store, { value: null });
    const s = await ChatSession.open(host());
    expect(s.listConversations().slice(-2).map((c) => c.id)).toEqual(['t1', 't2']);
    await s.recordExchange({ conversationId: 'c49', isNew: false, userText: 'again', assistantText: 'ok' });
    const ids = (await ChatSession.open(host())).listConversations().map((c) => c.id);
    expect(ids).toHaveLength(50);
    expect(ids.at(-1)).toBe('t1');
    expect(ids).not.toContain('t2');
  });
});

describe('US-11 AC2d: a chat delete is reported only once the stored file holds it', () => {
  /** Drive's gap: no conditional write, so a second writer that read before
   *  our upload can land right after it. The first armed write is followed by
   *  that writer's copy, taken before the delete, with the higher clock. */
  class OverwrittenOnce extends MemoryAdapter {
    stale: object | null = null;
    always = false;
    reads = 0;
    async read(name: string, signal?: AbortSignal) { this.reads++; return super.read(name, signal); }
    async write(name: string, body: object, expected: string | null, signal?: AbortSignal) {
      const result = await super.write(name, body, expected, signal);
      if (!this.stale) return result;
      const stale = this.stale;
      if (!this.always) this.stale = null;
      return super.write(name, stale, result.version);
    }
  }
  async function twoLive() {
    const store = new OverwrittenOnce();
    const s = await ChatSession.open(cloudHost(store));
    await exchange(s, 'c1', 'first question');
    await exchange(s, 'c2', 'second question');
    const before = (await store.read('chat-history.json')).body as { meta: { lamport: number } };
    store.stale = { ...before, meta: { ...before.meta, lamport: before.meta.lamport + 10 } };
    return { store, s };
  }

  it('eraseAll writes its tombstones again when another writer replaced them', async () => {
    const { store, s } = await twoLive();
    await s.eraseAll();
    expect((await ChatSession.open(cloudHost(store))).listConversations()).toEqual([]);
  });

  it('deleteConversation writes its tombstone again when another writer replaced it', async () => {
    const { store, s } = await twoLive();
    await s.deleteConversation('c1');
    expect((await ChatSession.open(cloudHost(store))).listConversations().map((c) => c.id)).toEqual(['c2']);
  });

  it('eraseAll fails, never reports success, when every write is replaced', async () => {
    const { store, s } = await twoLive();
    store.always = true;
    await expect(s.eraseAll()).rejects.toThrow();
  });

  it('an ordinary exchange still costs one read, no verify re-read', async () => {
    const store = new OverwrittenOnce();
    const s = await ChatSession.open(cloudHost(store));
    store.reads = 0;
    await exchange(s, 'c1');
    expect(store.reads).toBe(1);
  });
});
