/**
 * Chat API — CRUD for conversations + LLM chat via Shopify app proxy.
 *
 * GET  /api/chat                         — List conversations + daily remaining
 * GET  /api/chat?conversationId=xxx      — Load conversation messages
 * POST /api/chat { message, conversationId? } — Send message, get response
 * DELETE /api/chat { conversationId }    — Delete conversation
 */
import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from '@remix-run/node';
import * as Sentry from '@sentry/remix';
import { getAuthenticatedUser, EXEMPT_CUSTOMERS, checkSubscriptionFromTags, getCustomerOrders, getClientIp } from '../lib/route-helpers.server';
import { logAudit, getProfile, deductMessageCredit, updateSubscriptionPlan, createUserClient, getOrCreateGuestSession, GuestRateLimitError, type DbProfile } from '../lib/supabase.server';
import {
  checkDailyLimit,
  incrementDailyLimitCache,
  assembleChatContext,
  assembleGuestChatContext,
  buildSystemBlocks,
  buildConversationMessages,
  matchDocumentTitle,
  loadMatchedArticles,
  getChatCompletion,
  warmupCache,
  CHAT_MODEL,
  MAX_MESSAGE_LENGTH,
  FREE_DAILY_LIMIT,
  GUEST_DAILY_LIMIT,
} from '../lib/chat.server';

import { buildPackUrls } from '../lib/message-packs';

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

// ---------------------------------------------------------------------------
// GET — list conversations or load conversation messages
// ---------------------------------------------------------------------------

// Prompt cache warmup cooldown (4 min — cache TTL is 5 min)
let lastWarmupAt = Date.now();
const WARMUP_COOLDOWN = 4 * 60_000;

