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
import * as Sentry from '@sentry/remix';
import { supabaseAdmin } from './supabase.server';
import { classifyMessage, shouldFireRouter } from './chat-classifier.server';
import { routeQuery, sanitizeForRouter } from './chat-router.server';
import { findBlogByVideoId, type BlogIndexEntry } from './blog-index.server';
import {
  buildSystemBlocks,
  buildConversationMessages,
  getChatCompletion,
  loadBlogArticle,
  loadMatchedArticlesFromHandles,
} from './chat.server';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30 * 60_000; // 30 minutes
const COMMENTS_PER_TICK = 100;        // YouTube returns up to 100 per page
const DAILY_REPLY_CAP = 50;           // hard ceiling on posts per day
const PER_VIDEO_REPLY_CAP = 10;       // ceiling per video lifetime
const COMMENT_MAX_AGE_DAYS = 7;       // ignore comments older than this
const MIN_WORDS = 5;                  // ≥5 words to be considered substantive

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
}

async function runPipeline(thread: YouTubeThread, entry: BlogIndexEntry, body: string): Promise<PipelineOutcome> {
  const sanitized = sanitizeForRouter(thread.text);

  const classifierResult = await classifyMessage(sanitized);
  if (classifierResult.classification === 'GREETING') {
    return { posted: false, skipReason: 'classifier=GREETING', classification: 'GREETING', routerHandles: [] };
  }

  let routerHandles: string[] = [];
  if (shouldFireRouter(classifierResult)) {
    const routerResult = await routeQuery(sanitized);
    routerHandles = routerResult.handles;
  }

  const platformContext = buildYouTubePlatformContext(thread.videoId, entry, body);
  const blogArticles = loadMatchedArticlesFromHandles(routerHandles);
  const systemBlocks = buildSystemBlocks(platformContext, { blogArticles });
  const conversationMessages = buildConversationMessages([], thread.text);
  const completion = await getChatCompletion(systemBlocks, conversationMessages);

  if (completion.isFallback) {
    return {
      posted: false,
      skipReason: `main-LLM failure (${completion.failureMode ?? 'unknown'})`,
      classification: classifierResult.classification,
      routerHandles,
    };
  }

  const replyText = completion.content.trim();
  if (replyText === 'SKIP_NO_REPLY') {
    return {
      posted: false,
      skipReason: 'main-LLM returned SKIP_NO_REPLY',
      classification: classifierResult.classification,
      routerHandles,
    };
  }

  return {
    posted: true,
    classification: classifierResult.classification,
    routerHandles,
    replyText,
  };
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
      logTickError(err);
      skippedThisTick++;
      continue;
    }

    if (!outcome.posted) {
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
