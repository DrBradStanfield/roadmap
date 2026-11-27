/**
 * US-17 AC1b / AC4 — the reminders client and the real route agree on the
 * cancel body. Every cancel the browser sends is fed, byte for byte, into the
 * route's `action`. It lives beside the route so neither build's typecheck
 * compiles the other side's modules.
 *
 * The bug (live since c2d4192e, 2026-09-10): the client posted
 * `idToken: null` when it had no Google proof, and the route's zod
 * `.optional()` accepts a missing key but rejects null, so it answered
 * 400 "Invalid input". "Turn off" on Dropbox or GitHub, every hidden-tab
 * cancel, the cloud switch and "Delete all my data" left the server row active.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FileReminderOptIn } from '@roadmap/health-core/roadmap-file';

// --- the client's dependencies ---------------------------------------------
const getReminderOptIn = vi.fn<() => FileReminderOptIn | undefined>(() => undefined);
const isKnownMinorNow = vi.fn(() => false);
const getReminderIdToken = vi.fn<() => Promise<string | null>>(async () => null);
const setReminderRows = vi.fn((_rows: { token: string; status: string }[], _erase: string) => true);

vi.mock('../../widget-src/src/lib/roadmap-data', () => ({
  getReminderOptIn: () => getReminderOptIn(),
  setReminderRows: (rows: { token: string; status: string }[], erase: string) => setReminderRows(rows, erase),
  getShownErase: () => '[0,null]',
  getEraseIdentity: () => '[0,null]',
  stillShown: () => true,
  flushRoadmapStore: vi.fn(async () => {}),
  computeCurrentReminderSchedule: () => [],
  isKnownMinorNow: () => isKnownMinorNow(),
}));
vi.mock('../../widget-src/src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../../widget-src/src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../widget-src/src/lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
vi.mock('../../widget-src/standalone/google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../../widget-src/standalone/dropbox-config', () => ({ dropboxConfig: () => ({}) }));
vi.mock('../../widget-src/src/storage', () => ({
  GoogleDriveAdapter: class {
    getReminderIdToken() { return getReminderIdToken(); }
    accountEmail() { return 'drive@example.com'; }
  },
  DropboxAdapter: class { async accountEmail() { return 'dbx@example.com'; } },
  GitHubAdapter: class { async accountEmail() { return 'gh@example.com'; } },
}));

// --- the route's dependencies (the database and the outside world) ---------
const cancelByToken = vi.fn(async () => {});
vi.mock('../lib/supabase-guest.server', () => ({ hashClientIp: (ip: string) => `h:${ip}` }));
vi.mock('../lib/supabase-client.server', () => ({ supabaseAdmin: null }));
vi.mock('../lib/klaviyo.server', () => ({ subscribeToKlaviyo: vi.fn(async () => {}) }));
vi.mock('../lib/reminder-v2.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cancelByToken: (...a: unknown[]) => cancelByToken(...(a as [])),
  verifyGoogleIdToken: async () => null,
  enrolByEmail: async () => ({ token: 'tok-new', isNew: true }),
}));
vi.mock('../lib/email.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendPlanReadyEmail: vi.fn(async () => true),
}));
vi.mock('../lib/product-events.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordServerEvent: vi.fn(async () => {}),
}));

import { action } from './api.reminders-v2';
import { autoEnrolReminders, cancelReminders, cancelRemindersForErase, pushReminderSchedule } from '../../widget-src/standalone/reminders';

const optIn = (provider: FileReminderOptIn['provider']): FileReminderOptIn => ({
  status: 'active', token: 'cap-token', email: 'user@example.com', provider,
  updatedAt: '2026-08-01T00:00:00.000Z', lamport: 3,
});

/** Statuses the route answered, one per request the client sent. */
let statuses: number[] = [];
let ip = 0;
/** One client address for every request, when set: the route's per-address limit applies. */
let oneIp: string | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  statuses = [];
  oneIp = null;
  isKnownMinorNow.mockReturnValue(false);
  getReminderIdToken.mockResolvedValue(null);
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('sessionStorage', { setItem: vi.fn(), getItem: () => null, removeItem: vi.fn() });
  vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: () => null, removeItem: vi.fn() });
  // The browser's fetch, answered by the real route with the exact body sent.
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const res = await action({
      request: new Request(url, {
        method: 'POST',
        headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': oneIp ?? `10.7.0.${++ip}` },
        body: init.body,
      }),
    } as never);
    statuses.push(res.status);
    return res;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('US-17 AC1b/AC4: every cancel the client sends is one the route accepts', () => {
  it.each(['dropbox', 'github'] as const)('"Turn off" on %s (no Google proof): 200 and the row is cancelled', async (provider) => {
    getReminderOptIn.mockReturnValue(optIn(provider));
    await cancelReminders();
    expect(statuses).toEqual([200]);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });

  it('"Turn off" on Drive with no silent ID token: 200 and the row is cancelled', async () => {
    getReminderOptIn.mockReturnValue(optIn('google-drive'));
    await cancelReminders();
    expect(statuses).toEqual([200]);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });

  it('the hidden-tab cancel (a known minor, keepalive): 200 and the row is cancelled', async () => {
    getReminderOptIn.mockReturnValue(optIn('google-drive'));
    isKnownMinorNow.mockReturnValue(true);
    await pushReminderSchedule('google-drive', true);
    expect(statuses).toEqual([200]);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });

  it('"Delete all my data" on Dropbox: 200 and the row is cancelled', async () => {
    getReminderOptIn.mockReturnValue(undefined); // the erased record holds no token at the commit
    getReminderOptIn.mockReturnValueOnce(optIn('dropbox'));
    // Prepare inside the erase, commit once it stands, with the erase's observed set (US-11 AC15).
    await (await cancelRemindersForErase())({ observed: optIn('dropbox'), landed: undefined });
    expect(statuses).toEqual([200]);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });

  it('the cloud switch (Dropbox to GitHub): the old row is cancelled with 200 before the new enrolment', async () => {
    getReminderOptIn.mockReturnValue(optIn('dropbox'));
    await autoEnrolReminders('github');
    expect(statuses[0]).toBe(200);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });
});

