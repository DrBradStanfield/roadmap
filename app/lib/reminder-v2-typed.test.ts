/**
 * US-23 — typed-email reminders, server half. What must hold when ANYONE can
 * POST any email address with a schedule:
 *
 *  AC4/AC8  labels are an allow-list, never client-authored text — an
 *           unauthenticated capture names someone ELSE'S inbox;
 *  AC2      typed rows sit out a 3-day quiet period measured from created_at
 *           (never updated_at — refreshes touch that);
 *  AC7      a refresh updates the schedule ONLY: token kept (old unsubscribe
 *           links keep working), last_sent kept (no resend amplification),
 *           and a provider-verified row is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Chainable Supabase stub: every method returns the query object; awaiting it
// resolves to whatever the test primed. upsert/update/select terminate via
// maybeSingle() or by being awaited directly (thenable).
type Primed = { data?: unknown; error?: { message: string } | null };
const calls: Array<{ method: string; args: unknown[] }> = [];
let primedResults: Primed[] = [];

function makeQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const chain = (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return q;
    };
  for (const m of ['from', 'select', 'eq', 'upsert', 'update', 'delete', 'order', 'range']) q[m] = chain(m);
  q.maybeSingle = () => {
    calls.push({ method: 'maybeSingle', args: [] });
    return Promise.resolve(primedResults.shift() ?? { data: null, error: null });
  };
  // Awaiting the chain directly (upsert/update paths) resolves the next primed result.
  q.then = (resolve: (v: Primed) => void) => resolve(primedResults.shift() ?? { data: null, error: null });
  return q;
}

vi.mock('./supabase.server', () => ({
  supabaseAdmin: makeQuery(),
}));

import {
  inTypedQuietPeriod,
  scheduleSchema,
  upsertTypedOptin,
} from './reminder-v2.server';

const VALID_ITEM = { category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2027-05-12' };

beforeEach(() => {
  calls.length = 0;
  primedResults = [];
});

describe('US-23 AC4/AC8 — the label allow-list', () => {
  it('accepts every canonical label, including the annual floor', () => {
    const schedule = [
      VALID_ITEM,
      { category: 'screening_colorectal', label: 'Colonoscopy', dueAt: '2034-03-01' },
      { category: 'screening_colorectal', label: 'Colorectal screening', dueAt: '2027-01-01' },
      { category: 'annual_checkin', label: 'Annual health check-in', dueAt: '2027-08-14' },
    ];
    expect(scheduleSchema.safeParse(schedule).success).toBe(true);
  });

  it('rejects client-authored label text — even harmless-looking text', () => {
    const attack = [{ category: 'blood_test_lipids', label: 'URGENT: click http://evil.example', dueAt: '2026-08-20' }];
    expect(scheduleSchema.safeParse(attack).success).toBe(false);

    const benign = [{ category: 'blood_test_lipids', label: 'Lipid panel', dueAt: '2026-08-20' }];
    expect(scheduleSchema.safeParse(benign).success).toBe(false); // close, but not canonical → no
  });

  it("rejects a real label under the WRONG category (no cross-category smuggling)", () => {
    const smuggled = [{ category: 'medication_review', label: 'Colonoscopy', dueAt: '2026-08-20' }];
    expect(scheduleSchema.safeParse(smuggled).success).toBe(false);
  });
});

describe('US-23 AC2 — the typed quiet period', () => {
  const day = (iso: string) => iso.slice(0, 10);

  it('holds a typed row for its first 3 days', () => {
    const optin = { provider: 'typed' as const, created_at: '2026-08-14T02:00:00.000Z' };
    expect(inTypedQuietPeriod(optin, day('2026-08-14'))).toBe(true);
    expect(inTypedQuietPeriod(optin, day('2026-08-16'))).toBe(true);
    expect(inTypedQuietPeriod(optin, day('2026-08-17'))).toBe(false);
  });

  it('never holds a provider-verified row — the address vouched for itself', () => {
    const optin = { provider: 'google-drive' as const, created_at: '2026-08-14T02:00:00.000Z' };
    expect(inTypedQuietPeriod(optin, day('2026-08-14'))).toBe(false);
  });
});

describe('US-23 AC7 — typed writes create or refresh, never clobber', () => {
  it('leaves a provider-verified row untouched and returns null', async () => {
    primedResults = [{ data: { provider: 'google-drive', token: 'cloud-token' }, error: null }];

    const result = await upsertTypedOptin('victim@example.com', [VALID_ITEM]);

    expect(result).toBeNull();
    // Only the provider check ran — no update, no upsert reached the table.
    expect(calls.map((c) => c.method)).not.toContain('update');
    expect(calls.map((c) => c.method)).not.toContain('upsert');
  });

  it('refreshes an existing typed row: schedule only, token PRESERVED, cooldowns untouched', async () => {
    primedResults = [
      { data: { provider: 'typed', token: 'original-token' }, error: null }, // provider check
      { data: null, error: null },                                          // update result
    ];

    const result = await upsertTypedOptin('user@example.com', [VALID_ITEM]);

    expect(result).toEqual({ token: 'original-token', isNew: false });
    const update = calls.find((c) => c.method === 'update');
    expect(update).toBeDefined();
    const payload = update!.args[0] as Record<string, unknown>;
    // The three fields a refresh must NOT touch (review 2026-08-14): a new
    // token breaks every already-sent unsubscribe link; a reset last_sent
    // turns one re-capture/day into daily re-sends; created_at re-arms AC2.
    expect(payload).not.toHaveProperty('token');
    expect(payload).not.toHaveProperty('last_sent');
    expect(payload).not.toHaveProperty('created_at');
    expect(payload).toHaveProperty('schedule');
  });

  it('creates a fresh row (new token, isNew) when the email is unknown', async () => {
    primedResults = [
      { data: null, error: null }, // provider check: no row
      { data: null, error: null }, // upsert result
    ];

    const result = await upsertTypedOptin('New@Example.com', [VALID_ITEM]);

    expect(result).not.toBeNull();
    expect(result!.isNew).toBe(true);
    expect(result!.token).toMatch(/^[A-Za-z0-9_-]{20,}$/); // minted, urlsafe
    const upsert = calls.find((c) => c.method === 'upsert');
    const payload = (upsert!.args[0] as Record<string, unknown>);
    expect(payload.email).toBe('new@example.com'); // normalised
    expect(payload.provider).toBe('typed');
  });
});
