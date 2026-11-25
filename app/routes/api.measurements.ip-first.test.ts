/**
 * US-23 AC8 / US-52 AC4f (untangle S-22): the email capture checks the per-IP limit before the
 * per-email one, and a request the IP limit refuses never touches the email map. With bounded
 * maps (the oldest entry makes room), refused requests that reached the email map could push out
 * another address's used-up day and let that address capture again inside its 24 hours. The maps
 * are built with a bound of 25 here (the factory, wrapped).
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
  return { ...real, createRateLimiter: (...[max, windowMs, cleanupMs, options]: Parameters<typeof real.createRateLimiter>) => real.createRateLimiter(max, windowMs, cleanupMs, { ...options, maxKeys: 25 }) };
});

import { action } from './api.measurements';

const SCHEDULE = [{ category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2027-05-12' }];

async function capture(email: string, ip: string) {
  const res = await action({
    request: new Request('https://health-tool-app.fly.dev/api/measurements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ klaviyoCapture: { email, schedule: SCHEDULE } }),
    }),
  } as never);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('US-23 AC8 (S-22): the IP limit is checked first', () => {
  it('requests the IP limit refuses leave another address used up for the day', async () => {
    for (let i = 0; i < 5; i++) expect((await capture('victim@example.com', '10.6.0.1')).status).toBe(200);
    expect((await capture('victim@example.com', '10.6.0.2')).status).toBe(429); // its 5 a day
    for (let i = 0; i < 20; i++) expect((await capture(`a${i}@example.com`, '10.6.0.9')).status).toBe(200); // the IP's 20 an hour
    for (let i = 20; i < 40; i++) {
      const refused = await capture(`a${i}@example.com`, '10.6.0.9');
      expect(refused).toEqual({ status: 429, body: { success: false, error: 'Email limit reached. Try again tomorrow.' } });
    }
    expect((await capture('victim@example.com', '10.6.0.3')).status).toBe(429); // still used up
  });
});
