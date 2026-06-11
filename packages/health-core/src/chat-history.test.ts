import { describe, expect, it } from 'vitest';
import {
  CHAT_HISTORY_SCHEMA_VERSION,
  createEmptyChatHistoryFile,
  mergeChatHistoryFiles,
  migrateChatHistoryFile,
  type ChatFileConversation,
  type ChatHistoryFile,
} from './chat-history';
import { SchemaTooNewError } from './migrate';

const OPTS = { deviceId: 'dev1', now: '2026-06-11T00:00:00Z' };

function conv(partial: Partial<ChatFileConversation> & { id: string }): ChatFileConversation {
  return {
    title: 'Chat',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    messages: [],
    ...partial,
  };
}

function fileWith(conversations: ChatFileConversation[], lamport = 0): ChatHistoryFile {
  return {
    schemaVersion: CHAT_HISTORY_SCHEMA_VERSION,
    meta: { createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', lastDeviceId: 'dev0', lamport },
    conversations,
  };
}

describe('migrateChatHistoryFile', () => {
  it('turns null/garbage into a fresh empty file', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      const f = migrateChatHistoryFile(raw, OPTS);
      expect(f.schemaVersion).toBe(CHAT_HISTORY_SCHEMA_VERSION);
      expect(f.conversations).toEqual([]);
      expect(f.meta.lamport).toBe(0);
      expect(f.meta.lastDeviceId).toBe('dev1');
    }
  });

  it('throws SchemaTooNewError for a file from a newer app', () => {
    expect(() => migrateChatHistoryFile({ schemaVersion: 99 }, OPTS)).toThrow(SchemaTooNewError);
  });

  it('fills defaults and drops id-less conversations', () => {
    const f = migrateChatHistoryFile(
      { conversations: [{ id: 'c1' }, { title: 'no id' }, 'garbage'] },
      OPTS,
    );
    expect(f.conversations).toHaveLength(1);
    expect(f.conversations[0]).toMatchObject({ id: 'c1', title: '', messages: [] });
  });

  it('preserves unknown top-level fields (H7 round-trip)', () => {
    const f = migrateChatHistoryFile({ conversations: [], futureField: { a: 1 } }, OPTS);
    expect((f as unknown as Record<string, unknown>).futureField).toEqual({ a: 1 });
  });
});

describe('mergeChatHistoryFiles', () => {
  it('unions conversations by id', () => {
    const merged = mergeChatHistoryFiles(
      fileWith([conv({ id: 'a' })]),
      fileWith([conv({ id: 'b' })]),
      OPTS,
    );
    expect(merged.conversations.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('unions messages by id, ordered by createdAt', () => {
    const m1 = { id: 'm1', role: 'user' as const, content: 'hi', createdAt: '2026-06-01T10:00:00Z' };
    const m2 = { id: 'm2', role: 'assistant' as const, content: 'hello', createdAt: '2026-06-01T10:00:05Z' };
    const m3 = { id: 'm3', role: 'user' as const, content: 'more', createdAt: '2026-06-01T10:01:00Z' };
    const merged = mergeChatHistoryFiles(
      fileWith([conv({ id: 'a', messages: [m1, m3], updatedAt: '2026-06-01T10:01:00Z' })]),
      fileWith([conv({ id: 'a', messages: [m1, m2], updatedAt: '2026-06-01T10:00:05Z' })]),
      OPTS,
    );
    expect(merged.conversations[0].messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('deleted is a monotonic tombstone and clears messages', () => {
    const msg = { id: 'm1', role: 'user' as const, content: 'hi', createdAt: '2026-06-01T10:00:00Z' };
    const deletedSide = fileWith([conv({ id: 'a', deleted: true, messages: [] })]);
    const liveSide = fileWith([conv({ id: 'a', messages: [msg], updatedAt: '2026-06-02T00:00:00Z' })]);
    for (const [l, r] of [
      [deletedSide, liveSide],
      [liveSide, deletedSide],
    ]) {
      const merged = mergeChatHistoryFiles(l, r, OPTS);
      expect(merged.conversations[0].deleted).toBe(true);
      expect(merged.conversations[0].messages).toEqual([]);
    }
  });

  it("takes the newer side's title", () => {
    const merged = mergeChatHistoryFiles(
      fileWith([conv({ id: 'a', title: 'Old', updatedAt: '2026-06-01T00:00:00Z' })]),
      fileWith([conv({ id: 'a', title: 'New', updatedAt: '2026-06-02T00:00:00Z' })]),
      OPTS,
    );
    expect(merged.conversations[0].title).toBe('New');
    expect(merged.conversations[0].updatedAt).toBe('2026-06-02T00:00:00Z');
  });

  it('advances the lamport clock past both sides and stamps the merge author', () => {
    const merged = mergeChatHistoryFiles(fileWith([], 3), fileWith([], 7), OPTS);
    expect(merged.meta.lamport).toBe(8);
    expect(merged.meta.lastDeviceId).toBe('dev1');
    expect(merged.meta.updatedAt).toBe(OPTS.now);
  });

  it('is symmetric on conversation content', () => {
    const a = fileWith([conv({ id: 'a', title: 'A' }), conv({ id: 'shared', deleted: true })]);
    const b = fileWith([conv({ id: 'b', title: 'B' }), conv({ id: 'shared', updatedAt: '2026-06-03T00:00:00Z' })]);
    const ab = mergeChatHistoryFiles(a, b, OPTS);
    const ba = mergeChatHistoryFiles(b, a, OPTS);
    expect(ab.conversations).toEqual(ba.conversations);
  });

  it('two devices converge: same merged file regardless of sync order', () => {
    // dev1 and dev2 both start from an empty cloud, write locally, then sync.
    const base = createEmptyChatHistoryFile(OPTS);
    const dev1 = {
      ...base,
      conversations: [conv({ id: 'c1', messages: [{ id: 'm1', role: 'user' as const, content: 'from dev1', createdAt: '2026-06-01T09:00:00Z' }] })],
    };
    const dev2 = {
      ...base,
      conversations: [conv({ id: 'c2', messages: [{ id: 'm2', role: 'user' as const, content: 'from dev2', createdAt: '2026-06-01T09:30:00Z' }] })],
    };
    const cloudAfterDev1 = mergeChatHistoryFiles(dev1, base, OPTS);
    const cloudAfterBoth = mergeChatHistoryFiles(dev2, cloudAfterDev1, OPTS);
    expect(cloudAfterBoth.conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(cloudAfterBoth.conversations.flatMap((c) => c.messages).map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
