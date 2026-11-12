/**
 * YouTube comment auto-replier: post one claimed reply, top-level or follow-up
 * (US-27 AC5). Mark, then post, then record:
 *   1. markPosting sets posted=true with a token before the post. If the mark
 *      is not verified, nothing is posted.
 *   2. postReply's answer is classified (youtube-bot-post-result.ts):
 *      posted: the reply and its id are stored, as before.
 *      unknown: the row stays posted=true with no id, so it counts toward both
 *        caps, cleanup and unclaim keep it, and it is never posted again. The
 *        turn is stored as a success's is, with no posted id.
 *      refused: the mark is reverted to a plain claim by its row and token, or,
 *        for an account-wide refusal (401, 429, a quota or rate-limit reason),
 *        deleted so a later tick retries, and this tick posts nothing more.
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

/** Posts `replyText` under `thread` for the claimed comment: `claim.id` is the thread id or a follow-up's
 *  reply id, `claim.rowId` the claim row claimComment inserted. */
export async function postClaimed(
  token: string,
  thread: YouTubeThread,
  claim: { id: string; rowId: number },
  replyText: string,
  outcome: PipelineOutcome,
): Promise<Sent> {
  const claimId = claim.id;
  const mark = await markPosting(claimId, claim.rowId, thread.videoId);
  if (mark.state === 'lost') return 'skipped';
  if (mark.state === 'failed') {
    // Our mark may have landed; take it back, then the plain claim, so a later tick retries.
    await releasePostingMark(claimId, claim.rowId, mark.token, 'delete');
    await unclaimComment(claimId);
    return 'skipped';
  }

  const result = await postReply(token, thread.topLevelCommentId, replyText);
  if (result.kind !== 'refused') {
    if (result.kind === 'posted') await markPosted({
      commentId: claimId,
      videoId: thread.videoId,
      userChannel: thread.authorDisplayName,
      userComment: thread.text,
      replyText,
      postedYoutubeId: result.id,
      classification: outcome.classification ?? 'ERROR',
      routerHandles: outcome.routerHandles ?? [],
    });
    // Durable, queryable copy in the shared chat tables (training + audit); an unknown post's has no id (C15 R2).
    await persistYouTubeTurn({
      thread,
      outcome,
      postedYoutubeId: result.kind === 'posted' ? result.id : null,
      followUpCommentId: claimId === thread.topLevelCommentId ? null : claimId,
    });
    if (result.kind === 'posted') return 'posted';
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
  await releasePostingMark(claimId, claim.rowId, mark.token, halt ? 'delete' : 'revert');
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
