import { describe, expect, it, vi } from 'vitest';
import { planBackfill, run, type AuthRow } from './backfill-shopify-link-proof';

// US-09 AC27: the one-time copy of server-written links into app_metadata.
const T = '2026-07-01T00:00:00.000Z';
/** An auth user as admin createUser({ email_confirm: true }) leaves it, linked to `customer`. */
const created = (id: string, customer: string | null, extra: Partial<AuthRow> = {}): AuthRow => ({
  id, createdAt: T, emailConfirmedAt: '2026-07-01T00:00:00.004Z', confirmationSentAt: null, lastSignInAt: null,
  userClaim: customer, appClaim: null, appMetadata: { provider: 'email' }, profileCustomerId: customer, ...extra,
});

describe('planBackfill', () => {
  it('counts every category and writes only server-created, agreeing, never-signed-in, unique links', () => {
    const plan = planBackfill([
      created('a', '1'),
      created('b', '2'),
      created('c', '3', { appClaim: '3', appMetadata: { provider: 'email', shopify_customer_id: '3' } }),
      created('d', '4', { appClaim: '99' }),
      created('e', '5', { userClaim: null }),
      created('f', '6', { userClaim: '7' }),
      created('g', '8', { lastSignInAt: '2026-10-01T00:00:00Z' }),
      created('h', '9'),
      created('i', '9', { profileCustomerId: null }), // an unlinked second claimant of 9
      created('j', '10'),
      created('k', null, { appClaim: '10', profileCustomerId: null }), // an app_metadata claimant of 10
    ]);
    expect(plan.counts).toEqual({
      auth_users: 11, linked_profiles: 9, already_proven: 1, to_write: 2,
      skipped_not_server_created: 0, skipped_app_metadata_conflict: 1, skipped_user_metadata_missing: 1,
      skipped_user_metadata_differs: 1, skipped_signed_in: 1, skipped_duplicate_claim: 2,
    });
    expect(plan.writes).toEqual([
      { userId: 'a', customerId: '1', appMetadata: { provider: 'email', shopify_customer_id: '1' } },
      { userId: 'b', customerId: '2', appMetadata: { provider: 'email', shopify_customer_id: '2' } },
    ]);
  });
  it('skips a self sign-up with a forged claim: confirmation email sent, or confirmed long after creation, or never confirmed', () => {
    const plan = planBackfill([
      created('s1', '1', { confirmationSentAt: T, emailConfirmedAt: null }),
      created('s2', '2', { confirmationSentAt: T, emailConfirmedAt: '2026-07-01T00:00:00.004Z' }),
      created('s3', '3', { emailConfirmedAt: '2026-07-01T00:05:00.000Z' }),
      created('s4', '4', { emailConfirmedAt: null }),
    ]);
    expect(plan.counts.skipped_not_server_created).toBe(4);
    expect(plan.writes).toEqual([]);
  });
});

describe('run', () => {
  it('dry run writes nothing; execute writes and verifies; a second execute is a no-op', async () => {
    const rows = [created('a', '1'), created('b', '2', { lastSignInAt: 'x' })];
    const update = vi.fn(async (id: string, appMetadata: Record<string, unknown>) => {
      const row = rows.find(r => r.id === id)!;
      row.appMetadata = appMetadata; row.appClaim = String(appMetadata.shopify_customer_id);
      return true;
    });
    const deps = {
      readRows: async () => rows.map(r => ({ ...r })), update,
      readAppClaim: async (id: string) => rows.find(r => r.id === id)!.appClaim,
      confirm: async (id: string) => ({ ...rows.find(r => r.id === id)! }),
    };
    expect(await run(deps, false)).toMatchObject({ mode: 'dry-run', to_write: 1, confirmed: 1, skipped_signed_in: 1, written: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(await run(deps, true)).toMatchObject({ mode: 'execute', to_write: 1, written: 1, verified: 1, write_failed: 0 });
    expect(rows[0].appMetadata).toEqual({ provider: 'email', shopify_customer_id: '1' });
    expect(await run(deps, true)).toMatchObject({ already_proven: 1, to_write: 0, written: 0 });
    expect(update).toHaveBeenCalledTimes(1);
  });

  // The pg read is not certificate-verified, so it only narrows candidates; the
  // HTTPS admin record decides.
  it.each<[string, Partial<AuthRow> | null]>([
    ['missing from the admin API', null],
    ['signed in per the admin API', { lastSignInAt: '2026-10-01T00:00:00Z' }],
    ['self sign-up per the admin API', { confirmationSentAt: T }],
    ['a different user_metadata claim', { userClaim: '2' }],
    ['a different profile link', { profileCustomerId: '2' }],
    ['already holding another app_metadata claim', { appClaim: '2' }],
  ])('skips a candidate whose pg row disagrees with the admin record: %s', async (_name, change) => {
    const update = vi.fn(async () => true);
    const deps = {
      readRows: async () => [created('a', '1')], update, readAppClaim: async () => '1',
      confirm: async () => (change ? { ...created('a', '1'), ...change } : null),
    };
    expect(await run(deps, true)).toMatchObject({ to_write: 1, confirmed: 0, skipped_admin_mismatch: 1, written: 0 });
    expect(update).not.toHaveBeenCalled();
  });
});
