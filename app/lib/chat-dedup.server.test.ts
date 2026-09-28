import { describe, it, expect } from 'vitest';
import { findDuplicateReply, type DedupHistoryItem } from './chat-dedup.server';

const now = () => new Date().toISOString();
const pair = (reply: Partial<DedupHistoryItem>): DedupHistoryItem[] => [
  { role: 'user', content: 'q', created_at: now() },
  { role: 'assistant', content: 'a', created_at: now(), ...reply },
];

describe('findDuplicateReply', () => {
  it('re-serves an ordinary reply to a byte-identical resend', () => {
    expect(findDuplicateReply(pair({}), 'q')?.content).toBe('a');
  });
  it('never re-serves a fallback (US-15 AC3)', () => {
    expect(findDuplicateReply(pair({ is_fallback: true }), 'q')).toBeNull();
  });
  it('never re-serves a refusal line: a resend gets a fresh answer (US-15 AC14)', () => {
    expect(findDuplicateReply(pair({ failure_mode: 'refusal' }), 'q')).toBeNull();
  });
});
