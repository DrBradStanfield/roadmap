/**
 * US-15 AC31 — the pre-router classifier on Haiku 5.5. Its newer tokenizer
 * spent all 8 output tokens on "MEASUREMENT" (the longest label) in the
 * 2026-10-16 smoke, one token from a cut-off label that parses as ERROR and
 * silently fires the router. The cap leaves room; unused tokens are not billed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const call = vi.hoisted(() => vi.fn());
vi.mock('./anthropic.server', () => ({ callAnthropicWithUsage: call }));
vi.mock('@sentry/react-router', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import * as Sentry from '@sentry/react-router';
import { classifyMessage } from './chat-classifier.server';

const usage = { inputTokens: 37, outputTokens: 8, cacheReadTokens: 923, cacheWriteTokens: 0 };

describe('chat classifier request (US-15 AC31)', () => {
  beforeEach(() => { call.mockReset(); vi.mocked(Sentry.captureMessage).mockClear(); });

  it('asks Haiku 5.5 with thinking off, no sampling params, and room past the longest label', async () => {
    call.mockResolvedValue({ content: 'MEASUREMENT', contentBlocks: [], usage, stopReason: 'end_turn' });
    const result = await classifyMessage('My blood pressure was 118/65 this morning');
    const body = call.mock.calls[0][0];
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16, thinking: { type: 'disabled' } });
    expect(body).not.toHaveProperty('temperature');
    expect(result.classification).toBe('MEASUREMENT');
  });

  it('reads the label from the first word, so text the model adds after it never turns a label into ERROR', async () => {
    call.mockResolvedValue({ content: 'MEASUREMENT\nThe user is logging a reading.', contentBlocks: [], usage, stopReason: 'end_turn' });
    expect((await classifyMessage('118/65 today')).classification).toBe('MEASUREMENT');
    call.mockResolvedValue({ content: 'Not sure', contentBlocks: [], usage, stopReason: 'end_turn' });
    expect((await classifyMessage('118/65 today')).classification).toBe('ERROR');
  });

  it('reports a refusal as its own signal with the category, not as unparseable output', async () => {
    call.mockResolvedValue({ content: '', contentBlocks: [], usage, stopReason: 'refusal', refusalCategory: 'bio' });
    const result = await classifyMessage('a question');
    expect(result.classification).toBe('ERROR');
    expect(result.routerSkipped).toBe(false);
    expect(result.error).toBe('refusal');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Chat classifier: refusal', expect.objectContaining({
      tags: expect.objectContaining({ subsystem: 'classifier', stopReason: 'refusal', refusalCategory: 'bio' }),
    }));
  });
});
