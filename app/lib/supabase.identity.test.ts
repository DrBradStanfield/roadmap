import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Schema-driven application fixture, not a PostgreSQL permission/trigger test.
// The parent integration gate executes the extracted SQL in PostgreSQL.
const schema = readFileSync('supabase/rls-policies.sql', 'utf8');
const triggerMetadata = schema.match(/NEW\.(raw_(?:user|app)_meta_data)->>'shopify_customer_id'/)?.[1];
if (!triggerMetadata) throw new Error('Profile trigger identity source not found');

const state = vi.hoisted(() => ({ from: vi.fn(), create: vi.fn(), list: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: state.from, auth: { admin: { createUser: state.create, listUsers: state.list } } }) }));
vi.stubEnv('SUPABASE_URL', 'https://example.invalid');
vi.stubEnv('SUPABASE_SERVICE_KEY', 'synthetic');
vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic');
vi.stubEnv('SUPABASE_JWT_SECRET', 'synthetic');

let profiles: Array<Record<string, any>>;
let writes: Array<Record<string, any>>;
let lookupError: boolean;
let competingInsert: boolean;
let counter = 0;
let mapUser: typeof import('./supabase.server').getOrCreateSupabaseUser;
beforeEach(async () => {
  vi.resetModules(); profiles = []; writes = []; lookupError = false; competingInsert = false;
  ({ getOrCreateSupabaseUser: mapUser } = await import('./supabase.server'));
  state.create.mockReset().mockResolvedValue({ data: null, error: { message: 'already registered' } });
  state.list.mockReset().mockResolvedValue({ data: { users: [] }, error: null });
  state.from.mockImplementation((table: string) => {
    const filters: Array<[string, unknown]> = []; let payload: Record<string, any> | undefined; let ignore = false; let update = false;
    const q: any = {};
    q.select = q.single = q.maybeSingle = () => q;
    q.eq = (k: string, v: unknown) => { filters.push([k,v]); return q; };
    q.upsert = (row: Record<string, any>, opts: any) => {
      if (competingInsert) profiles.push({ id: row.id, shopify_customer_id: 'competing', email: 'competing@example.invalid' });
      payload = row; ignore = opts?.ignoreDuplicates; return q;
    };
    q.update = (row: Record<string, any>) => { payload = row; update = true; return q; };
    q.insert = () => ({ then: (resolve: any) => resolve({ error: null }) });
    q.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
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
// US-15 AC9: only Shopify-authenticated identity may acquire its own principal.
describe('Shopify principal reuse', () => {
  it('does not reuse a signup profile poisoned through the schema-selected user metadata source', async () => {
    const customer = identity();
    const signup = {
      raw_user_meta_data: { shopify_customer_id: customer },
      raw_app_meta_data: {} as Record<string, string>,
    };
    profiles.push({ id: 'mobile', email, shopify_customer_id: signup[triggerMetadata as keyof typeof signup].shopify_customer_id ?? null });
    await expect(mapUser(customer, email)).rejects.toThrow(/identity|link/i);
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
    const customer = identity(); profiles.push({ id: 'foreign', email, shopify_customer_id: link });
    await expect(mapUser(customer, email)).rejects.toThrow(/identity|link/i);
    await expect(mapUser(customer, email)).rejects.toThrow(/identity|link/i);
    expect(writes).toEqual([]); expect(state.create).toHaveBeenCalledTimes(2);
  });
  it('preserves an existing mapping only when admin-written proof matches', async () => {
    const customer = identity();
    profiles.push({ id: 'own', email, shopify_customer_id: customer });
    state.list.mockResolvedValue({ data: { users: [{ id: 'own', email, app_metadata: { shopify_customer_id: customer } }] }, error: null });
    expect(await mapUser(customer, email)).toBe('own');
    expect(await mapUser(customer, email)).toBe('own');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.list).toHaveBeenCalledTimes(1);
  });
  it('accepts a concurrent same-customer profile only with matching admin proof', async () => {
    const customer = identity();
    state.create.mockImplementationOnce(async () => {
      profiles.push({ id: 'raced', email, shopify_customer_id: customer });
      return { data: null, error: { message: 'duplicate' } };
    });
    state.list.mockResolvedValue({ data: { users: [{ id: 'raced', email, app_metadata: { shopify_customer_id: customer } }] }, error: null });
    expect(await mapUser(customer, email)).toBe('raced');
    expect(writes).toEqual([]);
  });
  it('does not treat user-editable auth metadata as identity proof', async () => {
    const customer = identity(); state.list.mockResolvedValue({ data: { users: [{ id: 'unlinked', email, user_metadata: { shopify_customer_id: customer }, app_metadata: {} }] }, error: null });
    await expect(mapUser(customer, email)).rejects.toThrow(/identity|link/i); expect(writes).toEqual([]);
  });
  it('does not overwrite a competing profile when an auth candidate has server-owned proof', async () => {
    const customer = identity(); profiles.push({ id: 'candidate', email: 'changed@example.invalid', shopify_customer_id: 'different' });
    state.list.mockResolvedValue({ data: { users: [{ id: 'candidate', email, app_metadata: { shopify_customer_id: customer } }] }, error: null });
    await expect(mapUser(customer, email)).rejects.toThrow(/identity|link/i);
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
    await expect(mapUser(identity(), email)).rejects.toThrow(/identity|link/i);
    expect(profiles).toEqual([{ id: 'racing', shopify_customer_id: 'competing', email: 'competing@example.invalid' }]);
  });
  it('converges two concurrent creations of the same Shopify identity', async () => {
    const customer = identity(); let created = false;
    state.create.mockImplementation(async () => {
      if (created) return { data: null, error: { message: 'duplicate' } };
      created = true; profiles.push({ id: 'shared', email, shopify_customer_id: customer });
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
  it('finds an auth-only same-customer principal beyond the first page', async () => {
    const customer = identity();
    state.list.mockImplementation(async (options?: { page: number }) => ({
      data: { users: options?.page === 2
        ? [{ id: 'later', email: email.toUpperCase(), app_metadata: { shopify_customer_id: customer } }]
        : Array.from({ length: 1000 }, (_, i) => ({ id: `filler-${i}`, email: `filler-${i}@example.invalid`, app_metadata: {} })) },
      error: null,
    }));
    expect(await mapUser(customer, email)).toBe('later');
    expect(state.list.mock.calls).toEqual([[{ page: 1, perPage: 1000 }], [{ page: 2, perPage: 1000 }]]);
    expect(profiles[0]).toMatchObject({ id: 'later', shopify_customer_id: customer });
  });
  it('stops at an exhausted page without inventing a principal', async () => {
    await expect(mapUser(identity(), email)).rejects.toThrow(/create/i);
    expect(state.list).toHaveBeenCalledTimes(1); expect(writes).toEqual([]);
  });
  it('bounds enumeration and refuses rather than creating a competing account', async () => {
    state.list.mockResolvedValue({ data: { users: Array.from({ length: 1000 }, (_, i) => ({ id: `f-${i}`, email: `f-${i}@example.invalid` })) }, error: null });
    await expect(mapUser(identity(), email)).rejects.toThrow(/limit/i);
    expect(state.list).toHaveBeenCalledTimes(10); expect(writes).toEqual([]);
  });
  it('reports a later page failure clearly without an upsert', async () => {
    state.list.mockResolvedValueOnce({ data: { users: Array.from({ length: 1000 }, () => ({ email: 'other@example.invalid' })) }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'synthetic page failure' } });
    await expect(mapUser(identity(), email)).rejects.toThrow(/list/i);
    expect(state.list).toHaveBeenCalledTimes(2); expect(writes).toEqual([]);
  });
  it('refuses a stored Shopify mapping that has no matching admin-written proof', async () => {
    const customer = identity();
    profiles.push({ id: 'legacy', email, shopify_customer_id: customer });
    state.list.mockResolvedValue({ data: { users: [{ id: 'legacy', email, app_metadata: {} }] }, error: null });
    await expect(mapUser(customer, email)).rejects.toThrow(/provenance|verification/i);
    expect(writes).toEqual([]);
    expect(state.create).not.toHaveBeenCalled();
  });
  it('fails clearly on profile lookup errors before trying to create an account', async () => {
    lookupError = true; await expect(mapUser(identity(), email)).rejects.toThrow(/lookup/i);
    expect(state.create).not.toHaveBeenCalled();
  });
});
