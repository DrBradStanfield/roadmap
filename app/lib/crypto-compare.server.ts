import crypto from 'node:crypto';

/**
 * Byte compare for secrets (nonces, tokens, MACs). Equal lengths go through
 * crypto.timingSafeEqual, so the time does not depend on where the bytes
 * differ; a different length is false at once and never throws. No caller's
 * length is secret: each compares against a fixed-length value it made.
 */
export function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
