/**
 * US-17 AC7–AC10 — the reminders route, at the HTTP boundary:
 *  - every limiter fires BEFORE any write and before the plan-ready send;
 *  - the Drive branch needs a VALID Google ID token — an address alone is not
 *    a Drive optin at all, it is 400 at the schema (a squatter who could enrol
 *    as 'google-drive' would keep the cancel capability across the inbox
 *    owner's own verification);
 *  - the oracle reply leaks nothing on the ADDRESS lane: exactly {token,email}
 *    for a new row, exactly {refreshed:true,email} for an existing one. The
 *    verified lane always gets its token back — new device or rotated, the
 *    owner proved the inbox;
 *  - cancel tombstones on a bare token and passes a verified email through
 *    only when the ID token checks out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const enrolByEmail = vi.fn<(email: string, provider: string, s: unknown) => Promise<{ token: string; isNew: true } | { isNew: false }>>();
const upsertVerifiedOptin = vi.fn<(email: string, s: unknown) => Promise<{ token: string; isNew: boolean }>>();
const verifyGoogleIdToken = vi.fn<(t: string) => Promise<string | null>>();
const cancelByToken = vi.fn(async () => {});
const sendPlanReadyEmail = vi.fn(async () => true);
const recordServerEvent = vi.fn(async () => {});

vi.mock('../lib/supabase.server', () => ({ hashClientIp: (ip: string) => `h:${ip}`, supabaseAdmin: null }));
vi.mock('../lib/klaviyo.server', () => ({ subscribeToKlaviyo: vi.fn(async () => {}) }));
vi.mock('../lib/email.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendPlanReadyEmail: (...a: unknown[]) => sendPlanReadyEmail(...(a as [])),
}));
vi.mock('../lib/reminder-v2.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enrolByEmail: (e: string, p: string, s: unknown) => enrolByEmail(e, p, s),
  upsertVerifiedOptin: (e: string, s: unknown) => upsertVerifiedOptin(e, s),
  verifyGoogleIdToken: (t: string) => verifyGoogleIdToken(t),
  cancelByToken: (...a: unknown[]) => cancelByToken(...(a as [])),
}));
vi.mock('../lib/product-events.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordServerEvent: (...a: unknown[]) => recordServerEvent(...(a as [])),
}));

import { action } from './api.reminders-v2';

const SCHEDULE = [{ category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2027-05-12' }];
let ipCounter = 0;
/** Unique IP per call unless given — the per-IP limiters are module-global. */
function post(body: unknown, ip = `10.0.0.${++ipCounter}`): Request {
  return new Request('https://health-tool-app.fly.dev/api/reminders-v2', {
    method: 'POST',
    headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': ip },
    body: JSON.stringify(body),
  });
}
let emailCounter = 0;
const freshEmail = () => `person${++emailCounter}@example.com`;

beforeEach(() => {
  vi.clearAllMocks();
  enrolByEmail.mockResolvedValue({ token: 'tok-new', isNew: true });
  upsertVerifiedOptin.mockResolvedValue({ token: 'tok-drive', isNew: true });
  verifyGoogleIdToken.mockResolvedValue('drive@example.com');
});

describe('the oracle reply shape', () => {
  it('new address: exactly {token, email}, one plan-ready send, one server-side optin count', async () => {
    const email = freshEmail();
    const res = await action({ request: post({ op: 'optin', provider: 'dropbox', email, schedule: SCHEDULE }) } as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'tok-new', email });
    expect(sendPlanReadyEmail).toHaveBeenCalledTimes(1);
    expect(recordServerEvent).toHaveBeenCalledWith('reminder_optin', { provider: 'dropbox' });
  });

  it('existing address-lane row: exactly {refreshed: true, email} — no token, no send, no count', async () => {
    enrolByEmail.mockResolvedValue({ isNew: false });
    const email = freshEmail();
    const res = await action({ request: post({ op: 'optin', provider: 'github', email, schedule: SCHEDULE }) } as never);

    expect(await res.json()).toEqual({ refreshed: true, email });
    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });
});

