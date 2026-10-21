import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Schema-driven application fixture, not a PostgreSQL permission/trigger test.
// The parent integration gate executes the extracted SQL in PostgreSQL.
const schema = readFileSync('supabase/rls-policies.sql', 'utf8');
const triggerMetadata = schema.match(/NEW\.(raw_(?:user|app)_meta_data)->>'shopify_customer_id'/)?.[1];
if (!triggerMetadata) throw new Error('Profile trigger identity source not found');

// No listUsers on the mock: a full scan fails live past ~300 users (US-09 AC27),
// so any call to it throws here.
const state = vi.hoisted(() => ({ from: vi.fn(), create: vi.fn(), getById: vi.fn(), warn: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: state.from, auth: { admin: { createUser: state.create, getUserById: state.getById } } }) }));
vi.mock('@sentry/react-router', () => ({ captureMessage: state.warn, captureException: vi.fn() }));
vi.stubEnv('SUPABASE_URL', 'https://example.invalid');
vi.stubEnv('SUPABASE_SERVICE_KEY', 'synthetic');
vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic');
vi.stubEnv('SUPABASE_JWT_SECRET', 'synthetic');

type AuthUser = { id: string; email: string; app_metadata?: Record<string, string>; user_metadata?: Record<string, string> };
let profiles: Array<Record<string, any>>;
let authUsers: Map<string, AuthUser>;
let writes: Array<Record<string, any>>;
let audits: Array<Record<string, any>>;
let lookupError: boolean;
let competingInsert: boolean;
let auditInsertFails: boolean;
let recordPaid: typeof import('./supabase.server').recordUnprovenPaidOrder;
let counter = 0;
let mapUser: typeof import('./supabase.server').getOrCreateSupabaseUser;
let webhookUser: typeof import('./supabase.server').getUserIdByCustomerId;
const addAuth = (id: string, customer: string | null, extra: Partial<AuthUser> = {}) =>
  authUsers.set(id, { id, email, app_metadata: customer ? { provider: 'email', shopify_customer_id: customer } : { provider: 'email' }, ...extra });
