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

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const getReminderOptIn = vi.fn<() => FileReminderOptIn | undefined>(() => undefined);
const setReminderOptIn = vi.fn();
const flushRoadmapStore = vi.fn(async () => {});
const computeCurrentReminderSchedule = vi.fn(() => [
  { category: 'blood_test_lipids', group: 'blood_test', label: 'Lipid panel blood test', dueAt: '2027-05-12' },
]);
const trackProductEvent = vi.fn();
const isKnownMinorNow = vi.fn(() => false);
const getReminderIdToken = vi.fn<() => Promise<string | null>>(async () => 'signed-id-token');
const driveAccountEmail = vi.fn<() => string | null>(() => null);
const githubAccountEmail = vi.fn<() => Promise<string | null>>(async () => 'gh@example.com');

vi.mock('../src/lib/roadmap-data', () => ({
  getReminderOptIn: () => getReminderOptIn(),
  setReminderOptIn: (fields: unknown) => setReminderOptIn(fields),
  flushRoadmapStore: () => flushRoadmapStore(),
  computeCurrentReminderSchedule: () => computeCurrentReminderSchedule(),
  isKnownMinorNow: () => isKnownMinorNow(),
}));

vi.mock('../src/lib/server-api', () => ({ trackProductEvent: (...a: unknown[]) => trackProductEvent(...a) }));
const captureException = vi.fn();
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: (...a: unknown[]) => captureException(...a) } }));
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
  const f = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status: 200 }));
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
  isKnownMinorNow.mockReturnValue(false);
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

  it("Google without a fresh ID token falls back to the remembered address as provider 'typed' — never a popup token, never the verified lane", async () => {
    getReminderIdToken.mockResolvedValue(null);
    driveAccountEmail.mockReturnValue('user@example.com');
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('google-drive');

    expect(postedBody(f)).toMatchObject({ provider: 'typed', email: 'user@example.com' });
    expect(postedBody(f)).not.toHaveProperty('idToken');
  });

  it('a TRANSIENT Google refresh failure is not "no email": no block, retried next visit', async () => {
    getReminderIdToken.mockRejectedValue(new Error('refresh endpoint down'));
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('google-drive');
    await autoEnrolReminders('google-drive');

    expect(f).not.toHaveBeenCalled();
    expect(getReminderIdToken).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('hr_reminders_autoenrol_blocked')).toBeNull();
  });

  it('a fresh connect lifts the "no email" block so auto-enrolment asks again', async () => {
    githubAccountEmail.mockResolvedValue(null);
    const f = mockFetchOk();
    const { autoEnrolReminders, clearAutoEnrolBlock } = await loadReminders();

    await autoEnrolReminders('github');
    expect(localStorage.getItem('hr_reminders_autoenrol_blocked')).toBe('1');
    clearAutoEnrolBlock();
    githubAccountEmail.mockResolvedValue('gh@example.com');
    await autoEnrolReminders('github');

    expect(f).toHaveBeenCalledTimes(1);
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

    // A typed address is never dressed up as the cloud lane it was typed on.
    expect(postedBody(f)).toMatchObject({ provider: 'typed', email: 'typed@example.com' });
    expect(setReminderOptIn).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', email: 'typed@example.com', provider: 'github' }));
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
    expect(postedBody(f, 0)).toEqual({ op: 'cancel', token: 'cap-token', idToken: 'signed-id-token' });
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

  // Adversary R3 (2026-10-14): a refused cancel used to fall through to the
  // enrolment, which wrote the new token over the old one. The old row then
  // had no token anywhere and kept emailing the abandoned inbox for good.
  it.each([400, 429, 500, 503])('a cancel answered %i stops the switch: no enrolment, the old token kept, retried next visit', async (status) => {
    getReminderOptIn.mockReturnValue(ACTIVE); // active on google-drive
    const f = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', f);
    const { autoEnrolReminders } = await loadReminders();

    await expect(autoEnrolReminders('dropbox')).resolves.toBeUndefined();

    expect(f).toHaveBeenCalledTimes(1);
    expect(postedBody(f, 0).op).toBe('cancel');
    expect(setReminderOptIn).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();

    // Next visit, the server answers: the old row goes, then the new cloud enrols.
    const next = mockFetchOk();
    await autoEnrolReminders('dropbox');
    expect(postedBody(next, 0)).toEqual({ op: 'cancel', token: 'cap-token', idToken: 'signed-id-token' });
    expect(postedBody(next, 1)).toMatchObject({ op: 'optin', provider: 'dropbox' });
    expect(setReminderOptIn).toHaveBeenCalledWith({ status: 'active', token: 'new-cap-token', email: 'user@example.com', provider: 'dropbox' });
  });

  it('a cancel that never reaches the server stops the switch too', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', f);
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('dropbox');

    expect(f).toHaveBeenCalledTimes(1);
    expect(setReminderOptIn).not.toHaveBeenCalled();
    // The user's own network, not a refusal: nothing for Sentry.
    expect(captureException).not.toHaveBeenCalled();
  });

  // Adversary R2 (2026-10-14): a refused switch cancel is retried on every
  // visit, and console.warn was the only trace. The error names the status
  // code and nothing else: no address, no schedule, no age.
  it('a refused switch cancel goes to Sentry with the status code only', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Too many requests"}', { status: 429 })));
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('dropbox');

    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, context] = captureException.mock.calls[0];
    expect((err as Error).message).toBe('Old reminder row cancel failed (429).');
    expect(context).toEqual({ tags: { area: 'reminders', op: 'switch-cancel' } });
    expect(JSON.stringify([(err as Error).message, context])).not.toMatch(/@|example|lipid|blood/i);
  });

  // Adversary R1 (2026-10-14): the new address may already hold a row (a typed
  // capture, another device). The server refreshes it and returns no token, so
  // there is nothing to write. The file keeps the old opt-in and the next visit
  // tries again; no push may 404 the old token into a "cancelled" they never chose.
  it('a different-email switch answered "refreshed": no file write, no notice, and no push in the meantime', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE); // active on google-drive, user@example.com
    const f = mockFetchOk({ refreshed: true, email: 'dbx@example.com' });
    const { autoEnrolReminders, pushReminderSchedule } = await loadReminders();

    await autoEnrolReminders('dropbox');
    expect(postedBody(f, 0).op).toBe('cancel');
    expect(postedBody(f, 1)).toMatchObject({ op: 'optin', provider: 'dropbox', email: 'dbx@example.com' });
    expect(setReminderOptIn).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('hr_reminders_notice')).toBeNull();

    await pushReminderSchedule('dropbox');
    await pushReminderSchedule('dropbox', true);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

