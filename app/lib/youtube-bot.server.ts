/**
 * YouTube comment auto-replier.
 *
 * Auto-starts on module import (same pattern as reminder-cron.server.ts and
 * discord-bot.server.ts). Polls the YouTube Data API every 30 minutes for new
 * top-level comments across all of Brad's videos (one channel-wide call via
 * `allThreadsRelatedToChannelId`), runs the exact chatbot pipeline on each
 * (classifier → conditional router → main LLM with chat-youtube-prompt.md),
 * and posts a reply when the model produces one.
 *
 * Race-safe across multiple Fly machines via INSERT ... ON CONFLICT DO NOTHING
 * on youtube_bot_log.youtube_comment_id — only one machine "claims" any
 * given comment before processing it.
 *
 * Required env (all needed — bot disables itself if any are missing):
 *   YOUTUBE_BOT_CHANNEL_ID       e.g. UCpcvPcHJVOkO9Qp79BOagTg
 *   YOUTUBE_BOT_CLIENT_ID        Google OAuth client ID
 *   YOUTUBE_BOT_CLIENT_SECRET    Google OAuth client secret
 *   YOUTUBE_BOT_REFRESH_TOKEN    Long-lived refresh token from setup_youtube_oauth.py
 *
 * Auto-start gating:
 *   FLY_APP_NAME set, OR YOUTUBE_BOT_FORCE_START=true   (avoids local-dev double-runs)
 *
 * See:
 *   docs/chat-architecture.md § YouTube comment replier
 *   tools/youtube-comment-dryrun.ts (preview tool, same pipeline)
 */
import fs from 'fs';
import path from 'path';
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin } from './supabase.server';
import { classifyMessage, shouldFireRouter } from './chat-classifier.server';
import { routeQuery, sanitizeForRouter, ROUTER_VERSION, type RouterResult } from './chat-router.server';
import { findBlogByVideoId, type BlogIndexEntry } from './blog-index.server';
import {
  buildSystemBlocks,
  buildConversationMessages,
  getChatCompletion,
  loadBlogArticle,
  loadMatchedArticlesFromHandles,
  DOCTOR_POSTURE,
  CHAT_MODEL,
} from './chat.server';
import type { AnthropicUsage } from './anthropic.server';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30 * 60_000; // 30 minutes
const COMMENTS_PER_TICK = 100;        // YouTube returns up to 100 per page
const DAILY_REPLY_CAP = 50;           // hard ceiling on posts per day
const PER_VIDEO_REPLY_CAP = 10;       // ceiling per video lifetime
const COMMENT_MAX_AGE_DAYS = 7;       // ignore comments older than this
const MIN_WORDS = 5;                  // ≥5 words to be considered substantive

const PLATFORM_YOUTUBE = 'youtube';

/**
 * FK anchor for the shared chat tables (`chat_*.user_id` is NOT NULL and
 * references profiles). Falls back to the Discord bot's pseudonymous profile so
 * YouTube persistence works with no new Supabase setup step — the rows are told
 * apart by `chat_conversations.platform`, not by this ID. Set
 * YOUTUBE_BOT_PROFILE_ID to split them later.
 */
const BOT_PROFILE_ID = process.env.YOUTUBE_BOT_PROFILE_ID ?? process.env.DISCORD_BOT_PROFILE_ID;

const CHANNEL_ID = process.env.YOUTUBE_BOT_CHANNEL_ID;
const CLIENT_ID = process.env.YOUTUBE_BOT_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_BOT_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YOUTUBE_BOT_REFRESH_TOKEN;

const YOUTUBE_PROMPT_PATH = path.join(process.cwd(), 'app/lib/chat-youtube-prompt.md');

