/**
 * Chat API — CRUD for conversations + LLM chat via Shopify app proxy.
 *
 * GET  /api/chat                         — List conversations + daily remaining
 * GET  /api/chat?conversationId=xxx      — Load conversation messages
 * POST /api/chat { message, conversationId? } — Send message, get response
 * POST /api/chat { warmupOnly: true }    — Prime Anthropic prompt cache (fired on chat-open)
 * DELETE /api/chat { conversationId }    — Delete conversation
 */
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { authenticate } from '../shopify.server';
import { getAuthenticatedUser, checkSubscriptionFromTags, getCustomerOrders, getClientIp } from '../lib/route-helpers.server';
import { logAudit, getProfile, updateSubscriptionPlan, createUserClient, getOrCreateGuestSession, GuestRateLimitError, type DbProfile } from '../lib/supabase.server';
import {
  assembleChatContext,
  assembleGuestChatContext,
  buildSystemBlocks,
  buildConversationMessages,
  matchDocumentTitle,
  loadMatchedArticlesFromHandles,
  getChatCompletion,
  warmupCache,
  CHAT_MODEL,
  MAX_MESSAGE_LENGTH,
} from '../lib/chat.server';
import { routeQuery, warmupRouter, sanitizeForRouter, ROUTER_VERSION } from '../lib/chat-router.server';

/** Generate a conversation title from the first user message. */
function generateTitle(message: string): string {
  const sentenceMatch = message.match(/^(.+?[.?!])\s/);
  if (sentenceMatch && sentenceMatch[1].length > 15 && sentenceMatch[1].length <= 80) {
    return sentenceMatch[1];
  }
  if (message.length <= 80) return message;
  const truncated = message.slice(0, 80);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 40 ? truncated.slice(0, lastSpace) + '…' : truncated + '…';
}

// ---------------------------------------------------------------------------
// Unified auth: handles both authenticated users and guests
// ---------------------------------------------------------------------------

interface AuthResult {
  client: any;
  userId: string;
  customerId: string | null;
  admin: any;
  isGuest: boolean;
  sessionToken?: string;
}

async function getAuthOrGuest(request: Request, sessionToken?: string | null): Promise<AuthResult> {
  // Try authenticated user first (also verifies HMAC internally)
  const auth = await getAuthenticatedUser(request);
  if (auth) {
    return { ...auth, isGuest: false };
  }

  // Guest path — HMAC was already verified inside getAuthenticatedUser
  const ip = getClientIp(request);
  const session = await getOrCreateGuestSession(ip, sessionToken);
  return {
    client: createUserClient(session.sessionId),
    userId: session.sessionId,
    customerId: null,
    admin: null,
    isGuest: true,
    sessionToken: session.sessionToken,
  };
}

// Order cache — orders change infrequently, no need to re-fetch every message
const ORDER_CACHE_TTL = 10 * 60_000; // 10 minutes
const orderCache = new Map<string, { summary: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of orderCache) {
    if (now > entry.expiresAt) orderCache.delete(key);
  }
}, 5 * 60_000);

async function getCachedOrders(admin: any, customerId: string): Promise<string> {
  const cached = orderCache.get(customerId);
  if (cached && Date.now() < cached.expiresAt) return cached.summary;

  const summary = await getCustomerOrders(admin, customerId);
  // Cache both successful and empty results (shorter TTL for empty to retry sooner)
  const ttl = summary ? ORDER_CACHE_TTL : 2 * 60_000;
  orderCache.set(customerId, { summary, expiresAt: Date.now() + ttl });
  return summary;
}