// US-17 AC12 (adversary R1, 2026-10-14): rows are keyed by email, so a switch
// to a cloud with the SAME address has nothing to move. The old token still
// owns that row. Cancelling it and opting the address in again got a
// `refreshed` reply with no token, so the file kept the old provider and every
// load cancelled and refreshed again, until the limiter's 429 left the row
// tombstoned and the next push's 404 wrote a "cancelled" nobody chose.
describe('US-17 AC12 — a switch to a cloud with the same email keeps the row', () => {
  it.each([
    ['dropbox', 'github', ' GH@Example.com'],
    ['google-drive', 'dropbox', 'dbx@example.com'],
  ] as const)('%s to %s: no cancel, no opt-in; the file takes the new provider and the next load does nothing', async (from, to, email) => {
    let file: FileReminderOptIn | undefined = { ...ACTIVE, provider: from, email };
    getReminderOptIn.mockImplementation(() => file);
    setReminderOptIn.mockImplementationOnce((fields: Omit<FileReminderOptIn, 'updatedAt' | 'lamport'>) => {
      file = { ...fields, updatedAt: '2026-10-14T00:00:00.000Z', lamport: 4 };
    });
    const f = mockFetchOk();
    const { autoEnrolReminders, pushReminderSchedule } = await loadReminders();

    await autoEnrolReminders(to);

    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).toHaveBeenCalledTimes(1);
    expect(setReminderOptIn).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', token: 'cap-token', email, provider: to }));
    expect(flushRoadmapStore).toHaveBeenCalledTimes(1);
    expect(trackProductEvent).not.toHaveBeenCalled();

    await autoEnrolReminders(to);
    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).toHaveBeenCalledTimes(1);

    // The old token keeps the row's schedule current from the new cloud.
    await pushReminderSchedule(to);
    expect(f).toHaveBeenCalledTimes(1);
    expect(postedBody(f)).toMatchObject({ op: 'update', token: 'cap-token' });
  });
});

