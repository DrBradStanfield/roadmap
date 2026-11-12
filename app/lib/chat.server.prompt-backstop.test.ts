/**
 * US-15 AC65 backstop: getChatCompletion throws fixed words and makes no model
 * call when the chat system prompt is missing, whatever its caller checked.
 */
import { describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  callAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
  streamAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
}));
vi.mock('./chat-system-prompt.server', () => ({ CHAT_PROMPT: { kind: 'missing' } }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  callAnthropicWithUsage: spies.callAnthropic,
  streamAnthropicWithUsage: spies.streamAnthropic,
}));

import { buildSystemBlocks, getChatCompletion } from './chat.server';

describe('US-15 AC65: getChatCompletion backstop', () => {
  it.each([['plain', undefined], ['streamed', () => {}]])('%s: throws fixed words, no model call', async (_case, onEvent) => {
    const blocks = buildSystemBlocks('{}', { savedChat: '' });
    await expect(getChatCompletion(blocks, [{ role: 'user', content: 'hello' }], false, onEvent))
      .rejects.toThrow('Chat system prompt missing; no model call');
    expect(spies.callAnthropic).not.toHaveBeenCalled();
    expect(spies.streamAnthropic).not.toHaveBeenCalled();
  });
});
