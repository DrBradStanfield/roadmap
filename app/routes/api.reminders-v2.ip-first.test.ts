/**
 * US-17 AC7 / US-52 AC4f (untangle S-22): the address-lane opt-in checks the per-IP limit before
 * the per-email one, and a request the IP limit refuses never touches the email map. With bounded
 * maps (the oldest entry makes room), refused requests that reached the email map could push out
 * another address's used-up day. The maps are built with a bound of 25 here (the factory, wrapped).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/supabase-guest.server', () => ({ hashClientIp: (ip: string) => `h:${ip}` }));
vi.mock('../lib/supabase-client.server', () => ({ supabaseAdmin: null }));
vi.mock('../lib/klaviyo.server', () => ({ subscribeToKlaviyo: vi.fn(async () => {}) }));
vi.mock('../lib/email.server', async (importOriginal) => ({ ...(await importOriginal<object>()), sendPlanReadyEmail: vi.fn(async () => true) }));
vi.mock('../lib/reminder-v2.server', async (importOriginal) => ({ ...(await importOriginal<object>()), enrolByEmail: vi.fn(async () => ({ isNew: false })) }));
vi.mock('../lib/product-events.server', async (importOriginal) => ({ ...(await importOriginal<object>()), recordServerEvent: vi.fn(async () => {}) }));
vi.mock('../lib/rate-limiter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rate-limiter')>();
  return { ...real, createRateLimiter: (...[max, windowMs, cleanupMs, options]: Parameters<typeof real.createRateLimiter>) => real.createRateLimiter(max, windowMs, cleanupMs, { ...options, maxKeys: 25 }) };
});

import { action } from './api.reminders-v2';

const SCHEDULE = [{ category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2027-05-12' }];
const T0 = Date.UTC(2026, 10, 13, 12);

async function optin(email: string, ip: string) {
  const res = await action({
    request: new Request('https://health-tool-app.fly.dev/api/reminders-v2', {
      method: 'POST',
      headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': ip },
      body: JSON.stringify({ op: 'optin', provider: 'dropbox', email, schedule: SCHEDULE }),
    }),
  } as never);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('US-17 AC7 (S-22): the opt-in IP limit is checked first', () => {
  it('requests the IP limit refuses leave another address used up for the day', async () => {
    for (let i = 0; i < 5; i++) expect((await optin('victim@example.com', '10.5.0.1')).status).toBe(200);
    expect((await optin('victim@example.com', '10.5.0.2')).status).toBe(429); // its 5 a day
    for (let i = 0; i < 20; i++) expect((await optin(`a${i}@example.com`, '10.5.0.9')).status).toBe(200); // the IP's 20 an hour
    vi.setSystemTime(T0 + 61_000); // past the 20-a-minute request limit, inside the hour
    for (let i = 20; i < 40; i++) expect(await optin(`a${i}@example.com`, '10.5.0.9')).toEqual({ status: 429, body: { error: 'Too many requests' } });
    expect((await optin('victim@example.com', '10.5.0.3')).status).toBe(429); // still used up
  });
});
