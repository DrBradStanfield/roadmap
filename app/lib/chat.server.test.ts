import { describe, it, expect } from 'vitest';
import {
  buildConversationMessages,
  buildSystemBlocks,
  matchDocumentTitle,
  matchBlogArticle,
  assembleGuestChatContext,
  checkDailyLimit,
  incrementDailyLimitCache,
  MAX_MESSAGE_LENGTH,
  GUEST_DAILY_LIMIT,
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
  // Products and blog index add cached blocks when present, so base count varies
  const baseBlocks = buildSystemBlocks('{}');
  const baseCount = baseBlocks.length;

  it('returns base blocks with cache_control on cached blocks', () => {
    const blocks = buildSystemBlocks('{"test": true}');
    expect(blocks).toHaveLength(baseCount);
    // Algorithm + evidence (+ products if present) should be cached
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    // User context block (last base block) should NOT be cached
    expect(blocks[baseCount - 1].cache_control).toBeUndefined();
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

  it('includes user context in last base block', () => {
    const ctx = '{"profile":{"sex":"male"}}';
    const blocks = buildSystemBlocks(ctx);
    expect(blocks[baseCount - 1].text).toContain(ctx);
  });

  it('adds document block when document content provided', () => {
    const blocks = buildSystemBlocks('{}', { documentContent: 'Colonoscopy report content...' });
    expect(blocks).toHaveLength(baseCount + 1);
    expect(blocks[baseCount].text).toContain('Colonoscopy report content');
    expect(blocks[baseCount].cache_control).toBeUndefined(); // NOT cached
  });

  it('skips document block when document content is null', () => {
    const blocks = buildSystemBlocks('{}', { documentContent: null });
    expect(blocks).toHaveLength(baseCount);
  });

  it('adds order block when order summary provided', () => {
    const blocks = buildSystemBlocks('{}', { orderSummary: 'Order #1001 — $55.00' });
    expect(blocks).toHaveLength(baseCount + 1);
    expect(blocks[baseCount].text).toContain('Order #1001');
  });

  it('adds both document and order blocks when both provided', () => {
    const blocks = buildSystemBlocks('{}', {
      documentContent: 'Lab report',
      orderSummary: 'Order #1001',
    });
    expect(blocks).toHaveLength(baseCount + 2);
  });

  it('adds blog article block when blog article provided', () => {
    const blocks = buildSystemBlocks('{}', { blogArticle: 'Berberine article content...' });
    expect(blocks).toHaveLength(baseCount + 1);
    expect(blocks[baseCount].text).toContain('Berberine article content');
  });
});

describe('assembleGuestChatContext', () => {
  it('returns personalized context for valid guest inputs', () => {
    const result = assembleGuestChatContext({
      heightCm: 180,
      sex: 'male',
      birthYear: 1990,
      birthMonth: 6,
      weightKg: 80,
    });
    expect(result).not.toBeNull();
    expect(result!.subscriptionPlan).toBe('free');
    expect(result!.messageCredits).toBe(0);
    expect(result!.healthDocuments).toEqual([]);
    expect(result!.userContextJson).toContain('"sex": "male"');
    expect(result!.userContextJson).toContain('"heightCm": 180');
  });

  it('returns null for invalid inputs (missing required fields)', () => {
    const result = assembleGuestChatContext({ weightKg: 80 });
    expect(result).toBeNull();
  });

  it('returns null for completely invalid data', () => {
    expect(assembleGuestChatContext(null)).toBeNull();
    expect(assembleGuestChatContext('string')).toBeNull();
    expect(assembleGuestChatContext(123)).toBeNull();
  });

  it('sanitizes medications — rejects nested objects', () => {
    const result = assembleGuestChatContext({
      heightCm: 180,
      sex: 'male',
      medications: {
        statin: 'atorvastatin',
        malicious: { nested: 'object' },  // should be stripped
      },
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.userContextJson);
    expect(parsed.medications.statin).toBe('atorvastatin');
    expect(parsed.medications.malicious).toBeUndefined();
  });

  it('sanitizes screenings — rejects nested objects', () => {
    const result = assembleGuestChatContext({
      heightCm: 180,
      sex: 'male',
      screenings: {
        colorectal_method: 'colonoscopy',
        evil: { injected: 'prompt' },
      },
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.userContextJson);
    expect(parsed.screenings.colorectal_method).toBe('colonoscopy');
    expect(parsed.screenings.evil).toBeUndefined();
  });

  it('defaults unitSystem to si when not specified', () => {
    const result = assembleGuestChatContext({ heightCm: 180, sex: 'female' });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.userContextJson);
    expect(parsed.profile.unitSystem).toBe('si');
  });

  it('accepts conventional unit system', () => {
    const result = assembleGuestChatContext({ heightCm: 180, sex: 'male', unitSystem: 'conventional' });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.userContextJson);
    expect(parsed.profile.unitSystem).toBe('conventional');
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

  describe('guest user', () => {
    it('allows message when under guest limit', async () => {
      const result = await checkDailyLimit(mockClient(1), uniqueUserId(), 'free', 0, true);
      expect(result).toEqual({ allowed: true, remaining: GUEST_DAILY_LIMIT - 1, useCredit: false, messageCredits: 0 });
    });

    it('denies guest at limit with no credits', async () => {
      const result = await checkDailyLimit(mockClient(GUEST_DAILY_LIMIT), uniqueUserId(), 'free', 0, true);
      expect(result).toEqual({ allowed: false, remaining: 0, useCredit: false, messageCredits: 0 });
    });
  });

  describe('free user (logged in)', () => {
    it('allows message when under daily limit', async () => {
      const result = await checkDailyLimit(mockClient(1), uniqueUserId(), 'free', 0);
      expect(result).toEqual({ allowed: true, remaining: FREE_DAILY_LIMIT - 1, useCredit: false, messageCredits: 0 });
    });

    it('allows message when at 0 messages', async () => {
      const result = await checkDailyLimit(mockClient(0), uniqueUserId(), 'free', 0);
      expect(result).toEqual({ allowed: true, remaining: FREE_DAILY_LIMIT, useCredit: false, messageCredits: 0 });
    });

    it('denies message at limit with no credits', async () => {
      const result = await checkDailyLimit(mockClient(FREE_DAILY_LIMIT), uniqueUserId(), 'free', 0);
      expect(result).toEqual({ allowed: false, remaining: 0, useCredit: false, messageCredits: 0 });
    });

    it('allows message at limit when credits available', async () => {
      const result = await checkDailyLimit(mockClient(FREE_DAILY_LIMIT), uniqueUserId(), 'free', 5);
      expect(result).toEqual({ allowed: true, remaining: 0, useCredit: true, messageCredits: 5 });
    });
  });

  describe('subscriber', () => {
    it('allows message when under subscriber limit', async () => {
      const result = await checkDailyLimit(mockClient(5), uniqueUserId(), 'subscriber', 0);
      expect(result).toEqual({ allowed: true, remaining: SUBSCRIBER_DAILY_LIMIT - 5, useCredit: false, messageCredits: 0 });
    });

    it('denies subscriber at limit with no credits', async () => {
      const result = await checkDailyLimit(mockClient(SUBSCRIBER_DAILY_LIMIT), uniqueUserId(), 'subscriber', 0);
      expect(result).toEqual({ allowed: false, remaining: 0, useCredit: false, messageCredits: 0 });
    });

    it('allows subscriber at limit when credits available', async () => {
      const result = await checkDailyLimit(mockClient(SUBSCRIBER_DAILY_LIMIT), uniqueUserId(), 'subscriber', 25);
      expect(result).toEqual({ allowed: true, remaining: 0, useCredit: true, messageCredits: 25 });
    });
  });

  describe('defaults and edge cases', () => {
    it('defaults to free plan when plan is undefined', async () => {
      const result = await checkDailyLimit(mockClient(FREE_DAILY_LIMIT), uniqueUserId());
      expect(result.allowed).toBe(false);
    });

    it('treats unknown plan as free', async () => {
      const result = await checkDailyLimit(mockClient(FREE_DAILY_LIMIT), uniqueUserId(), 'unknown', 0);
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
      expect(result.remaining).toBe(FREE_DAILY_LIMIT - 1); // From cached count of 1, not mock's 999
    });

    it('incrementDailyLimitCache updates cached count', async () => {
      const userId = uniqueUserId();
      await checkDailyLimit(mockClient(FREE_DAILY_LIMIT - 1), userId, 'free', 0);
      incrementDailyLimitCache(userId);
      // Now cache has count=FREE_DAILY_LIMIT, at limit
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
    expect(GUEST_DAILY_LIMIT).toBe(3);
    expect(FREE_DAILY_LIMIT).toBe(50);
    expect(SUBSCRIBER_DAILY_LIMIT).toBe(999);
  });
});
