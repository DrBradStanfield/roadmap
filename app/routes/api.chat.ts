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
import { getAuthenticatedUser, checkSubscriptionFromTags, getCustomerOrders, isValidUuid } from '../lib/route-helpers.server';
import { getClientIp } from '../lib/local-first-route.server';
import { logAudit, getProfile, updateSubscriptionPlan, createUserClient, getOrCreateGuestSession, GuestRateLimitError, type DbProfile } from '../lib/supabase.server';
import {
  resolveChatContext,
  buildSystemBlocks,
  buildConversationMessages,
  matchDocumentTitle,
  loadMatchedArticlesFromHandles,
  DOCTOR_POSTURE,
  BRAND_POSTURE,
  getChatCompletion,
  reportChatFallback,
  generateTitle,
  CHAT_MODEL,
  MAX_MESSAGE_LENGTH,
} from '../lib/chat.server';
import { routeQuery, reportRouterFailure, sanitizeForRouter, redactForWidget, routerText, ROUTER_VERSION } from '../lib/chat-router.server';
import { titledHandles } from '../lib/chat-router-guard';
import { MAX_HISTORY_MESSAGES, MAX_HISTORY_TURN_CHARS, cutText } from '../../packages/health-core/src/chat-history';
import { classifyMessage, shouldFireRouter } from '../lib/chat-classifier.server';
import { findDuplicateReply, type DedupHistoryItem } from '../lib/chat-dedup.server';
import { PURGED_TEXT } from '../lib/chat-purge-cron.server';


// Only fixed operation descriptions enter diagnostics. Database errors can echo
// conversation contents even when every identifier passed validation.
function reportChatError(message: string): void {
  console.error(message);
  Sentry.captureException(new Error(message), { tags: { feature: 'chat' } });
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && isValidUuid(value.toLowerCase());
}

type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * The widget's earlier turns, sent from its own chat-history.json (US-15 AC7:
 * the server stores none). Whitelisted roles, non-empty strings, the same
 * bound the BYOK transport uses, each turn cut at MAX_HISTORY_TURN_CHARS (no
 * shorter than a question may be), and never starting on an assistant turn — the Messages API 400s on that,
 * which would surface as a fallback.
 */
function readClientHistory(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  const turns = value.slice(-MAX_HISTORY_MESSAGES).filter((t): t is Turn =>
    !!t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant')
    && typeof t.content === 'string' && t.content.length > 0)
    .map((t) => ({ role: t.role, content: cutText(t.content, MAX_HISTORY_TURN_CHARS) }));
  return turns.slice(Math.max(0, turns.findIndex((t) => t.role === 'user')));
}

/**
 * An NDJSON reply (US-15 AC16): one JSON object per line, written as `run`
 * produces them. The status is sent before the answer exists, so a failure
 * inside `run` ends the stream with an error `done` line instead. A reader
 * that went away does not stop the turn: `run` still finishes and persists.
 * `no-transform` keeps proxies from buffering the stream to compress it.
 */
function streamTurn(run: (write: (line: object) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: object) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(line) + '\n')); } catch { /* reader gone */ }
      };
      void run(write)
        .catch(() => {
          reportChatError('Chat: Action failed');
          write({ type: 'done', success: false, error: 'Failed to process message' });
        })
        .finally(() => { try { controller.close(); } catch { /* reader gone */ } });
    },
  });
  return new Response(body, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' },
  });
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
  const ip = getClientIp(request, 'shopify');
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
  updateSubscriptionPlan(auth.userId, plan).catch(() => {
    reportChatError('Chat: Failed to update subscription plan');
  });
  return plan;
}

