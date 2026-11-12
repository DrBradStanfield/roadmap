/**
 * US-27 AC5: what a YouTube comments.insert answer means for the posting mark.
 * `posted` and a definite `refused` are known; anything that may have landed is
 * `unknown` (timeout, network, 5xx, an unreadable 2xx or 400, and the 400
 * processingFailure, which Google calls often transient: Q4). Reason codes are
 * Google's, shape-checked, so no body text ever leaves this function.
 */
import { describe, expect, it } from 'vitest';
import { classifyPost, isAccountWide, nextPosting, OPEN_POSTING, type Posting, type PostResult, type Sent } from './youtube-bot-post-result';

const body = (reason: string, message = 'Some message with viewer words') =>
  JSON.stringify({ error: { code: 0, message, errors: [{ reason, domain: 'youtube.comment', message }] } });
const notReplyable = JSON.stringify({ error: { code: 400, message: "Not all comments can be replied to. Check the comment thread's canReply field." } });

describe('US-27 AC5: classifyPost', () => {
  const table: Array<[string, Parameters<typeof classifyPost>[0], PostResult]> = [
    ['200 with an id', { status: 200, body: '{"id":"Ugx.abc"}' }, { kind: 'posted', id: 'Ugx.abc' }],
    ['200, body not JSON', { status: 200, body: '<html>' }, { kind: 'unknown', why: 'unreadable', status: 200 }],
    ['200, JSON with no id', { status: 200, body: '{"kind":"youtube#comment"}' }, { kind: 'unknown', why: 'unreadable', status: 200 }],
    ['500', { status: 500, body: body('backendError') }, { kind: 'unknown', why: '5xx' }],
    ['503 with no body', { status: 503, body: '' }, { kind: 'unknown', why: '5xx' }],
    ['400 processingFailure', { status: 400, body: body('processingFailure') }, { kind: 'unknown', why: 'processingFailure' }],
    ['400 not replyable', { status: 400, body: notReplyable }, { kind: 'refused', status: 400, reason: 'notReplyable' }],
    // A 400 with no reason may be processingFailure behind a proxy page: a missed reply beats a second one (N3).
    ['400, body not JSON', { status: 400, body: '<html>Bad Request viewer words</html>' }, { kind: 'unknown', why: 'unreadable', status: 400 }],
    ['400, empty body', { status: 400, body: '' }, { kind: 'unknown', why: 'unreadable', status: 400 }],
    ['400, a reason that is not a plain code', { status: 400, body: body('has spaces') }, { kind: 'unknown', why: 'unreadable', status: 400 }],
    ['400 invalidCommentText', { status: 400, body: body('invalidCommentText') }, { kind: 'refused', status: 400, reason: 'invalidCommentText' }],
    ['400 commentTextTooLong', { status: 400, body: body('commentTextTooLong') }, { kind: 'refused', status: 400, reason: 'commentTextTooLong' }],
    ['401', { status: 401, body: body('authError') }, { kind: 'refused', status: 401, reason: 'authError' }],
    ['403 forbidden', { status: 403, body: body('forbidden') }, { kind: 'refused', status: 403, reason: 'forbidden' }],
    ['403 quotaExceeded', { status: 403, body: body('quotaExceeded') }, { kind: 'refused', status: 403, reason: 'quotaExceeded' }],
    ['404 parentCommentNotFound', { status: 404, body: body('parentCommentNotFound') }, { kind: 'refused', status: 404, reason: 'parentCommentNotFound' }],
    ['429 rateLimitExceeded', { status: 429, body: body('rateLimitExceeded') }, { kind: 'refused', status: 429, reason: 'rateLimitExceeded' }],
    ['403, body not JSON', { status: 403, body: 'Forbidden: viewer words here' }, { kind: 'refused', status: 403, reason: 'unparsed' }],
    ['403, a reason that is not a plain code', { status: 403, body: body('has spaces and viewer words') }, { kind: 'refused', status: 403, reason: 'unparsed' }],
    ['timeout', { error: new DOMException('The operation was aborted due to timeout', 'TimeoutError') }, { kind: 'unknown', why: 'timeout' }],
    ['fetch failed', { error: new TypeError('fetch failed') }, { kind: 'unknown', why: 'network' }],
    ['a thrown non-error', { error: 'boom' }, { kind: 'unknown', why: 'network' }],
  ];
  for (const [name, input, want] of table) {
    it(name, () => expect(classifyPost(input)).toEqual(want));
  }
});

describe('US-27 AC5 (Q3, R1): 401, 429 and the quota and rate-limit reasons are account-wide', () => {
  const table: Array<[PostResult, boolean]> = [
    [{ kind: 'refused', status: 401, reason: 'authError' }, true],
    [{ kind: 'refused', status: 429, reason: 'rateLimitExceeded' }, true],
    [{ kind: 'refused', status: 403, reason: 'quotaExceeded' }, true],
    [{ kind: 'refused', status: 403, reason: 'forbidden' }, false],
    [{ kind: 'refused', status: 403, reason: 'rateLimitExceeded' }, true],
    [{ kind: 'refused', status: 403, reason: 'userRateLimitExceeded' }, true],
    [{ kind: 'refused', status: 403, reason: 'dailyLimitExceeded' }, true],
    [{ kind: 'refused', status: 400, reason: 'notReplyable' }, false],
    [{ kind: 'unknown', why: '5xx' }, false],
    [{ kind: 'posted', id: 'x' }, false],
  ];
  for (const [result, want] of table) {
    it(JSON.stringify(result), () => expect(isAccountWide(result)).toBe(want));
  }
});

describe('US-27 AC5 (c): one tick posts until an account-wide refusal or the second unreadable 400', () => {
  const open = (n: number): Posting => ({ kind: 'open', unreadable400s: n });
  const accountWide: Posting = { kind: 'halted', reason: 'accountWide' };
  const unreadable: Posting = { kind: 'halted', reason: 'unreadable400' };
  const table: Array<[Posting, Sent, Posting]> = [
    [open(0), 'posted', open(0)],
    [open(0), 'unknown', open(0)],
    [open(0), 'skipped', open(0)],
    [open(0), 'unknown400', open(1)],
    [open(1), 'posted', open(1)],
    [open(1), 'unknown', open(1)],
    [open(1), 'unknown400', unreadable],
    [open(0), 'halt', accountWide],
    [open(1), 'halt', accountWide],
    [accountWide, 'posted', accountWide],
    // A halted tick stays halted with its first reason (N2).
    [unreadable, 'halt', unreadable],
    [accountWide, 'unknown400', accountWide],
  ];
  for (const [from, sent, want] of table) {
    it(`${JSON.stringify(from)} + ${sent}`, () => expect(nextPosting(from, sent)).toEqual(want));
  }
  it('a tick starts open with none seen', () => expect(OPEN_POSTING).toEqual(open(0)));
  it('OPEN_POSTING is frozen, so no edit leaks across ticks', () => expect(Object.isFrozen(OPEN_POSTING)).toBe(true));
});
