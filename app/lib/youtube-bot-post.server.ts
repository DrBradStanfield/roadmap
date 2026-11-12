/**
 * YouTube comment auto-replier: post one claimed reply, top-level or follow-up
 * (US-27 AC5). Mark, then post, then record:
 *   1. markPosting sets posted=true with a token before the post. If the mark
 *      is not verified, nothing is posted.
 *   2. postReply's answer is classified (youtube-bot-post-result.ts):
 *      posted: the reply and its id are stored, as before.
 *      unknown: the row stays posted=true with no id, so it counts toward both
 *        caps, cleanup and unclaim keep it, and it is never posted again.
 *      refused: the mark is reverted to a plain claim by its token, or, for an
 *        account-wide refusal (401, 429, quotaExceeded), deleted so a later tick
 *        retries, and this tick posts nothing more.
 * Logs and Sentry carry the result class, Google's reason code and the comment
 * id only: never viewer text, the answer or Google's body.
 */
import * as Sentry from '@sentry/react-router';
import { postReply, type YouTubeThread } from './youtube-bot-api.server';
import { isAccountWide } from './youtube-bot-post-result';
import { markPosting, releasePostingMark, unclaimComment, markPosted, persistYouTubeTurn } from './youtube-bot-store.server';
import type { PipelineOutcome } from './youtube-bot-pipeline.server';

/** `halt`: an account-wide refusal; the tick posts nothing more. */
export type Sent = 'posted' | 'unknown' | 'skipped' | 'halt';

/** Posts `replyText` under `thread` for the comment claimed as `claimId` (the thread id, or a follow-up's reply id). */
export async function postClaimed(
  token: string,
  thread: YouTubeThread,
  claimId: string,
  replyText: string,
  outcome: PipelineOutcome,
): Promise<Sent> {
  const mark = await markPosting(claimId, thread.videoId);
  if (mark.state === 'lost') return 'skipped';
  if (mark.state === 'failed') {
    // Our mark may have landed; take it back, then the plain claim, so a later tick retries.
    await releasePostingMark(claimId, mark.token, 'delete');
    await unclaimComment(claimId);
    return 'skipped';
  }

  const result = await postReply(token, thread.topLevelCommentId, replyText);
  if (result.kind === 'posted') {
    await markPosted({
      commentId: claimId,
      videoId: thread.videoId,
      userChannel: thread.authorDisplayName,
      userComment: thread.text,
      replyText,
      postedYoutubeId: result.id,
      classification: outcome.classification ?? 'ERROR',
      routerHandles: outcome.routerHandles ?? [],
    });
    // Durable, queryable copy in the shared chat tables (training + audit).
    await persistYouTubeTurn({
      thread,
      outcome,
      postedYoutubeId: result.id,
      followUpCommentId: claimId === thread.topLevelCommentId ? null : claimId,
    });
    return 'posted';
  }

  console.log(JSON.stringify({ evt: 'youtube_bot_post', commentId: claimId, ...result }));
  if (result.kind === 'unknown') {
    Sentry.captureMessage('YouTube bot: post outcome unknown', {
      level: 'warning',
      tags: { feature: 'youtube-bot', subsystem: 'post', why: result.why },
      extra: { commentId: claimId },
    });
    return 'unknown';
  }
  const halt = isAccountWide(result);
  await releasePostingMark(claimId, mark.token, halt ? 'delete' : 'revert');
  if (result.reason !== 'notReplyable') {
    Sentry.captureMessage('YouTube bot: post refused', {
      level: halt ? 'error' : 'warning',
      tags: { feature: 'youtube-bot', subsystem: 'post', status: String(result.status), reason: result.reason },
      extra: { commentId: claimId },
    });
  }
  return halt ? 'halt' : 'skipped';
}

/** Counts one answer; an unknown counts against both caps, as a post does. */
export function countSent(
  sent: Sent,
  tally: { posted: number; unknown: number; skipped: number },
  videoPostCounts: Map<string, number>,
  videoId: string,
): void {
  if (sent === 'posted' || sent === 'unknown') {
    tally[sent]++;
    videoPostCounts.set(videoId, (videoPostCounts.get(videoId) ?? 0) + 1);
  } else {
    tally.skipped++;
  }
}