export async function loader({ request }: LoaderFunctionArgs) {
  // Warm the Anthropic prompt cache if stale — fires in background, doesn't block response.
  // Must be before the guest early-return so first-time visitors also trigger warmup.
  if (Date.now() - lastWarmupAt > WARMUP_COOLDOWN) {
    lastWarmupAt = Date.now();
    warmupCache().catch(err => console.warn('Chat warmup failed:', (err as Error).message));
  }

  try {
    const url = new URL(request.url);

    // Guest without a session token — return empty default (don't create a session just to list conversations)
    const sessionToken = url.searchParams.get('sessionToken');
    const hasCustomerId = !!url.searchParams.get('logged_in_customer_id');
    if (!hasCustomerId && !sessionToken) {
      return json({
        success: true,
        conversations: [],
        dailyRemaining: GUEST_DAILY_LIMIT,
        messageCredits: 0,
        packs: [],
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

    // List conversations + get profile for plan check (parallelize)
    const [convResult, profile] = await Promise.all([
      auth.client
        .from('chat_conversations')
        .select('id, title, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(50),
      auth.isGuest ? Promise.resolve(null) : getProfile(auth.client),
    ]);

    if (convResult.error) {
      console.error('Error listing conversations:', convResult.error);
      return json({ success: false, error: 'Failed to load conversations' }, { status: 500 });
    }

    const messageCredits = profile?.message_credits ?? 0;
    const isExempt = !auth.isGuest && auth.customerId && EXEMPT_CUSTOMERS.has(auth.customerId);

    // Lazy subscription check (at most once per 24 hours)
    const plan = (!auth.isGuest && auth.customerId && profile)
      ? await refreshSubscriptionIfStale(
          { admin: auth.admin, customerId: auth.customerId, userId: auth.userId },
          profile,
        )
      : 'free';

    const limitResult = isExempt
      ? { allowed: true, remaining: 999, useCredit: false, messageCredits }
      : await checkDailyLimit(auth.client, auth.userId, plan, messageCredits, auth.isGuest);

    return json({
      success: true,
      conversations: (convResult.data ?? []).map(c => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updated_at,
        createdAt: c.created_at,
      })),
      dailyRemaining: limitResult.remaining,
      messageCredits,
      packs: (!auth.isGuest && limitResult.remaining <= 0 && messageCredits <= 0) ? buildPackUrls() : [],
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
  try {
    if (process.env.CHAT_ENABLED === 'false') {
      return json({ success: false, error: 'Chat is temporarily disabled' }, { status: 503 });
    }

    const body = await request.json();

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

    // Assemble context — guest uses client-supplied inputs, authenticated loads from Supabase
    let context;
    let orderSummary = '';

    if (auth.isGuest) {
      context = body.guestInputs
        ? assembleGuestChatContext(body.guestInputs)
        : { userContextJson: '{}', subscriptionPlan: 'free', messageCredits: 0, healthDocuments: [] };
    } else {
      [context, orderSummary] = await Promise.all([
        assembleChatContext(auth.client, auth.userId),
        auth.admin ? getCachedOrders(auth.admin, auth.customerId!) : Promise.resolve(''),
      ]);
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

    const isExempt = !auth.isGuest && auth.customerId && EXEMPT_CUSTOMERS.has(auth.customerId);
    const limitCheck = isExempt
      ? { allowed: true, remaining: 999, useCredit: false, messageCredits: context.messageCredits }
      : await checkDailyLimit(auth.client, auth.userId, context.subscriptionPlan, context.messageCredits, auth.isGuest);
    let responseCredits = limitCheck.messageCredits;

    if (!limitCheck.allowed) {
      return json({
        success: false,
        error: 'limit_reached',
        dailyRemaining: 0,
        messageCredits: 0,
        packs: buildPackUrls(),
      }, { status: 429 });
    }

    // Deduct a credit if daily limit was exceeded
    if (limitCheck.useCredit) {
      const newBalance = await deductMessageCredit(auth.userId);
      if (newBalance === -1) {
        // Race condition: credits exhausted between check and deduct
        return json({
          success: false,
          error: 'limit_reached',
          dailyRemaining: 0,
          messageCredits: 0,
          packs: buildPackUrls(),
        }, { status: 429 });
      }
      responseCredits = newBalance;
    }

    if (!isExempt && !limitCheck.useCredit) {
      incrementDailyLimitCache(auth.userId);
    }

    // Create or validate conversation
    let activeConversationId = conversationId;
    if (!activeConversationId) {
      const title = message.slice(0, 80);
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

    // Load history FIRST (before insert) to avoid fragile content-based dedup
    const { data: historyRows } = await auth.client
      .from('chat_messages')
      .select('role, content')
      .eq('conversation_id', activeConversationId)
      .order('created_at', { ascending: true });

    const history = (historyRows ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>;

    // Then insert user message
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

    // Match and load blog articles — try current message, fall back to first message
    const firstUserMsg = history.find(m => m.role === 'user');
    const blogArticles = loadMatchedArticles(message, firstUserMsg?.content);

    // Build system blocks + messages, call LLM
    const systemBlocks = buildSystemBlocks(context.userContextJson, { documentContent, orderSummary, blogArticles });
    const messages = buildConversationMessages(history, message);
    const completion = await getChatCompletion(systemBlocks, messages);

    // Fire-and-forget: save assistant message + update timestamp after returning response
    // User sees the response immediately — DB writes happen in background
    auth.client
      .from('chat_messages')
      .insert({
        conversation_id: activeConversationId,
        user_id: auth.userId,
        role: 'assistant',
        content: completion.content,
        input_tokens: completion.usage.inputTokens,
        output_tokens: completion.usage.outputTokens,
        model: CHAT_MODEL,
      })
      .then(({ error }) => {
        if (error) {
          console.error('Error saving assistant message:', error);
          Sentry.captureException(new Error('Chat: Failed to save assistant message'), {
            tags: { feature: 'chat' },
            extra: { conversationId: activeConversationId, dbError: error.message },
          });
        }
      });

    auth.client
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', activeConversationId)
      .then(({ error }) => {
        if (error) {
          console.error('Error updating conversation timestamp:', error);
          Sentry.captureException(new Error('Chat: Failed to update conversation timestamp'), {
            tags: { feature: 'chat' },
            extra: { conversationId: activeConversationId, dbError: error.message },
          });
        }
      });

    logAudit(auth.userId, 'CHAT_MESSAGE', 'chat', activeConversationId, {
      cacheRead: completion.usage.cacheReadTokens,
      cacheCreation: completion.usage.cacheCreationTokens,
    });

    const finalRemaining = limitCheck.useCredit ? 0 : Math.max(0, limitCheck.remaining - 1);
    return json({
      success: true,
      conversationId: activeConversationId,
      messageId: null,
      content: completion.content,
      dailyRemaining: finalRemaining,
      messageCredits: responseCredits,
      packs: (!auth.isGuest && finalRemaining <= 0 && responseCredits <= 0) ? buildPackUrls() : [],
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
