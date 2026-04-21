/**
 * Platform-agnostic chat wrapper (Discord today, other platforms tomorrow).
 *
 * Reuses the Shopify chat pipeline (`chat.server.ts` + `chat-router.server.ts`)
 * but skips Shopify-specific features (personalized health data, orders, account
 * page redirects). The cached system prompt is kept identical to the Shopify
 * chatbot so Anthropic prompt cache hits are shared across platforms — the
 * platform-specific overrides live in the uncached user context block.
 */
import {
  buildSystemBlocks,
  buildConversationMessages,
  getChatCompletion,
  loadMatchedArticlesFromHandles,
} from './chat.server';
import { routeQuery, sanitizeForRouter, ROUTER_VERSION } from './chat-router.server';
import type { AnthropicUsage } from './anthropic.server';

export interface PlatformCompletionResult {
  content: string;
  usage: AnthropicUsage;
  router: {
    handles: string[];
    latencyMs: number;
    cacheHit: boolean;
    inputTokens: number;
    cacheReadTokens: number;
    error: string | null;
    rawJson: string | null;
    version: number;
  };
}

const DISCORD_PLATFORM_CONTEXT = `Platform: Discord — you are Dr Brad's AI assistant, running in Dr Brad Stanfield's Discord server.

No individual health data is available for this user — they are chatting from
Discord, not the Health Roadmap app.

Override the following default system prompt behaviours:
- Refer to yourself as "Dr Brad's AI assistant" — NOT as "Health Roadmap community chat" or any community-chat phrasing.
- Do NOT reference "your roadmap suggestions", "your numbers", or any personalized
  data. Answer based on the general algorithm, clinical guidelines, and pathway
  content provided.
- Do NOT direct users to "account.drstanfield.com" or tell them to "log in" /
  "create a free account". They're on Discord. If they want personalized
  recommendations, mention drstanfield.com (the main site) where they can use
  the Health Roadmap tool.
- Do NOT proactively mention or promote Dr Stanfield's supplements or products
  in greetings or unprompted. Only discuss them if the user asks directly.
- Present numeric values in BOTH SI (mmol/L, kg, cm) and conventional (mg/dL,
  lbs, inches) units — no unit preference is known.
- Keep each response under 2000 characters (Discord's single-message limit).
- The educational-disclaimer footer is still required on every response.`;

export async function platformChatCompletion(params: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<PlatformCompletionResult> {
  const { message, history } = params;

  const sanitizedCurrent = sanitizeForRouter(message);
  const firstUserMsg = history.find(m => m.role === 'user')?.content;
  const recentUserMsgs = history.filter(m => m.role === 'user').slice(-3).map(m => m.content);
  const sanitizedFirst = firstUserMsg ? sanitizeForRouter(firstUserMsg) : undefined;
  const sanitizedRecent = recentUserMsgs.map(sanitizeForRouter);

  const routerResult = await routeQuery(sanitizedCurrent, sanitizedFirst, sanitizedRecent);
  const blogArticles = loadMatchedArticlesFromHandles(routerResult.handles);

  const systemBlocks = buildSystemBlocks(DISCORD_PLATFORM_CONTEXT, { blogArticles });
  const conversationMessages = buildConversationMessages(history, message);
  const completion = await getChatCompletion(systemBlocks, conversationMessages);

  return {
    content: completion.content,
    usage: completion.usage,
    router: {
      handles: routerResult.handles,
      latencyMs: routerResult.latencyMs,
      cacheHit: routerResult.cacheHit,
      inputTokens: routerResult.usage.inputTokens,
      cacheReadTokens: routerResult.usage.cacheReadTokens,
      error: routerResult.error,
      rawJson: routerResult.rawJson,
      version: ROUTER_VERSION,
    },
  };
}