// Lazy subscription check — at most once per 24 hours
async function refreshSubscriptionIfStale(
  auth: { admin: any; customerId: string; userId: string },
  profile: Pick<DbProfile, 'subscription_plan' | 'subscription_checked_at'>,
): Promise<string> {
  const checkedAt = profile.subscription_checked_at
    ? new Date(profile.subscription_checked_at).getTime()
    : 0;
  const staleThreshold = Date.now() - 24 * 60 * 60_000;

  if (checkedAt > staleThreshold) {
    return profile.subscription_plan ?? 'free';
  }

  // Refresh from Shopify tags
  if (!auth.admin) return profile.subscription_plan ?? 'free';

  const plan = await checkSubscriptionFromTags(auth.admin, auth.customerId);
  // Fire-and-forget update
  updateSubscriptionPlan(auth.userId, plan).catch(err => {
    console.error('Failed to update subscription plan:', err);
    Sentry.captureException(err, { tags: { feature: 'chat' } });
  });
  return plan;
}

// Warmup cooldown. 4 min deliberately < 5-min Anthropic TTL so the cache
// stays warm across rapid chat-open events. Starts at 0 so the first click
// after a deploy/restart fires immediately.
let lastWarmupAt = 0;
const WARMUP_MIN_INTERVAL = 4 * 60_000;

