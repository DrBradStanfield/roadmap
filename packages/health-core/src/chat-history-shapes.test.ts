import { describe, expect, it } from 'vitest';
import { createEmptyChatHistoryFile, migrateChatHistoryFile, mergeChatHistoryFiles } from './chat-history';

const opts = { deviceId: 'synthetic', now: '2026-06-15T12:00:00Z' };
const message = { id: 'local-message', role: 'user', content: '  Keep exact text 🧪\n', createdAt: '2025-01-15T03:00:00+02:00', future: { keep: true } };
const conversation = { id: 'local-conversation', title: 'synthetic', createdAt: opts.now, updatedAt: opts.now, future: 'keep', messages: [message] };

// US-15 AC7 / US-10 AC4: malformed cloud history cannot prevent saving valid turns.
describe('chat migration message contract', () => {
  const malformed = [null, [], 'text', {}, ...['', 42, null, {}, []].map((id) => ({ ...message, id })),
    ...['system', '', null].map((role) => ({ ...message, role })),
    ...[null, 42, {}].map((content) => ({ ...message, content })),
    ...[null, 42, {}].map((createdAt) => ({ ...message, createdAt })),
    ...['id', 'role', 'content', 'createdAt'].map((key) => Object.fromEntries(Object.entries(message).filter(([k]) => k !== key)))];
  for (const [index, bad] of malformed.entries()) {
    it(`ignores malformed message ${index}, preserves valid content and merges`, () => {
      const raw = { ...createEmptyChatHistoryFile(opts), conversations: [{ ...conversation, messages: [message, bad, { ...message, id: 'assistant', role: 'assistant', content: '', isFallback: true }] }] };
      const bytes = JSON.stringify(raw);
      const migrated = migrateChatHistoryFile(JSON.parse(bytes), opts);
      expect(() => mergeChatHistoryFiles(migrated, migrated, opts)).not.toThrow();
      const expected = [message, { ...message, id: 'assistant', role: 'assistant', content: '', isFallback: true }];
      expect(JSON.stringify(migrated.conversations[0].messages)).toBe(JSON.stringify(expected));
      expect(migrated.conversations[0]).toMatchObject({ future: 'keep' });
      expect(JSON.stringify(raw)).toBe(bytes);
    });
  }

  it('ignores malformed conversation IDs, retaining non-UUID IDs unchanged', () => {
    const raw = { ...createEmptyChatHistoryFile(opts), conversations: [conversation, ...['', 42, null].map((id) => ({ ...conversation, id }))] };
    expect(migrateChatHistoryFile(raw, opts).conversations).toEqual([conversation]);
  });

  it('keeps conversation tombstones sticky in both merge orders', () => {
    const live = migrateChatHistoryFile({ ...createEmptyChatHistoryFile(opts), conversations: [{ ...conversation, messages: [message, null] }] }, opts);
    const dead = migrateChatHistoryFile({ ...createEmptyChatHistoryFile(opts), conversations: [{ ...conversation, deleted: true, title: '', messages: [] }] }, opts);
    for (const [a, b] of [[live, dead], [dead, live]]) {
      expect(mergeChatHistoryFiles(a, b, opts).conversations).toEqual([{ ...conversation, deleted: true, title: '', messages: [] }]);
    }
  });
});
