import { describe, it, expect } from 'vitest';
import {
  buildConversationMessages,
  buildSystemBlocks,
  matchDocumentTitle,
  checkDailyLimit,
  incrementDailyLimitCache,
  MAX_MESSAGE_LENGTH,
  FREE_DAILY_LIMIT,
  SUBSCRIBER_DAILY_LIMIT,
} from './chat.server';

/** Mock Supabase client that returns a configurable message count. */
function mockClient(messageCount: number, shouldError = false) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gte: () => shouldError
              ? { count: null, error: { message: 'DB error' } }
              : { count: messageCount, error: null },
          }),
        }),
      }),
    }),
  } as any;
}

describe('buildConversationMessages', () => {
  it('adds new message to empty history', () => {
    const result = buildConversationMessages([], 'Hello');
    expect(result).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('preserves conversation history with new message', () => {
    const history = [
      { role: 'user' as const, content: 'What is my LDL?' },
      { role: 'assistant' as const, content: 'Your LDL is 3.2 mmol/L.' },
    ];
    const result = buildConversationMessages(history, 'Is that high?');
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('What is my LDL?');
    expect(result[1].content).toBe('Your LDL is 3.2 mmol/L.');
    expect(result[2].content).toBe('Is that high?');
  });

  it('keeps first user message when truncating for token budget', () => {
    // Create a history that exceeds 8000 token budget (~32000 chars)
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'user', content: `Question ${i}: ${'x'.repeat(2000)}` });
      history.push({ role: 'assistant', content: `Answer ${i}: ${'y'.repeat(2000)}` });
    }
    const result = buildConversationMessages(history, 'New question');

    // First message should always be the original first user message
    expect(result[0].content).toContain('Question 0');
    // Last message should be the new question
    expect(result[result.length - 1].content).toBe('New question');
    // Should have fewer messages than the full history
    expect(result.length).toBeLessThan(history.length + 1);
  });
});

describe('buildSystemBlocks', () => {
  it('returns 3 blocks with cache_control on first two', () => {
    const blocks = buildSystemBlocks('{"test": true}');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[2].cache_control).toBeUndefined();
  });

  it('includes algorithm doc in first block', () => {
    const blocks = buildSystemBlocks('{}');
    // First block should contain the system prompt + algorithm
    expect(blocks[0].text).toContain('Health Roadmap Assistant');
    expect(blocks[0].text).toContain('Scope boundaries');
  });

  it('includes evidence in second block', () => {
    const blocks = buildSystemBlocks('{}');
    expect(blocks[1].text).toContain('Clinical Evidence Reference');
  });

  it('includes user context in third block', () => {
    const ctx = '{"profile":{"sex":"male"}}';
    const blocks = buildSystemBlocks(ctx);
    expect(blocks[2].text).toContain(ctx);
  });

  it('adds 4th block when document content provided', () => {
    const blocks = buildSystemBlocks('{}', 'Colonoscopy report content...');
    expect(blocks).toHaveLength(4);
    expect(blocks[3].text).toContain('Colonoscopy report content');
    expect(blocks[3].cache_control).toBeUndefined(); // NOT cached
  });

  it('skips 4th block when document content is null', () => {
    const blocks = buildSystemBlocks('{}', null);
    expect(blocks).toHaveLength(3);
  });
});

describe('matchDocumentTitle', () => {
  const documents = [
    { title: 'Colonoscopy Report — Dr. Smith, Nov 2025', documentDate: '2025-11-15', documentType: 'scan_result' },
    { title: 'Blood Test Results — Lab Corp', documentDate: '2026-01-10', documentType: 'lab_report' },
    { title: 'Clinic Letter — Cardiology', documentDate: '2026-02-01', documentType: 'clinic_letter' },
  ];

  it('matches colonoscopy keyword', () => {
    const result = matchDocumentTitle('What did my colonoscopy show?', documents);
    expect(result).toBe('Colonoscopy Report — Dr. Smith, Nov 2025');
  });

  it('matches blood test keyword', () => {
    const result = matchDocumentTitle('Tell me about my blood test', documents);
    expect(result).toBe('Blood Test Results — Lab Corp');
  });

  it('matches clinic letter keyword', () => {
    const result = matchDocumentTitle('What did the clinic letter say?', documents);
    expect(result).toBe('Clinic Letter — Cardiology');
  });

  it('returns null when no match', () => {
    const result = matchDocumentTitle('How is the weather today?', documents);
    expect(result).toBeNull();
  });

  it('returns null for empty documents', () => {
    const result = matchDocumentTitle('What did my scan show?', []);
    expect(result).toBeNull();
  });

  it('is case insensitive', () => {
    const result = matchDocumentTitle('COLONOSCOPY results please', documents);
    expect(result).toBe('Colonoscopy Report — Dr. Smith, Nov 2025');
  });
});

