/**
 * What a YouTube comments.insert answer means (US-27 AC5). `refused` is a
 * definite no: nothing was posted. `unknown` may have landed: a timeout or a
 * network error (Google can commit after our side gives up, and the call has no
 * idempotency key), a 5xx, an unreadable 2xx, the 400 processingFailure, which
 * Google calls often transient (C15 Q4), or a 400 with no reason code, which may
 * hide one: a missed reply is cheaper than a second public one (N3). Pure; the reason is Google's
 * code, shape-checked, so no body text leaves here.
 */
export type PostResult =
  | { kind: 'posted'; id: string }
  | { kind: 'refused'; status: number; reason: string }
  | { kind: 'unknown'; why: 'timeout' | 'network' | '5xx' | 'processingFailure' }
  | { kind: 'unknown'; why: 'unreadable'; status: number };

/** The 400 YouTube sends when the thread cannot take replies (canReply false). */
const NOT_REPLYABLE = 'Not all comments can be replied to';

function googleReason(body: string): string {
  if (body.includes(NOT_REPLYABLE)) return 'notReplyable';
  try {
    const reason = (JSON.parse(body) as { error?: { errors?: Array<{ reason?: unknown }> } }).error?.errors?.[0]?.reason;
    return typeof reason === 'string' && /^[\w-]{1,40}$/.test(reason) ? reason : 'unparsed';
  } catch {
    return 'unparsed';
  }
}

export function classifyPost(answer: { status: number; body: string } | { error: unknown }): PostResult {
  if ('error' in answer) {
    return { kind: 'unknown', why: (answer.error as { name?: unknown })?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  const { status, body } = answer;
  if (status >= 200 && status < 300) {
    try {
      const id = (JSON.parse(body) as { id?: unknown }).id;
      if (typeof id === 'string' && id) return { kind: 'posted', id };
    } catch { /* unreadable */ }
    return { kind: 'unknown', why: 'unreadable', status };
  }
  // fetch follows redirects, so a failure is 4xx or 5xx; anything else is not a definite no.
  if (status < 400 || status >= 500) return { kind: 'unknown', why: '5xx' };
  const reason = googleReason(body);
  if (reason === 'processingFailure') return { kind: 'unknown', why: 'processingFailure' };
  if (reason === 'unparsed' && status === 400) return { kind: 'unknown', why: 'unreadable', status };
  return { kind: 'refused', status, reason };
}

/** Google's quota and rate-limit reasons (403s): they refuse the account, not the comment. */
const ACCOUNT_WIDE_REASONS = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']);

/** 401, 429 and the quota and rate-limit reasons refuse every post on the account, not this one comment (C15 Q3, R1). */
export function isAccountWide(r: PostResult): boolean {
  return r.kind === 'refused' && (r.status === 401 || r.status === 429 || ACCOUNT_WIDE_REASONS.has(r.reason));
}
