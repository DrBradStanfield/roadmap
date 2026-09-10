/**
 * US-17 — default-on email reminders (Brad's 2026-08-11 decision: opt-OUT, not
 * opt-in). These tests pin what makes an opt-out model safe rather than merely
 * aggressive:
 *
 *  AC1  connecting a cloud enrols you with no user action at all;
 *  AC7  no storage credential ever leaves the browser: Google sends a signed
 *       ID token (it grants nothing), Dropbox and GitHub send the ADDRESS;
 *  AC8  an already-enrolled address gets no token back and writes nothing;
 *  AC1  enrolment is silent — a provider with no email to give must fail
 *       quietly, not throw, and the manual path asks for one instead;
 *  AC4  an opt-out already in the file is never overridden (the 2026-08-07
 *       incident was exactly this: an off switch that came back on);
 *  AC6  a user with no cloud (local / WebDAV) is never enrolled;
 *  AC1b erasing your data deletes the server row too — the token that
 *       authorises that delete dies with the file, so it must run first.
 *
 * Plus the kill-criterion instrumentation: an enrolment is counted by the
 * SERVER (never here), and an opt-out is counted only once the server
 * confirms it — otherwise the optout:optin ratio US-17 is judged on is a lie.
 *
 * The adapters are mocked: storage/drive-reminder-identity.test.ts pins that
 * the real Drive adapter opens no popup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FileReminderOptIn } from '@roadmap/health-core';

type FetchMock = ReturnType<typeof vi.fn<[input: RequestInfo | URL, init?: RequestInit], Promise<Response>>>;

const getReminderOptIn = vi.fn<[], FileReminderOptIn | undefined>(() => undefined);
const setReminderOptIn = vi.fn();
const flushRoadmapStore = vi.fn(async () => {});
const computeCurrentReminderSchedule = vi.fn(() => [
  { category: 'blood_test_lipids', group: 'blood_test', label: 'Lipid panel blood test', dueAt: '2027-05-12' },
]);
const trackProductEvent = vi.fn();
const getReminderIdToken = vi.fn<[], Promise<string | null>>(async () => 'signed-id-token');
const driveAccountEmail = vi.fn<[], string | null>(() => null);
const githubAccountEmail = vi.fn<[], Promise<string | null>>(async () => 'gh@example.com');

vi.mock('../src/lib/roadmap-data', () => ({
  getReminderOptIn: () => getReminderOptIn(),
  setReminderOptIn: (fields: unknown) => setReminderOptIn(fields),
  flushRoadmapStore: () => flushRoadmapStore(),
  computeCurrentReminderSchedule: () => computeCurrentReminderSchedule(),
}));

vi.mock('../src/lib/server-api', () => ({ trackProductEvent: (...a: unknown[]) => trackProductEvent(...a) }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('./dropbox-config', () => ({ dropboxConfig: () => ({}) }));

vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class {
    getReminderIdToken() { return getReminderIdToken(); }
    accountEmail() { return driveAccountEmail(); }
  },
  DropboxAdapter: class {
    async accountEmail() { return 'dbx@example.com'; }
  },
  GitHubAdapter: class {
    accountEmail() { return githubAccountEmail(); }
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

function mockFetchOk(body: unknown = { token: 'new-cap-token', email: 'user@example.com' }): FetchMock {
  const f = vi.fn<[input: RequestInfo | URL, init?: RequestInit], Promise<Response>>(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', f);
  return f;
}

/** Parsed POST body of the nth fetch call (the protocol is text/plain JSON). */
function postedBody(f: FetchMock, n = 0): Record<string, unknown> {
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
  getReminderIdToken.mockResolvedValue('signed-id-token');
  driveAccountEmail.mockReturnValue(null);
  githubAccountEmail.mockResolvedValue('gh@example.com');
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/lib/build-flags');
});

