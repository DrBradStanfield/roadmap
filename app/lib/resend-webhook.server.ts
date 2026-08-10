import crypto from 'node:crypto';

/**
 * Resend webhook signature verification (US-22 AC3).
 *
 * Resend signs with Svix. Verifying by hand rather than adding the `svix`
 * package: the algorithm is ~20 lines of node:crypto, and CLAUDE.md requires a
 * justification for every new dependency — "avoids 20 lines" isn't one on a
 * public, health-adjacent repo.
 *
 * signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 * signature      = base64(HMAC-SHA256(secret, signed content))
 * header         = space-separated `v1,<sig>` entries (key rotation → several)
 */

/** Reject anything older than this — a captured POST must not be replayable. */
const MAX_SKEW_SECONDS = 5 * 60;

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export function verifyResendSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyOutcome {
  if (!secret) return { ok: false, reason: 'RESEND_WEBHOOK_SECRET not configured' };
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing svix headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: 'timestamp outside tolerance' };

  // `whsec_` prefix is cosmetic; the rest is the base64 key.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  // Header may carry several versioned signatures; any match is a pass.
  const candidates = signature
    .split(' ')
    .map((part) => part.split(','))
    .filter(([version]) => version === 'v1')
    .map(([, sig]) => sig)
    .filter((sig): sig is string => Boolean(sig));

  const expectedBuf = Buffer.from(expected);
  const matched = candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate);
    // timingSafeEqual throws on length mismatch — check first, still constant
    // time for equal-length values, which is the case that matters.
    return candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf);
  });

  return matched ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

export type ResendEventKind = 'bounced' | 'complained' | 'ignored';

export interface ParsedResendEvent {
  kind: ResendEventKind;
  emails: string[];
}

/**
 * Pull the actionable facts out of a Resend event.
 *
 * Only PERMANENT bounces suppress. A transient bounce (full mailbox, greylist,
 * a momentarily broken MX) says nothing about whether the address is real, and
 * treating it as dead would silently unenroll a legitimate user from health
 * reminders — the expensive direction to be wrong in.
 */
export function parseResendEvent(payload: unknown): ParsedResendEvent {
  const event = payload as {
    type?: unknown;
    data?: { to?: unknown; bounce?: { type?: unknown } };
  } | null;
  const type = typeof event?.type === 'string' ? event.type : '';
  const to = event?.data?.to;
  const emails = (Array.isArray(to) ? to : [to])
    .filter((value): value is string => typeof value === 'string' && value.includes('@'))
    .map((value) => value.trim().toLowerCase());

  if (!emails.length) return { kind: 'ignored', emails: [] };

  if (type === 'email.complained') return { kind: 'complained', emails };

  if (type === 'email.bounced') {
    const bounceType = event?.data?.bounce?.type;
    const permanent = typeof bounceType === 'string' && bounceType.toLowerCase() === 'permanent';
    return permanent ? { kind: 'bounced', emails } : { kind: 'ignored', emails };
  }

  return { kind: 'ignored', emails };
}
