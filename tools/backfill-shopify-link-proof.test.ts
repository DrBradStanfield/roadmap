import { describe, expect, it, vi } from 'vitest';
import { planBackfill, run, type LinkRow } from './backfill-shopify-link-proof';

// US-09 AC27: the one-time copy of server-written links into app_metadata.
const row = (userId: string, customerId: string, user: LinkRow['user']): LinkRow => ({ userId, customerId, user });
const created = (customer: string | null, extra: Record<string, unknown> = {}) =>
  ({ app_metadata: { provider: 'email' }, user_metadata: customer ? { shopify_customer_id: customer } : {}, last_sign_in_at: null, ...extra });

describe('planBackfill', () => {
  it('counts every category and writes only agreeing, never-signed-in, unique links', () => {
    const plan = planBackfill([
      row('a', '1', created('1')),
      row('b', '2', created('2')),
      row('c', '3', { ...created('3'), app_metadata: { provider: 'email', shopify_customer_id: '3' } }),
      row('d', '4', { ...created('4'), app_metadata: { shopify_customer_id: '99' } }),
      row('e', '5', created(null)),
      row('f', '6', created('7')),
      row('g', '8', created('8', { last_sign_in_at: '2026-10-01T00:00:00Z' })),
      row('h', '9', created('9')),
      row('i', '10', created('9')),
      row('j', '11', null),
    ]);
    expect(plan.counts).toEqual({
      linked_profiles: 10, already_proven: 1, to_write: 2, skipped_unreadable: 1,
      skipped_app_metadata_conflict: 1, skipped_user_metadata_missing: 1, skipped_user_metadata_differs: 2,
      skipped_signed_in: 1, skipped_duplicate_claim: 1,
    });
    expect(plan.writes).toEqual([
      { userId: 'a', customerId: '1', appMetadata: { provider: 'email', shopify_customer_id: '1' } },
      { userId: 'b', customerId: '2', appMetadata: { provider: 'email', shopify_customer_id: '2' } },
    ]);
  });
  it('compares numeric metadata as text', () => {
    expect(planBackfill([row('a', '12', created(null, { user_metadata: { shopify_customer_id: 12 } }))]).counts.to_write).toBe(1);
  });
});

function fakeAdmin(users: Map<string, any>, profiles: Array<{ id: string; shopify_customer_id: string }>) {
  const update = vi.fn(async (id: string, attrs: any) => {
    users.set(id, { ...users.get(id), app_metadata: attrs.app_metadata });
    return { data: {}, error: null };
  });
  const q: any = { select: () => q, not: () => q, order: () => q, range: async () => ({ data: profiles, error: null }) };
  return {
    update,
    admin: {
      from: () => q,
      auth: { admin: {
        getUserById: async (id: string) => (users.has(id) ? { data: { user: users.get(id) }, error: null } : { data: { user: null }, error: { message: 'x' } }),
        updateUserById: update,
      } },
    } as any,
  };
}

describe('run', () => {
  it('dry run writes nothing; execute writes and verifies; a second execute is a no-op', async () => {
    const users = new Map<string, any>([['a', created('1')], ['b', created('2', { last_sign_in_at: 'x' })]]);
    const { admin, update } = fakeAdmin(users, [{ id: 'a', shopify_customer_id: '1' }, { id: 'b', shopify_customer_id: '2' }]);
    expect(await run(admin, false)).toMatchObject({ mode: 'dry-run', to_write: 1, skipped_signed_in: 1, written: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(await run(admin, true)).toMatchObject({ mode: 'execute', to_write: 1, written: 1, verified: 1, write_failed: 0 });
    expect(users.get('a').app_metadata).toEqual({ provider: 'email', shopify_customer_id: '1' });
    expect(await run(admin, true)).toMatchObject({ already_proven: 1, to_write: 0, written: 0 });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
