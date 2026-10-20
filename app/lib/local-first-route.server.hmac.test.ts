import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { getClientIp, verifyAppProxySignature } from './local-first-route.server';
import { forgedQuery, proxyPairs, signedQuery, TEST_PROXY_SECRET } from './app-proxy.test-helpers';

const SECRET = TEST_PROXY_SECRET;
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

  // US-09 AC24: Shopify sends each of its own params once. A second copy is a
  // forgery even when the signature covers the comma-joined values.
  it.each(['logged_in_customer_id', 'path_prefix', 'shop', 'timestamp'])(
    'rejects a duplicated %s even when the signature covers both copies',
    (key) => {
      const pairs: [string, string][] = [...proxyPairs('111', NOW)];
      const value = pairs.find(([k]) => k === key)![1];
      pairs.push([key, value]);
      const req = new Request(`https://x.test/api${signedQuery(pairs)}`);
      expect(verifyAppProxySignature(req, NOW)).toBe(false);
    },
  );

  it('rejects a duplicated signature', () => {
    const qs = signedQuery(proxyPairs('111', NOW));
    const sig = new URLSearchParams(qs).get('signature');
    expect(verifyAppProxySignature(new Request(`https://x.test/api${qs}`), NOW)).toBe(true);
    expect(verifyAppProxySignature(new Request(`https://x.test/api${qs}&signature=${sig}`), NOW)).toBe(false);
  });

  it('rejects the prepended-customer forgery a last-copy verifier accepts', () => {
    expect(verifyAppProxySignature(new Request(`https://x.test/api${forgedQuery('999', '111', NOW)}`), NOW)).toBe(false);
    expect(verifyAppProxySignature(new Request(`https://x.test/api${forgedQuery('999', '', NOW)}`), NOW)).toBe(false);
  });

  it('still accepts a repeated app param (only Shopify params must be single)', () => {
    const pairs: [string, string][] = [...proxyPairs('111', NOW), ['tag', 'a'], ['tag', 'b']];
    expect(verifyAppProxySignature(new Request(`https://x.test/api${signedQuery(pairs)}`), NOW)).toBe(true);
  });

  it('rejects everything when the secret env is missing', () => {
    delete process.env.SHOPIFY_API_SECRET;
    const req = new Request(signedUrl(baseParams));
    expect(verifyAppProxySignature(req, NOW)).toBe(false);
    process.env.SHOPIFY_API_SECRET = SECRET;
  });
});


describe('getClientIp (US-32 M-6)', () => {
  const ip = (headers: Record<string, string>, trust: 'fly' | 'shopify') =>
    getClientIp(new Request('https://x.test/', { headers }), trust);

  describe("trust: 'fly' — the caller reaches Fly directly (mcp, google-token, reminders-v2)", () => {
    it('uses the header Fly writes and ignores the one a client can forge', () => {
      expect(ip({ 'fly-client-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }, 'fly')).toBe('203.0.113.7');
    });

    it('never falls back to a forgeable X-Forwarded-For', () => {
      expect(ip({ 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }, 'fly')).toBe('unknown');
      expect(ip({}, 'fly')).toBe('unknown');
    });
  });

  describe("trust: 'shopify' — browser -> Shopify app proxy -> Fly", () => {
    // Fly's peer is Shopify's egress, so Fly-Client-IP is Shopify, not the
    // shopper. The shopper is the hop Shopify added, one to the LEFT of the
    // entry Fly saw. Everything left of that is caller-supplied.
    it('takes the hop before the one Fly saw, not the leading (forgeable) entry', () => {
      expect(ip({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 35.1.2.3', 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('203.0.113.9');
    });

    it('a rotating forged first entry does not change the answer', () => {
      for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3, 4.4.4.4']) {
        expect(ip({ 'x-forwarded-for': `${forged}, 203.0.113.9, 35.1.2.3`, 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('203.0.113.9');
      }
    });

    it('handles Fly appending its own app IP after the peer', () => {
      // Documented shape: "the last address (rightmost) ... will be a shared or
      // dedicated IP address assigned to your app". Anchoring on Fly-Client-IP
      // (searched from the right) works whether or not that entry is last.
      expect(ip({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 35.1.2.3, 66.0.0.1', 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('203.0.113.9');
      expect(ip({ 'x-forwarded-for': '203.0.113.9, 35.1.2.3, 66.241.124.56', 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('203.0.113.9');
    });

    it('a different shopper behind the same Shopify egress is a different IP', () => {
      expect(ip({ 'x-forwarded-for': '198.51.100.77, 35.1.2.3', 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('198.51.100.77');
    });

    it('local dev: no Fly header and a single XFF entry is the caller', () => {
      expect(ip({ 'x-forwarded-for': '198.51.100.4' }, 'shopify')).toBe('198.51.100.4');
    });

    it('uses the last hop when Fly did not append its peer to XFF', () => {
      // Fly is not documented to append; if its address is absent from the
      // list, the final hop is the one SHOPIFY appended — the shopper.
      expect(ip({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('203.0.113.9');
      expect(ip({ 'x-forwarded-for': '203.0.113.9', 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('203.0.113.9');
    });

    it('falls back to the Fly header when XFF is missing, unparseable, or holds only the Fly hop', () => {
      expect(ip({ 'fly-client-ip': '35.1.2.3' }, 'shopify')).toBe('35.1.2.3');
      expect(ip({ 'fly-client-ip': '35.1.2.3', 'x-forwarded-for': ' , ,' }, 'shopify')).toBe('35.1.2.3');
      expect(ip({ 'fly-client-ip': '35.1.2.3', 'x-forwarded-for': '35.1.2.3' }, 'shopify')).toBe('35.1.2.3');
    });

    it('multi-hop XFF with no Fly header refuses to guess', () => {
      expect(ip({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' }, 'shopify')).toBe('unknown');
      expect(ip({}, 'shopify')).toBe('unknown');
    });
  });
});