// Codex R1/R2 on a9966d80 (2026-10-14). R2: Drive's identity carries an ID
// token, not an email, so a same-address switch TO Drive must compare against
// the account email the browser holds. R1: an erase (or any change) that lands
// while the identity lookup is pending must never be overwritten by the opt-in
// captured before it.
describe('US-17 AC12 — the same-address shortcut, to Drive and across an erase', () => {
  it('dropbox to google-drive with a fresh ID token and the same account email: no POST, the token is kept', async () => {
    getReminderIdToken.mockResolvedValue('signed-id-token');
    driveAccountEmail.mockReturnValue('DBX@example.com ');
    getReminderOptIn.mockReturnValue({ ...ACTIVE, provider: 'dropbox', email: 'dbx@example.com' });
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('google-drive');

    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).toHaveBeenCalledWith(expect.objectContaining({ token: 'cap-token', provider: 'google-drive' }));
  });

  it('an erase that lands while the identity lookup is pending is not overwritten', async () => {
    let file: FileReminderOptIn | undefined = { ...ACTIVE, provider: 'dropbox', email: 'gh@example.com' };
    getReminderOptIn.mockImplementation(() => file);
    let release!: (v: string | null) => void;
    githubAccountEmail.mockImplementation(() => new Promise((r) => { release = r; }));
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    const run = autoEnrolReminders('github');
    await Promise.resolve();
    // Delete all my data: the file's opt-in is now cancelled and blank.
    file = { status: 'cancelled', token: '', email: '', provider: 'dropbox', updatedAt: '2026-10-14T00:00:00.000Z', lamport: 9 };
    release('gh@example.com');
    await run;

    expect(setReminderOptIn).not.toHaveBeenCalled();
    expect(flushRoadmapStore).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});

// Orchestrator decision (2026-10-14): a switch to a cloud that gives no address
// yet keeps the old row. Cancelling it first left a tombstoned row while the
// control still read "on".
describe('US-17 AC12 — a switch to a cloud with no address keeps the old row', () => {
  it('dropbox to github with no GitHub email: no cancel, no opt-in, the file is untouched', async () => {
    githubAccountEmail.mockResolvedValue(null);
    getReminderOptIn.mockReturnValue({ ...ACTIVE, provider: 'dropbox', email: 'dbx@example.com' });
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();

    await autoEnrolReminders('github');

    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });
});

// Adversary R4 (2026-10-14): app load fires the push and the auto-enrolment
// together. A push carrying the old token could land after the switch's cancel
// had tombstoned the row and fill it again, or 404 into a "cancelled" the user
// never chose. While the file's opt-in belongs to another cloud, the switch
// owns the row and the push waits.
describe('US-17 AC12 — no schedule push while a cloud switch is pending', () => {
  it('an opt-in from another cloud is not pushed, on load or on tab hide', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE); // active on google-drive
    const f = mockFetchOk({ ok: true });
    const { pushReminderSchedule } = await loadReminders();

    await pushReminderSchedule('dropbox');
    await pushReminderSchedule('github', true);

    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });

  it.each(['local', 'self-host'] as const)('no switch can run on %s, so the push goes ahead as before', async (backend) => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ ok: true });
    const { pushReminderSchedule } = await loadReminders();

    await pushReminderSchedule(backend);

    expect(postedBody(f)).toMatchObject({ op: 'update', token: 'cap-token' });
  });

  it('the Pages build never switches, so the push goes ahead as before', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ ok: true });
    const { pushReminderSchedule } = await loadReminders(false);

    await pushReminderSchedule('dropbox');

    expect(postedBody(f)).toMatchObject({ op: 'update', token: 'cap-token' });
  });

  it('a known minor mid-switch is still turned off (auto-enrolment never runs for them)', async () => {
    isKnownMinorNow.mockReturnValue(true);
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ ok: true });
    const { pushReminderSchedule } = await loadReminders();

    await pushReminderSchedule('dropbox');

    expect(postedBody(f)).toMatchObject({ op: 'cancel', token: 'cap-token' });
  });
});

describe('US-17 AC1b — erasing your data reaches the server row too', () => {
  it('cancels the live reminder row using the token that is about to be wiped, with the Drive proof that makes it a delete', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ ok: true });
    const { cancelRemindersForErase } = await loadReminders();

    await cancelRemindersForErase();

    expect(postedBody(f)).toEqual({ op: 'cancel', token: 'cap-token', idToken: 'signed-id-token' });
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
  // US-17 AC1b (2026-10-14): `idToken: null` was a 400 at the route's zod
  // `.optional()`, so this cancel never reached the row. The key is left out.
  it('a Dropbox cancel carries no proof (no idToken key → the server tombstones)', async () => {
    getReminderOptIn.mockReturnValue({ ...ACTIVE, provider: 'dropbox' });
    const f = mockFetchOk({ ok: true });
    const { cancelReminders } = await loadReminders();

    await cancelReminders();

    expect(postedBody(f)).toEqual({ op: 'cancel', token: 'cap-token' });
  });

  it('fires reminder_optout after the server row is cancelled and the file flipped', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ ok: true });
    const { cancelReminders } = await loadReminders();

    await cancelReminders();

    expect(postedBody(f)).toEqual({ op: 'cancel', token: 'cap-token', idToken: 'signed-id-token' });
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

