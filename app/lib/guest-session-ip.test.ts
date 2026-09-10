import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';

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

let hashClientIp: typeof import('./supabase.server').hashClientIp;
let getOrCreateGuestSession: typeof import('./supabase.server').getOrCreateGuestSession;

const IP = '203.0.113.7';

describe('guest session IP hashing (US-15 AC7)', () => {
  beforeAll(async () => {
    vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'stub-service-key');
    vi.stubEnv('SUPABASE_ANON_KEY', 'stub-anon-key');
    vi.stubEnv('SUPABASE_JWT_SECRET', 'stub-jwt-secret');
    vi.stubEnv('SHOPIFY_API_SECRET', 'stub-shopify-secret');
    vi.resetModules();
    ({ hashClientIp, getOrCreateGuestSession } = await import('./supabase.server'));
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

  it('matches a returning guest against the stored hash, not the raw IP', async () => {
    db.session = { id: 'guest-uuid', session_token: 'tok', ip_address: hashClientIp(IP) };
    const result = await getOrCreateGuestSession(IP, 'tok');
    expect(result).toEqual({ sessionId: 'guest-uuid', sessionToken: 'tok' });
    expect(db.inserts).toHaveLength(0);
  });
});