// US-17 AC19: one Turn off sends one cancel per token it read, each one the route accepts.
describe('US-17 AC19: Turn off with several tokens, against the real route', () => {
  const rows = (n: number): FileReminderOptIn => {
    const row = (i: number) => ({ ...optIn('dropbox'), token: `test-token-${String(i).padStart(2, '0')}`, email: `person-${i}@example.test`, lamport: n - i });
    return { ...row(0), tokens: Array.from({ length: n - 1 }, (_, i) => row(i + 1)) };
  };

  it('three tokens: three cancels, each 200, every row written cancelled in one edit', async () => {
    getReminderOptIn.mockReturnValue(rows(3));
    await cancelReminders();
    expect(statuses).toEqual([200, 200, 200]);
    expect(cancelByToken.mock.calls.map(([token]) => token).sort()).toEqual(['test-token-00', 'test-token-01', 'test-token-02']);
    expect(setReminderRows).toHaveBeenCalledTimes(1);
    expect(setReminderRows.mock.calls[0][0].map((r) => [r.token, r.status])).toEqual([['test-token-00', 'cancelled'], ['test-token-01', 'cancelled'], ['test-token-02', 'cancelled']]);
  });

  // US-11 AC15 and US-17 AC19 Limit: the route takes about 20 requests a minute from one address.
  it('more tokens than one address may send in a minute: the first 20 land, the rest stay on and the Turn off says so', async () => {
    oneIp = '10.9.9.9';
    getReminderOptIn.mockReturnValue(rows(22));
    await expect(cancelReminders()).rejects.toThrow('Could not turn reminders off (429). Please retry.');
    expect(statuses).toEqual([...Array(20).fill(200), 429, 429]);
    expect(setReminderRows).toHaveBeenCalledTimes(1);
    expect(setReminderRows.mock.calls[0][0]).toHaveLength(20);
    expect(setReminderRows.mock.calls[0][0].map((r) => r.token)).not.toContain('test-token-21');
  });
});