let YOUTUBE_PROMPT_TEMPLATE = '';
try {
  YOUTUBE_PROMPT_TEMPLATE = fs.readFileSync(YOUTUBE_PROMPT_PATH, 'utf-8');
} catch {
  console.warn('YouTube bot: chat-youtube-prompt.md not found — bot will not start');
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let isRunning = false;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;
let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt = 0;

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

export function startYouTubeBot(): void {
  if (isRunning) {
    console.log('YouTube bot already running — skip start');
    return;
  }

  if (!CHANNEL_ID || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.log('YouTube bot: required env not set (YOUTUBE_BOT_CHANNEL_ID/CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN) — bot disabled');
    return;
  }

  if (!YOUTUBE_PROMPT_TEMPLATE) {
    console.warn('YouTube bot: chat-youtube-prompt.md missing — bot disabled');
    return;
  }

  // Block auto-start during local `npm run dev` so dev reloads don't spawn
  // posting loops. Developers can force-start with YOUTUBE_BOT_FORCE_START=true.
  if (!process.env.FLY_APP_NAME && process.env.YOUTUBE_BOT_FORCE_START !== 'true') {
    console.log('YouTube bot: not on Fly.io and YOUTUBE_BOT_FORCE_START != "true" — skipping');
    return;
  }

  if (!supabaseAdmin) {
    console.warn('YouTube bot: supabaseAdmin not configured — bot disabled');
    return;
  }

  console.log(`YouTube bot started (cron every ${POLL_INTERVAL_MS / 60_000} min, daily cap ${DAILY_REPLY_CAP})`);

  // Run first tick after a short delay to avoid blocking app boot.
  setTimeout(() => { tick().catch(logTickError); }, 30_000);

  cronIntervalId = setInterval(() => {
    tick().catch(logTickError);
  }, POLL_INTERVAL_MS);

  isRunning = true;
}

export function stopYouTubeBot(): void {
  if (cronIntervalId) {
    clearInterval(cronIntervalId);
    cronIntervalId = null;
  }
  isRunning = false;
  console.log('YouTube bot stopped');
}

function logTickError(err: unknown): void {
  console.error('YouTube bot tick error:', err);
  Sentry.captureException(err, { tags: { feature: 'youtube-bot' } });
}

// ---------------------------------------------------------------------------
// OAuth — refresh the access token using the long-lived refresh token
// ---------------------------------------------------------------------------

async function getAccessToken(): Promise<string> {
  // 60s buffer to avoid mid-request expiry
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube OAuth refresh failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

// ---------------------------------------------------------------------------
// Platform-context construction — substitutes the video's blog post (looked up
// via the shared blog-index/loader the on-site chatbot already uses).
// ---------------------------------------------------------------------------

function buildYouTubePlatformContext(videoId: string, entry: BlogIndexEntry, body: string): string {
  return YOUTUBE_PROMPT_TEMPLATE
    .replace('{{VIDEO_TITLE}}', entry.title)
    .replace('{{VIDEO_URL}}', `https://youtu.be/${videoId}`)
    .replace('{{VIDEO_CONTENT}}', body);
}

// ---------------------------------------------------------------------------
// YouTube Data API — list recent threads (channel-wide), post reply
// ---------------------------------------------------------------------------

interface YouTubeThread {
  topLevelCommentId: string;
  videoId: string;
  authorDisplayName: string;
  authorChannelId: string | null;
  text: string;
  publishedAt: string;
  totalReplyCount: number;
}

async function listRecentThreads(token: string): Promise<YouTubeThread[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.searchParams.set('allThreadsRelatedToChannelId', CHANNEL_ID!);
  url.searchParams.set('order', 'time');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('maxResults', String(COMMENTS_PER_TICK));
  url.searchParams.set('textFormat', 'plainText');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as {
    items?: Array<{
      snippet: {
        videoId: string;
        totalReplyCount: number;
        topLevelComment: {
          id: string;
          snippet: {
            authorDisplayName: string;
            authorChannelId?: { value: string };
            textOriginal: string;
            publishedAt: string;
          };
        };
      };
    }>;
  };

  return (data.items ?? []).map(item => {
    const top = item.snippet.topLevelComment;
    return {
      topLevelCommentId: top.id,
      videoId: item.snippet.videoId,
      authorDisplayName: top.snippet.authorDisplayName,
      authorChannelId: top.snippet.authorChannelId?.value ?? null,
      text: top.snippet.textOriginal,
      publishedAt: top.snippet.publishedAt,
      totalReplyCount: item.snippet.totalReplyCount,
    };
  });
}

async function postReply(token: string, parentCommentId: string, text: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/youtube/v3/comments?part=snippet', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      snippet: {
        parentId: parentCommentId,
        textOriginal: text,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube post failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

// ---------------------------------------------------------------------------
// Dedup table operations
// ---------------------------------------------------------------------------

/**
 * Try to claim a comment for processing. Returns true if this machine should
 * process the comment (we won the race). Returns false if another machine
 * already claimed it (or it was processed earlier).
 *
 * Inserts a row with posted=FALSE as a "claim". If we end up posting, we'll
 * UPDATE the same row with posted=TRUE + full data.
 */
async function claimComment(commentId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from('youtube_bot_log')
    .insert({ youtube_comment_id: commentId, posted: false })
    .select('id')
    .maybeSingle();
  if (error) {
    // 23505 = unique_violation — another machine claimed it. Expected, not an error.
    if (error.code === '23505') return false;
    // Any other DB error: surface it.
    throw error;
  }
  return !!data;
}

/** Release the claim row when the pipeline failed before producing a decision
 *  (e.g. transient Anthropic 529 / network blip). Next tick will see the
 *  comment as unseen again and retry. Only deletes UNposted rows — never
 *  removes a successful post. */
async function unclaimComment(commentId: string): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin
    .from('youtube_bot_log')
    .delete()
    .eq('youtube_comment_id', commentId)
    .eq('posted', false);
  if (error) {
    Sentry.captureException(error, {
      tags: { feature: 'youtube-bot', subsystem: 'unclaim' },
      extra: { commentId },
    });
  }
}

interface MarkPostedParams {
  commentId: string;
  videoId: string;
  userChannel: string;
  userComment: string;
  replyText: string;
  postedYoutubeId: string;
  classification: string;
  routerHandles: string[];
}

async function markPosted(p: MarkPostedParams): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin
    .from('youtube_bot_log')
    .update({
      posted: true,
      video_id: p.videoId,
      user_channel: p.userChannel,
      user_comment: p.userComment,
      reply_text: p.replyText,
      posted_youtube_id: p.postedYoutubeId,
      classification: p.classification,
      router_handles: p.routerHandles,
      posted_at: new Date().toISOString(),
    })
    .eq('youtube_comment_id', p.commentId);
  if (error) {
    Sentry.captureException(error, {
      tags: { feature: 'youtube-bot', subsystem: 'persist' },
      extra: { commentId: p.commentId },
    });
  }
}

async function countTodayPosts(): Promise<number> {
  if (!supabaseAdmin) return 0;
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabaseAdmin
    .from('youtube_bot_log')
    .select('id', { count: 'exact', head: true })
    .eq('posted', true)
    .gte('posted_at', todayStart.toISOString());
  if (error) {
    Sentry.captureException(error, { tags: { feature: 'youtube-bot' } });
    return 0;
  }
  return count ?? 0;
}

/** Single-query fetch of how many replies we've posted on each video.
 *  Called once per tick to avoid N queries in the per-comment loop. */
async function fetchVideoPostCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!supabaseAdmin) return counts;
  const { data, error } = await supabaseAdmin
    .from('youtube_bot_log')
    .select('video_id')
    .eq('posted', true);
  if (error) {
    Sentry.captureException(error, { tags: { feature: 'youtube-bot' } });
    return counts;
  }
  for (const row of data ?? []) {
    if (row.video_id) counts.set(row.video_id, (counts.get(row.video_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Persist a YouTube turn to the SHARED chat tables — the same
 * chat_conversations / chat_messages / chat_match_events that web and Discord
 * write to.
 *
 * Why this exists (added 2026-08-07): until now the bot wrote ONLY to
 * `youtube_bot_log`, and `cleanupSkippedRows()` deletes the non-posted rows from
 * that table. The result was that YouTube produced no durable, queryable record
 * of what was asked or answered:
 *   - every audit query built on `chat_messages` silently excluded YouTube,
 *     which is why past reviews looked YouTube-free rather than YouTube-clean;
 *   - skipped turns left no trace at all once cleanup ran, so "why did the bot
 *     not reply to these?" was unanswerable after the fact;
 *   - none of it was available as training data.
 *
 * `youtube_bot_log` is kept as-is — it owns the dedup claim
 * (`youtube_comment_id` UNIQUE) and the posting lifecycle. This is additive and
 * runs alongside it. The two join on the comment ID, which is stored here as
 * `chat_conversations.external_id`.
 *
 * Every outcome is persisted, including skips: `matched_handles`, the
 * classification, and the model's raw output (`SKIP_NO_REPLY` included) are all
 * signal about whether the bot behaved correctly.
 *
 * Failure is non-fatal and never blocks posting — the reply is already live on
 * YouTube by the time this runs.
 */
async function persistYouTubeTurn(p: {
  thread: YouTubeThread;
  outcome: PipelineOutcome;
  postedYoutubeId: string | null;
}): Promise<void> {
  if (!supabaseAdmin || !BOT_PROFILE_ID) return;

  const { thread, outcome } = p;

  try {
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('chat_conversations')
      .insert({
        user_id: BOT_PROFILE_ID,
        title: thread.text.slice(0, 80),
        platform: PLATFORM_YOUTUBE,
        external_id: thread.topLevelCommentId,
      })
      .select('id')
      .single();
    if (convErr || !conv) {
      Sentry.captureException(new Error('YouTube: failed to create conversation'), {
        tags: { feature: 'youtube-bot', subsystem: 'persist-chat' },
        extra: { dbError: convErr?.message, commentId: thread.topLevelCommentId },
      });
      return;
    }
    const conversationId = conv.id;

    // The viewer's comment. Always stored — this is the prompt half of the pair.
    const { error: userErr } = await supabaseAdmin.from('chat_messages').insert({
      conversation_id: conversationId,
      user_id: BOT_PROFILE_ID,
      role: 'user',
      content: thread.text,
    });
    if (userErr) {
      Sentry.captureException(new Error('YouTube: failed to save user message'), {
        tags: { feature: 'youtube-bot', subsystem: 'persist-chat' },
        extra: { dbError: userErr.message, conversationId },
      });
      // Continue — the assistant row + match event are still worth having.
    }

    // The assistant half. Only when the LLM actually produced output: a
    // classifier GREETING short-circuit never reached the model, and a fallback
    // produced no genuine answer, so neither gets a fabricated assistant row.
    let assistantMessageId: string | null = null;
    if (outcome.llmOutput) {
      assistantMessageId = crypto.randomUUID();
      const { error: asstErr } = await supabaseAdmin.from('chat_messages').insert({
        id: assistantMessageId,
        conversation_id: conversationId,
        user_id: BOT_PROFILE_ID,
        role: 'assistant',
        content: outcome.llmOutput,
        input_tokens: outcome.usage?.inputTokens ?? null,
        output_tokens: outcome.usage?.outputTokens ?? null,
        model: CHAT_MODEL,
        is_fallback: outcome.isFallback ?? false,
      });
      if (asstErr) {
        Sentry.captureException(new Error('YouTube: failed to save assistant message'), {
          tags: { feature: 'youtube-bot', subsystem: 'persist-chat' },
          extra: { dbError: asstErr.message, conversationId },
        });
        assistantMessageId = null; // don't FK the match event to a row that failed
      }
    }

    const r = outcome.routerResult;
    const { error: evtErr } = await supabaseAdmin.from('chat_match_events').insert({
      message_id: assistantMessageId,
      conversation_id: conversationId,
      user_id: BOT_PROFILE_ID,
      message: thread.text,
      router_context: {
        platform: PLATFORM_YOUTUBE,
        videoId: thread.videoId,
        commentId: thread.topLevelCommentId,
        postedYoutubeId: p.postedYoutubeId,
        posted: outcome.posted,
        skipReason: outcome.skipReason ?? null,
      },
      matched_handles: outcome.routerHandles ?? [],
      router_version: ROUTER_VERSION,
      router_latency_ms: r?.latencyMs ?? null,
      router_cache_hit: r?.cacheHit ?? null,
      router_input_tokens: r?.usage.inputTokens ?? null,
      router_cache_read_tokens: r?.usage.cacheReadTokens ?? null,
      router_raw: r?.error ? (r.rawJson?.slice(0, 500) ?? null) : null,
      router_error: r?.error ?? null,
      classification: outcome.classification ?? 'ERROR',
      router_skipped: outcome.routerSkipped ?? false,
    });
    if (evtErr) {
      Sentry.captureException(new Error('YouTube: match-event insert failed'), {
        tags: { feature: 'youtube-bot', subsystem: 'persist-chat' },
        extra: { dbError: evtErr.message, conversationId },
      });
    }
  } catch (err) {
    // Never let an analytics write break the bot.
    Sentry.captureException(err, {
      tags: { feature: 'youtube-bot', subsystem: 'persist-chat' },
      extra: { commentId: thread.topLevelCommentId },
    });
  }
}

async function cleanupSkippedRows(): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.rpc('youtube_bot_cleanup_skipped');
  if (error) {
    Sentry.captureException(error, { tags: { feature: 'youtube-bot', subsystem: 'cleanup' } });
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface FilterResult {
  pass: boolean;
  reason?: string;
}

function filterThread(thread: YouTubeThread): FilterResult {
  if (!thread.text || !thread.text.trim()) return { pass: false, reason: 'empty' };
  const wordCount = thread.text.trim().split(/\s+/).length;
  if (wordCount < MIN_WORDS) return { pass: false, reason: `too short (${wordCount} words)` };

  // Don't reply to Brad's own comments
  if (thread.authorChannelId && CHANNEL_ID && thread.authorChannelId === CHANNEL_ID) {
    return { pass: false, reason: "Brad's own comment" };
  }

  // Stale comments — don't dig up old ones on first launch / after downtime
  const ageDays = (Date.now() - new Date(thread.publishedAt).getTime()) / (24 * 60 * 60_000);
  if (ageDays > COMMENT_MAX_AGE_DAYS) return { pass: false, reason: `older than ${COMMENT_MAX_AGE_DAYS} days` };

  return { pass: true };
}

// ---------------------------------------------------------------------------
// Pipeline — classifier → conditional router → main LLM
// ---------------------------------------------------------------------------

interface PipelineOutcome {
  posted: boolean;
  skipReason?: string;
  classification?: string;
  routerHandles?: string[];
  replyText?: string;
  /**
   * Telemetry for persistYouTubeTurn(). Previously all of this was computed and
   * then thrown away, which is why YouTube had no auditable/trainable record —
   * see the comment on persistYouTubeTurn().
   */
  routerResult?: RouterResult | null;
  routerSkipped?: boolean;
  /** The model's raw output, INCLUDING 'SKIP_NO_REPLY'. Absent if no LLM call happened. */
  llmOutput?: string;
  usage?: AnthropicUsage;
  isFallback?: boolean;
}

async function runPipeline(thread: YouTubeThread, entry: BlogIndexEntry, body: string): Promise<PipelineOutcome> {
  const sanitized = sanitizeForRouter(thread.text);

  const classifierResult = await classifyMessage(sanitized);
  if (classifierResult.classification === 'GREETING') {
    return {
      posted: false,
      skipReason: 'classifier=GREETING',
      classification: 'GREETING',
      routerHandles: [],
      routerResult: null,
      routerSkipped: true,
    };
  }

  let routerHandles: string[] = [];
  let routerResult: RouterResult | null = null;
  const routerSkipped = !shouldFireRouter(classifierResult);
  if (!routerSkipped) {
    routerResult = await routeQuery(sanitized);
    routerHandles = routerResult.handles;
  }

  const platformContext = buildYouTubePlatformContext(thread.videoId, entry, body);
  const blogArticles = loadMatchedArticlesFromHandles(routerHandles);
  // YouTube is a doctor-family surface (Brad's public channel) → strict doctor posture.
  const systemBlocks = buildSystemBlocks(platformContext, { surfaceContext: DOCTOR_POSTURE, blogArticles });
  const conversationMessages = buildConversationMessages([], thread.text);
  const completion = await getChatCompletion(systemBlocks, conversationMessages);

  const base = {
    classification: classifierResult.classification,
    routerHandles,
    routerResult,
    routerSkipped,
    usage: completion.usage,
  };

  if (completion.isFallback) {
    return {
      ...base,
      posted: false,
      skipReason: `main-LLM failure (${completion.failureMode ?? 'unknown'})`,
      isFallback: true,
    };
  }

  const replyText = completion.content.trim();
  if (replyText === 'SKIP_NO_REPLY') {
    // Still a real, deliberate model decision — worth keeping as training signal.
    return {
      ...base,
      posted: false,
      skipReason: 'main-LLM returned SKIP_NO_REPLY',
      llmOutput: replyText,
    };
  }

  return { ...base, posted: true, replyText, llmOutput: replyText };
}

// ---------------------------------------------------------------------------
// Main cron tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const t0 = Date.now();
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    logTickError(err);
    return;
  }

  let threads: YouTubeThread[];
  try {
    threads = await listRecentThreads(token);
  } catch (err) {
    logTickError(err);
    return;
  }

  let postedThisTick = 0;
  let skippedThisTick = 0;
  const [startingDailyCount, videoPostCounts] = await Promise.all([
    countTodayPosts(),
    fetchVideoPostCounts(),
  ]);

  for (const thread of threads) {
    if (startingDailyCount + postedThisTick >= DAILY_REPLY_CAP) {
      console.log(`YouTube bot: daily cap (${DAILY_REPLY_CAP}) reached, stopping tick`);
      break;
    }

    let claimed: boolean;
    try {
      claimed = await claimComment(thread.topLevelCommentId);
    } catch (err) {
      logTickError(err);
      continue;
    }
    if (!claimed) continue;

    const filt = filterThread(thread);
    if (!filt.pass) {
      skippedThisTick++;
      continue;
    }

    const blogEntry = findBlogByVideoId(thread.videoId);
    if (!blogEntry) {
      skippedThisTick++;
      continue;
    }
    const fullContent = loadBlogArticle(blogEntry.handle);
    if (!fullContent) {
      skippedThisTick++;
      continue;
    }
    const blogBody = fullContent.replace(/^---[\s\S]*?---\n\n?/, '');

    if ((videoPostCounts.get(thread.videoId) ?? 0) >= PER_VIDEO_REPLY_CAP) {
      skippedThisTick++;
      continue;
    }

    let outcome: PipelineOutcome;
    try {
      outcome = await runPipeline(thread, blogEntry, blogBody);
    } catch (err) {
      // Unhandled pipeline exception. Likely transient (Anthropic 529 / timeout) —
      // un-claim so the next tick can retry. Persistent failures will be visible
      // via Sentry on the underlying call.
      logTickError(err);
      await unclaimComment(thread.topLevelCommentId);
      skippedThisTick++;
      continue;
    }

    if (!outcome.posted) {
      // Record the skip BEFORE unclaiming. cleanupSkippedRows() deletes the
      // youtube_bot_log row for non-posted comments, so without this the reason
      // a comment was passed over is lost entirely.
      await persistYouTubeTurn({ thread, outcome, postedYoutubeId: null });

      // Main-LLM failure (fallback path inside getChatCompletion) is transient —
      // un-claim so the next tick can retry once Anthropic recovers. Genuine
      // SKIP_NO_REPLY / GREETING / blog-missing cases leave the claim intact so
      // we don't waste LLM tokens re-evaluating the same comment.
      const isTransient = outcome.skipReason?.startsWith('main-LLM failure');
      if (isTransient) await unclaimComment(thread.topLevelCommentId);
      skippedThisTick++;
      continue;
    }

    // Post to YouTube
    let postedId: string;
    try {
      postedId = await postReply(token, thread.topLevelCommentId, outcome.replyText!);
    } catch (err) {
      logTickError(err);
      // Row stays as posted=FALSE — won't retry, but post failure is visible
      // via the audit. Could become retry-able later via a status column.
      skippedThisTick++;
      continue;
    }

    // Persist the success
    await markPosted({
      commentId: thread.topLevelCommentId,
      videoId: thread.videoId,
      userChannel: thread.authorDisplayName,
      userComment: thread.text,
      replyText: outcome.replyText!,
      postedYoutubeId: postedId,
      classification: outcome.classification ?? 'ERROR',
      routerHandles: outcome.routerHandles ?? [],
    });

    // Durable, queryable copy in the shared chat tables (training + audit).
    await persistYouTubeTurn({ thread, outcome, postedYoutubeId: postedId });

    videoPostCounts.set(thread.videoId, (videoPostCounts.get(thread.videoId) ?? 0) + 1);
    postedThisTick++;
  }

  await cleanupSkippedRows();

  console.log(JSON.stringify({
    evt: 'youtube_bot_tick',
    durationMs: Date.now() - t0,
    threads: threads.length,
    posted: postedThisTick,
    skipped: skippedThisTick,
    dailyTotal: startingDailyCount + postedThisTick,
  }));
}

// ---------------------------------------------------------------------------
// Auto-start on module import
// ---------------------------------------------------------------------------

startYouTubeBot();
