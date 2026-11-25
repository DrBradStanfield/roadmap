/**
 * US-15 AC65 backstop: getChatCompletion throws and makes no model call when a
 * chat doc is missing, whatever its caller checked. US-15 AC74: the error names
 * the missing files (names only), not always the prompt.
 */
import { describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  callAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
  streamAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
}));
vi.mock('./chat-system-prompt.server', () => ({ CHAT_PROMPT: { kind: 'missing', files: ['health_roadmap_algorithm.md', 'app/lib/chat-posture-brand.md'] } }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  callAnthropicWithUsage: spies.callAnthropic,
  streamAnthropicWithUsage: spies.streamAnthropic,
}));

import { buildSystemBlocks, getChatCompletion } from './chat.server';

describe('US-15 AC65: getChatCompletion backstop', () => {
  it.each([['plain', undefined], ['streamed', () => {}]])('%s: US-15 AC74 throws naming the missing docs, no model call', async (_case, onEvent) => {
    const blocks = buildSystemBlocks('{}', { savedChat: '' });
    await expect(getChatCompletion(blocks, [{ role: 'user', content: 'hello' }], false, onEvent, { purpose: 'CHAT' }))
      .rejects.toThrow(new Error('Chat docs missing (health_roadmap_algorithm.md, app/lib/chat-posture-brand.md); no model call'));
    expect(spies.callAnthropic).not.toHaveBeenCalled();
    expect(spies.streamAnthropic).not.toHaveBeenCalled();
  });
});
