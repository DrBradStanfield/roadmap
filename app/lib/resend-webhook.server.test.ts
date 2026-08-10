import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyResendSignature, parseResendEvent } from './resend-webhook.server';

/**
 * US-22 AC3/AC10 — the bounce/complaint webhook is authenticated only by its
 * Svix signature, so these tests are the security boundary for a public
 * endpoint that can unsubscribe people and delete reminder rows.
 */

const SECRET = 'whsec_' + Buffer.from('super-secret-key-bytes').toString('base64');

function sign(body: string, id: string, timestamp: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${sig}`;
}

describe('US-22 verifyResendSignature', () => {
  const body = JSON.stringify({ type: 'email.bounced' });
  const id = 'msg_123';
  const now = 1_700_000_000;
  const ts = String(now);

  it('accepts a correctly signed, fresh request', () => {
    const result = verifyResendSignature(body, { id, timestamp: ts, signature: sign(body, id, ts) }, SECRET, now);
    expect(result.ok).toBe(true);
  });

  it('rejects a tampered body (the signature covers the exact bytes)', () => {
    const signature = sign(body, id, ts);
    const tampered = JSON.stringify({ type: 'email.bounced', injected: true });
    const result = verifyResendSignature(tampered, { id, timestamp: ts, signature }, SECRET, now);
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const other = 'whsec_' + Buffer.from('attacker-key').toString('base64');
    const result = verifyResendSignature(body, { id, timestamp: ts, signature: sign(body, id, ts, other) }, SECRET, now);
    expect(result.ok).toBe(false);
  });

  it('rejects a replayed request outside the skew window', () => {
    const oldTs = String(now - 3600);
    const result = verifyResendSignature(body, { id, timestamp: oldTs, signature: sign(body, id, oldTs) }, SECRET, now);
    expect(result).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
  });

  it('rejects when headers are missing entirely', () => {
    const result = verifyResendSignature(body, { id: null, timestamp: null, signature: null }, SECRET, now);
    expect(result).toEqual({ ok: false, reason: 'missing svix headers' });
  });

  it('fails closed when the secret is not configured', () => {
    const result = verifyResendSignature(body, { id, timestamp: ts, signature: sign(body, id, ts) }, undefined, now);
    expect(result.ok).toBe(false);
  });

  it('accepts when the header carries several rotated signatures', () => {
    const good = sign(body, id, ts);
    const header = `v1,AAAAinvalidsignature== ${good}`;
    expect(verifyResendSignature(body, { id, timestamp: ts, signature: header }, SECRET, now).ok).toBe(true);
  });
});

describe('US-22 parseResendEvent', () => {
  it('treats a permanent bounce as actionable', () => {
    const parsed = parseResendEvent({
      type: 'email.bounced',
      data: { to: ['Dead@Example.com'], bounce: { type: 'Permanent' } },
    });
    expect(parsed).toEqual({ kind: 'bounced', emails: ['dead@example.com'] });
  });

  it('IGNORES a transient bounce — a full mailbox must not unenroll a real user', () => {
    const parsed = parseResendEvent({
      type: 'email.bounced',
      data: { to: ['busy@example.com'], bounce: { type: 'Transient' } },
    });
    expect(parsed.kind).toBe('ignored');
  });

  it('treats a spam complaint as actionable (AC10)', () => {
    const parsed = parseResendEvent({ type: 'email.complained', data: { to: ['annoyed@example.com'] } });
    expect(parsed).toEqual({ kind: 'complained', emails: ['annoyed@example.com'] });
  });

  it('ignores delivery events', () => {
    expect(parseResendEvent({ type: 'email.delivered', data: { to: ['ok@example.com'] } }).kind).toBe('ignored');
  });

  it('ignores malformed payloads instead of throwing', () => {
    expect(parseResendEvent(null).kind).toBe('ignored');
    expect(parseResendEvent({ type: 'email.bounced' }).kind).toBe('ignored');
    expect(parseResendEvent({ type: 'email.bounced', data: { to: 'not-an-email' } }).kind).toBe('ignored');
  });
});