beforeEach(async () => {
  vi.resetModules(); profiles = []; writes = []; audits = []; authUsers = new Map(); lookupError = false; competingInsert = false; auditInsertFails = false;
  ({ getOrCreateSupabaseUser: mapUser, getUserIdByCustomerId: webhookUser, recordUnprovenPaidOrder: recordPaid } = await import('./supabase.server'));
  state.warn.mockReset();
  state.create.mockReset().mockResolvedValue({ data: null, error: { message: 'already registered' } });
  state.getById.mockReset().mockImplementation(async (id: string) => {
    const user = authUsers.get(id);
    return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
  });
  state.from.mockImplementation((table: string) => {
    const filters: Array<[string, unknown]> = []; let payload: Record<string, any> | undefined; let ignore = false; let update = false;
    const q: any = {};
    q.select = q.single = q.maybeSingle = q.limit = () => q;
    q.eq = (k: string, v: unknown) => { filters.push([k,v]); return q; };
    q.upsert = (row: Record<string, any>, opts: any) => {
      if (competingInsert) profiles.push({ id: row.id, shopify_customer_id: 'competing', email: 'competing@example.invalid' });
      payload = row; ignore = opts?.ignoreDuplicates; return q;
    };
    q.update = (row: Record<string, any>) => { payload = row; update = true; return q; };
    q.insert = (row: Record<string, any>) => {
      if (table === 'audit_logs' && !auditInsertFails) audits.push(row);
      return { then: (resolve: any) => resolve({ error: table === 'audit_logs' && auditInsertFails ? { message: 'down' } : null }) };
    };
    q.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
      if (table === 'audit_logs') return { data: audits.filter(a => filters.every(([k,v]) => a[k] === v)), error: null };
      if (table !== 'profiles') return { data: null, error: null };
      if (payload) {
        writes.push(payload);
        const row = profiles.find(p => update ? filters.every(([k,v]) => p[k] === v) : p.id === payload!.id);
        if (row && !ignore) Object.assign(row, payload);
        else if (!row && !update) profiles.push({ ...payload });
        return { data: null, error: null };
      }
      if (lookupError) return { data: null, error: { code: '08006' } };
      return { data: profiles.find(p => filters.every(([k,v]) => p[k] === v)) ?? null, error: null };
    }).then(resolve, reject);
    return q;
  });
});
const identity = () => `customer-${++counter}`;
const email = 'synthetic@example.invalid';
// US-09 AC27: a Shopify customer reaches a principal only through admin-written
// proof. Anything unproven is refused as null (the caller answers as a guest),
// never thrown into a 500, never cached.
describe('Shopify principal reuse', () => {
  it('does not reuse a signup profile poisoned through the schema-selected user metadata source', async () => {
    const customer = identity();
    const signup = {
      raw_user_meta_data: { shopify_customer_id: customer },
      raw_app_meta_data: {} as Record<string, string>,
    };
    profiles.push({ id: 'mobile', email, shopify_customer_id: signup[triggerMetadata as keyof typeof signup].shopify_customer_id ?? null });
    addAuth('mobile', null, { user_metadata: { shopify_customer_id: customer } });
    expect(await mapUser(customer, email)).toBeNull();
    expect(writes).toEqual([]);
  });
  it('accepts the new-account trigger mapping from administrator-owned metadata', async () => {
    const customer = identity();
    state.create.mockImplementationOnce(async (options: any) => {
      const signup = { raw_user_meta_data: {}, raw_app_meta_data: options.app_metadata };
      profiles.push({ id: 'trusted-trigger', email, shopify_customer_id: signup[triggerMetadata as keyof typeof signup].shopify_customer_id ?? null });
      return { data: { user: { id: 'trusted-trigger' } }, error: null };
    });
    expect(await mapUser(customer, email)).toBe('trusted-trigger');
    expect(profiles[0].shopify_customer_id).toBe(customer);
  });
  it.each(['other-customer', null])('refuses an email profile linked to %s, without caching it', async link => {
    const customer = identity(); profiles.push({ id: 'foreign', email, shopify_customer_id: link }); addAuth('foreign', link);
    expect(await mapUser(customer, email)).toBeNull();
    expect(await mapUser(customer, email)).toBeNull();
    expect(writes).toEqual([]); expect(state.create).toHaveBeenCalledTimes(2);
  });
  it('preserves an existing mapping only when admin-written proof matches', async () => {
    const customer = identity();
    profiles.push({ id: 'own', email, shopify_customer_id: customer }); addAuth('own', customer);
    expect(await mapUser(customer, email)).toBe('own');
    expect(await mapUser(customer, email)).toBe('own');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.getById).toHaveBeenCalledTimes(1);
  });
  it('accepts a concurrent same-customer profile only with matching admin proof', async () => {
    const customer = identity();
    state.create.mockImplementationOnce(async () => {
      profiles.push({ id: 'raced', email, shopify_customer_id: customer }); addAuth('raced', customer);
      return { data: null, error: { message: 'duplicate' } };
    });
    expect(await mapUser(customer, email)).toBe('raced');
    expect(writes).toEqual([]);
  });
  it('does not treat user-editable auth metadata as identity proof', async () => {
    const customer = identity();
    profiles.push({ id: 'unlinked', email, shopify_customer_id: null });
    addAuth('unlinked', null, { user_metadata: { shopify_customer_id: customer } });
    expect(await mapUser(customer, email)).toBeNull(); expect(writes).toEqual([]);
  });
  it('never adopts an account by email, even one whose auth user carries proof, and never lists users', async () => {
    const customer = identity();
    profiles.push({ id: 'auth-only', email, shopify_customer_id: null }); addAuth('auth-only', customer);
    expect(await mapUser(customer, email)).toBeNull();
    expect(writes).toEqual([]);
  });
  it('does not overwrite a competing profile when an auth candidate has server-owned proof', async () => {
    const customer = identity(); profiles.push({ id: 'candidate', email, shopify_customer_id: 'different' });
    addAuth('candidate', customer);
    expect(await mapUser(customer, email)).toBeNull();
    expect(profiles[0].shopify_customer_id).toBe('different');
  });
  it('creates a new user with server-owned identity proof', async () => {
    const customer = identity(); state.create.mockResolvedValueOnce({ data: { user: { id: 'new' } }, error: null });
    expect(await mapUser(customer, email)).toBe('new');
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ app_metadata: { shopify_customer_id: customer } }));
    expect(profiles[0]).toMatchObject({ id: 'new', shopify_customer_id: customer });
  });
  it('does not overwrite a conflicting profile inserted after the precheck', async () => {
    competingInsert = true;
    state.create.mockResolvedValueOnce({ data: { user: { id: 'racing' } }, error: null });
    expect(await mapUser(identity(), email)).toBeNull();
    expect(profiles).toEqual([{ id: 'racing', shopify_customer_id: 'competing', email: 'competing@example.invalid' }]);
  });
  it('converges two concurrent creations of the same Shopify identity', async () => {
    const customer = identity(); let created = false;
    state.create.mockImplementation(async () => {
      if (created) return { data: null, error: { message: 'duplicate' } };
      created = true; profiles.push({ id: 'shared', email, shopify_customer_id: customer }); addAuth('shared', customer);
      return { data: { user: { id: 'shared' } }, error: null };
    });
    expect(await Promise.all([mapUser(customer, email), mapUser(customer, email)])).toEqual(['shared', 'shared']);
    expect(profiles).toHaveLength(1);
  });
  it('preserves names when the auth trigger already inserted the same-customer profile', async () => {
    const customer = identity(); state.create.mockImplementationOnce(async () => {
      profiles.push({ id: 'triggered', email, shopify_customer_id: customer });
      return { data: { user: { id: 'triggered' } }, error: null };
    });
    expect(await mapUser(customer, email, 'Synthetic', 'Person')).toBe('triggered');
    expect(profiles[0]).toMatchObject({ first_name: 'Synthetic', last_name: 'Person' });
  });
  it('treats an email held by an auth user with no profile row as unproven: guest and a warning, never a 500', async () => {
    const customer = identity();
    expect(await mapUser(customer, email)).toBeNull();
    expect(writes).toEqual([]);
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([expect.objectContaining({ user_id: null, action: 'IDENTITY_LINK_UNPROVEN' })]);
  });
  it('refuses a legacy stored mapping without admin-written proof: no 500, no writes, no cache, a value-free warning', async () => {
    const customer = identity();
    profiles.push({ id: 'legacy', email, shopify_customer_id: customer });
    addAuth('legacy', null, { user_metadata: { shopify_customer_id: customer } });
    expect(await mapUser(customer, email)).toBeNull();
    expect(writes).toEqual([]);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain(customer);
    expect(audits).toEqual([expect.objectContaining({ user_id: 'legacy', action: 'IDENTITY_LINK_UNPROVEN' })]);
    expect(JSON.stringify(audits)).not.toContain(customer);
    // Once the backfill writes the proof, the next request is accepted: the refusal was never cached.
    addAuth('legacy', customer);
    expect(await mapUser(customer, email)).toBe('legacy');
  });
  it('fails clearly on profile lookup errors before trying to create an account', async () => {
    lookupError = true; await expect(mapUser(identity(), email)).rejects.toThrow(/lookup/i);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('fails clearly, uncached, when the auth user cannot be read', async () => {
    const customer = identity(); profiles.push({ id: 'unreadable', email, shopify_customer_id: customer });
    await expect(mapUser(customer, email)).rejects.toThrow(/auth user/i);
    addAuth('unreadable', customer);
    expect(await mapUser(customer, email)).toBe('unreadable');
  });
});