// US-07 AC6 (amended 2026-10-14): the plan is built for adults, and so are its
// reminders. The server holds no age, and it refills any pushed schedule with
// its annual check-in, so the browser is the only place a known minor can be
// kept out: no enrolment, no schedule push, and an existing row is turned off.
describe('US-07 AC6 — a known minor is never enrolled and their schedule is never pushed', () => {
  beforeEach(() => isKnownMinorNow.mockReturnValue(true));

  it('auto-enrolment does nothing at all for a known minor', async () => {
    const f = mockFetchOk();
    const { autoEnrolReminders } = await loadReminders();
    await autoEnrolReminders('google-drive');
    expect(f).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });

  it('the manual toggle refuses, in words, and posts nothing', async () => {
    const f = mockFetchOk();
    const { optInToReminders } = await loadReminders();
    await expect(optInToReminders('dropbox')).rejects.toThrow('Check-up reminders are for adults aged 18 and over.');
    expect(f).not.toHaveBeenCalled();
  });

  it('an enrolled minor: no schedule push; the row is turned off with the existing cancel', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ success: true });
    const { pushReminderSchedule } = await loadReminders();
    await pushReminderSchedule('google-drive');
    expect(f).toHaveBeenCalledTimes(1);
    expect(postedBody(f).op).toBe('cancel');
    expect(postedBody(f).token).toBe('cap-token');
    expect(setReminderOptIn).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  // Amended 2026-10-14: the cancel is the age gate's, not the user's opt-out,
  // so it never counts toward US-17's optout:optin kill criterion.
  it('the age gate\'s cancel is not counted as an opt-out', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    mockFetchOk({ success: true });
    const { pushReminderSchedule } = await loadReminders();
    await pushReminderSchedule('google-drive');
    expect(setReminderOptIn).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  // Codex R2 (2026-10-14): on tab hide the cancel must leave with keepalive,
  // and before any wait on the Drive ID token, or the row can stay active.
  it('the hidden-tab push sends the cancel with keepalive, not waiting on the identity proof', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    getReminderIdToken.mockReturnValue(new Promise(() => {})); // a proof that never arrives
    const f = mockFetchOk({ success: true });
    const { pushReminderSchedule } = await loadReminders();
    void pushReminderSchedule('google-drive', true);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(postedBody(f).op).toBe('cancel');
    expect(postedBody(f).token).toBe('cap-token');
    expect((f.mock.calls[0][1] as RequestInit).keepalive).toBe(true);
  });

  // Adversary R2 (2026-10-14): only a minor reaches this cancel, so a failure
  // reported to Sentry would put age data in telemetry. It retries next visit.
  it('a failed age-gate cancel sends nothing to Sentry, writes nothing, and does not throw', async () => {
    getReminderOptIn.mockReturnValue(ACTIVE);
    isKnownMinorNow.mockReturnValue(true);
    const f = mockFetchOk({ error: 'boom' });
    f.mockResolvedValue(new Response('{}', { status: 500 }));
    const { pushReminderSchedule } = await loadReminders();
    await expect(pushReminderSchedule('google-drive')).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
    expect(postedBody(f).op).toBe('cancel');
    expect(captureException).not.toHaveBeenCalled();
    expect(setReminderOptIn).not.toHaveBeenCalled();
  });

  it('an adult\'s failed push is still reported to Sentry', async () => {
    isKnownMinorNow.mockReturnValue(false);
    getReminderOptIn.mockReturnValue(ACTIVE);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { pushReminderSchedule } = await loadReminders();
    await pushReminderSchedule('google-drive');
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('an adult is unchanged: the schedule is pushed', async () => {
    isKnownMinorNow.mockReturnValue(false);
    getReminderOptIn.mockReturnValue(ACTIVE);
    const f = mockFetchOk({ success: true });
    const { pushReminderSchedule } = await loadReminders();
    await pushReminderSchedule('google-drive');
    expect(f).toHaveBeenCalledTimes(1);
    expect(postedBody(f).op).toBe('update');
  });
});