// ---------------------------------------------------------------------------
// GET — list conversations or load conversation messages
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);

    // Guest without a session token — return empty default (don't create a session just to list conversations)
    const sessionToken = url.searchParams.get('sessionToken');
    const hasCustomerId = !!url.searchParams.get('logged_in_customer_id');
    if (!hasCustomerId && !sessionToken) {
      return json({
        success: true,
        conversations: [],
        isGuest: true,
      });
    }

    let auth: AuthResult;
    try {
      auth = await getAuthOrGuest(request, sessionToken);
    } catch (err) {
      if (err instanceof GuestRateLimitError) {
        return json({ success: false, error: 'rate_limited' }, { status: 429 });
      }
      throw err;
    }

    const conversationId = url.searchParams.get('conversationId');

    if (conversationId) {
      const { data, error } = await auth.client
        .from('chat_messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Error loading chat messages:', error);
        return json({ success: false, error: 'Failed to load messages' }, { status: 500 });
      }

      return json({
        success: true,
        messages: (data ?? []).map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
        })),
        ...(auth.isGuest ? { sessionToken: auth.sessionToken } : {}),
      });
    }

    const { data: convData, error: convError } = await auth.client
      .from('chat_conversations')
      .select('id, title, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50);

    if (convError) {
      console.error('Error listing conversations:', convError);
      return json({ success: false, error: 'Failed to load conversations' }, { status: 500 });
    }

    // Off the response path: load profile + refresh subscription plan from
    // Shopify tags at most once per 24h. Guest requests have no profile to refresh.
    if (!auth.isGuest && auth.customerId) {
      const customerId = auth.customerId;
      (async () => {
        const profile = await getProfile(auth.client);
        if (!profile) return;
        await refreshSubscriptionIfStale(
          { admin: auth.admin, customerId, userId: auth.userId },
          profile,
        );
      })().catch(err => {
        console.error('Subscription refresh failed:', err);
        Sentry.captureException(err, { tags: { feature: 'chat' } });
      });
    }

    return json({
      success: true,
      conversations: (convData ?? []).map((c: { id: string; title: string; created_at: string; updated_at: string }) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updated_at,
        createdAt: c.created_at,
      })),
      ...(auth.isGuest ? { sessionToken: auth.sessionToken, isGuest: true } : {}),
    });
  } catch (error) {
    if (error instanceof GuestRateLimitError) {
      return json({ success: false, error: 'rate_limited' }, { status: 429 });
    }
    console.error('Chat loader error:', error);
    Sentry.captureException(error, { tags: { feature: 'chat' } });
    return json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST/DELETE — send message or delete conversation
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  const t0 = Date.now();
  try {
    if (process.env.CHAT_ENABLED === 'false') {
      return json({ success: false, error: 'Chat is temporarily disabled' }, { status: 503 });
    }

    const body = await request.json();

    // ----- WARMUP — prime Anthropic prompt cache (event-driven from the widget) -----
    // HMAC-only auth: skip `getAuthOrGuest` so a speculative warmup never creates
    // orphaned guest sessions, and logged-in users don't pay the ~400ms Shopify
    // GraphQL + Supabase hop. Shopify's proxy is the only trusted caller; cost
    // is further bounded by `WARMUP_MIN_INTERVAL`.
    if (body.warmupOnly === true) {
      console.log('Chat warmup: endpoint hit');
      await authenticate.public.appProxy(request);

      if (Date.now() - lastWarmupAt < WARMUP_MIN_INTERVAL) {
        console.log('Chat warmup: skipped (within cooldown)');
        return json({ ok: true, skipped: true });
      }
      lastWarmupAt = Date.now();
      const started = Date.now();
      try {
        // Warm both the main LLM cache (4 blocks) and the router cache (2 blocks) in parallel.
        const [usage] = await Promise.all([warmupCache(), warmupRouter()]);
        // cacheReadTokens > 0 → prior warmup's cache is still live.
        // cacheHitRatio: 0 on real POSTs despite a recent success here → cache
        // prefix is diverging between warmup and real requests; inspect blocks.
        console.log(JSON.stringify({
          evt: 'chat_warmup',
          ok: true,
          durationMs: Date.now() - started,
          inputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
        }));
        return json({ ok: true });
      } catch (err) {
        console.error('Chat warmup: failed', err);
        Sentry.captureException(err, { tags: { feature: 'chat', step: 'warmup' } });
        const message = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: message }, { status: 500 });
      }
    }

    let auth: AuthResult;
    try {
      auth = await getAuthOrGuest(request, body.sessionToken);
    } catch (err) {
      if (err instanceof GuestRateLimitError) {
        return json({ success: false, error: 'rate_limited' }, { status: 429 });
      }
      throw err;
    }

    // ----- DELETE -----
    if (request.method === 'DELETE') {
      const { conversationId } = body;
      if (!conversationId || typeof conversationId !== 'string') {
        return json({ success: false, error: 'conversationId required' }, { status: 400 });
      }

      const { error } = await auth.client
        .from('chat_conversations')
        .delete()
        .eq('id', conversationId);

      if (error) {
        console.error('Error deleting conversation:', error);
        return json({ success: false, error: 'Failed to delete' }, { status: 500 });
      }

      logAudit(auth.userId, 'CHAT_CONVERSATION_DELETED', 'chat', conversationId);
      return json({ success: true });
    }

    // ----- POST — send message -----
    const { message, conversationId } = body;

    if (!message || typeof message !== 'string') {
      return json({ success: false, error: 'message required' }, { status: 400 });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return json({ success: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` }, { status: 400 });
    }

    // Sanitize message for router (strips control chars, caps at 2000 chars)
    const sanitizedCurrent = sanitizeForRouter(message);

    // History pre-load: for existing conversations load now so router gets context.
    // For new conversations (no conversationId yet) history is empty by definition.
    let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (conversationId) {
      const { data: historyRows } = await auth.client
        .from('chat_messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      history = (historyRows ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>;
    }

    const firstUserMsg = history.find(m => m.role === 'user')?.content;
    const recentUserMsgs = history.filter(m => m.role === 'user').slice(-3).map(m => m.content);
    const sanitizedFirst = firstUserMsg ? sanitizeForRouter(firstUserMsg) : undefined;
    const sanitizedRecent = recentUserMsgs.map(sanitizeForRouter);

    // Assemble context + run router in parallel. Router runs alongside context/orders
    // to reclaim ~300ms of latency — routerResult is awaited before the main LLM call.
    let context;
    let orderSummary = '';
    let routerResult;

    if (auth.isGuest) {
      [context, routerResult] = await Promise.all([
        Promise.resolve(
          body.guestInputs
            ? assembleGuestChatContext(body.guestInputs)
            : { userContextJson: '{}', subscriptionPlan: 'free', messageCredits: 0, healthDocuments: [] }
        ),
        routeQuery(sanitizedCurrent, sanitizedFirst, sanitizedRecent),
      ]);
    } else {
      let ctxResult: [Awaited<ReturnType<typeof assembleChatContext>>, string];
      [ctxResult, routerResult] = await Promise.all([
        Promise.all([
          assembleChatContext(auth.client, auth.userId),
          auth.admin ? getCachedOrders(auth.admin, auth.customerId!) : Promise.resolve(''),
        ]) as Promise<[Awaited<ReturnType<typeof assembleChatContext>>, string]>,
        routeQuery(sanitizedCurrent, sanitizedFirst, sanitizedRecent),
      ]);
      [context, orderSummary] = ctxResult;
    }
    const tAfterContext = Date.now();

    if (routerResult.error) {
      Sentry.captureMessage(`Router: ${routerResult.error}`, {
        level: 'warning',
        tags: { feature: 'chat', subsystem: 'router' },
        extra: { latencyMs: routerResult.latencyMs, cacheHit: routerResult.cacheHit },
      });
    }

    if (!context) {
      const err = new Error('Chat: Could not load health data');
      console.error(err.message);
      Sentry.captureException(err, {
        tags: { feature: 'chat' },
        extra: { isGuest: auth.isGuest, userId: auth.userId },
      });
      return json({ success: false, error: 'Could not load health data' }, { status: 500 });
    }

    // Create or validate conversation
    let activeConversationId = conversationId;
    if (!activeConversationId) {
      const title = generateTitle(message);
      const { data: conv, error: convError } = await auth.client
        .from('chat_conversations')
        .insert({ user_id: auth.userId, title })
        .select('id')
        .single();

      if (convError || !conv) {
        const err = new Error('Chat: Failed to create conversation');
        console.error(err.message, convError);
        Sentry.captureException(err, {
          tags: { feature: 'chat' },
          extra: { userId: auth.userId, dbError: convError?.message },
        });
        return json({ success: false, error: 'Failed to create conversation' }, { status: 500 });
      }
      activeConversationId = conv.id;
    }

    // Insert user message (history already loaded above for existing convs)
    const { error: userMsgError } = await auth.client
      .from('chat_messages')
      .insert({
        conversation_id: activeConversationId,
        user_id: auth.userId,
        role: 'user',
        content: message,
      });

    if (userMsgError) {
      const err = new Error('Chat: Failed to save user message');
      console.error(err.message, userMsgError);
      Sentry.captureException(err, {
        tags: { feature: 'chat' },
        extra: { userId: auth.userId, conversationId: activeConversationId, dbError: userMsgError.message },
      });
      return json({ success: false, error: 'Failed to save message' }, { status: 500 });
    }

    // Check for document content match (uses full docs from context, no extra DB call)
    let documentContent: string | null = null;
    const docTitles = context.healthDocuments.map(d => ({
      title: d.title,
      documentDate: d.document_date,
      documentType: d.document_type,
    }));
    const matchedTitle = matchDocumentTitle(message, docTitles);
    if (matchedTitle) {
      const matchedDoc = context.healthDocuments.find(d => d.title === matchedTitle);
      if (matchedDoc) {
        documentContent = matchedDoc.content_md;
      }
    }

    // Load content from router handles (router already ran in parallel with context above)
    const blogArticles = loadMatchedArticlesFromHandles(routerResult.handles);

    // Build system blocks + messages, call LLM
    const systemBlocks = buildSystemBlocks(context.userContextJson, { documentContent, orderSummary, blogArticles });
    const conversationMessages = buildConversationMessages(history, message);
    const tBeforeLlm = Date.now();
    const completion = await getChatCompletion(systemBlocks, conversationMessages);
    const tAfterLlm = Date.now();

    // Pre-generate the assistant message UUID so chat_match_events can FK it cleanly.
    const assistantMessageId = crypto.randomUUID();

    // Fire-and-forget: save assistant message, then (nested) log match event.
    // Nesting ensures the chat_messages FK is satisfied before match_events insert.
    auth.client
      .from('chat_messages')
      .insert({
        id: assistantMessageId,
        conversation_id: activeConversationId,
        user_id: auth.userId,
        role: 'assistant',
        content: completion.content,
        input_tokens: completion.usage.inputTokens,
        output_tokens: completion.usage.outputTokens,
        model: CHAT_MODEL,
      })
      .then(({ error: msgError }: { error: { message: string } | null }) => {
        if (msgError) {
          console.error('Error saving assistant message:', msgError);
          Sentry.captureException(new Error('Chat: Failed to save assistant message'), {
            tags: { feature: 'chat' },
            extra: { conversationId: activeConversationId, dbError: msgError.message },
          });
          return;
        }
        // FK on message_id now satisfied — safe to insert match event
        auth.client
          .from('chat_match_events')
          .insert({
            message_id: assistantMessageId,
            conversation_id: activeConversationId,
            user_id: auth.userId,
            message: sanitizedCurrent,
            router_context: { first: sanitizedFirst ?? null, recent: sanitizedRecent },
            matched_handles: routerResult.handles,
            router_version: ROUTER_VERSION,
            router_latency_ms: routerResult.latencyMs,
            router_cache_hit: routerResult.cacheHit,
            router_input_tokens: routerResult.usage.inputTokens,
            router_cache_read_tokens: routerResult.usage.cacheReadTokens,
            router_raw: routerResult.error ? (routerResult.rawJson?.slice(0, 500) ?? null) : null,
            router_error: routerResult.error,
          })
          .then(({ error: matchError }: { error: { message: string } | null }) => {
            if (matchError) {
              Sentry.captureException(new Error('Chat: match-event insert failed'), {
                tags: { feature: 'chat' },
                extra: { dbError: matchError.message, messageId: assistantMessageId },
              });
            }
          });
      });

    auth.client
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', activeConversationId)
      .then(({ error: tsError }: { error: { message: string } | null }) => {
        if (tsError) {
          console.error('Error updating conversation timestamp:', tsError);
          Sentry.captureException(new Error('Chat: Failed to update conversation timestamp'), {
            tags: { feature: 'chat' },
            extra: { conversationId: activeConversationId, dbError: tsError.message },
          });
        }
      });

    logAudit(auth.userId, 'CHAT_MESSAGE', 'chat', activeConversationId, {
      cacheRead: completion.usage.cacheReadTokens,
      cacheCreation: completion.usage.cacheCreationTokens,
    });

    console.log(JSON.stringify({
      evt: 'chat_timing',
      totalMs: Date.now() - t0,
      contextMs: tAfterContext - t0,
      preLlmMs: tBeforeLlm - t0,
      llmMs: tAfterLlm - tBeforeLlm,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      cacheReadTokens: completion.usage.cacheReadTokens,
      cacheCreationTokens: completion.usage.cacheCreationTokens,
      cacheHitRatio: Math.round(100 * completion.usage.cacheReadTokens / Math.max(1, completion.usage.inputTokens)) / 100,
      routerMs: routerResult.latencyMs,
      routerCacheHit: routerResult.cacheHit,
      routerInputTokens: routerResult.usage.inputTokens,
      routerCacheReadTokens: routerResult.usage.cacheReadTokens,
      handleCount: routerResult.handles.length,
      routerError: routerResult.error,
      isGuest: auth.isGuest,
    }));

    return json({
      success: true,
      conversationId: activeConversationId,
      messageId: null,
      content: completion.content,
      ...(auth.isGuest ? { sessionToken: auth.sessionToken, isGuest: true } : {}),
    });
  } catch (error) {
    if (error instanceof GuestRateLimitError) {
      return json({ success: false, error: 'rate_limited' }, { status: 429 });
    }
    console.error('Chat action error:', error);
    Sentry.captureException(error, { tags: { feature: 'chat' } });
    return json({ success: false, error: 'Failed to process message' }, { status: 500 });
  }
}