// ---------------------------------------------------------------------------
// GET — list conversations or load conversation messages
// ---------------------------------------------------------------------------

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('conversationId');
    if (conversationId !== null && !validConversationId(conversationId)) {
      return Response.json({ success: false, error: 'Invalid conversationId' }, { status: 400 });
    }

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

    const auth = await getAuthOrGuest(request, sessionToken, url.searchParams.get('localFirst') === '1');

    if (conversationId) {
      const { data, error } = await auth.client
        .from('chat_messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });

      if (error) {
        reportChatError('Chat: Failed to load messages');
        return Response.json({ success: false, error: 'Failed to load messages' }, { status: 500 });
      }

      return Response.json({
        success: true,
        // A turn past the 30-day window keeps its place in the thread but not
        // its words (US-15 AC8, chat-purge-cron.server.ts).
        messages: (data ?? []).map((m: { id: string; role: string; content: string | null; created_at: string }) => ({
          id: m.id,
          role: m.role,
          content: m.content ?? PURGED_TEXT,
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
      reportChatError('Chat: Failed to list conversations');
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
      })().catch(() => {
        reportChatError('Chat: Subscription refresh failed');
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
    // One ladder for both handlers (the action's catch mirrors it): the
    // app-proxy check rejects an unsigned request by THROWING a 400 Response,
    // which the framework returns as-is (US-15 AC9); a guest over the daily
    // cap is a 429; only our own failures are reported.
    if (error instanceof Response) throw error;
    if (error instanceof GuestRateLimitError) {
      return Response.json({ success: false, error: 'rate_limited' }, { status: 429 });
    }
    reportChatError('Chat: Loader failed');
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

    // A malformed body is client error, not ours: Node's SyntaxError message
    // quotes the offending text, so it must not reach the outer capture.
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ success: false, error: 'JSON object required' }, { status: 400 });
    }
    // Omitted/null means a new conversation; an explicitly empty ID is invalid.
    if ((body.conversationId != null || request.method === 'DELETE') && !validConversationId(body.conversationId)) {
      return Response.json({ success: false, error: 'Invalid conversationId' }, { status: 400 });
    }

    const auth = await getAuthOrGuest(request, body.sessionToken, body.localFirst === true);

    // ----- DELETE -----
    if (request.method === 'DELETE') {
      const { conversationId } = body;
      const { error } = await auth.client
        .from('chat_conversations')
        .delete()
        .eq('id', conversationId);

      if (error) {
        reportChatError('Chat: Failed to delete conversation');
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

    // The widget (localFirst) sends the record with every turn, so nothing it
    // says is stored: no conversation row, no message rows, no dedup — its
    // history arrives in the body (US-15 AC7). The other surfaces keep their
    // transcripts server-side and load them here; is_fallback is needed for
    // the dedup check below, created_at for the time window.
    const widget = body.localFirst === true;
    let history: Turn[] = widget ? readClientHistory(body.history) : [];
    let storedHistory: DedupHistoryItem[] = [];
    if (conversationId && !widget) {
      const { data: historyRows, error: historyError } = await auth.client
        .from('chat_messages')
        .select('role, content, created_at, is_fallback, failure_mode')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      if (historyError) reportChatError('Chat: Failed to load conversation history');
      // Purged turns are gone, not empty: send the model only the words that
      // are still there, and never dedup against a blank (US-15 AC8).
      const live = (historyRows ?? []).filter(
        (m: { content: string | null }) => m.content !== null,
      ) as DedupHistoryItem[];
      // The purge is per row, so on the one tick where the cutoff falls between
      // a question and its reply the history could open on an assistant turn.
      // Start it at the first user turn, as readClientHistory does.
      storedHistory = live.slice(Math.max(0, live.findIndex((m) => m.role === 'user')));
      history = storedHistory;
    }

    // Dedup: re-serve the previous reply if the user just double-sent the same
    // message. See app/lib/chat-dedup.server.ts and chat-architecture.md §
    // Consecutive-duplicate dedup. Shared with the Discord handler. The widget
    // dedups from its own file (chat-api.ts) — its rows here carry no timestamp.
    if (conversationId && !widget) {
      const dup = findDuplicateReply(storedHistory, message);
      if (dup) {
        Sentry.captureMessage('chat: duplicate user message detected, re-serving previous reply', {
          level: 'info',
          tags: { feature: 'chat', platform: 'shopify', diagnostic: 'dedup' },
          extra: {
            isGuest: auth.isGuest,
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

    // Only the widget's own chat applies form edits, so only it gets the tools (US-15 AC19).
    const canApplyEdits = body.canApplyEdits === true;
    // The streamed turn opens its stream here, before stage 1, so the user
    // sees progress while the classifier, router and content load (US-15
    // AC20). From here on a failure is a `done` line there and an HTTP 500
    // on the JSON path. CHAT_STREAMING=false is the off switch: the client
    // reads a JSON reply unchanged (AC16).
    const streaming = body.stream === true && process.env.CHAT_STREAMING !== 'false';

    /** Stages 1–3 and the answer. `write` is the stream's; a no-op on the JSON path. */
    const runTurn = async (write: (line: object) => void): Promise<{ status?: number; reply: object }> => {
      write({ type: 'status', text: 'Reading your question' });

      const firstUserMsg = history.find(m => m.role === 'user')?.content;
      const recentUserMsgs = history.filter(m => m.role === 'user').slice(-3).map(m => m.content);
      const sanitizedFirst = firstUserMsg ? sanitizeForRouter(firstUserMsg) : undefined;
      const sanitizedRecent = recentUserMsgs.map(sanitizeForRouter);

      // Stage 1: classifier + (logged-in) orders fetch dispatch first so their
      // network round-trips overlap the synchronous context assembly below.
      // Health context is client-supplied on every v2 surface — the v1
      // server-side health tables were purged June 2026 — so it's built from
      // body.guestInputs for guests and logged-in customers alike
      // (missing/invalid inputs degrade to the empty context).
      const ordersPromise = !auth.isGuest && auth.admin
        ? getCachedOrders(auth.admin, auth.customerId!)
        : Promise.resolve('');
      const classifierPromise = classifyMessage(sanitizedCurrent, sanitizedFirst, sanitizedRecent);
      const context = resolveChatContext(body.guestInputs);
      const [orderSummary, classifierResult] = await Promise.all([ordersPromise, classifierPromise]);

      // Stage 2: router fires ONLY when the classifier didn't bypass it.
      // Trade-off: +150-300ms on ROUTE turns vs the previous parallel design,
      // since the router now waits for the classifier to return. See
      // chat-architecture.md § Pre-router classifier for the timing analysis.
      const fireRouter = shouldFireRouter(classifierResult);
      if (fireRouter) write({ type: 'status', text: 'Finding relevant articles' });
      const routerResult = fireRouter
        ? await routeQuery(sanitizedCurrent, sanitizedFirst, sanitizedRecent)
        : null;

      const tAfterContext = Date.now();

      const routerSkipped = classifierResult.routerSkipped;
      const effectiveHandles = routerResult?.handles ?? [];

      reportRouterFailure(routerResult);

      // Create or validate conversation. A widget conversation exists only in the
      // user's file; the id here is a grouping key for its telemetry rows.
      let activeConversationId = conversationId;
      if (!activeConversationId && widget) activeConversationId = crypto.randomUUID();
      if (!activeConversationId) {
        const title = generateTitle(message);
        const { data: conv, error: convError } = await auth.client
          .from('chat_conversations')
          .insert({ user_id: auth.userId, title })
          .select('id')
          .single();

        if (convError || !conv) {
          reportChatError('Chat: Failed to create conversation');
          return { status: 500, reply: { success: false, error: 'Failed to create conversation' } };
        }
        activeConversationId = conv.id;
      }

      // Insert user message (history already loaded above for existing convs)
      if (!widget) {
        const { error: userMsgError } = await auth.client
          .from('chat_messages')
          .insert({
            conversation_id: activeConversationId,
            user_id: auth.userId,
            role: 'user',
            content: message,
          });

        if (userMsgError) {
          reportChatError('Chat: Failed to save user message');
          return { status: 500, reply: { success: false, error: 'Failed to save message' } };
        }
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
      // The stream names the articles loaded, by their index titles (US-15 AC20),
      // except crisis pathways and population pathways the text gives no signal
      // of (AC25). Every routed article still loads.
      const titled = titledHandles(effectiveHandles, routerText(sanitizedCurrent, sanitizedFirst, sanitizedRecent));
      const articles = loadMatchedArticlesFromHandles(effectiveHandles, titled);
      if (articles?.titles.length) write({ type: 'sources', titles: articles.titles });

      // Build system blocks + messages, call LLM
      // Surface posture: the brand store (microvitamin.com) sets CHAT_SURFACE=brand;
      // everything else (drstanfield.com education) defaults to the strict doctor
      // posture — a config slip can never silently produce a selling bot.
      const surfaceContext = process.env.CHAT_SURFACE === 'brand' ? BRAND_POSTURE : DOCTOR_POSTURE;
      const systemBlocks = buildSystemBlocks(context.userContextJson, { surfaceContext, documentContent, orderSummary, blogArticles: articles?.content ?? null });
      const conversationMessages = buildConversationMessages(history, message);
      const tBeforeLlm = Date.now();

      write({ type: 'status', text: 'Writing the answer' });
      let firstTokenMs: number | null = null;
      const completion = streaming
        ? await getChatCompletion(systemBlocks, conversationMessages, canApplyEdits, (event) => {
          if (event.type === 'text' && firstTokenMs === null) firstTokenMs = Date.now() - tBeforeLlm;
          write(event);
        })
        : await getChatCompletion(systemBlocks, conversationMessages, canApplyEdits);
      const tAfterLlm = Date.now();

      // The assistant message id doubles as the telemetry row's message_id on
      // the stored surfaces; the widget has no message row, so null there.
      const assistantMessageId = widget ? null : crypto.randomUUID();

      reportChatFallback({
        completion,
        platform: 'shopify',
        latencyMs: tAfterLlm - tBeforeLlm,
        conversationId: activeConversationId,
      });

      // Router telemetry, one row per answered turn. On the widget it is the ONLY
      // row, trimmed to its whitelist in one place (redactForWidget).
      // The row holds question text, which may carry health details: at most its
      // first 500 chars, as before the 8,000 cap, blanked by the 30-day purge
      // (US-15 AC7/AC26). CLAUDE.md keeps health values out of telemetry, so it never grows.
      const MATCH_EVENT_MESSAGE_CHARS = 500;
      const clip = (s: string) => cutText(s, MATCH_EVENT_MESSAGE_CHARS);
      const matchEvent = {
        message_id: assistantMessageId,
        conversation_id: activeConversationId,
        user_id: auth.userId,
        message: clip(sanitizedCurrent),
        router_context: {
          platform: 'shopify',
          first: sanitizedFirst ? clip(sanitizedFirst) : null,
          recent: sanitizedRecent.map(clip),
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
        is_fallback: completion.isFallback,
        failure_mode: completion.failureMode ?? null,
      };
      const logMatchEvent = () => auth.client
        .from('chat_match_events')
        .insert(widget ? redactForWidget(matchEvent) : matchEvent)
        .then(({ error: matchError }: { error: { message: string } | null }) => {
          if (matchError) {
            reportChatError('Chat: Match-event insert failed');
          }
        }).catch(() => reportChatError('Chat: Match-event insert failed'));

      if (widget) {
        logMatchEvent();
      } else {
        // Fire-and-forget: save the assistant message, then log the match event
        // once its message_id names a row that exists.
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
              reportChatError('Chat: Failed to save assistant message');
              return;
            }
            logMatchEvent();
          }).catch(() => reportChatError('Chat: Failed to save assistant message'));

        auth.client
          .from('chat_conversations')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', activeConversationId)
          .then(({ error: tsError }: { error: { message: string } | null }) => {
            if (tsError) {
              reportChatError('Chat: Failed to update conversation timestamp');
            }
          }).catch(() => reportChatError('Chat: Failed to update conversation timestamp'));
      }

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
        // Bounded: the API's stop_reason and, on a refusal, the closed category.
        stopReason: completion.stopReason ?? null,
        refusalCategory: completion.refusalCategory ?? null,
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        cacheReadTokens: completion.usage.cacheReadTokens,
        cacheCreationTokens: completion.usage.cacheCreationTokens,
        // Share of the prompt served from cache, 0–1. The three counters are
        // DISJOINT — Anthropic's `input_tokens` excludes cache reads and cache
        // writes — so the denominator is their sum, not inputTokens alone.
        // (Dividing by inputTokens alone reported 8.63 on 2026-08-06.)
        cacheHitRatio: Math.round(100 * completion.usage.cacheReadTokens / Math.max(1,
          completion.usage.inputTokens + completion.usage.cacheReadTokens + completion.usage.cacheCreationTokens)) / 100,
        routerMs: routerResult?.latencyMs ?? null,
        routerCacheHit: routerResult?.cacheHit ?? null,
        routerInputTokens: routerResult?.usage.inputTokens ?? null,
        routerCacheReadTokens: routerResult?.usage.cacheReadTokens ?? null,
        handleCount: routerResult?.handles.length ?? 0,
        effectiveHandleCount: effectiveHandles.length,
        routerError: !!routerResult?.error,
        classifierMs: classifierResult.latencyMs,
        classification: classifierResult.classification,
        routerSkipped,
        classifierError: !!classifierResult.error,
        isGuest: auth.isGuest,
        streamed: streaming,
        // The question's length, a number only: how often a message passes 500 or 2,000 (US-15 AC26).
        messageChars: message.length,
        // Ms from the LLM call to the first answer text; null when not streamed or no text came.
        firstTokenMs,
      }));

      // The streamed path sends this as its `done` line.
      return {
        reply: {
          success: true,
          conversationId: activeConversationId,
          messageId: null,
          content: completion.content,
          // The widget's own dedup never re-serves a fallback (US-15 AC3) or a
          // refusal line (AC14): on the wire a refusal is a fallback too, and
          // the client drops what streamed for either (AC16).
          isFallback: completion.isFallback || completion.isRefusal === true,
          ...(completion.isRefusal ? { isRefusal: true } : {}),
          // Form edits the model proposed via tool_use (already validated server-side).
          // Omitted on normal turns — additive, no impact on existing clients.
          ...(completion.proposedEdits && completion.proposedEdits.length > 0
            ? { proposedEdits: completion.proposedEdits }
            : {}),
          ...(auth.isGuest ? { sessionToken: auth.sessionToken, isGuest: true } : {}),
        },
      };
    };

    if (streaming) {
      return streamTurn(async (write) => write({ type: 'done', ...(await runTurn(write)).reply }));
    }
    const { status, reply } = await runTurn(() => {});
    return Response.json(reply, status ? { status } : undefined);
  } catch (error) {
    if (error instanceof Response) throw error; // see the loader's catch (US-15 AC9)
    if (error instanceof GuestRateLimitError) {
      return Response.json({ success: false, error: 'rate_limited' }, { status: 429 });
    }
    reportChatError('Chat: Action failed');
    return Response.json({ success: false, error: 'Failed to process message' }, { status: 500 });
  }
}
