/**
 * US-09 AC36: the server's Supabase clients start no token-refresh timer.
 *
 * supabase-js defaults suit a browser. Off one, every client starts a
 * 30-second refresh ticker at construction and never stops it, and the ticker
 * holds the client. `createUserClient` builds a client per request, so each
 * request left its client in memory for good. Real supabase-js, no mock: the
 * timers are what the test watches, and it counts intervals of any period.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Wait until each client has finished starting: initialize(), then a short
 *  wait, because auth-js starts the ticker from a call it does not await. */
async function started(clients: SupabaseClient[]): Promise<void> {
  await Promise.all(clients.map((c) => c.auth.initialize()));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

type IntervalSpy = { mock: { calls: unknown[][] } };

/** Any interval at all: the test does not depend on auth-js keeping 30 s. */
function intervals(spy: IntervalSpy): number {
  return spy.mock.calls.length;
}

describe('US-09 AC36: no refresh ticker on the server clients', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:9');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'test-service-key');
    vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon-key');
    vi.stubEnv('SUPABASE_JWT_SECRET', 'test-jwt-secret-for-signing');
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('a per-request user client starts none, however many requests build one', async () => {
    const { createUserClient } = await import('./supabase-client.server');
    const clients = Array.from({ length: 5 }, (_, i) => createUserClient(`user-${i}`));
    await started(clients);
    expect(intervals(setIntervalSpy)).toBe(0);
  });

  it('the admin client starts none either', async () => {
    const { supabaseAdmin } = await import('./supabase-client.server');
    expect(supabaseAdmin).not.toBeNull();
    await started([supabaseAdmin!]);
    expect(intervals(setIntervalSpy)).toBe(0);
  });

  it('the user client still sends its own signed token', async () => {
    const { createUserClient } = await import('./supabase-client.server');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    try {
      await createUserClient('user-a').from('profiles').select('id').limit(1);
      const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
      const [scheme, token] = (headers.get('authorization') ?? '').split(' ');
      expect(scheme).toBe('Bearer');
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      expect(payload).toMatchObject({ sub: 'user-a', role: 'authenticated' });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
