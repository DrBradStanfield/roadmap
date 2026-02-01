import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';

// Test the corsHeaders and verifySessionToken logic directly.
// These are internal functions, so we re-implement the logic here for unit testing.

function corsHeaders(request?: Request) {
  const origin = request?.headers.get('Origin') || '';
  const allowedOrigin =
    origin.endsWith('.shopify.com') ||
    origin.endsWith('.myshopify.com') ||
    origin.endsWith('.shopifycdn.com')
      ? origin
      : '';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
}

describe('corsHeaders', () => {
  it('allows *.shopify.com origins', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://admin.shopify.com' },
    });
    expect(corsHeaders(req)['Access-Control-Allow-Origin']).toBe('https://admin.shopify.com');
  });

  it('allows *.myshopify.com origins', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://mystore.myshopify.com' },
    });
    expect(corsHeaders(req)['Access-Control-Allow-Origin']).toBe('https://mystore.myshopify.com');
  });

  it('allows *.shopifycdn.com origins', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://extensions.shopifycdn.com' },
    });
    expect(corsHeaders(req)['Access-Control-Allow-Origin']).toBe('https://extensions.shopifycdn.com');
  });

  it('rejects non-Shopify origins', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://evil.com' },
    });
    expect(corsHeaders(req)['Access-Control-Allow-Origin']).toBe('');
  });

  it('rejects origins that contain shopify.com but do not end with it', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://shopify.com.evil.com' },
    });
    expect(corsHeaders(req)['Access-Control-Allow-Origin']).toBe('');
  });

  it('returns empty origin when no Origin header', () => {
    const req = new Request('http://localhost');
    expect(corsHeaders(req)['Access-Control-Allow-Origin']).toBe('');
  });
});

describe('verifySessionToken', () => {
  const secret = 'test-secret-key';
  const apiKey = 'test-api-key';

  function makeToken(payload: Record<string, unknown>) {
    return jwt.sign(payload, secret, { algorithm: 'HS256' });
  }

  function verify(authHeader: string | null) {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: apiKey,
    }) as jwt.JwtPayload;

    const sub = decoded.sub;
    if (!sub) throw new Error('Token missing sub claim');
    const match = sub.match(/^gid:\/\/shopify\/Customer\/(\d+)$/);
    if (!match) throw new Error('Invalid customer GID format');
    const dest = decoded.dest;
    if (!dest) throw new Error('Token missing dest claim');
    const shopDomain = dest.includes('://') ? new URL(dest).hostname : dest;
    return { sub: match[1], dest: shopDomain };
  }

  it('extracts customer ID and shop domain from valid token', () => {
    const token = makeToken({
      sub: 'gid://shopify/Customer/12345',
      dest: 'https://mystore.myshopify.com',
      aud: apiKey,
    });
    const result = verify(`Bearer ${token}`);
    expect(result.sub).toBe('12345');
    expect(result.dest).toBe('mystore.myshopify.com');
  });

  it('handles dest without protocol', () => {
    const token = makeToken({
      sub: 'gid://shopify/Customer/99',
      dest: 'mystore.myshopify.com',
      aud: apiKey,
    });
    const result = verify(`Bearer ${token}`);
    expect(result.dest).toBe('mystore.myshopify.com');
  });

  it('throws on missing Authorization header', () => {
    expect(() => verify(null)).toThrow('Missing or invalid Authorization header');
  });

  it('throws on non-Bearer token', () => {
    expect(() => verify('Basic abc123')).toThrow('Missing or invalid Authorization header');
  });

  it('throws on missing sub claim', () => {
    const token = makeToken({ dest: 'https://store.myshopify.com', aud: apiKey });
    expect(() => verify(`Bearer ${token}`)).toThrow('Token missing sub claim');
  });

  it('throws on invalid customer GID format', () => {
    const token = makeToken({
      sub: 'not-a-gid',
      dest: 'https://store.myshopify.com',
      aud: apiKey,
    });
    expect(() => verify(`Bearer ${token}`)).toThrow('Invalid customer GID format');
  });

  it('throws on missing dest claim', () => {
    const token = makeToken({
      sub: 'gid://shopify/Customer/123',
      aud: apiKey,
    });
    expect(() => verify(`Bearer ${token}`)).toThrow('Token missing dest claim');
  });
});
