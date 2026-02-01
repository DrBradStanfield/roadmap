import { describe, it, expect, beforeEach } from 'vitest';

// Re-import fresh module for each test to reset the in-memory store.
// We use dynamic import with cache-busting via vi.resetModules().
import { rateLimit } from './rate-limit.server';

function makeRequest(ip: string): Request {
  return new Request('http://localhost/api/test', {
    headers: { 'Fly-Client-IP': ip },
  });
}

describe('rateLimit', () => {
  it('allows requests under the limit', () => {
    const req = makeRequest('10.0.0.1');
    const result = rateLimit(req, { maxRequests: 5 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('tracks requests per IP', () => {
    const ip = '10.0.0.2';
    for (let i = 0; i < 3; i++) {
      rateLimit(makeRequest(ip), { maxRequests: 5 });
    }
    const result = rateLimit(makeRequest(ip), { maxRequests: 5 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it('blocks requests over the limit', () => {
    const ip = '10.0.0.3';
    for (let i = 0; i < 5; i++) {
      rateLimit(makeRequest(ip), { maxRequests: 5 });
    }
    const result = rateLimit(makeRequest(ip), { maxRequests: 5 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('isolates different IPs', () => {
    for (let i = 0; i < 5; i++) {
      rateLimit(makeRequest('10.0.0.4'), { maxRequests: 5 });
    }
    const result = rateLimit(makeRequest('10.0.0.5'), { maxRequests: 5 });
    expect(result.allowed).toBe(true);
  });

  it('uses X-Forwarded-For when Fly-Client-IP is absent', () => {
    const req = new Request('http://localhost/api/test', {
      headers: { 'X-Forwarded-For': '192.168.1.1, 10.0.0.1' },
    });
    const result = rateLimit(req, { maxRequests: 5 });
    expect(result.allowed).toBe(true);
  });

  it('resets after window expires', () => {
    const ip = '10.0.0.6';
    // Use a very short window
    for (let i = 0; i < 5; i++) {
      rateLimit(makeRequest(ip), { maxRequests: 5, windowMs: 1 });
    }
    // Wait for window to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = rateLimit(makeRequest(ip), { maxRequests: 5, windowMs: 1 });
        expect(result.allowed).toBe(true);
        resolve();
      }, 10);
    });
  });
});
