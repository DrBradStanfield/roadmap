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
