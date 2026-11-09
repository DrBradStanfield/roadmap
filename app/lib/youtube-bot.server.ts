/**
 * YouTube comment auto-replier.
 *
 * Auto-starts on module import (same pattern as reminder-v2-cron.server.ts and
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
 * Split by concern (issue #429): youtube-bot-config.server.ts (limits, env),
 * youtube-bot-api.server.ts (OAuth, YouTube Data API),
 * youtube-bot-store.server.ts (Supabase claim, caps, chat persistence) and
 * youtube-bot-pipeline.server.ts (filters, follow-up gates, chat pipeline).
 * This file keeps the start/stop, the cron tick and the follow-up scan, and
 * re-exports every name it exported before the split.
 *
 * See:
 *   claude_business docs/chat-architecture.md § YouTube comment replier
 *   tools/youtube-comment-dryrun.ts (preview tool, same pipeline)
 */
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin } from './supabase.server';
import { YOUTUBE_PROMPT_TEMPLATE } from './youtube-context';
import {
  POLL_INTERVAL_MS,
  DAILY_REPLY_CAP,
  PER_VIDEO_REPLY_CAP,
  FOLLOWUP_THREADS_PER_TICK,
  CHANNEL_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
} from './youtube-bot-config.server';
import {
  getAccessToken,
  listRecentThreads,
  listReplies,
  resolveHandle,
  getChannelHandle,
  addressReply,
  postReply,
  isNotReplyableError,
  type YouTubeThread,
  type YouTubeReply,
} from './youtube-bot-api.server';
import {
  claimComment,
  unclaimComment,
  markPosted,
  readPostingCaps,
  persistYouTubeTurn,
  cleanupSkippedRows,
  fetchRecentPostedThreads,
} from './youtube-bot-store.server';
import {
  loadVideoBody,
  filterThread,
  assessThreadFollowUp,
  buildThreadHistory,
  shouldUnclaim,
  runPipeline,
  reportTickFallbacks,
  type PipelineOutcome,
} from './youtube-bot-pipeline.server';

// Every name this file exported before the split (issue #429).
export { PER_VIDEO_REPLY_CAP } from './youtube-bot-config.server';
export { addressReply, isNotReplyableError, type YouTubeReply } from './youtube-bot-api.server';
export { readPostingCaps, persistYouTubeTurn } from './youtube-bot-store.server';
export {
  filterThread,
  assessThreadFollowUp,
  buildThreadHistory,
  completionOutcome,
  shouldUnclaim,
  runPipeline,
  reportTickFallbacks,
} from './youtube-bot-pipeline.server';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let isRunning = false;
/** One tick at a time per machine: a tick reads the daily cap at its start (US-27 AC3). */
let tickInFlight = false;
let cronIntervalId: ReturnType<typeof setInterval> | null = null;

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
  setTimeout(() => { runTick().catch(logTickError); }, 30_000);

  cronIntervalId = setInterval(() => {
    runTick().catch(logTickError);
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

async function runTick(): Promise<void> {
  if (tickInFlight) {
    console.log('YouTube bot: previous tick still running, skipping this one');
    return;
  }
  tickInFlight = true;
  try {
    await tick();
  } finally {
    reportTickFallbacks();
    tickInFlight = false;
  }
}

function logTickError(err: unknown): void {
  console.error('YouTube bot tick error:', err);
  Sentry.captureException(err, { tags: { feature: 'youtube-bot' } });
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
      if (shouldUnclaim(outcome)) await unclaimComment(reply.id);
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
      if (!isNotReplyableError(err)) logTickError(err);
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
  let startingDailyCount: number;
  let videoPostCounts: Map<string, number>;
  try {
    ({ dailyCount: startingDailyCount, videoPostCounts } = await readPostingCaps());
  } catch {
    // Already captured at the query site. Caps unknown ⇒ posting budget
    // unknown ⇒ post nothing this tick (US-27 AC2); next tick retries.
    console.log('YouTube bot: posting-cap reads failed — skipping tick, will retry next tick');
    return;
  }

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
      // SKIP_NO_REPLY / GREETING or SPAM / unreadable classifier answer (US-15
      // AC48) / blog-missing / refusal cases leave the claim intact so we don't
      // waste LLM tokens re-evaluating the same comment.
      if (shouldUnclaim(outcome)) await unclaimComment(thread.topLevelCommentId);
      skippedThisTick++;
      continue;
    }

    // Post to YouTube
    let postedId: string;
    try {
      postedId = await postReply(token, thread.topLevelCommentId, outcome.replyText!);
    } catch (err) {
      if (!isNotReplyableError(err)) logTickError(err);
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
