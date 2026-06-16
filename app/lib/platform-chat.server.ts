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
import type { ChatFailureMode } from './chat.server';
import { routeQuery, sanitizeForRouter, type RouterResult } from './chat-router.server';
import {
  classifyMessage,
  shouldFireRouter,
  type Classification,
} from './chat-classifier.server';
import type { AnthropicUsage } from './anthropic.server';

export interface PlatformCompletionResult {
  content: string;
  usage: AnthropicUsage;
  /** True when the main-LLM call failed/empty and a fallback message was substituted.
   *  Callers must propagate to their persistence layer (chat_messages.is_fallback) AND
   *  to reportChatFallback() for the Sentry alert. */
  isFallback: boolean;
  failureMode?: ChatFailureMode;
  errorDetail?: string;
  /** Router-call result. null when the classifier said SKIP (router never ran). */
  routerResult: RouterResult | null;
  classifier: {
    classification: Classification;
    routerSkipped: boolean;
    latencyMs: number;
    error: string | null;
  };
}

const DISCORD_PLATFORM_CONTEXT = `Platform: Discord — you are Dr Brad's AI assistant, running in Dr Brad Stanfield's Discord server.

No individual health data is available for this user — they are chatting from
Discord, not the Health Roadmap app. There is NO form to edit here — never call
the propose_field_edit or propose_medication_edit tools; answer in words only.

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

  // Stage 1: classifier (Discord has no per-user data fetch to parallelize with).
  const classifierResult = await classifyMessage(sanitizedCurrent, sanitizedFirst, sanitizedRecent);

  // Stage 2: router fires only when the classifier didn't bypass it (ROUTE/ERROR → fire).
  const routerResult: RouterResult | null = shouldFireRouter(classifierResult)
    ? await routeQuery(sanitizedCurrent, sanitizedFirst, sanitizedRecent)
    : null;

  const blogArticles = loadMatchedArticlesFromHandles(routerResult?.handles ?? []);

  const systemBlocks = buildSystemBlocks(DISCORD_PLATFORM_CONTEXT, { blogArticles });
  const conversationMessages = buildConversationMessages(history, message);
  const completion = await getChatCompletion(systemBlocks, conversationMessages);

  return {
    content: completion.content,
    usage: completion.usage,
    isFallback: completion.isFallback,
    failureMode: completion.failureMode,
    errorDetail: completion.errorDetail,
    routerResult,
    classifier: {
      classification: classifierResult.classification,
      routerSkipped: classifierResult.routerSkipped,
      latencyMs: classifierResult.latencyMs,
      error: classifierResult.error,
    },
  };
}
