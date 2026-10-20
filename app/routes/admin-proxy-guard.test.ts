/**
 * US-09 AC24 (adversary R1; Codex + adversary re-check R1): the app proxy maps
 * the whole app root, so a proxied request can reach the admin routes.
 * `authenticate.admin`'s bounce page copies the whole query, `signature`
 * included, into its Location header. Every admin entry point goes through
 * `authenticateAdmin` (app/lib/admin-shop.server.ts), which refuses a request
 * carrying `signature` before that runs. Each loader AND action is checked:
 * react-router runs loaders in parallel (a child's redirect beats the parent's
 * 404) and a POST runs only the child's action. The admin launch signs with
 * `hmac` and never carries `signature`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  // Stand-in for the bounce: echo the query into a redirect, as the library does.
  admin: vi.fn(async (request: Request) => {
    throw new Response(null, { status: 302, headers: { Location: `/auth/session-token${new URL(request.url).search}` } });
  }),
  job: vi.fn(async () => ({})),
}));
vi.mock('../shopify.server', () => ({ authenticate: { admin: mocks.admin } }));
vi.mock('../lib/supabase.server', () => ({
  getDashboardStats: mocks.job, getABTests: mocks.job, getActiveABTests: mocks.job, getABTestById: mocks.job,
  createABTest: mocks.job, updateABTestStatus: mocks.job, getABTestResults: mocks.job,
}));
vi.mock('../lib/trending-cron.server', () => ({ computeAndWriteTrending: mocks.job }));
vi.mock('../lib/reminder-v2-cron.server', () => ({ processV2Reminders: mocks.job }));
vi.mock('../lib/youtube-bot-summary-cron.server', () => ({ runYouTubeBotSummaryOnce: mocks.job }));

import * as app from './app';
import * as appIndex from './app._index';
import * as auth from './auth.$';
import * as abTesting from './app.ab-testing';
import * as trending from './app.trending-test';
import * as reminders from './app.reminders-v2-test';
import * as youtube from './app.youtube-bot-summary-test';

const SIGNED = '?logged_in_customer_id=&path_prefix=%2Fapps%2Fhealth-tool-1&shop=x.myshopify.com&timestamp=1780000000&signature=' + 'a'.repeat(64);
const ADMIN = '?embedded=1&hmac=abc&host=aG9zdA&shop=x.myshopify.com&timestamp=1780000000';

type Handler = (args: never) => unknown;

async function call(handler: Handler, url: string, method: 'GET' | 'POST'): Promise<Response> {
  const body = method === 'POST' ? new URLSearchParams({ intent: 'create' }) : undefined;
  try {
    await handler({ request: new Request(`https://health-tool-app.fly.dev${url}`, { method, body }), params: {}, context: {} } as never);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error('handler returned without throwing');
}

beforeEach(() => { mocks.admin.mockClear(); mocks.job.mockClear(); });

const ENTRY_POINTS: [string, string, Handler | undefined, 'GET' | 'POST'][] = [
  ['/app loader', '/app', app.loader as Handler, 'GET'],
  ['/app (index) loader', '/app', appIndex.loader as Handler, 'GET'],
  ['/auth/x loader', '/auth/x', auth.loader as Handler, 'GET'],
  ['/app/ab-testing loader', '/app/ab-testing', abTesting.loader as Handler, 'GET'],
  ['/app/ab-testing action', '/app/ab-testing', abTesting.action as Handler, 'POST'],
  ['/app/trending-test loader', '/app/trending-test', trending.loader as Handler, 'GET'],
  ['/app/trending-test action', '/app/trending-test', trending.action as Handler, 'POST'],
  ['/app/reminders-v2-test loader', '/app/reminders-v2-test', reminders.loader as Handler, 'GET'],
  ['/app/reminders-v2-test action', '/app/reminders-v2-test', reminders.action as Handler, 'POST'],
  ['/app/youtube-bot-summary-test loader', '/app/youtube-bot-summary-test', youtube.loader as Handler, 'GET'],
  ['/app/youtube-bot-summary-test action', '/app/youtube-bot-summary-test', youtube.action as Handler, 'POST'],
];

describe.each(ENTRY_POINTS)('%s', (_name, url, handler, method) => {
  it('exists', () => { expect(typeof handler).toBe('function'); });

  it('a signed proxy request gets a 404 with no Location, before authenticate.admin', async () => {
    const res = await call(handler!, `${url}${SIGNED}`, method);
    expect(res.status).toBe(404);
    expect(res.headers.get('Location')).toBeNull();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.job).not.toHaveBeenCalled();
  });

  it('the admin hmac launch still reaches authenticate.admin', async () => {
    const res = await call(handler!, `${url}${ADMIN}`, method);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
  });
});

// Every module under app/routes that exports a loader or action and reaches
// the admin authenticator is in ENTRY_POINTS. A new admin route fails here
// until it is listed.
const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.dirname(ROUTES_DIR);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test(-helpers)?\./.test(name) ? [full] : [];
  });
}

// `authenticate.admin`, `authenticate['admin']` or `{ admin } = authenticate`.
const RAW_ADMIN = /authenticate\s*(\?\.|\.)\s*admin\b|authenticate\s*\[\s*['"`]admin|\{[^}]*\badmin\b[^}]*\}\s*=\s*(shopify\.)?authenticate\b/;

/** Source with block and line comments removed, so prose naming the call is not a hit. */
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

describe('one guarded admin authenticator (US-09 AC24)', () => {
  it('no file in app/ calls the raw authenticate.admin except the wrapper', () => {
    const offenders = sourceFiles(APP_DIR)
      .filter((f) => RAW_ADMIN.test(code(f)))
      .map((f) => path.relative(APP_DIR, f));
    expect(offenders).toEqual(['lib/admin-shop.server.ts']);
  });

  it('every route that uses the admin authenticator is covered above', () => {
    const covered = new Set(['app.tsx', 'app._index.tsx', 'auth.$.tsx', 'app.ab-testing.tsx', 'app.trending-test.tsx',
      'app.reminders-v2-test.tsx', 'app.youtube-bot-summary-test.tsx']);
    const users = sourceFiles(ROUTES_DIR)
      .filter((f) => /authenticateAdmin|authenticateOwnerAdmin|runAdminTrigger/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROUTES_DIR, f));
    expect(users.sort()).toEqual([...covered].sort());
  });

  it('the pattern catches each raw form', () => {
    for (const src of ['await authenticate.admin(request)', 'authenticate?.admin(r)', "authenticate['admin'](r)",
      'const { admin } = authenticate;', 'const { admin: a } = shopify.authenticate']) {
      expect(RAW_ADMIN.test(src), src).toBe(true);
    }
    expect(RAW_ADMIN.test('await authenticate.public.appProxy(request)')).toBe(false);
  });
});
