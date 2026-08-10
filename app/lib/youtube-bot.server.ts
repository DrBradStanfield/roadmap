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

// Multi-turn (follow-up) config — see § Follow-up replies below.
const FOLLOWUP_MIN_WORDS = 3;             // follow-ups are naturally shorter ("does it cause blindness?")
const MAX_CHANNEL_REPLIES_PER_THREAD = 2; // hard cap: initial reply + at most ONE follow-up (screenshot-risk control)
const FOLLOWUP_THREADS_PER_TICK = 25;     // bound the per-tick comments.list calls

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

/** Appended to the platform context on follow-up turns only. The bot has
 *  already answered once in this thread; the bar for speaking again is higher
 *  and disengaging from hostility is mandatory (agreed with Brad 2026-08-10). */
const FOLLOWUP_POSTURE = `

FOLLOW-UP TURN: You already replied once in this comment thread (see the conversation history). This is a follow-up directed at you.
- Answer ONLY a genuine, substantive follow-up question you can ground in the video content or provided articles.
- If the message is hostile, sarcastic, bait, a rant, or mere disagreement without a question — return SKIP_NO_REPLY. Never argue, never defend yourself, never reply to hostility.
- This is your LAST reply in this thread either way, so make it self-contained and do not invite further questions.`;

function buildYouTubePlatformContext(videoId: string, entry: BlogIndexEntry, body: string, isFollowUp = false): string {
  const base = YOUTUBE_PROMPT_TEMPLATE
    .replace('{{VIDEO_TITLE}}', entry.title)
    .replace('{{VIDEO_URL}}', `https://youtu.be/${videoId}`)
    .replace('{{VIDEO_CONTENT}}', body);
  return isFollowUp ? base + FOLLOWUP_POSTURE : base;
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
    };
  });
}

export interface YouTubeReply {
  id: string;
  authorDisplayName: string;
  authorChannelId: string | null;
  text: string;
  publishedAt: string;
}

/** List all replies under a top-level comment (YouTube threads are 2-level:
 *  every reply's parentId is the top-level comment, and reply IDs are
 *  `<threadId>.<suffix>`). Sorted oldest-first. */
async function listReplies(token: string, topLevelCommentId: string): Promise<YouTubeReply[]> {
  const url = new URL('https://www.googleapis.com/youtube/v3/comments');
  url.searchParams.set('parentId', topLevelCommentId);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('maxResults', '100');
  url.searchParams.set('textFormat', 'plainText');

  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube replies list failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as {
    items?: Array<{
      id: string;
      snippet: {
        authorDisplayName: string;
        authorChannelId?: { value: string };
        textOriginal: string;
        publishedAt: string;
      };
    }>;
  };
  return (data.items ?? [])
    .map(item => ({
      id: item.id,
      authorDisplayName: item.snippet.authorDisplayName,
      authorChannelId: item.snippet.authorChannelId?.value ?? null,
      text: item.snippet.textOriginal,
      publishedAt: item.snippet.publishedAt,
    }))
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

/** channelId → "@handle" (null = lookup failed / no handle). Process-lifetime cache. */
const handleCache = new Map<string, string | null>();

/** Resolve a channel's @handle via channels.list → snippet.customUrl. 1 quota unit,
 *  cached per channel. Returns null on any failure — callers must degrade silently. */
async function resolveHandle(token: string, channelId: string): Promise<string | null> {
  const cached = handleCache.get(channelId);
  if (cached !== undefined) return cached;
  let handle: string | null = null;
  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/channels');
    url.searchParams.set('id', channelId);
    url.searchParams.set('part', 'snippet');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`channels.list ${res.status}`);
    const data = await res.json() as { items?: Array<{ snippet?: { customUrl?: string } }> };
    handle = data.items?.[0]?.snippet?.customUrl ?? null;
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'youtube-bot', subsystem: 'resolve-handle' } });
  }
  handleCache.set(channelId, handle);
  return handle;
}

let cachedChannelHandle: string | null | undefined;

/** The channel's @handle (e.g. "@drbradstanfield") — YouTube auto-prefixes it
 *  when a viewer taps Reply on one of our replies, which is the deterministic
 *  "addressed to the bot" signal. Cached for the process lifetime; null when
 *  the lookup fails (the addressee gate then falls back to original-author-only). */
async function getChannelHandle(token: string): Promise<string | null> {
  if (cachedChannelHandle === undefined) cachedChannelHandle = await resolveHandle(token, CHANNEL_ID!);
  return cachedChannelHandle;
}

/**
 * Address a follow-up reply to the person who asked.
 *
 * Top-level replies are NOT tagged: YouTube nests them directly under the
 * comment and notifies its author, so an @mention is pure clutter. Follow-ups
 * ARE tagged: YouTube threads are flat (every reply hangs off the top-level
 * comment), so our reply lands at the bottom of the list rather than beside
 * theirs — the @handle is how YouTube's own UI addresses someone in a thread,
 * and it's what reliably notifies a replier who isn't the thread author.
 * Degrades to no prefix when the handle can't be resolved.
 */
