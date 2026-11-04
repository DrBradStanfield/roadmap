/**
 * YouTube comment auto-replier: Supabase reads and writes. The youtube_bot_log
 * claim and posting lifecycle, the posting caps, the shared chat-table copy of
 * each turn, and the recent threads scanned for follow-ups. Split out of
 * youtube-bot.server.ts (issue #429), which re-exports its public names.
 */
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin } from './supabase.server';
import { routerColumns, matchEventText, answerColumns } from './chat-persist.server';
import { generateTitle } from './chat.server';
import { COMMENT_MAX_AGE_DAYS, PLATFORM_YOUTUBE, BOT_PROFILE_ID } from './youtube-bot-config.server';
import type { YouTubeThread } from './youtube-bot-api.server';
import type { PipelineOutcome } from './youtube-bot-pipeline.server';

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
export async function claimComment(commentId: string): Promise<boolean> {
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
export async function unclaimComment(commentId: string): Promise<void> {
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

export async function markPosted(p: MarkPostedParams): Promise<void> {
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

/** Throws when the count is unreadable (US-27 AC1) — returning 0 here silently
 *  re-armed the full daily cap whenever Supabase errored (Sentry
 *  JAVASCRIPT-REMIX-65). Captured at the query site so the Sentry issue keeps
 *  this function's name; the caps catch in tick() must not re-capture. */
async function countTodayPosts(): Promise<number> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not configured');
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabaseAdmin
    .from('youtube_bot_log')
    .select('id', { count: 'exact', head: true })
    .eq('posted', true)
    .gte('posted_at', todayStart.toISOString());
  if (error) {
    Sentry.captureException(error, { tags: { feature: 'youtube-bot' } });
    throw error;
  }
  return count ?? 0;
}

/** Rows asked for per page of readPostedRows; PostgREST answers at most 1000 (Supabase's default max rows). */
const VIDEO_COUNT_PAGE = 1000;

/** Every posted row in youtube_bot_log, read in pages by id until a page comes
 *  back empty (US-27 AC4): one select answered only the first 1000 posted rows,
 *  so past 1000 replies the lifetime cap undercounted. An empty page, not a
 *  short one, ends the read, so a server cap below the page size still reads all.
 *  Throws when any page is unreadable (US-27 AC1). */
async function readPostedRows(): Promise<{ id: number; video_id: string | null }[]> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not configured');
  const rows: { id: number; video_id: string | null }[] = [];
  let afterId = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('youtube_bot_log')
      .select('id, video_id')
      .eq('posted', true)
      .gt('id', afterId)
      .order('id', { ascending: true })
      .limit(VIDEO_COUNT_PAGE);
    if (error) {
      Sentry.captureException(error, { tags: { feature: 'youtube-bot' } });
      throw error;
    }
    if (!data.length) return rows;
    rows.push(...data);
    afterId = data[data.length - 1].id;
  }
}

/** How many replies we've posted on each video, read once per tick so the
 *  per-comment loop makes no queries.
 *  Throws when the counts are unreadable (US-27 AC1) — an empty map on error
 *  bypassed PER_VIDEO_REPLY_CAP (Sentry JAVASCRIPT-REMIX-64). */
async function fetchVideoPostCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const row of await readPostedRows()) {
    if (row.video_id) counts.set(row.video_id, (counts.get(row.video_id) ?? 0) + 1);
  }
  return counts;
}

/** Both posting caps; rejects if either read failed — with caps unknown the
 *  tick must post nothing and retry next tick (US-27 AC2). */
export async function readPostingCaps(): Promise<{ dailyCount: number; videoPostCounts: Map<string, number> }> {
  const [dailyCount, videoPostCounts] = await Promise.all([
    countTodayPosts(),
    fetchVideoPostCounts(),
  ]);
  return { dailyCount, videoPostCounts };
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
 * YouTube by the time this runs. Exported for tests.
 */
export async function persistYouTubeTurn(p: {
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
          title: generateTitle(thread.text),
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

    // The assistant half, whenever the main LLM was called, as the web chat
    // stores it (US-15 AC52): the answer, SKIP_NO_REPLY, or on a failed turn the
    // fixed fallback or refusal line with its failure_mode and error_detail. That
    // line is never posted on YouTube. A classifier silent skip (GREETING, SPAM or
    // an unreadable answer) never reached the model, so it gets no assistant row.
    let assistantMessageId: string | null = null;
    if (outcome.completion) {
      assistantMessageId = crypto.randomUUID();
      const { error: asstErr } = await supabaseAdmin.from('chat_messages').insert({
        id: assistantMessageId,
        conversation_id: conversationId,
        user_id: BOT_PROFILE_ID,
        role: 'assistant',
        content: outcome.completion.content.trim(), // as posted (completionOutcome trims)
        ...answerColumns(outcome.completion),
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
      message: matchEventText(thread.text),
      router_context: {
        platform: PLATFORM_YOUTUBE,
        videoId: thread.videoId,
        commentId: thread.topLevelCommentId,
        followUpCommentId: p.followUpCommentId ?? null,
        postedYoutubeId: p.postedYoutubeId,
        posted: outcome.posted,
        skipReason: outcome.skipReason ?? null,
        ...(outcome.replaced?.length ? { replaced: outcome.replaced } : {}),
        ...(outcome.reduced?.length ? { reduced: outcome.reduced } : {}),
      },
      matched_handles: outcome.routerHandles ?? [],
      ...routerColumns(r),
      classification: outcome.classification ?? 'ERROR',
      router_skipped: outcome.routerSkipped ?? false,
      is_fallback: outcome.isFallback ?? false,
      failure_mode: outcome.failureMode ?? null,
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

export async function cleanupSkippedRows(): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.rpc('youtube_bot_cleanup_skipped');
  if (error) {
    Sentry.captureException(error, { tags: { feature: 'youtube-bot', subsystem: 'cleanup' } });
  }
}

/** Threads the bot has posted in recently (candidates for follow-up scanning),
 *  plus the set of ALL comment IDs the bot ever posted in the window — used to
 *  tell bot replies apart from Brad's own. Reply-row IDs (`thread.suffix`)
 *  collapse onto their thread. */
export async function fetchRecentPostedThreads(): Promise<{
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
