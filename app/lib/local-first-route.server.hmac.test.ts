import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { verifyAppProxySignature } from './local-first-route.server';

const SECRET = 'test-shopify-secret';
const NOW = 1_780_000_000; // fixed "current" time, seconds

/** Build a request URL signed the way Shopify's app proxy signs it. */
function signedUrl(params: Record<string, string>, secret = SECRET): string {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('');
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const qs = new URLSearchParams({ ...params, signature });
  return `https://health-tool-app.fly.dev/api/lab-import-v2?${qs}`;
}

const baseParams = {
  shop: 'microvitamin.myshopify.com',
  path_prefix: '/apps/health-tool-1',
  timestamp: String(NOW),
};

let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = SECRET;
});
afterAll(() => {
  process.env.SHOPIFY_API_SECRET = savedSecret;
});

describe('verifyAppProxySignature', () => {
  it('accepts a correctly signed proxy request', () => {
    const req = new Request(signedUrl(baseParams));
    expect(verifyAppProxySignature(req, NOW)).toBe(true);
  });

  it('accepts extra app params (batchId) covered by the signature', () => {
    const req = new Request(signedUrl({ ...baseParams, batchId: 'batch_abc123' }));
    expect(verifyAppProxySignature(req, NOW)).toBe(true);
  });

  it('rejects a tampered param', () => {
    const url = signedUrl(baseParams).replace('health-tool-1', 'evil-prefix');
    expect(verifyAppProxySignature(new Request(url), NOW)).toBe(false);
  });

  it('rejects a signature minted with the wrong secret', () => {
    const req = new Request(signedUrl(baseParams, 'wrong-secret'));
    expect(verifyAppProxySignature(req, NOW)).toBe(false);
  });

  it('rejects a missing or malformed signature', () => {
    const qs = new URLSearchParams(baseParams);
    expect(verifyAppProxySignature(new Request(`https://x.test/api?${qs}`), NOW)).toBe(false);
    expect(verifyAppProxySignature(new Request(`https://x.test/api?${qs}&signature=nothex`), NOW)).toBe(false);
  });

  it('rejects a stale timestamp (replay outside the ±10-minute window)', () => {
    const req = new Request(signedUrl({ ...baseParams, timestamp: String(NOW - 11 * 60) }));
    expect(verifyAppProxySignature(req, NOW)).toBe(false);
  });

  it('rejects everything when the secret env is missing', () => {
    delete process.env.SHOPIFY_API_SECRET;
    const req = new Request(signedUrl(baseParams));
    expect(verifyAppProxySignature(req, NOW)).toBe(false);
    process.env.SHOPIFY_API_SECRET = SECRET;
  });
});
