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
 * youtube-bot-store.server.ts (Supabase claim, caps, chat persistence),
 * youtube-bot-pipeline.server.ts (filters, follow-up gates, chat pipeline) and
 * youtube-bot-post.server.ts (mark, post, record: US-27 AC5).
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
  type YouTubeThread,
  type YouTubeReply,
} from './youtube-bot-api.server';
import {
  claimComment,
  unclaimComment,
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
import { safeErrorFields } from './safe-error-fields.server';
import { postClaimed, countSent } from './youtube-bot-post.server';

// Every name this file exported before the split (issue #429).
export { PER_VIDEO_REPLY_CAP } from './youtube-bot-config.server';
export { addressReply, type YouTubeReply } from './youtube-bot-api.server';
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
let firstTickId: ReturnType<typeof setTimeout> | null = null;

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
  firstTickId = setTimeout(() => { firstTickId = null; runTick().catch(logTickError); }, 30_000);

  cronIntervalId = setInterval(() => {
    runTick().catch(logTickError);
  }, POLL_INTERVAL_MS);

  isRunning = true;
}

export function stopYouTubeBot(): void {
  // A stop in the first 30 s (SIGTERM at boot) must not leave the first tick armed (US-27 AC5).
  if (firstTickId) {
    clearTimeout(firstTickId);
    firstTickId = null;
  }
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
  console.error('YouTube bot tick error:', safeErrorFields(err));
  Sentry.captureException(err, { tags: { feature: 'youtube-bot' } });
}

// ---------------------------------------------------------------------------
// Follow-up scan — runs after the top-level loop, inside the same daily cap
// ---------------------------------------------------------------------------

type FollowUpTally = { posted: number; unknown: number; skipped: number; gates: Record<string, number> };

async function processFollowUps(
  token: string,
  budget: number,
  videoPostCounts: Map<string, number>,
): Promise<FollowUpTally> {
  const tally = { posted: 0, unknown: 0, skipped: 0 };
  // Which gate stopped each thread — the only way to see the gates working in prod.
  const gates: Record<string, number> = {};
  const gate = (reason: string) => { gates[reason] = (gates[reason] ?? 0) + 1; };

  if (budget <= 0) return { ...tally, gates };

  const recent = await fetchRecentPostedThreads();
  if (recent.threadIds.length === 0) return { ...tally, gates };
  const channelHandle = await getChannelHandle(token);

  for (const threadId of recent.threadIds.slice(0, FOLLOWUP_THREADS_PER_TICK)) {
    if (tally.posted + tally.unknown >= budget) break;
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

    let claimRowId: number | null;
    try {
      claimRowId = await claimComment(reply.id);
    } catch (err) {
      logTickError(err);
      continue;
    }
    if (claimRowId === null) continue;

    const video = loadVideoBody(meta.videoId);
    if (!video) {
      tally.skipped++;
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
      tally.skipped++;
      continue;
    }

    if (!outcome.posted) {
      await persistYouTubeTurn({ thread: pseudoThread, outcome, postedYoutubeId: null, followUpCommentId: reply.id });
      if (shouldUnclaim(outcome)) await unclaimComment(reply.id);
      tally.skipped++;
      continue;
    }

    // Address the asker by @handle — see addressReply() for why follow-ups are
    // tagged and top-level replies are not.
    const askerHandle = reply.authorChannelId ? await resolveHandle(token, reply.authorChannelId) : null;
    const replyText = addressReply(outcome.replyText!, askerHandle);

    const sent = await postClaimed(token, pseudoThread, { id: reply.id, rowId: claimRowId }, replyText, outcome);
    countSent(sent, tally, videoPostCounts, meta.videoId);
    if (sent === 'halt') break;
  }

  return { ...tally, gates };
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

  const tally = { posted: 0, unknown: 0, skipped: 0 };
  let halted = false; // an account-wide refusal (401, 429, quotaExceeded) ends this tick's posting
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
    if (startingDailyCount + tally.posted + tally.unknown >= DAILY_REPLY_CAP) {
      console.log(`YouTube bot: daily cap (${DAILY_REPLY_CAP}) reached, stopping tick`);
      break;
    }

    let claimRowId: number | null;
    try {
      claimRowId = await claimComment(thread.topLevelCommentId);
    } catch (err) {
      logTickError(err);
      continue;
    }
    if (claimRowId === null) continue;

    const filt = filterThread(thread);
    if (!filt.pass) {
      tally.skipped++;
      continue;
    }

    const video = loadVideoBody(thread.videoId);
    if (!video) {
      tally.skipped++;
      continue;
    }

    if ((videoPostCounts.get(thread.videoId) ?? 0) >= PER_VIDEO_REPLY_CAP) {
      tally.skipped++;
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
      tally.skipped++;
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
      tally.skipped++;
      continue;
    }

    const sent = await postClaimed(token, thread, { id: thread.topLevelCommentId, rowId: claimRowId }, outcome.replyText!, outcome);
    countSent(sent, tally, videoPostCounts, thread.videoId);
    if (sent === 'halt') {
      halted = true;
      break;
    }
  }

  // Follow-up pass: replies directed at the bot in threads it already
  // answered, within whatever daily budget the top-level loop left.
  let followUps: FollowUpTally = { posted: 0, unknown: 0, skipped: 0, gates: {} };
  try {
    if (!halted) {
      followUps = await processFollowUps(token, DAILY_REPLY_CAP - startingDailyCount - tally.posted - tally.unknown, videoPostCounts);
    }
  } catch (err) {
    logTickError(err);
  }

  await cleanupSkippedRows();

  console.log(JSON.stringify({
    evt: 'youtube_bot_tick',
    durationMs: Date.now() - t0,
    threads: threads.length,
    posted: tally.posted,
    unknown: tally.unknown,
    skipped: tally.skipped,
    followUpsPosted: followUps.posted,
    followUpsUnknown: followUps.unknown,
    followUpsSkipped: followUps.skipped,
    followUpGates: followUps.gates,
    dailyTotal: startingDailyCount + tally.posted + tally.unknown + followUps.posted + followUps.unknown,
  }));
}

// ---------------------------------------------------------------------------
// Auto-start on module import
// ---------------------------------------------------------------------------

startYouTubeBot();
