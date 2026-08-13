/**
 * US-17 — default-on email reminders (Brad's 2026-08-11 decision: opt-OUT, not
 * opt-in). These tests pin what makes an opt-out model safe rather than merely
 * aggressive:
 *
 *  AC1  connecting a cloud enrols you with no user action at all;
 *  AC1  enrolment is SILENT-PROOF only — it may never open a popup, and a
 *       provider that can't vouch must fail quietly, not throw;
 *  AC4  an opt-out already in the file is never overridden (the 2026-08-07
 *       incident was exactly this: an off switch that came back on);
 *  AC6  a user with no cloud (local / WebDAV) is never enrolled;
 *  AC1b erasing your data deletes the server row too — the token that
 *       authorises that delete dies with the file, so it must run first.
 *
 * Plus the kill-criterion instrumentation: an enrolment is counted only once
 * it is DURABLE, and an opt-out is counted only once the server confirms it —
 * otherwise the optout:optin ratio US-17 is judged on is a lie.
 *
 * The Google popup fallback itself is pinned in storage/drive.test.ts: these
 * tests mock the adapter, so they prove `proofFor` ASKS for a silent proof,
 * not that the adapter honours it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FileReminderOptIn } from '@roadmap/health-core';

const getReminderOptIn = vi.fn<() => FileReminderOptIn | undefined>(() => undefined);
const setReminderOptIn = vi.fn();
const flushRoadmapStore = vi.fn(async () => {});
const computeCurrentReminderSchedule = vi.fn(() => [
  { category: 'blood_test_lipids', group: 'blood_test', label: 'Lipid panel blood test', dueAt: '2027-05-12' },
]);
const trackProductEvent = vi.fn();
const getReminderProof = vi.fn<(silent?: boolean) => Promise<unknown>>(async () => ({ idToken: 'signed-id-token' }));

vi.mock('../src/lib/roadmap-data', () => ({
  getReminderOptIn: () => getReminderOptIn(),
  setReminderOptIn: (fields: unknown) => setReminderOptIn(fields),
  flushRoadmapStore: () => flushRoadmapStore(),
  computeCurrentReminderSchedule: () => computeCurrentReminderSchedule(),
}));

vi.mock('../src/lib/api', () => ({ trackProductEvent: (...a: unknown[]) => trackProductEvent(...a) }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('./dropbox-config', () => ({ dropboxConfig: () => ({}) }));

vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class {
    getReminderProof(silent?: boolean) { return getReminderProof(silent); }
  },
  DropboxAdapter: class {
    async getReminderProofToken() { return 'dropbox-access-token'; }
  },
  GitHubAdapter: class {
    getReminderProofToken() { return 'github-pat'; }
  },
}));

const ACTIVE: FileReminderOptIn = {
  status: 'active', token: 'cap-token', email: 'user@example.com',
  provider: 'google-drive', updatedAt: '2026-08-01T00:00:00.000Z', lamport: 3,
};

/** Minimal Storage stand-in — the enrolment guards use both web storages. */
function makeStorage(): Storage {
  const s = new Map<string, string>();
  return {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
    clear: () => s.clear(),
    key: (i: number) => [...s.keys()][i] ?? null,
    get length() { return s.size; },
  } as unknown as Storage;
}

function stubBrowser(): void {
  vi.stubGlobal('localStorage', makeStorage());
  vi.stubGlobal('sessionStorage', makeStorage());
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
}

function mockFetchOk(body: unknown = { token: 'new-cap-token', email: 'user@example.com' }): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', f);
  return f;
}

/** Parsed POST body of the nth fetch call (the protocol is text/plain JSON). */
function postedBody(f: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  return JSON.parse((f.mock.calls[n][1] as RequestInit).body as string);
}

/** Import under a chosen build surface — the Shopify gate is module-level. */
async function loadReminders(shopifySurface = true) {
  vi.resetModules();
  vi.doMock('../src/lib/build-flags', () => ({ SHOPIFY_SURFACE: shopifySurface, LOCAL_FIRST: true }));
  return import('./reminders');
}

beforeEach(() => {
  vi.clearAllMocks();
  getReminderOptIn.mockReturnValue(undefined);
  getReminderProof.mockResolvedValue({ idToken: 'signed-id-token' });
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/lib/build-flags');
});

