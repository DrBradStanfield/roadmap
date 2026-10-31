import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// US-15 AC7c: when a new guest session cannot be stored, the server removes
// the ghost profile and auth user it just made. A step of that cleanup that
// fails leaves an orphan, so it is reported to Sentry instead of being
// dropped. The caller still gets the same "Failed to create guest session".
// The report is a fixed Error with closed tags: a Postgres error's details
// can echo the guest id, and AC6 keeps raw database errors and ids out of
// route diagnostics (review 2026-10-31).

const db = vi.hoisted(() => ({
  /** What awaiting the profiles delete gives: an answer, or a rejection. */
  profileDelete: (async () => ({ error: null })) as () => Promise<unknown>,
  deleteUser: vi.fn(async (_id: string) => ({ data: {}, error: null }) as unknown),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => sentry);

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: 'guest-uuid' } }, error: null })),
        deleteUser: (id: string) => db.deleteUser(id),
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
      query.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        (deleting && table === 'profiles' ? db.profileDelete() : Promise.resolve({ error: null })).then(resolve, reject);
      return query;
    }),
  })),
}));

let getOrCreateGuestSession: typeof import('./supabase.server').getOrCreateGuestSession;
let PostgrestError: typeof import('@supabase/supabase-js').PostgrestError;
let AuthApiError: typeof import('@supabase/supabase-js').AuthApiError;

beforeAll(async () => {
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'stub-service-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'stub-anon-key');
  vi.stubEnv('SUPABASE_JWT_SECRET', 'stub-jwt-secret');
  vi.stubEnv('SHOPIFY_API_SECRET', 'stub-shopify-secret');
  vi.resetModules();
  ({ getOrCreateGuestSession } = await import('./supabase.server'));
  ({ PostgrestError, AuthApiError } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js'));
});
afterAll(() => vi.unstubAllEnvs());

let ip = 0;
beforeEach(() => {
  db.profileDelete = async () => ({ error: null });
  db.deleteUser.mockReset();
  db.deleteUser.mockImplementation(async () => ({ data: {}, error: null }));
  sentry.captureException.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
// A fresh address each time keeps the per-IP creation limit out of the way.
const create = () => getOrCreateGuestSession(`198.51.100.${++ip}`);
const cleanupReports = () => sentry.captureException.mock.calls
  .filter(([, hint]) => (hint as { tags?: { subsystem?: string } })?.tags?.subsystem === 'guest_session_cleanup');

/** Everything the SDK could read from a capture call, an Error's own
 *  non-enumerable message, stack and cause included. */
const asSent = (call: unknown[]) => JSON.stringify(call, (_key, value) => (value instanceof Error
  ? { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause }
  : value));

/** Each report is the one fixed Error, with only the closed tags. */
function expectFixedReports(expected: { step: string; code: string }[], ...raw: string[]) {
  const reports = cleanupReports();
  expect(reports.map(([, hint]) => hint)).toEqual(expected.map(({ step, code }) => ({
    tags: { feature: 'guest_chat', subsystem: 'guest_session_cleanup', step, code },
  })));
  for (const call of reports) {
    const [error] = call as [Error];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Guest session cleanup failed');
    expect(error.cause).toBeUndefined();
    const sent = asSent(call);
    for (const text of [...raw, 'guest-uuid']) expect(sent).not.toContain(text);
  }
}

describe('US-15 AC7c: a failed guest-session cleanup is reported', () => {
  it('a clean cleanup reports nothing, and both deletes run', async () => {
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expect(cleanupReports()).toHaveLength(0);
    expect(db.deleteUser).toHaveBeenCalledWith('guest-uuid');
  });

  it('a profile delete that answers with an error is reported with its code, never its message, details or hint', async () => {
    const failure = new PostgrestError({
      message: 'update or delete on table "profiles" violates foreign key constraint "chat_fkey"',
      details: 'Key (id)=(guest-uuid) is still referenced from table "chat_messages".',
      hint: 'synthetic hint about guest-uuid',
      code: '23503',
    });
    db.profileDelete = async () => ({ error: failure });
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expectFixedReports([{ step: 'profile', code: '23503' }], failure.message, failure.details, failure.hint);
    expect(db.deleteUser).toHaveBeenCalledWith('guest-uuid');
  });

  it('a profile delete that throws is reported, and the auth user is still deleted', async () => {
    db.profileDelete = async () => { throw new TypeError('fetch failed for guest-uuid'); };
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expectFixedReports([{ step: 'profile', code: 'thrown' }], 'fetch failed');
    expect(db.deleteUser).toHaveBeenCalledWith('guest-uuid');
  });

  it('an auth-user delete that answers with an error is reported with its code, never its message', async () => {
    const failure = new AuthApiError('User guest-uuid not allowed', 403, 'not_admin');
    db.deleteUser.mockImplementation(async () => ({ data: null, error: failure }));
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expectFixedReports([{ step: 'auth_user', code: 'not_admin' }], failure.message);
  });

  it('an auth-user delete that throws is reported', async () => {
    db.deleteUser.mockImplementation(async () => { throw new TypeError('fetch failed'); });
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expectFixedReports([{ step: 'auth_user', code: 'thrown' }], 'fetch failed');
  });

  it('both steps failing are reported once each', async () => {
    db.profileDelete = async () => { throw new TypeError('fetch failed'); };
    db.deleteUser.mockImplementation(async () => ({ data: null, error: new AuthApiError('gone', 404, 'user_not_found') }));
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expectFixedReports([{ step: 'profile', code: 'thrown' }, { step: 'auth_user', code: 'user_not_found' }], 'fetch failed', 'gone');
  });

  it('a code that is not a plain identifier is sent as unknown', async () => {
    db.profileDelete = async () => ({ error: new PostgrestError({ message: 'm', details: '', hint: '', code: 'guest-uuid' }) });
    await expect(create()).rejects.toThrow('Failed to create guest session');
    expectFixedReports([{ step: 'profile', code: 'unknown' }]);
  });
});