describe('the Drive branch', () => {
  it('requires a VALID ID token: an invalid one is 401 with no write', async () => {
    verifyGoogleIdToken.mockResolvedValue(null);
    const res = await action({ request: post({ op: 'optin', provider: 'google-drive', idToken: 'forged', schedule: SCHEDULE }) } as never);

    expect(res.status).toBe(401);
    expect(upsertVerifiedOptin).not.toHaveBeenCalled();
    expect(enrolByEmail).not.toHaveBeenCalled();
  });

  it('a valid ID token enrols the address Google vouched for, through the verified path', async () => {
    const res = await action({ request: post({ op: 'optin', provider: 'google-drive', idToken: 'good', schedule: SCHEDULE }) } as never);

    expect(await res.json()).toEqual({ token: 'tok-drive', email: 'drive@example.com' });
    expect(upsertVerifiedOptin).toHaveBeenCalledWith('drive@example.com', expect.anything());
    expect(enrolByEmail).not.toHaveBeenCalled();
  });

  it("provider 'google-drive' with only an address is rejected at the schema — it never becomes an address-lane row", async () => {
    const res = await action({ request: post({ op: 'optin', provider: 'google-drive', email: freshEmail(), schedule: SCHEDULE }) } as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid input' });
    expect(upsertVerifiedOptin).not.toHaveBeenCalled();
    expect(enrolByEmail).not.toHaveBeenCalled();
  });

  it('existing Google-verified address: the reply carries the token, with no plan-ready email and no optin count', async () => {
    upsertVerifiedOptin.mockResolvedValue({ token: 'tok-drive', isNew: false });
    const res = await action({ request: post({ op: 'optin', provider: 'google-drive', idToken: 'good', schedule: SCHEDULE }) } as never);

    expect(await res.json()).toEqual({ token: 'tok-drive', email: 'drive@example.com' });
    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });
});

describe('limits fire before any write and before the plan-ready send', () => {
  it('per email: the 6th optin for one inbox in a day is 429 — and a +tag / Gmail-dot variant shares the bucket', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await action({ request: post({ op: 'optin', provider: 'typed', email: 'victim@gmail.com', schedule: SCHEDULE }) } as never)).status).toBe(200);
    }
    enrolByEmail.mockClear();
    sendPlanReadyEmail.mockClear();

    const res = await action({ request: post({ op: 'optin', provider: 'typed', email: 'v.i.c.t.i.m+again@Gmail.com', schedule: SCHEDULE }) } as never);

    expect(res.status).toBe(429);
    expect(enrolByEmail).not.toHaveBeenCalled();
    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
  });

  it('per IP: a burst from one address is 429 before any write', async () => {
    const ip = '203.0.113.7';
    let blocked = false;
    for (let i = 0; i < 25 && !blocked; i++) {
      const res = await action({ request: post({ op: 'optin', provider: 'typed', email: freshEmail(), schedule: SCHEDULE }, ip) } as never);
      if (res.status === 429) blocked = true;
    }
    const writesBefore = enrolByEmail.mock.calls.length;
    expect(blocked).toBe(true);
    expect(writesBefore).toBeLessThanOrEqual(20);

    enrolByEmail.mockClear();
    await action({ request: post({ op: 'optin', provider: 'typed', email: freshEmail(), schedule: SCHEDULE }, ip) } as never);
    expect(enrolByEmail).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('a bare token tombstones (no verified email passed)', async () => {
    const res = await action({ request: post({ op: 'cancel', token: 'cap-token' }) } as never);

    expect(res.status).toBe(200);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });

  it('a valid Google ID token passes the verified address through (the delete path)', async () => {
    await action({ request: post({ op: 'cancel', token: 'cap-token', idToken: 'good' }) } as never);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', 'drive@example.com');
  });

  it('an invalid ID token degrades to the tombstone, never an error', async () => {
    verifyGoogleIdToken.mockResolvedValue(null);
    const res = await action({ request: post({ op: 'cancel', token: 'cap-token', idToken: 'forged' }) } as never);

    expect(res.status).toBe(200);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });
});
