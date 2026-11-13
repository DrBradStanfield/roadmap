/**
 * US-09 AC47: a server misconfiguration answers 502, so browsers keep their
 * Google Drive sign-in. Google answers a wrong client secret with
 * `invalid_client` at a 4xx status; passed through, every browser read that
 * as a refused grant. Every other refusal still passes through with its status, and no
 * line is logged. Synthetic Google; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { action } from './api.google-token';

function refreshRequest(ip: string): Request {
  return new Request('https://health-tool-app.fly.dev/api/google-token', {
    method: 'POST',
    headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': ip, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ grantType: 'refresh', refreshToken: 'test-refresh-a' }),
  });
}

const logs = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

beforeEach(() => {
  process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_DRIVE_SECRET = 'test-secret-value';
  for (const [name, fn] of Object.entries(logs)) {
    fn.mockReset();
    vi.spyOn(console, name as keyof typeof logs).mockImplementation(fn);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('US-09 AC47: the Google token exchange', () => {
  it.each([401, 400, 403])('maps Google\'s %s invalid_client to 502, without the description', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_client', error_description: 'Unauthorized' }, { status })));
    const res = await action({ request: refreshRequest('203.0.113.70') } as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'exchange_failed', errorDescription: 'server_misconfigured' });
    expect(Object.values(logs).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    [400, 'invalid_grant'],
    [401, 'unauthorized_client'],
    [403, 'access_denied'],
    // A 5xx invalid_client is Google's outage, not this server's secret: not remapped.
    [503, 'invalid_client'],
  ])('passes a %s %s through as it did', async (status, error) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error, error_description: 'test description' }, { status })));
    const res = await action({ request: refreshRequest('203.0.113.71') } as never);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error, errorDescription: 'test description' });
    expect(Object.values(logs).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});