describe('US-17 AC1/AC7 — a cloud connect enrols you, with no user action and no credential', () => {
  it('Google posts the signed ID token (grants nothing) and the client-computed schedule', async () => {
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();
    await autoEnrolReminders('google-drive');

    expect(f).toHaveBeenCalledTimes(1);
    const body = postedBody(f);
    expect(body.op).toBe('optin');
    expect(body.provider).toBe('google-drive');
    expect(body.idToken).toBe('signed-id-token');
    expect(body.schedule).toHaveLength(1);
    expect(body).not.toHaveProperty('accessToken');
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

  it('never counts the enrolment here — the server counts it when the row lands', async () => {
    mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();
    await autoEnrolReminders('google-drive');
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('Dropbox and GitHub post the ADDRESS the browser read — never a token, never a PAT', async () => {
    const f = mockFetchOk({ token: 'new-cap-token', email: 'dbx@example.com' });
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('dropbox');
    expect(postedBody(f)).toMatchObject({ op: 'optin', provider: 'dropbox', email: 'dbx@example.com' });
    expect(JSON.stringify(postedBody(f))).not.toMatch(/accessToken|token/);

    getReminderOptIn.mockReturnValue(undefined);
    const g = mockFetchOk({ token: 'new-cap-token', email: 'gh@example.com' });
    await autoEnrolReminders('github');
    expect(postedBody(g)).toMatchObject({ provider: 'github', email: 'gh@example.com' });
    expect(JSON.stringify(postedBody(g))).not.toMatch(/accessToken|token/);
  });

  it('Google without a fresh ID token falls back to the remembered address, not a popup token', async () => {
    getReminderIdToken.mockResolvedValue(null);
    driveAccountEmail.mockReturnValue('user@example.com');
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('google-drive');

    expect(postedBody(f)).toMatchObject({ provider: 'google-drive', email: 'user@example.com' });
    expect(postedBody(f)).not.toHaveProperty('idToken');
  });
});

describe('US-17 AC8 — an already-enrolled address gets no token and writes nothing', () => {
  it('auto-enrol: the server refreshed the schedule; no file write, no notice, retried next visit', async () => {
    const f = mockFetchOk({ refreshed: true, email: 'dbx@example.com' });
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('dropbox');
    await autoEnrolReminders('dropbox');

    expect(f).toHaveBeenCalledTimes(2);
    expect(setReminderOptIn).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('hr_reminders_notice')).toBeNull();
  });

  it('manual: reports refreshed so the control can say so instead of showing "on" without a token', async () => {
    mockFetchOk({ refreshed: true, email: 'dbx@example.com' });
    const { optInToReminders } = await loadReminders();

    await expect(optInToReminders('dropbox')).resolves.toEqual({ email: 'dbx@example.com', refreshed: true });
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });
});

describe('US-17 AC1 — auto-enrolment is silent: no error, no retry storm; the manual path asks for an address', () => {
  it('does nothing at all when the provider has no email to give — and stops asking (the answer will not change)', async () => {
    githubAccountEmail.mockResolvedValue(null);
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await expect(autoEnrolReminders('github')).resolves.toBeUndefined();
    await autoEnrolReminders('github');

    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
    expect(githubAccountEmail).toHaveBeenCalledTimes(1); // blocked after the first null
  });

  it('a TRANSIENT provider failure is not a block — retried next visit', async () => {
    githubAccountEmail.mockRejectedValue(new Error('network'));
    mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('github');
    await autoEnrolReminders('github');

    expect(githubAccountEmail).toHaveBeenCalledTimes(2);
  });

  it('manual path with no provider email throws ReminderEmailNeeded (the control shows a typed field, never enrols silently)', async () => {
    githubAccountEmail.mockResolvedValue(null);
    const f = mockFetchOk();
    const { optInToReminders, ReminderEmailNeeded } = await loadReminders();

    await expect(optInToReminders('github')).rejects.toBeInstanceOf(ReminderEmailNeeded);
    expect(f).not.toHaveBeenCalled();
  });

  it('manual path with a typed address posts that address', async () => {
    githubAccountEmail.mockResolvedValue(null);
    const f = mockFetchOk({ token: 'new-cap-token', email: 'typed@example.com' });
    const { optInToReminders } = await loadReminders();

    await optInToReminders('github', { email: 'typed@example.com' });

    expect(postedBody(f)).toMatchObject({ provider: 'github', email: 'typed@example.com' });
    expect(setReminderOptIn).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', email: 'typed@example.com' }));
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

  it('AC6: a device-only or WebDAV user is never enrolled (no account email exists)', async () => {
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