export function addressReply(replyText: string, handle: string | null): string {
  if (!handle) return replyText;
  const at = handle.startsWith('@') ? handle : `@${handle}`;
  if (replyText.toLowerCase().startsWith(at.toLowerCase())) return replyText; // already addressed
  return `${at} ${replyText}`;
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
  /** Set on follow-up turns: the reply comment we responded to (the thread id lives in thread.topLevelCommentId). */
  followUpCommentId?: string | null;
}): Promise<void> {
  if (!supabaseAdmin || !BOT_PROFILE_ID) return;

  const { thread, outcome } = p;

  try {
    // Find-or-create keyed on the thread id, so follow-up turns append to the
    // same conversation instead of forking a new one per turn.
    const { data: existing } = await supabaseAdmin
      .from('chat_conversations')
      .select('id')
      .eq('platform', PLATFORM_YOUTUBE)
      .eq('external_id', thread.topLevelCommentId)
      .maybeSingle();
    let conversationId: string | null = existing?.id ?? null;
    if (!conversationId) {
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
      conversationId = conv.id;
    }

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
        followUpCommentId: p.followUpCommentId ?? null,
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

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

function ageInDays(publishedAt: string): number {
  return (Date.now() - new Date(publishedAt).getTime()) / (24 * 60 * 60_000);
}

/** The video's companion blog post + its body (frontmatter stripped), or null
 *  when the video has no linked article or the file is unreadable. */
function loadVideoBody(videoId: string): { entry: BlogIndexEntry; body: string } | null {
  const entry = findBlogByVideoId(videoId);
  if (!entry) return null;
  const fullContent = loadBlogArticle(entry.handle);
  if (!fullContent) return null;
  return { entry, body: fullContent.replace(/^---[\s\S]*?---\n\n?/, '') };
}

function filterThread(thread: YouTubeThread): FilterResult {
  if (!thread.text || !thread.text.trim()) return { pass: false, reason: 'empty' };
  const words = wordCount(thread.text);
  if (words < MIN_WORDS) return { pass: false, reason: `too short (${words} words)` };

  // Don't reply to Brad's own comments
  if (thread.authorChannelId && CHANNEL_ID && thread.authorChannelId === CHANNEL_ID) {
    return { pass: false, reason: "Brad's own comment" };
  }

  // Stale comments — don't dig up old ones on first launch / after downtime
  if (ageInDays(thread.publishedAt) > COMMENT_MAX_AGE_DAYS) {
    return { pass: false, reason: `older than ${COMMENT_MAX_AGE_DAYS} days` };
  }

  return { pass: true };
}

// ---------------------------------------------------------------------------
// Follow-up replies (multi-turn) — three gates, decided 2026-08-10 with Brad:
//   1. Addressee: only replies directed at the bot — the thread's original
//      author continuing after our reply, or an explicit @our-handle mention
//      (YouTube auto-inserts it when someone taps Reply on our reply). Other
//      users talking to each other are never interrupted.
//   2. Brad-engaged exit: any channel-authored reply we didn't post means Brad
//      is personally in the thread — the bot leaves it to him, permanently.
//   3. Hard cap: MAX_CHANNEL_REPLIES_PER_THREAD channel replies per thread
//      (initial + one follow-up), regardless of quality — the screenshot-risk
//      control. Hostile/bait follow-ups additionally die in the pipeline
//      (classifier skip or SKIP_NO_REPLY with the follow-up posture block).
// ---------------------------------------------------------------------------

type FollowUpDecision = { skip: string } | { candidate: YouTubeReply };

export function assessThreadFollowUp(p: {
  replies: YouTubeReply[];       // full reply list, oldest-first
  botPostedIds: Set<string>;     // comment IDs the bot itself posted
  channelId: string;
  originalAuthor: string;        // display name of the thread's top-level author
  channelHandle: string | null;  // "@handle", or null when unknown
}): FollowUpDecision {
  const channelReplies = p.replies.filter(r => r.authorChannelId === p.channelId);

  if (channelReplies.some(r => !p.botPostedIds.has(r.id))) return { skip: 'brad-engaged' };
  if (channelReplies.length === 0) return { skip: 'no-bot-reply-visible' };
  if (channelReplies.length >= MAX_CHANNEL_REPLIES_PER_THREAD) return { skip: 'thread-cap' };

  const lastBotTime = channelReplies[channelReplies.length - 1].publishedAt;
  const handle = p.channelHandle?.toLowerCase();
  const candidates = p.replies.filter(r =>
    r.authorChannelId !== p.channelId &&
    r.publishedAt > lastBotTime &&
    (r.authorDisplayName === p.originalAuthor ||
      (handle ? r.text.trim().toLowerCase().startsWith(handle) : false)),
  );
  if (candidates.length === 0) return { skip: 'no-addressed-followup' };

  return { candidate: candidates[0] }; // oldest first — one follow-up per thread per tick
}

/** Rebuild the thread as chat history for the main LLM: top-level comment,
 *  then every reply before the candidate — bot turns as assistant, viewer
 *  turns as user (name-prefixed). Consecutive viewer turns are merged so a
 *  multi-comment aside reads as one turn (the trailing candidate is appended
 *  separately by buildConversationMessages and may still follow a user turn). */
export function buildThreadHistory(
  original: { author: string; text: string },
  replies: YouTubeReply[],
  channelId: string,
  candidateId: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: `${original.author}: ${original.text}` },
  ];
  for (const r of replies) {
    if (r.id === candidateId) break;
    turns.push(
      r.authorChannelId === channelId
        ? { role: 'assistant', content: r.text }
        : { role: 'user', content: `${r.authorDisplayName}: ${r.text}` },
    );
  }
  return turns.reduce<typeof turns>((merged, t) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n\n${t.content}`;
    else merged.push({ ...t });
    return merged;
  }, []);
}

/** Threads the bot has posted in recently (candidates for follow-up scanning),
 *  plus the set of ALL comment IDs the bot ever posted in the window — used to
 *  tell bot replies apart from Brad's own. Reply-row IDs (`thread.suffix`)
 *  collapse onto their thread. */
async function fetchRecentPostedThreads(): Promise<{
  threadIds: string[];
  botPostedIds: Set<string>;
  threadMeta: Map<string, { videoId: string; originalAuthor: string; originalComment: string }>;
}> {
  const out = { threadIds: [] as string[], botPostedIds: new Set<string>(), threadMeta: new Map() };
  if (!supabaseAdmin) return out;
  const cutoff = new Date(Date.now() - COMMENT_MAX_AGE_DAYS * 24 * 60 * 60_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('youtube_bot_log')
    .select('youtube_comment_id, posted_youtube_id, video_id, user_channel, user_comment, posted_at')
    .eq('posted', true)
    .gte('posted_at', cutoff)
    .order('posted_at', { ascending: false });
  if (error) {
    Sentry.captureException(error, { tags: { feature: 'youtube-bot', subsystem: 'followups' } });
    return out;
  }
  for (const row of data ?? []) {
    if (row.posted_youtube_id) out.botPostedIds.add(row.posted_youtube_id);
    // Top-level rows carry the thread id; follow-up rows carry `<threadId>.<suffix>`.
    if (!row.youtube_comment_id.includes('.') && !out.threadMeta.has(row.youtube_comment_id)) {
      out.threadIds.push(row.youtube_comment_id);
      out.threadMeta.set(row.youtube_comment_id, {
        videoId: row.video_id,
        originalAuthor: row.user_channel ?? '',
        originalComment: row.user_comment ?? '',
      });
    }
  }
  return out;
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

async function runPipeline(
  thread: YouTubeThread,
  entry: BlogIndexEntry,
  body: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<PipelineOutcome> {
  const sanitized = sanitizeForRouter(thread.text);
  const isFollowUp = history.length > 0;

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

  const platformContext = buildYouTubePlatformContext(thread.videoId, entry, body, isFollowUp);
  const blogArticles = loadMatchedArticlesFromHandles(routerHandles);
  // YouTube is a doctor-family surface (Brad's public channel) → strict doctor posture.
  const systemBlocks = buildSystemBlocks(platformContext, { surfaceContext: DOCTOR_POSTURE, blogArticles });
  const conversationMessages = buildConversationMessages(history, thread.text);
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
// Follow-up scan — runs after the top-level loop, inside the same daily cap
// ---------------------------------------------------------------------------

async function processFollowUps(
  token: string,
  budget: number,
  videoPostCounts: Map<string, number>,
): Promise<{ posted: number; skipped: number; gates: Record<string, number> }> {
  let posted = 0;
  let skipped = 0;
  // Which gate stopped each thread — the only way to see the gates working in prod.
  const gates: Record<string, number> = {};
  const gate = (reason: string) => { gates[reason] = (gates[reason] ?? 0) + 1; };

  if (budget <= 0) return { posted, skipped, gates };

  const recent = await fetchRecentPostedThreads();
  if (recent.threadIds.length === 0) return { posted, skipped, gates };
  const channelHandle = await getChannelHandle(token);

  for (const threadId of recent.threadIds.slice(0, FOLLOWUP_THREADS_PER_TICK)) {
    if (posted >= budget) break;
    const meta = recent.threadMeta.get(threadId)!;

    let replies: YouTubeReply[];
    try {
      replies = await listReplies(token, threadId);
    } catch (err) {
      logTickError(err);
      continue;
    }

    const decision = assessThreadFollowUp({
      replies,
      botPostedIds: recent.botPostedIds,
      channelId: CHANNEL_ID!,
      originalAuthor: meta.originalAuthor,
      channelHandle,
    });
    if ('skip' in decision) {
      gate(decision.skip);
      continue;
    }
    const reply = decision.candidate;

    // Same hygiene gates as top-level, with the shorter follow-up word floor.
    if (ageInDays(reply.publishedAt) > COMMENT_MAX_AGE_DAYS) { gate('stale'); continue; }
    if (wordCount(reply.text) < FOLLOWUP_MIN_WORDS) { gate('too-short'); continue; }
    if ((videoPostCounts.get(meta.videoId) ?? 0) >= PER_VIDEO_REPLY_CAP) { gate('video-cap'); continue; }

    let claimed: boolean;
    try {
      claimed = await claimComment(reply.id);
    } catch (err) {
      logTickError(err);
      continue;
    }
    if (!claimed) continue;

    const video = loadVideoBody(meta.videoId);
    if (!video) {
      skipped++;
      continue;
    }

    const history = buildThreadHistory(
      { author: meta.originalAuthor, text: meta.originalComment },
      replies,
      CHANNEL_ID!,
      reply.id,
    );
    const pseudoThread: YouTubeThread = {
      topLevelCommentId: threadId,
      videoId: meta.videoId,
      authorDisplayName: reply.authorDisplayName,
      authorChannelId: reply.authorChannelId,
      text: reply.text,
      publishedAt: reply.publishedAt,
    };

    let outcome: PipelineOutcome;
    try {
      outcome = await runPipeline(pseudoThread, video.entry, video.body, history);
    } catch (err) {
      logTickError(err);
      await unclaimComment(reply.id);
      skipped++;
      continue;
    }

    if (!outcome.posted) {
      await persistYouTubeTurn({ thread: pseudoThread, outcome, postedYoutubeId: null, followUpCommentId: reply.id });
      if (outcome.skipReason?.startsWith('main-LLM failure')) await unclaimComment(reply.id);
      skipped++;
      continue;
    }

    // Address the asker by @handle — see addressReply() for why follow-ups are
    // tagged and top-level replies are not.
    const askerHandle = reply.authorChannelId ? await resolveHandle(token, reply.authorChannelId) : null;
    const replyText = addressReply(outcome.replyText!, askerHandle);

    let postedId: string;
    try {
      postedId = await postReply(token, threadId, replyText);
    } catch (err) {
      logTickError(err);
      skipped++;
      continue;
    }

    await markPosted({
      commentId: reply.id,
      videoId: meta.videoId,
      userChannel: reply.authorDisplayName,
      userComment: reply.text,
      replyText,
      postedYoutubeId: postedId,
      classification: outcome.classification ?? 'ERROR',
      routerHandles: outcome.routerHandles ?? [],
    });
    await persistYouTubeTurn({ thread: pseudoThread, outcome, postedYoutubeId: postedId, followUpCommentId: reply.id });

    videoPostCounts.set(meta.videoId, (videoPostCounts.get(meta.videoId) ?? 0) + 1);
    posted++;
  }

  return { posted, skipped, gates };
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

    const video = loadVideoBody(thread.videoId);
    if (!video) {
      skippedThisTick++;
      continue;
    }

    if ((videoPostCounts.get(thread.videoId) ?? 0) >= PER_VIDEO_REPLY_CAP) {
      skippedThisTick++;
      continue;
    }

    let outcome: PipelineOutcome;
    try {
      outcome = await runPipeline(thread, video.entry, video.body);
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

  // Follow-up pass: replies directed at the bot in threads it already
  // answered, within whatever daily budget the top-level loop left.
  let followUps: { posted: number; skipped: number; gates: Record<string, number> } =
    { posted: 0, skipped: 0, gates: {} };
  try {
    followUps = await processFollowUps(
      token,
      DAILY_REPLY_CAP - startingDailyCount - postedThisTick,
      videoPostCounts,
    );
  } catch (err) {
    logTickError(err);
  }

  await cleanupSkippedRows();

  console.log(JSON.stringify({
    evt: 'youtube_bot_tick',
    durationMs: Date.now() - t0,
    threads: threads.length,
    posted: postedThisTick,
    skipped: skippedThisTick,
    followUpsPosted: followUps.posted,
    followUpsSkipped: followUps.skipped,
    followUpGates: followUps.gates,
    dailyTotal: startingDailyCount + postedThisTick + followUps.posted,
  }));
}

// ---------------------------------------------------------------------------
// Auto-start on module import
// ---------------------------------------------------------------------------

startYouTubeBot();
