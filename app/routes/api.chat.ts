/**
 * Chat API — CRUD for conversations + LLM chat via Shopify app proxy.
 *
 * GET  /api/chat                         — List conversations + daily remaining
 * GET  /api/chat?conversationId=xxx      — Load conversation messages
 * POST /api/chat { message, conversationId? } — Send message, get response
 * DELETE /api/chat { conversationId }    — Delete conversation
 */
import { type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import * as Sentry from '@sentry/react-router';
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
  reportChatFallback,
  generateTitle,
  CHAT_MODEL,
  MAX_MESSAGE_LENGTH,
} from '../lib/chat.server';
import { routeQuery, sanitizeForRouter, ROUTER_VERSION } from '../lib/chat-router.server';
import { classifyMessage, shouldFireRouter } from '../lib/chat-classifier.server';
import { findDuplicateReply } from '../lib/chat-dedup.server';

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

async function getAuthOrGuest(
  request: Request,
  sessionToken?: string | null,
  // Local-first clients (Health Plan v2 on drstanfield.com): the user's plan
  // lives in THEIR cloud, never our DB, so even a logged-in Shopify customer has
  // no server-side health record to read. Force the guest path — context comes
  // from the client-supplied `guestInputs`, conversations store under the guest
  // session — while still verifying the app-proxy HMAC via getAuthenticatedUser.
  // Brad pays either way; this only changes WHERE the context comes from.
  forceGuest = false,
): Promise<AuthResult> {
  // Try authenticated user first (also verifies HMAC internally)
  const auth = await getAuthenticatedUser(request);
  if (auth && !forceGuest) {
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
      return Response.json({
        success: true,
        conversations: [],
        isGuest: true,
      });
    }

    let auth: AuthResult;
    try {
      auth = await getAuthOrGuest(request, sessionToken, url.searchParams.get('localFirst') === '1');
    } catch (err) {
      if (err instanceof GuestRateLimitError) {
        return Response.json({ success: false, error: 'rate_limited' }, { status: 429 });
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
        return Response.json({ success: false, error: 'Failed to load messages' }, { status: 500 });
      }

      return Response.json({
        success: true,
        messages: (data ?? []).map((m: { id: string; role: string; content: string; created_at: string }) => ({
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
      return Response.json({ success: false, error: 'Failed to load conversations' }, { status: 500 });
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

    return Response.json({
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
      return Response.json({ success: false, error: 'rate_limited' }, { status: 429 });
    }
    console.error('Chat loader error:', error);
    Sentry.captureException(error, { tags: { feature: 'chat' } });
    return Response.json({ success: false, error: 'Internal error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST/DELETE — send message or delete conversation
// ---------------------------------------------------------------------------

export async function action({ request }: ActionFunctionArgs) {
  const t0 = Date.now();
  try {
    if (process.env.CHAT_ENABLED === 'false') {
      return Response.json({ success: false, error: 'Chat is temporarily disabled' }, { status: 503 });
    }

    const body = await request.json();

    let auth: AuthResult;
    try {
      auth = await getAuthOrGuest(request, body.sessionToken, body.localFirst === true);
    } catch (err) {
      if (err instanceof GuestRateLimitError) {
        return Response.json({ success: false, error: 'rate_limited' }, { status: 429 });
      }
      throw err;
    }

    // ----- DELETE -----
    if (request.method === 'DELETE') {
      const { conversationId } = body;
      if (!conversationId || typeof conversationId !== 'string') {
        return Response.json({ success: false, error: 'conversationId required' }, { status: 400 });
      }

      const { error } = await auth.client
        .from('chat_conversations')
        .delete()
        .eq('id', conversationId);

      if (error) {
        console.error('Error deleting conversation:', error);
        return Response.json({ success: false, error: 'Failed to delete' }, { status: 500 });
      }

      logAudit(auth.userId, 'CHAT_CONVERSATION_DELETED', 'chat', conversationId);
      return Response.json({ success: true });
    }

    // ----- POST — send message -----
    const { message, conversationId } = body;

    if (!message || typeof message !== 'string') {
      return Response.json({ success: false, error: 'message required' }, { status: 400 });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return Response.json({ success: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` }, { status: 400 });
    }

    // Sanitize message for router (strips control chars, caps at 2000 chars)
    const sanitizedCurrent = sanitizeForRouter(message);

    // History pre-load: for existing conversations load now so router gets context.
    // For new conversations (no conversationId yet) history is empty by definition.
    // is_fallback is needed for the dedup check below; created_at for the time window.
    let history: Array<{ role: 'user' | 'assistant'; content: string; created_at: string; is_fallback: boolean | null }> = [];
    if (conversationId) {
      const { data: historyRows } = await auth.client
        .from('chat_messages')
        .select('role, content, created_at, is_fallback')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      history = (historyRows ?? []) as Array<{ role: 'user' | 'assistant'; content: string; created_at: string; is_fallback: boolean | null }>;
    }

    // Dedup: re-serve the previous reply if the user just double-sent the same
    // message. See app/lib/chat-dedup.server.ts and chat-architecture.md §
    // Consecutive-duplicate dedup. Shared with the Discord handler.
    if (conversationId) {
      const dup = findDuplicateReply(history, message);
      if (dup) {
        Sentry.captureMessage('chat: duplicate user message detected, re-serving previous reply', {
          level: 'info',
          tags: { feature: 'chat', platform: 'shopify', diagnostic: 'dedup' },
          extra: {
            conversationId,
            isGuest: auth.isGuest,
            userId: auth.userId,
            ageMs: dup.ageMs,
            messageLength: message.length,
          },
        });
        return Response.json({
          success: true,
          conversationId,
          messageId: null,
          content: dup.content,
          ...(auth.isGuest ? { sessionToken: auth.sessionToken, isGuest: true } : {}),
        });
      }
    }

    const firstUserMsg = history.find(m => m.role === 'user')?.content;
    const recentUserMsgs = history.filter(m => m.role === 'user').slice(-3).map(m => m.content);
    const sanitizedFirst = firstUserMsg ? sanitizeForRouter(firstUserMsg) : undefined;
    const sanitizedRecent = recentUserMsgs.map(sanitizeForRouter);

    // Stage 1: classifier runs in parallel with user-data + orders. The
    // classifier returns in ~100-200ms, by which time user-data is usually
    // still loading — overlap is free.
    let context;
    let orderSummary = '';
    const classifierPromise = classifyMessage(sanitizedCurrent, sanitizedFirst, sanitizedRecent);

    let classifierResult;
    if (auth.isGuest) {
      // `?? empty`: guestInputs that fail schema validation (an EMPTY form —
      // v2 invites chat before any data entry — or a malformed payload) get the
      // no-data context instead of nulling out and 500ing downstream.
      const emptyGuestContext = { userContextJson: '{}', subscriptionPlan: 'free', messageCredits: 0, healthDocuments: [] };
      [context, classifierResult] = await Promise.all([
        Promise.resolve(
          (body.guestInputs ? assembleGuestChatContext(body.guestInputs) : null) ?? emptyGuestContext
        ),
        classifierPromise,
      ]);
    } else {
      let ctxResult: [Awaited<ReturnType<typeof assembleChatContext>>, string];
      [ctxResult, classifierResult] = await Promise.all([
        Promise.all([
          assembleChatContext(auth.client, auth.userId),
          auth.admin ? getCachedOrders(auth.admin, auth.customerId!) : Promise.resolve(''),
        ]) as Promise<[Awaited<ReturnType<typeof assembleChatContext>>, string]>,
        classifierPromise,
      ]);
      [context, orderSummary] = ctxResult;
    }

    // Stage 2: router fires ONLY when the classifier didn't bypass it.
    // Trade-off: +150-300ms on ROUTE turns vs the previous parallel design,
    // since the router now waits for the classifier to return. See
    // chat-architecture.md § Pre-router classifier for the timing analysis.
    const routerResult = shouldFireRouter(classifierResult)
      ? await routeQuery(sanitizedCurrent, sanitizedFirst, sanitizedRecent)
      : null;

    const tAfterContext = Date.now();

    const routerSkipped = classifierResult.routerSkipped;
    const effectiveHandles = routerResult?.handles ?? [];

    if (routerResult?.error) {
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
      return Response.json({ success: false, error: 'Could not load health data' }, { status: 500 });
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
        return Response.json({ success: false, error: 'Failed to create conversation' }, { status: 500 });
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
      return Response.json({ success: false, error: 'Failed to save message' }, { status: 500 });
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

    // Load content from router handles — [] when classifier said SKIP (router never ran).
    const blogArticles = loadMatchedArticlesFromHandles(effectiveHandles);

    // Build system blocks + messages, call LLM
    const systemBlocks = buildSystemBlocks(context.userContextJson, { documentContent, orderSummary, blogArticles });
    const conversationMessages = buildConversationMessages(history, message);
    const tBeforeLlm = Date.now();
    const completion = await getChatCompletion(systemBlocks, conversationMessages);
    const tAfterLlm = Date.now();

    // Pre-generate the assistant message UUID so chat_match_events can FK it cleanly.
    const assistantMessageId = crypto.randomUUID();

    reportChatFallback({
      completion,
      platform: 'shopify',
      conversationId: activeConversationId,
      messagePreview: message,
      latencyMs: tAfterLlm - tBeforeLlm,
      matchedHandles: effectiveHandles,
      userId: auth.userId,
      isGuest: auth.isGuest,
    });

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
        is_fallback: completion.isFallback,
        // Persist the fallback cause so the daily audit email is self-diagnosing
        // (previously only sent to Sentry via reportChatFallback). Null on success.
        failure_mode: completion.failureMode ?? null,
        error_detail: completion.errorDetail?.slice(0, 500) ?? null,
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
        // FK on message_id now satisfied — safe to insert match event.
        auth.client
          .from('chat_match_events')
          .insert({
            message_id: assistantMessageId,
            conversation_id: activeConversationId,
            user_id: auth.userId,
            message: sanitizedCurrent,
            router_context: {
              first: sanitizedFirst ?? null,
              recent: sanitizedRecent,
            },
            matched_handles: effectiveHandles,
            router_version: routerResult ? ROUTER_VERSION : null,
            router_latency_ms: routerResult?.latencyMs ?? null,
            router_cache_hit: routerResult?.cacheHit ?? null,
            router_input_tokens: routerResult?.usage.inputTokens ?? null,
            router_cache_read_tokens: routerResult?.usage.cacheReadTokens ?? null,
            router_raw: routerResult?.error ? (routerResult.rawJson?.slice(0, 500) ?? null) : null,
            router_error: routerResult?.error ?? null,
            classification: classifierResult.classification,
            router_skipped: routerSkipped,
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
      routerMs: routerResult?.latencyMs ?? null,
      routerCacheHit: routerResult?.cacheHit ?? null,
      routerInputTokens: routerResult?.usage.inputTokens ?? null,
      routerCacheReadTokens: routerResult?.usage.cacheReadTokens ?? null,
      handleCount: routerResult?.handles.length ?? 0,
      effectiveHandleCount: effectiveHandles.length,
      routerError: routerResult?.error ?? null,
      classifierMs: classifierResult.latencyMs,
      classification: classifierResult.classification,
      routerSkipped,
      classifierError: classifierResult.error,
      isGuest: auth.isGuest,
    }));

    return Response.json({
      success: true,
      conversationId: activeConversationId,
      messageId: null,
      content: completion.content,
      ...(auth.isGuest ? { sessionToken: auth.sessionToken, isGuest: true } : {}),
    });
  } catch (error) {
    if (error instanceof GuestRateLimitError) {
      return Response.json({ success: false, error: 'rate_limited' }, { status: 429 });
    }
    console.error('Chat action error:', error);
    Sentry.captureException(error, { tags: { feature: 'chat' } });
    return Response.json({ success: false, error: 'Failed to process message' }, { status: 500 });
  }
}
