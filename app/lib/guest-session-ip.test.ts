import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { ipKeyedLimitCases } from './ip-key.test-helpers';

// US-15 AC7 (2026-09-10): a guest session holds a hashed address, never the
// caller's IP. Nothing written to Supabase — the session row or the audit log —
// may carry the raw value.

interface Insert { table: string; row: Record<string, unknown> }
const db = {
  inserts: [] as Insert[],
  session: null as { id: string; session_token: string; ip_address: string } | null,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: 'guest-uuid' } }, error: null })),
        deleteUser: vi.fn(async () => ({})),
      },
    },
    from: vi.fn((table: string) => {
      const query: Record<string, unknown> = {};
      const chain = () => query;
      query.select = chain;
      query.eq = chain;
      query.delete = chain;
      query.upsert = async () => ({ error: null });
      query.insert = (row: Record<string, unknown>) => {
        db.inserts.push({ table, row });
        return query;
      };
      query.single = async () => ({
        data: table === 'guest_chat_sessions' && db.inserts.some((i) => i.table === table)
          ? { session_token: 'new-token' }
          : db.session,
        error: null,
      });
      query.then = (resolve: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve);
      return query;
    }),
  })),
}));

let hashClientIp: typeof import('./supabase-guest.server').hashClientIp;
let getOrCreateGuestSession: typeof import('./supabase-guest.server').getOrCreateGuestSession;

const IP = '203.0.113.7';

describe('guest session IP hashing (US-15 AC7)', () => {
  beforeAll(async () => {
    vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'stub-service-key');
    vi.stubEnv('SUPABASE_ANON_KEY', 'stub-anon-key');
    vi.stubEnv('SUPABASE_JWT_SECRET', 'stub-jwt-secret');
    vi.stubEnv('SHOPIFY_API_SECRET', 'stub-shopify-secret');
    vi.resetModules();
    ({ hashClientIp, getOrCreateGuestSession } = await import('./supabase-guest.server'));
  });

  afterAll(() => vi.unstubAllEnvs());

  beforeEach(() => {
    db.inserts = [];
    db.session = null;
  });

  it('gives equal IPs the same hash, and never returns the address itself', () => {
    expect(hashClientIp(IP)).toBe(hashClientIp(IP));
    expect(hashClientIp(IP)).not.toBe(hashClientIp('198.51.100.4'));
    expect(hashClientIp(IP)).not.toContain('203.0.113');
  });

  it('separates the salt by HKDF info — another context cannot recompute it', () => {
    const otherKey = crypto.hkdfSync('sha256', 'stub-shopify-secret', Buffer.alloc(0), 'some/other/v1', 32);
    const otherHash = crypto.createHmac('sha256', Buffer.from(otherKey)).update(IP, 'utf8').digest('base64url');
    expect(hashClientIp(IP)).not.toBe(otherHash);
    // …and it is not a bare unsalted digest either.
    expect(hashClientIp(IP)).not.toBe(crypto.createHash('sha256').update(IP).digest('base64url'));
  });

  it('stores the hash on the session row and keeps the raw IP out of every write', async () => {
    await getOrCreateGuestSession(IP);
    const session = db.inserts.find((i) => i.table === 'guest_chat_sessions');
    expect(session?.row.ip_address).toBe(hashClientIp(IP));
    expect(JSON.stringify(db.inserts)).not.toContain(IP);
  });

  it('drops the address from the audit log metadata', async () => {
    await getOrCreateGuestSession(IP);
    const audit = db.inserts.find((i) => i.table === 'audit_logs');
    expect(audit?.row.action).toBe('GUEST_SESSION_CREATED');
    expect(audit?.row.metadata).toBeNull();
  });

  // US-15 AC67: the per-IP limit holds on the shared bounded limiter.
  it('creates 10 sessions per address per hour, refuses the 11th, and serves another address', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const ip = '192.0.2.10';
      for (let i = 0; i < 10; i++) await getOrCreateGuestSession(ip);
      await expect(getOrCreateGuestSession(ip)).rejects.toThrow('Too many requests');
      await expect(getOrCreateGuestSession('192.0.2.11')).resolves.toMatchObject({ sessionId: 'guest-uuid' });
      vi.setSystemTime(Date.now() + 60 * 60_000 - 1);
      await expect(getOrCreateGuestSession(ip)).rejects.toThrow('Too many requests'); // a refusal does not stretch the hour
      vi.setSystemTime(Date.now() + 1);
      await expect(getOrCreateGuestSession(ip)).resolves.toMatchObject({ sessionId: 'guest-uuid' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an address at its limit until 50,000 other addresses are live in the hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const ip = '192.0.2.20';
      for (let i = 0; i < 10; i++) await getOrCreateGuestSession(ip);
      // The map already holds the earlier cases' addresses, so fewer than 50,000 new ones fill it.
      for (let i = 0; i < 49_990; i++) await getOrCreateGuestSession(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
      await expect(getOrCreateGuestSession(ip)).rejects.toThrow('Too many requests'); // still held
      for (let i = 0; i < 20; i++) await getOrCreateGuestSession(`10.200.0.${i}`);
      // Only now, with 50,000 newer live addresses, has the oldest entry made room.
      await expect(getOrCreateGuestSession(ip)).resolves.toMatchObject({ sessionId: 'guest-uuid' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches a returning guest against the stored hash, not the raw IP', async () => {
    db.session = { id: 'guest-uuid', session_token: 'tok', ip_address: hashClientIp(IP) };
    const result = await getOrCreateGuestSession(IP, 'tok');
    expect(result).toEqual({ sessionId: 'guest-uuid', sessionToken: 'tok' });
    expect(db.inserts).toHaveLength(0);
  });

  // US-52 AC4k (owner ruling 2a): the limit moves onto the bucket; the session stays bound to the address.
  it('binds a session to the address, not its /64', async () => {
    db.session = { id: 'guest-uuid', session_token: 'tok', ip_address: hashClientIp('2001:db8:5e::1') };
    await getOrCreateGuestSession('2001:db8:5e::2', 'tok');
    expect(db.inserts.some((i) => i.table === 'guest_chat_sessions')).toBe(true);
  });

  describe('US-52 AC4k: the new-session limit keys on the one per-IP bucket, 10 an hour (30 for an IPv6 /64)', () => {
    ipKeyedLimitCases({
      limit: 10, v6Limit: 30, windowMs: 60 * 60_000, v6: '2001:db8:5e', v4: '100.79',
      allowed: (ip) => getOrCreateGuestSession(ip).then(() => true, (error: Error) => {
        if (error.message !== 'Too many requests') throw error;
        return false;
      }),
    });
  });
});
