/**
 * US-52 AC4f at the route: the email capture's limit maps are bounded, and a full map of
 * other callers' live entries never turns a NEW caller away. A caller at its limit stays
 * limited while its entry is in the map. The maps are built with a bound of 3 here (the
 * factory, wrapped), so the test does not need 50,000 callers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn(async () => ({})) } } }));
vi.mock('../lib/klaviyo.server', () => ({ subscribeToKlaviyo: vi.fn(async () => {}) }));
vi.mock('../lib/email.server', async (importOriginal) => ({ ...(await importOriginal<object>()), sendPlanReadyEmail: vi.fn(async () => true) }));
vi.mock('../lib/reminder-v2.server', async (importOriginal) => ({ ...(await importOriginal<object>()), enrolByEmail: vi.fn(async () => ({ isNew: false })) }));
vi.mock('../lib/product-events.server', async (importOriginal) => ({ ...(await importOriginal<object>()), recordServerEvent: vi.fn(async () => {}) }));
vi.mock('../lib/rate-limiter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rate-limiter')>();
  return { ...real, createRateLimiter: (...[max, windowMs, cleanupMs, options]: Parameters<typeof real.createRateLimiter>) => real.createRateLimiter(max, windowMs, cleanupMs, { ...options, maxKeys: 3 }) };
});

import { action } from './api.measurements';

const SCHEDULE = [{ category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2027-05-12' }];

function capture(email: string, ip: string): Request {
  return new Request('https://health-tool-app.fly.dev/api/measurements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ klaviyoCapture: { email, schedule: SCHEDULE } }),
  });
}
const status = async (email: string, ip: string) => (await action({ request: capture(email, ip) } as never)).status;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('US-52 AC4f: the email capture limits with full maps', () => {
  it('serves a new caller when both maps are full of other callers; one at its limit stays limited', async () => {
    for (let i = 0; i < 5; i++) expect(await status('limited@example.com', '10.9.0.1')).toBe(200);
    expect(await status('limited@example.com', '10.9.0.1')).toBe(429); // its 5 a day
    expect(await status('b@example.com', '10.9.0.2')).toBe(200);
    expect(await status('c@example.com', '10.9.0.3')).toBe(200); // both maps now full of live entries
    expect(await status('limited@example.com', '10.9.0.1')).toBe(429); // still in the map: still limited
    expect(await status('new@example.com', '10.9.0.4')).toBe(200); // a new caller is served
  });
});
