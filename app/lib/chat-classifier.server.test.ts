/**
 * US-15 AC34 — the pre-router classifier on Haiku 5.5. Its newer tokenizer
 * spent all 8 output tokens on "MEASUREMENT" (the longest label) in the
 * 2026-10-16 smoke, one token from a cut-off label that parses as ERROR and
 * silently fires the router. The cap leaves room; unused tokens are not billed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const call = vi.hoisted(() => vi.fn());
vi.mock('./anthropic.server', () => ({ callAnthropicWithUsage: call }));
vi.mock('@sentry/react-router', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import * as Sentry from '@sentry/react-router';
import { classifyMessage, isUnreadableAnswer } from './chat-classifier.server';

const usage = { inputTokens: 37, outputTokens: 8, cacheReadTokens: 923, cacheWriteTokens: 0 };

describe('chat classifier request (US-15 AC34)', () => {
  beforeEach(() => { call.mockReset(); vi.mocked(Sentry.captureMessage).mockClear(); });

  it('asks Haiku 5.5 with thinking off, no sampling params, and room past the longest label', async () => {
    call.mockResolvedValue({ content: 'MEASUREMENT', contentBlocks: [], usage, stopReason: 'end_turn' });
    const result = await classifyMessage('My blood pressure was 120/80 this morning');
    const body = call.mock.calls[0][0];
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16, thinking: { type: 'disabled' } });
    expect(body).not.toHaveProperty('temperature');
    expect(result.classification).toBe('MEASUREMENT');
  });

  it('reads the label from the first word, so text the model adds after it never turns a label into ERROR', async () => {
    call.mockResolvedValue({ content: 'MEASUREMENT\nThe user is logging a reading.', contentBlocks: [], usage, stopReason: 'end_turn' });
    expect((await classifyMessage('120/80 today')).classification).toBe('MEASUREMENT');
    call.mockResolvedValue({ content: 'Not sure', contentBlocks: [], usage, stopReason: 'end_turn' });
    expect((await classifyMessage('120/80 today')).classification).toBe('ERROR');
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

describe('spam label (US-15 AC41)', () => {
  beforeEach(() => call.mockReset());

  it('SPAM is a label of its own, so the model naming the category never fails open as ERROR', async () => {
    call.mockResolvedValue({ content: 'SPAM', contentBlocks: [], usage, stopReason: 'end_turn' });
    const result = await classifyMessage('Got my Semax from VendorX, real quality.');
    expect(result.classification).toBe('SPAM');
    expect(result.routerSkipped).toBe(true);
  });
});


describe('unreadable classifier answers (US-15 AC48)', () => {
  beforeEach(() => call.mockReset());

  it('US-15 AC48: a refusal or a non-label answer is unreadable; a timeout, an API failure or a label is not', async () => {
    call.mockResolvedValue({ content: '', contentBlocks: [], usage, stopReason: 'refusal', refusalCategory: 'bio' });
    expect(isUnreadableAnswer(await classifyMessage('a question'))).toBe(true);
    call.mockResolvedValue({ content: 'PROMOTION', contentBlocks: [], usage, stopReason: 'end_turn' });
    expect(isUnreadableAnswer(await classifyMessage('a question'))).toBe(true);
    call.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timedOut = await classifyMessage('a question');
    expect(timedOut).toMatchObject({ classification: 'ERROR', error: 'timeout' });
    expect(isUnreadableAnswer(timedOut)).toBe(false);
    call.mockRejectedValue(new Error('Anthropic API 529: overloaded'));
    expect(isUnreadableAnswer(await classifyMessage('a question'))).toBe(false);
    call.mockResolvedValue({ content: 'ROUTE', contentBlocks: [], usage, stopReason: 'end_turn' });
    expect(isUnreadableAnswer(await classifyMessage('a question'))).toBe(false);
  });
});

describe('missing classifier prompt (US-15 AC48)', () => {
  it('US-15 AC48: an unreadable prompt file fails open without calling the model, and reaches Sentry once', async () => {
    vi.resetModules();
    call.mockReset();
    const fs = (await import('fs')).default;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    const sentry = await import('@sentry/react-router');
    vi.mocked(sentry.captureMessage).mockClear();
    const fresh = await import('./chat-classifier.server');
    try {
      const first = await fresh.classifyMessage('Got my peptides from VendorX');
      const second = await fresh.classifyMessage('a question');
      for (const result of [first, second]) {
        expect(result).toMatchObject({ classification: 'ERROR', routerSkipped: false, error: 'no prompt' });
        expect(fresh.isUnreadableAnswer(result)).toBe(false);
        expect(fresh.shouldFireRouter(result)).toBe(true);
      }
      expect(call).not.toHaveBeenCalled();
      expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(sentry.captureMessage).toHaveBeenCalledWith('Chat classifier: prompt missing', expect.objectContaining({ level: 'error' }));
    } finally {
      read.mockRestore();
    }
  });
});