describe('checkDailyLimit', () => {
  // Use unique user IDs to avoid cache interference between tests
  let testUserId = 0;
  function uniqueUserId() { return `test-user-limit-${++testUserId}`; }

  describe('free user', () => {
    it('allows message when under daily limit', async () => {
      const result = await checkDailyLimit(mockClient(1), uniqueUserId(), 'free', 0);
      expect(result).toEqual({ allowed: true, remaining: 2, useCredit: false, messageCredits: 0 });
    });

    it('allows message when at 0 messages', async () => {
      const result = await checkDailyLimit(mockClient(0), uniqueUserId(), 'free', 0);
      expect(result).toEqual({ allowed: true, remaining: 3, useCredit: false, messageCredits: 0 });
    });

    it('denies message at limit with no credits', async () => {
      const result = await checkDailyLimit(mockClient(3), uniqueUserId(), 'free', 0);
      expect(result).toEqual({ allowed: false, remaining: 0, useCredit: false, messageCredits: 0 });
    });

    it('allows message at limit when credits available', async () => {
      const result = await checkDailyLimit(mockClient(3), uniqueUserId(), 'free', 5);
      expect(result).toEqual({ allowed: true, remaining: 0, useCredit: true, messageCredits: 5 });
    });

    it('denies message over limit with no credits', async () => {
      const result = await checkDailyLimit(mockClient(10), uniqueUserId(), 'free', 0);
      expect(result).toEqual({ allowed: false, remaining: 0, useCredit: false, messageCredits: 0 });
    });
  });

  describe('subscriber', () => {
    it('allows message when under subscriber limit', async () => {
      const result = await checkDailyLimit(mockClient(5), uniqueUserId(), 'subscriber', 0);
      expect(result).toEqual({ allowed: true, remaining: 5, useCredit: false, messageCredits: 0 });
    });

    it('allows up to 10 messages for subscriber', async () => {
      const result = await checkDailyLimit(mockClient(9), uniqueUserId(), 'subscriber', 0);
      expect(result).toEqual({ allowed: true, remaining: 1, useCredit: false, messageCredits: 0 });
    });

    it('denies subscriber at limit with no credits', async () => {
      const result = await checkDailyLimit(mockClient(10), uniqueUserId(), 'subscriber', 0);
      expect(result).toEqual({ allowed: false, remaining: 0, useCredit: false, messageCredits: 0 });
    });

    it('allows subscriber at limit when credits available', async () => {
      const result = await checkDailyLimit(mockClient(10), uniqueUserId(), 'subscriber', 25);
      expect(result).toEqual({ allowed: true, remaining: 0, useCredit: true, messageCredits: 25 });
    });
  });

  describe('defaults and edge cases', () => {
    it('defaults to free plan when plan is undefined', async () => {
      const result = await checkDailyLimit(mockClient(3), uniqueUserId());
      expect(result.allowed).toBe(false);
    });

    it('treats unknown plan as free', async () => {
      const result = await checkDailyLimit(mockClient(3), uniqueUserId(), 'unknown', 0);
      expect(result.allowed).toBe(false);
    });

    it('fails open on DB error', async () => {
      const result = await checkDailyLimit(mockClient(0, true), uniqueUserId(), 'free', 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
      expect(result.useCredit).toBe(false);
    });

    it('passes through messageCredits value', async () => {
      const result = await checkDailyLimit(mockClient(1), uniqueUserId(), 'free', 42);
      expect(result.messageCredits).toBe(42);
    });
  });

  describe('cache behavior', () => {
    it('uses cached count on second call', async () => {
      const userId = uniqueUserId();
      // First call: DB says 1 message
      await checkDailyLimit(mockClient(1), userId, 'free', 0);
      // Second call with different mock — should use cache, not DB
      const result = await checkDailyLimit(mockClient(999), userId, 'free', 0);
      expect(result.remaining).toBe(2); // From cached count of 1, not mock's 999
    });

    it('incrementDailyLimitCache updates cached count', async () => {
      const userId = uniqueUserId();
      await checkDailyLimit(mockClient(2), userId, 'free', 0);
      incrementDailyLimitCache(userId);
      // Now cache has count=3, at limit
      const result = await checkDailyLimit(mockClient(999), userId, 'free', 0);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });
});

describe('constants', () => {
  it('has correct message length limit', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(500);
  });

  it('has correct daily limits', () => {
    expect(FREE_DAILY_LIMIT).toBe(3);
    expect(SUBSCRIBER_DAILY_LIMIT).toBe(10);
  });
});
