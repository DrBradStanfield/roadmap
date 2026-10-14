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
import type { FileReminderOptIn } from '@roadmap/health-core';

// --- the client's dependencies ---------------------------------------------
const getReminderOptIn = vi.fn<() => FileReminderOptIn | undefined>(() => undefined);
const isKnownMinorNow = vi.fn(() => false);
const getReminderIdToken = vi.fn<() => Promise<string | null>>(async () => null);

vi.mock('../../widget-src/src/lib/roadmap-data', () => ({
  getReminderOptIn: () => getReminderOptIn(),
  setReminderOptIn: vi.fn(),
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
vi.mock('../lib/supabase.server', () => ({ hashClientIp: (ip: string) => `h:${ip}`, supabaseAdmin: null }));
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

beforeEach(() => {
  vi.clearAllMocks();
  statuses = [];
  isKnownMinorNow.mockReturnValue(false);
  getReminderIdToken.mockResolvedValue(null);
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('sessionStorage', { setItem: vi.fn(), getItem: () => null, removeItem: vi.fn() });
  vi.stubGlobal('localStorage', { setItem: vi.fn(), getItem: () => null, removeItem: vi.fn() });
  // The browser's fetch, answered by the real route with the exact body sent.
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const res = await action({
      request: new Request(url, {
        method: 'POST',
        headers: { Origin: 'https://drstanfield.com', 'fly-client-ip': `10.7.0.${++ip}` },
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
    await pushReminderSchedule(true);
    expect(statuses).toEqual([200]);
    expect(cancelByToken).toHaveBeenCalledWith('cap-token', null);
  });

  it('"Delete all my data" on Dropbox: 200 and the row is cancelled', async () => {
    getReminderOptIn.mockReturnValue(optIn('dropbox'));
    await expect(cancelRemindersForErase()).resolves.toBeUndefined();
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
