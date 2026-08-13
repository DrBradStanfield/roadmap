/**
 * US-23 AC8 — the capture route's abuse bounds, pinned at the ROUTE level.
 *
 * The 2026-08-14 adversarial review found the "one plan-ready email per
 * address ever" claim had three bypasses, all reachable only through this
 * route — and no test touched it. These pin the fixed semantics:
 *
 *  - the plan-ready email fires ONLY on a NEW enrolment (isNew);
 *  - a schedule-less body (attacker or stale bundle) sends NOTHING;
 *  - a capture against a cloud-enrolled address sends NOTHING;
 *  - a replayed capture (refresh) sends NOTHING;
 *  - the response is CONSTANT — no membership oracle;
 *  - reminder_optin is counted server-side, on new enrolments only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertTypedOptin = vi.fn<(email: string, s: unknown) => Promise<{ token: string; isNew: boolean } | null>>();
const sendPlanReadyEmail = vi.fn(async () => true);
const subscribeToKlaviyo = vi.fn(async () => {});
const recordServerEvent = vi.fn(async () => {});

vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: vi.fn(async () => ({})) } },
}));
vi.mock('../lib/klaviyo.server', () => ({
  subscribeToKlaviyo: (...a: unknown[]) => subscribeToKlaviyo(...(a as [])),
}));
vi.mock('../lib/email.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendPlanReadyEmail: (...a: unknown[]) => sendPlanReadyEmail(...(a as [])),
}));
vi.mock('../lib/reminder-v2.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  upsertTypedOptin: (email: string, s: unknown) => upsertTypedOptin(email, s),
}));
vi.mock('../lib/product-events.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordServerEvent: (...a: unknown[]) => recordServerEvent(...(a as [])),
}));

import { action } from './api.measurements';

const SCHEDULE = [{ category: 'blood_test_lipids', label: 'Lipid panel blood test', dueAt: '2027-05-12' }];
let emailCounter = 0;

function capture(body: Record<string, unknown>): Request {
  return new Request('https://health-tool-app.fly.dev/api/measurements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.${emailCounter}.${emailCounter}` },
    body: JSON.stringify({ klaviyoCapture: body }),
  });
}

/** Fresh address per test — the per-email/per-IP limiters are process-global. */
function freshEmail(): string {
  emailCounter += 1;
  return `user${emailCounter}@example.com`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('US-23 AC8 — plan-ready email fires ONLY on a new enrolment', () => {
  it('new enrolment: exactly one send, carrying the calendar + unsubscribe, and one server-side optin count', async () => {
    upsertTypedOptin.mockResolvedValue({ token: 'tok-new', isNew: true });
    const email = freshEmail();

    const res = await action({ request: capture({ email, schedule: SCHEDULE }) } as never);

    expect(res.status).toBe(200);
    expect(sendPlanReadyEmail).toHaveBeenCalledTimes(1);
    const [sentTo, options] = sendPlanReadyEmail.mock.calls[0] as [string, { schedule: unknown; unsubscribeUrl: string }];
    expect(sentTo).toBe(email);
    expect(options.schedule).toEqual(SCHEDULE);
    expect(options.unsubscribeUrl).toContain('/reminders-v2/unsubscribe?token=tok-new');
    expect(recordServerEvent).toHaveBeenCalledWith('reminder_optin', { provider: 'typed' });
  });

  it('schedule-less body (attacker / stale bundle): NO email, NO enrolment', async () => {
    const res = await action({ request: capture({ email: freshEmail() }) } as never);

    expect(res.status).toBe(200);
    expect(upsertTypedOptin).not.toHaveBeenCalled();
    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
  });

  it('capture against a cloud-enrolled address (upsert returns null): NO email', async () => {
    upsertTypedOptin.mockResolvedValue(null);

    await action({ request: capture({ email: freshEmail(), schedule: SCHEDULE }) } as never);

    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it('replayed capture (refresh, isNew=false): NO email, NO optin count', async () => {
    upsertTypedOptin.mockResolvedValue({ token: 'tok-old', isNew: false });

    await action({ request: capture({ email: freshEmail(), schedule: SCHEDULE }) } as never);

    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it('a Supabase failure degrades to no-email, capture still succeeds (the PDF is the delivery)', async () => {
    upsertTypedOptin.mockRejectedValue(new Error('supabase down'));

    const res = await action({ request: capture({ email: freshEmail(), schedule: SCHEDULE }) } as never);

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
  });
});

describe('no membership oracle — the response is constant', () => {
  it('returns an identical body for new, refreshed, and cloud-blocked captures', async () => {
    upsertTypedOptin.mockResolvedValueOnce({ token: 't1', isNew: true });
    const a = await (await action({ request: capture({ email: freshEmail(), schedule: SCHEDULE }) } as never)).json();

    upsertTypedOptin.mockResolvedValueOnce({ token: 't1', isNew: false });
    const b = await (await action({ request: capture({ email: freshEmail(), schedule: SCHEDULE }) } as never)).json();

    upsertTypedOptin.mockResolvedValueOnce(null);
    const c = await (await action({ request: capture({ email: freshEmail(), schedule: SCHEDULE }) } as never)).json();

    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).not.toHaveProperty('enrolled');
  });
});

describe('input hardening', () => {
  it('rejects a schedule with a non-canonical label at the route boundary', async () => {
    const res = await action({
      request: capture({
        email: freshEmail(),
        schedule: [{ category: 'blood_test_lipids', label: 'You have HIV — call now', dueAt: '2026-08-20' }],
      }),
    } as never);

    expect(res.status).toBe(400);
    expect(upsertTypedOptin).not.toHaveBeenCalled();
    expect(sendPlanReadyEmail).not.toHaveBeenCalled();
  });

  it('Klaviyo subscribe still fires on every valid capture (marketing list unchanged)', async () => {
    upsertTypedOptin.mockResolvedValue({ token: 't', isNew: false });
    const email = freshEmail();

    await action({ request: capture({ email, schedule: SCHEDULE }) } as never);

    expect(subscribeToKlaviyo).toHaveBeenCalledWith({ email });
  });
});
