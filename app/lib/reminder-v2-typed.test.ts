/**
 * US-23 / US-17 AC8 — credential-free reminders, server half. What must hold
 * when ANYONE can POST any email address with a schedule (typed, Dropbox and
 * GitHub lanes alike since 2026-09-10):
 *
 *  AC4/AC8  labels are an allow-list, never client-authored text — an
 *           unauthenticated optin names someone ELSE'S inbox;
 *  AC2      every fresh row sits out a 3-day quiet period measured from
 *           created_at (never updated_at — refreshes touch that);
 *  AC7/AC8  an optin against an existing address refreshes the schedule
 *           ONLY: token never rotated and NEVER RETURNED (the silent-
 *           unsubscribe attack: optin the victim, cancel with the token),
 *           last_sent kept (no resend amplification), provider immutable;
 *           a tombstoned token refuses schedule pushes so the device flips
 *           itself to cancelled.
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
  enrolByEmail,
  ensureAnnualFloor,
  inQuietPeriod,
  scheduleSchema,
  unsubscribeByToken,
  updateScheduleByToken,
  upsertVerifiedOptin,
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

describe('US-23 AC4 — dueAt must be a real calendar date', () => {
  it('rejects regex-valid impossible dates (they make the email builders throw)', () => {
    const poisoned = [{ category: 'annual_checkin', label: 'Annual health check-in', dueAt: '2026-99-99' }];
    expect(scheduleSchema.safeParse(poisoned).success).toBe(false);
  });
});

describe('US-23 AC6 — the SERVER-side annual floor (integrity bound, not UX)', () => {
  const NOW = new Date('2026-08-14T00:00:00Z');

  it('appends a check-in when every pushed date is beyond 12 months — the "silent kill switch" clamp', () => {
    const suppressed = [{ category: 'screening_colorectal', label: 'Colonoscopy', dueAt: '2099-12-31' }];
    const floored = ensureAnnualFloor(suppressed, NOW);
    expect(floored).toHaveLength(2);
    expect(floored[1]).toEqual({ category: 'annual_checkin', label: 'Annual health check-in', dueAt: '2027-08-14' });
  });

  it('floors an empty schedule too (old client bundles without the client floor)', () => {
    expect(ensureAnnualFloor([], NOW)).toHaveLength(1);
  });

  it('leaves a schedule alone when something is already due within 12 months', () => {
    const fine = [VALID_ITEM]; // 2027-05-12 < 12 months from NOW
    expect(ensureAnnualFloor(fine, NOW)).toBe(fine);
  });
});

describe('US-23 AC2 — the quiet period, every lane', () => {
  const day = (iso: string) => iso.slice(0, 10);

  it('holds a fresh row for its first 3 days', () => {
    const optin = { created_at: '2026-08-14T02:00:00.000Z' };
    expect(inQuietPeriod(optin, day('2026-08-14'))).toBe(true);
    expect(inQuietPeriod(optin, day('2026-08-16'))).toBe(true);
    expect(inQuietPeriod(optin, day('2026-08-17'))).toBe(false);
  });
});

describe('Google-verified opt-in over an existing row preserves the unsubscribe token and cooldowns', () => {
  it('reuses the existing token and last_sent instead of minting/resetting (already-sent links must keep working)', async () => {
    primedResults = [
      { data: { token: 'original-token', last_sent: { blood_test_lipids: '2026-08-01' } }, error: null }, // lookup
      { data: null, error: null }, // upsert
    ];

    const result = await upsertVerifiedOptin('user@example.com', [VALID_ITEM]);

    expect(result).toEqual({ token: 'original-token', isNew: false });
    const upsert = calls.find((c) => c.method === 'upsert')!;
    const payload = upsert.args[0] as Record<string, unknown>;
    expect(payload.token).toBe('original-token');
    expect(payload.provider).toBe('google-drive');
    expect(payload.last_sent).toEqual({ blood_test_lipids: '2026-08-01' });
  });
});

describe('US-23 AC5/AC8 — unsubscribe is a DURABLE tombstone for every lane', () => {
  it('tombstones the row (schedule=[], row kept) so a replayed optin is a refresh, not a fresh isNew', async () => {
    primedResults = [
      { data: { provider: 'dropbox', schedule: [VALID_ITEM] }, error: null }, // lookup
      { data: null, error: null },                                           // tombstone update
    ];

    const provider = await unsubscribeByToken('tok');

    expect(provider).toBe('dropbox');
    const update = calls.find((c) => c.method === 'update')!;
    expect((update.args[0] as Record<string, unknown>).schedule).toEqual([]);
    expect(calls.map((c) => c.method)).not.toContain('delete');
  });

  it('is idempotent: a second click on an already-tombstoned row counts nothing', async () => {
    primedResults = [{ data: { provider: 'typed', schedule: [] }, error: null }];
    expect(await unsubscribeByToken('tok')).toBeNull();
  });

  it('a tombstoned token refuses schedule pushes (false) so the device flips itself to cancelled', async () => {
    primedResults = [{ data: { schedule: [] }, error: null }]; // token lookup
    expect(await updateScheduleByToken('tok', [VALID_ITEM])).toBe(false);
    expect(calls.map((c) => c.method)).not.toContain('update');
  });

  it('a live token still takes the push', async () => {
    primedResults = [
      { data: { schedule: [VALID_ITEM] }, error: null }, // token lookup
      { data: null, error: null },                       // update
    ];
    expect(await updateScheduleByToken('tok', [VALID_ITEM])).toBe(true);
    expect(calls.map((c) => c.method)).toContain('update');
  });
});

describe('US-17 AC8 — a credential-free optin creates or refreshes, never clobbers, never hands out a token', () => {
  it('the silent-unsubscribe attack: optin against an enrolled address returns NO token and rotates nothing', async () => {
    primedResults = [
      { data: { id: 'row-1' }, error: null }, // lookup: the victim's Google-verified row
      { data: null, error: null },            // schedule refresh
    ];

    const result = await enrolByEmail('victim@example.com', 'dropbox', [VALID_ITEM]);

    expect(result).toEqual({ isNew: false }); // no token → no cancel capability for the caller
    const update = calls.find((c) => c.method === 'update')!;
    const payload = update.args[0] as Record<string, unknown>;
    // The fields a refresh must NOT touch (reviews 2026-08-14, 2026-09-10): a
    // new token breaks every sent unsubscribe link AND 404s the victim's own
    // device into "cancelled"; a reset last_sent turns one optin/day into
    // daily re-sends; created_at re-arms AC2; provider rewrites the ratio.
    expect(payload).not.toHaveProperty('token');
    expect(payload).not.toHaveProperty('last_sent');
    expect(payload).not.toHaveProperty('created_at');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).toHaveProperty('schedule');
    expect(calls.map((c) => c.method)).not.toContain('upsert');
  });

  it('the tombstone refill: a refresh against an unsubscribed row rewrites the schedule but is not a new enrolment', async () => {
    primedResults = [
      { data: { id: 'row-1' }, error: null }, // lookup: tombstoned row exists
      { data: null, error: null },            // refresh
    ];

    const result = await enrolByEmail('user@example.com', 'typed', [VALID_ITEM]);

    expect(result).toEqual({ isNew: false }); // no plan-ready email, no optin count
    const update = calls.find((c) => c.method === 'update')!;
    expect((update.args[0] as Record<string, unknown>).schedule).toEqual(expect.arrayContaining([VALID_ITEM]));
  });

  it('creates a fresh row (new token, isNew, the lane recorded) when the email is unknown', async () => {
    primedResults = [
      { data: null, error: null }, // lookup: no row
      { data: null, error: null }, // upsert result
    ];

    const result = await enrolByEmail('New@Example.com', 'github', [VALID_ITEM]);

    expect(result.isNew).toBe(true);
    expect(result.isNew && result.token).toMatch(/^[A-Za-z0-9_-]{20,}$/); // minted, urlsafe
    const upsert = calls.find((c) => c.method === 'upsert');
    const payload = (upsert!.args[0] as Record<string, unknown>);
    expect(payload.email).toBe('new@example.com'); // normalised
    expect(payload.provider).toBe('github');
  });
});
