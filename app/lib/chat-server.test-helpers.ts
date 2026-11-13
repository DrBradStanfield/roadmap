import { vi } from 'vitest';
import type * as ChatServer from './chat.server';

/**
 * The chat.server stand-in the chat route tests share (S-6). It covers every
 * export api.chat.ts and app-routes.server.ts read, so a new one is added here
 * once. Each stub is inert: no context, no blocks, no history, no articles, one
 * synthetic answer. A test passes only the exports it drives or inspects.
 * Use it inside the test's own vi.mock factory, which vitest hoists:
 *
 *   vi.mock('../lib/chat.server', async (original) => (await import('../lib/chat-server.test-helpers'))
 *     .chatServerStub(await original<typeof import('../lib/chat.server')>(), { getChatCompletion: mocks.complete }));
 *
 * `real` supplies MAX_MESSAGE_LENGTH: pass the real module to keep the real limit, or a literal.
 */
export function chatServerStub(
  real: { MAX_MESSAGE_LENGTH: number },
  overrides: Partial<Record<keyof typeof ChatServer, unknown>> = {},
) {
  return {
    resolveChatContext: () => ({ userContextJson: '{}' }),
    buildSystemBlocks: () => [],
    buildConversationMessages: () => [],
    loadMatchedArticlesFromHandles: () => null,
    DOCTOR_POSTURE: '', BRAND_POSTURE: '',
    getChatCompletion: async () => ({
      content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      isFallback: false, stopReason: 'end_turn',
    }),
    reportChatFallback: vi.fn(), generateTitle: () => 'Synthetic title', CHAT_MODEL: 'test',
    MAX_MESSAGE_LENGTH: real.MAX_MESSAGE_LENGTH,
    ...overrides,
  };
}
