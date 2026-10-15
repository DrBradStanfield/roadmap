// US-49: scanner probes never flood Sentry. A GET/HEAD route miss outside our own
// top-level route prefixes is a probe (/.env, /id_rsa, /.git/credentials ...) and
// handleError drops it; every other error still reaches Sentry.
import { describe, it, expect } from 'vitest';
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from 'react-router';
import { fileURLToPath } from 'node:url';
import { isUnservedProbe, ROUTE_PREFIXES } from './route-miss.server';

// The exact shape react-router 7.18 hands handleError on a route miss:
// getInternalRouterError(404, { pathname }).
const routeMiss = (path: string) =>
  new ErrorResponseImpl(404, 'Not Found', new Error(`No route matches URL "${path}"`), true);
const req = (path: string, method = 'GET') =>
  new Request(`https://mcp.drstanfield.com${path}`, { method });

describe('isUnservedProbe (US-49)', () => {
  it('drops GET and HEAD misses on paths we never serve', () => {
    for (const path of [
      '/.env', '/id_rsa', '/.git/credentials', '/terraform.tfstate',
      '/robots.txt', '/apiz', '/apiz/x', '/wp-admin/setup.php',
    ]) {
      expect(isUnservedProbe(routeMiss(path), req(path)), path).toBe(true);
      expect(isUnservedProbe(routeMiss(path), req(path, 'HEAD')), `HEAD ${path}`).toBe(true);
    }
  });

  it('keeps a POST miss on an unknown path', () => {
    expect(isUnservedProbe(routeMiss('/.env'), req('/.env', 'POST'))).toBe(false);
  });

  it('keeps a GET miss under one of our own prefixes', () => {
    for (const path of [
      '/webhooks/orders-paid-old', '/reminders-v2/x', '/api/nope', '/api',
      '/app/missing', '/auth/x', '/roadmap/x', '/healthz/x', '/mcp/x', '/.well-known/x',
      '/API/nope', // router matching is case-insensitive
    ]) {
      expect(isUnservedProbe(routeMiss(path), req(path)), path).toBe(false);
    }
  });

  it('keeps the index path reported', () => {
    expect(isUnservedProbe(routeMiss('/'), req('/'))).toBe(false);
  });

  it('keeps errors that are not route-error responses', () => {
    expect(isUnservedProbe(new Error('boom'), req('/.env'))).toBe(false);
    expect(isUnservedProbe(new Response(null, { status: 404 }), req('/.env'))).toBe(false);
    expect(isUnservedProbe(undefined, req('/.env'))).toBe(false);
  });

  it('keeps route-error responses with any other status', () => {
    for (const status of [400, 403, 405, 500]) {
      const err = new ErrorResponseImpl(status, 'x', new Error('x'), true);
      expect(isUnservedProbe(err, req('/.env')), String(status)).toBe(false);
    }
  });
});

// Drift guard: build the real route config the way the app does (app/routes.ts, which
// skips test files and dotfiles) and check the prefix list matches every top-level URL
// segment. A new top-level route without a list update fails here, not in production.
describe('ROUTE_PREFIXES drift guard (US-49)', () => {
  it('equals the first URL segment of every route in app/routes/', async () => {
    type Entry = { path?: string; children?: Entry[] };
    (globalThis as { __reactRouterAppDirectory?: string }).__reactRouterAppDirectory =
      fileURLToPath(new URL('..', import.meta.url));
    const routes: Entry[] = await (await import('../routes')).default;

    const segments = new Set<string>();
    const walk = (entries: Entry[]) => {
      for (const e of entries) {
        if (e.path) segments.add(e.path.split('/')[0]);
        else if (e.children) walk(e.children); // pathless layout or the "/" index
      }
    };
    walk(routes);

    expect(segments.has('.well-known')).toBe(true); // `[.]` escape resolved
    expect([...segments].sort()).toEqual([...ROUTE_PREFIXES].sort());
  });
});