describe('US-17 AC1 — a cloud connect enrols you, with no user action', () => {
  it('posts an optin with the provider proof and the client-computed schedule', async () => {
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();
    await autoEnrolReminders('google-drive');

    expect(f).toHaveBeenCalledTimes(1);
    const body = postedBody(f);
    expect(body.op).toBe('optin');
    expect(body.provider).toBe('google-drive');
    expect(body.idToken).toBe('signed-id-token');
    expect(body.schedule).toHaveLength(1);
  });

  it('saves the returned capability token as active and flushes it to the cloud file', async () => {
    mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();
    await autoEnrolReminders('google-drive');

    expect(setReminderOptIn).toHaveBeenCalledWith({
      status: 'active', token: 'new-cap-token', email: 'user@example.com', provider: 'google-drive',
    });
    expect(flushRoadmapStore).toHaveBeenCalledTimes(1);
  });

  it('counts the enrolment only once it is DURABLE — after the flush, never before', async () => {
    flushRoadmapStore.mockRejectedValueOnce(new Error('Drive conflict'));
    mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('google-drive');

    // No file record was written, so the next visit will enrol this same person
    // again. Counting the first attempt would inflate the kill-criterion base.
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('counts a successful enrolment (reminder_optin) so the opt-out ratio has a denominator', async () => {
    mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();
    await autoEnrolReminders('google-drive');
    expect(trackProductEvent).toHaveBeenCalledWith('reminder_optin', { provider: 'google-drive' });
  });

  it('enrols Dropbox and GitHub on their stored credentials — no re-auth', async () => {
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('dropbox');
    expect(postedBody(f).accessToken).toBe('dropbox-access-token');

    getReminderOptIn.mockReturnValue(undefined);
    const g = mockFetchOk();
    await autoEnrolReminders('github');
    expect(postedBody(g).accessToken).toBe('github-pat');
  });
});

describe('US-17 AC1 — auto-enrolment is silent: no popup, no error, no retry storm', () => {
  it('asks Google for a SILENT proof (a popup at page load is blocked and unasked-for)', async () => {
    mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();
    await autoEnrolReminders('google-drive');
    expect(getReminderProof).toHaveBeenCalledWith(true);
  });

  it('does nothing at all when the provider cannot vouch silently — retried next visit', async () => {
    getReminderProof.mockResolvedValue(null);
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await expect(autoEnrolReminders('google-drive')).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });

  it('swallows a failing server — an enrolment nobody asked for cannot raise an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { autoEnrolReminders } = await loadReminders();

    await expect(autoEnrolReminders('google-drive')).resolves.toBeUndefined();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });

  it('retries a TRANSIENT failure on the next visit (500 must not be permanent)', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', f);
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('github');
    await autoEnrolReminders('github');

    expect(f).toHaveBeenCalledTimes(2);
  });

  it('stops re-posting the credential once the provider REFUSES to vouch (401)', async () => {
    // A GitHub PAT without the email permission fails identically forever, and
    // that PAT holds write access to the repo the health data lives in.
    const f = vi.fn(async () => new Response(JSON.stringify({ reason: 'github-email-permission' }), { status: 401 }));
    vi.stubGlobal('fetch', f);
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('github');
    await autoEnrolReminders('github');
    await autoEnrolReminders('github');

    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('US-17 AC4/AC6 — enrolment never overrides a decision, and never happens without a cloud', () => {
  it('AC4: a cancelled opt-in in the file is NEVER re-enrolled (the off switch has to stick)', async () => {
    getReminderOptIn.mockReturnValue({ ...ACTIVE, status: 'cancelled' });
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('google-drive');

    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });

  it('does not re-enrol (or re-mint a token) when already active on this provider', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('google-drive');

    expect(f).not.toHaveBeenCalled();
  });

  it('AC6: a device-only or WebDAV user is never enrolled (no provider-verified email exists)', async () => {
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('local');
    await autoEnrolReminders('self-host');

    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });

  it('the Pages / self-host build never auto-enrols — that surface has no Brad server', async () => {
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders(false);

    await autoEnrolReminders('google-drive');

    expect(f).not.toHaveBeenCalled();
  });
});

describe('US-17 — switching clouds moves the reminders, it does not duplicate them', () => {
  it('drops the row at the abandoned account before enrolling the new one', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE); // active on google-drive
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('dropbox');

    // Rows are keyed by EMAIL server-side, so the new opt-in cannot replace the
    // old one — without this cancel the user gets reminders at both addresses.
    expect(postedBody(f, 0)).toEqual({ op: 'cancel', token: 'cap-token' });
    expect(postedBody(f, 1).op).toBe('optin');
    expect(postedBody(f, 1).provider).toBe('dropbox');
  });

  it('does not count the switch as an opt-out (it would poison the kill criterion)', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('dropbox');

    expect(trackProductEvent).not.toHaveBeenCalledWith('reminder_optout');
  });
});

describe('US-17 AC1b — erasing your data deletes the server row too', () => {
  it('cancels the live reminder row using the token that is about to be wiped', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ ok: true });
    const { cancelRemindersForErase } = await loadReminders();

    await cancelRemindersForErase();

    expect(postedBody(f)).toEqual({ op: 'cancel', token: 'cap-token' });
  });

  it('is not counted as an opt-out — they erased everything, they did not judge reminders', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    mockFetchOk({ ok: true });
    const { cancelRemindersForErase } = await loadReminders();

    await cancelRemindersForErase();

    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('reports a failed delete rather than swallowing it (an orphaned row still emails)', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { cancelRemindersForErase } = await loadReminders();

    await expect(cancelRemindersForErase()).rejects.toThrow();
  });

  it('no-ops when there is nothing enrolled', async () => {
    getReminderOptIn.mockReturnValue(undefined);
    const f = mockFetchOk();
    const { cancelRemindersForErase } = await loadReminders();

    await cancelRemindersForErase();

    expect(f).not.toHaveBeenCalled();
  });
});

describe('US-17 — turning reminders off is counted', () => {
  it('fires reminder_optout after the server row is deleted and the file flipped', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ ok: true });
    const { cancelReminders } = await loadReminders();

    await cancelReminders();

    expect(postedBody(f)).toEqual({ op: 'cancel', token: 'cap-token' });
    expect(setReminderOptIn).toHaveBeenCalledWith({ ...ACTIVE, status: 'cancelled' });
    // Tagged with the lane (US-23: typed and cloud ratios are judged apart).
    expect(trackProductEvent).toHaveBeenCalledWith('reminder_optout', { provider: 'google-drive' });
  });

  it('does NOT count an opt-out the server refused — the ratio must stay honest', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { cancelReminders } = await loadReminders();

    await expect(cancelReminders()).rejects.toThrow();
    expect(trackProductEvent).not.toHaveBeenCalled();
  });
});