// US-09 AC27: the orders/paid webhook shares the customer→principal cache with
// chat, so it may neither credit nor cache an unproven link.
describe('webhook customer lookup', () => {
  it('returns no principal for a legacy unproven link, and a later chat request cannot reach it through the cache', async () => {
    const customer = identity();
    profiles.push({ id: 'legacy', email, shopify_customer_id: customer }); addAuth('legacy', null);
    expect(await webhookUser(customer)).toEqual({ userId: 'legacy', proven: false });
    expect(await mapUser(customer, email)).toBeNull();
    expect(state.getById).toHaveBeenCalledTimes(2);
  });
  it('caches only a proven link', async () => {
    const customer = identity();
    profiles.push({ id: 'own', email, shopify_customer_id: customer }); addAuth('own', customer);
    expect(await webhookUser(customer)).toEqual({ userId: 'own', proven: true });
    expect(await webhookUser(customer)).toEqual({ userId: 'own', proven: true }); // from the cache
    expect(await mapUser(customer, email)).toBe('own');
    expect(state.getById).toHaveBeenCalledTimes(1);
  });
});

// US-09 AC27: the record Brad credits an unproven paid order from must be
// stored before orders/paid answers 200, once per order.
describe('recordUnprovenPaidOrder', () => {
  const order = 'gid://shopify/Order/5';
  it('stores one row per order, value-free, and reports success', async () => {
    expect(await recordPaid('legacy', order)).toBe(true);
    expect(await recordPaid('legacy', order)).toBe(true);
    expect(audits).toEqual([expect.objectContaining({ user_id: 'legacy', action: 'PAID_ORDER_UNPROVEN_LINK', resource_id: order, metadata: null })]);
  });
  it('reports failure when the row cannot be stored, so the webhook can ask for a retry', async () => {
    auditInsertFails = true;
    expect(await recordPaid('legacy', order)).toBe(false);
  });
});
