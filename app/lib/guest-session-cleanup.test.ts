import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// US-15 AC7c: when a new guest session cannot be stored, the server removes
// the ghost profile and auth user it just made. A step of that cleanup that
// fails leaves an orphan, so it is reported to Sentry instead of being
// dropped. The caller still gets the same "Failed to create guest session".

const db = vi.hoisted(() => ({
  profileDelete: { error: null as unknown },
  deleteUser: (async () => ({ data: {}, error: null })) as () => Promise<unknown>,
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => sentry);

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: 'guest-uuid' } }, error: null })),
        deleteUser: vi.fn(() => db.deleteUser()),
      },
    },
    from: vi.fn((table: string) => {
      const query: Record<string, unknown> = {};
      let deleting = false;
      const chain = () => query;
      query.select = chain;
      query.eq = chain;
      query.delete = () => { deleting = true; return query; };
      query.upsert = async () => ({ error: null });
      query.insert = chain;
      // The session row insert fails, which starts the cleanup.
      query.single = async () => (table === 'guest_chat_sessions'
        ? { data: null, error: { message: 'synthetic insert failure' } }
        : { data: null, error: null });
      query.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(deleting && table === 'profiles' ? db.profileDelete : { error: null }).then(resolve);
      return query;
    }),
  })),
}));

let getOrCreateGuestSession: typeof import('./supabase.server').getOrCreateGuestSession;

beforeAll(async () => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'stub-service-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'stub-anon-key');
  vi.stubEnv('SUPABASE_JWT_SECRET', 'stub-jwt-secret');
  vi.stubEnv('SHOPIFY_API_SECRET', 'stub-shopify-secret');
  vi.resetModules();
  ({ getOrCreateGuestSession } = await import('./supabase.server'));
});
afterAll(() => vi.unstubAllEnvs());

let ip = 0;
beforeEach(() => {
  db.profileDelete = { error: null };
  db.deleteUser = async () => ({ data: {}, error: null });
  sentry.captureException.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
// A fresh address each time keeps the per-IP creation limit out of the way.
const create = () => getOrCreateGuestSession(`198.51.100.${++ip}`);
const cleanupReports = () => sentry.captureException.mock.calls
  .filter(([, hint]) => (hint as { tags?: { subsystem?: string } })?.tags?.subsystem === 'guest_session_cleanup');

describe('US-15 AC7c: a failed guest-session cleanup is reported', () => {
  it('a clean cleanup reports nothing', async () => {
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expect(cleanupReports()).toHaveLength(0);
  });

  it('a failed profile delete is reported', async () => {
    const failure = { message: 'synthetic profile delete failure' };
    db.profileDelete = { error: failure };
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expect(cleanupReports().map(([error]) => error)).toEqual([failure]);
    expect(cleanupReports()[0][1]).toMatchObject({ tags: { feature: 'guest_chat' } });
  });

  it('an auth-user delete that answers with an error is reported', async () => {
    const failure = { message: 'synthetic delete user failure' };
    db.deleteUser = async () => ({ data: null, error: failure });
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expect(cleanupReports().map(([error]) => error)).toEqual([failure]);
  });

  it('an auth-user delete that throws is reported', async () => {
    const failure = new TypeError('fetch failed');
    db.deleteUser = async () => { throw failure; };
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expect(cleanupReports().map(([error]) => error)).toEqual([failure]);
  });
});
