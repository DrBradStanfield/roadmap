// @vitest-environment jsdom
/**
 * US-17 AC19 and US-11 AC15 (untangle R9, part 2): the web writers and the
 * erase read and write the opt-in one row per token. The real data layer and
 * store run over an in-memory cloud; the reminders server and the providers'
 * address lookups are stubbed. Fake, low-entropy tokens and addresses only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { rowsOf, shownOptIn } from '@roadmap/health-core/reminder-rows';
import { createEmptyFile, type FileReminderOptIn, type ReminderTokenRow, type RoadmapFile } from '@roadmap/health-core/roadmap-file';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../src/lib/build-flags', () => ({ SHOPIFY_SURFACE: true, LOCAL_FIRST: true }));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('./dropbox-config', () => ({ dropboxConfig: () => ({}) }));

const A = 'test-token-a';
const B = 'test-token-b';
const C = 'test-token-c';
const T = (n: number) => `2026-11-0${n}T00:00:00.000Z`;
const row = (token: string, status: 'active' | 'cancelled', n: number, extra: Partial<ReminderTokenRow> = {}): ReminderTokenRow =>
  ({ status, token, email: `${token}@example.test`, provider: 'dropbox', updatedAt: T(n), lamport: n, ...extra });
const nest = (top: ReminderTokenRow, ...tokens: ReminderTokenRow[]): FileReminderOptIn => (tokens.length ? { ...top, tokens } : top);
const statusOf = (optIn: FileReminderOptIn | undefined) => Object.fromEntries(rowsOf(optIn).map((r) => [r.token, r.status]));

type Posted = { op: string; token?: string; idToken?: string };

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('health_roadmap_backend', 'memory');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function setUp(optIn?: FileReminderOptIn) {
  const data = await import('../src/lib/roadmap-data');
  const reminders = await import('./reminders');
  const { RoadmapStore } = await import('../src/storage/roadmap-store');
  const storage = await import('../src/storage');
  let page!: import('../src/storage/roadmap-store').RoadmapStore;
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(function (this: import('../src/storage/roadmap-store').RoadmapStore) {
    page = this;
    return () => {};
  });
  const edits = vi.spyOn(RoadmapStore.prototype, 'setReminderRows');
  const cloud = new MemoryCloud();
  const seed = createEmptyFile({ deviceId: 'dev_seed', now: T(1) });
  if (optIn) {
    seed.reminderOptIn = optIn;
    seed.schemaVersion = optIn.tokens ? 2 : seed.schemaVersion;
  }
  cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(seed), version: 1 });
  await data.initRoadmapStore(new MemoryAdapter(cloud));
  data.setPreEraseHook(reminders.cancelRemindersForErase); // as standalone/app.tsx registers it
  /** Writes the stored record's opt-in straight into the cloud copy, as another device's save would. */
  const cloudWrites = (next: FileReminderOptIn | undefined, change: (f: RoadmapFile) => void = () => {}) => {
    const entry = cloud.files.get(ROADMAP_FILE_NAME)!;
    const file = JSON.parse(entry.json) as RoadmapFile;
    file.reminderOptIn = next;
    change(file);
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: entry.version + 1 });
  };
  edits.mockClear();
  const posts: Posted[] = [];
  const answer = { of: (_body: Posted): Response => new Response('{}', { status: 200 }) };
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posts.push(body);
    return answer.of(body);
  }));
  const cancels = () => posts.filter((p) => p.op === 'cancel').map((p) => p.token);
  vi.spyOn(storage.DropboxAdapter.prototype, 'accountEmail').mockResolvedValue('new-address@example.test');
  const proof = vi.spyOn(storage.GoogleDriveAdapter.prototype, 'getReminderIdToken').mockResolvedValue(null);
  return { data, reminders, page: () => page, cloud, cloudWrites, edits, posts, answer, cancels, proof };
}

describe('US-17 AC19: the auto-enrol gate reads the stored object (AC4)', () => {
  it.each([['the same provider', 'dropbox'], ['a different provider', 'github']] as const)(
    'a stale active row under a newest cancelled row, %s: no enrolment, no switch cancel',
    async (_case, provider) => {
      const t = await setUp(nest(row(A, 'cancelled', 3), row(B, 'active', 1, { provider })));
      expect(shownOptIn({ reminderOptIn: t.data.getReminderOptIn() })?.token).toBe(B);
      await t.reminders.autoEnrolReminders('dropbox');
      expect(t.posts).toEqual([]);
      expect(t.edits).not.toHaveBeenCalled();
    },
  );
});

describe('US-17 AC19: the writers keep every row', () => {
  it('Turn on writes one active row and keeps the others', async () => {
    const t = await setUp(nest(row(A, 'cancelled', 2), row(C, 'cancelled', 1)));
    t.answer.of = () => new Response(JSON.stringify({ token: B, email: 'new-address@example.test' }), { status: 200 });
    await t.reminders.optInToReminders('dropbox');
    expect(statusOf(t.data.getReminderOptIn())).toEqual({ [A]: 'cancelled', [B]: 'active', [C]: 'cancelled' });
    expect(t.edits).toHaveBeenCalledTimes(1);
  });

  it('a switch writes the old token cancelled and the new one active in one edit; cancelling the new one shows off', async () => {
    const t = await setUp(row(A, 'active', 1, { provider: 'google-drive' }));
    t.answer.of = (body) => new Response(JSON.stringify(body.op === 'optin' ? { token: B, email: 'new-address@example.test' } : {}), { status: 200 });
    await t.reminders.autoEnrolReminders('dropbox');
    expect(t.cancels()).toEqual([A]);
    expect(t.edits).toHaveBeenCalledTimes(1);
    expect(t.edits.mock.calls[0][0].map((r) => [r.token, r.status])).toEqual([[A, 'cancelled'], [B, 'active']]);
    const after = t.data.getReminderOptIn();
    expect(statusOf(after)).toEqual({ [A]: 'cancelled', [B]: 'active' });
    expect(rowsOf(after).find((r) => r.token === A)?.email).toBe(`${A}@example.test`); // a cancelled row keeps its address

    t.posts.length = 0;
    await t.reminders.cancelReminders();
    expect(shownOptIn({ reminderOptIn: t.data.getReminderOptIn() })?.status).toBe('cancelled');
    expect(statusOf(t.data.getReminderOptIn())).toEqual({ [A]: 'cancelled', [B]: 'cancelled' });
    expect(t.cancels()).toEqual([B, A]);
  });

  it('a 404 on the pushed token writes a cancelled row for that token only', async () => {
    const t = await setUp(nest(row(A, 'active', 2), row(B, 'active', 1)));
    t.answer.of = (body) => new Response('{}', { status: body.op === 'update' ? 404 : 200 });
    await t.reminders.pushReminderSchedule('dropbox');
    expect(t.posts.map((p) => [p.op, p.token])).toEqual([['update', A]]);
    expect(statusOf(t.data.getReminderOptIn())).toEqual({ [A]: 'cancelled', [B]: 'active' });
    expect(shownOptIn({ reminderOptIn: t.data.getReminderOptIn() })?.token).toBe(B);
  });

  it('case 3, two devices: the merged record shows B on, and one Turn off cancels B and A in one edit', async () => {
    const t = await setUp(nest(row(A, 'cancelled', 2), row(B, 'active', 1)));
    await t.reminders.cancelReminders();
    expect(t.cancels()).toEqual([B, A]);
    expect(t.edits).toHaveBeenCalledTimes(1);
    expect(statusOf(t.data.getReminderOptIn())).toEqual({ [A]: 'cancelled', [B]: 'cancelled' });
    const stored = JSON.parse(t.cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(statusOf(stored.reminderOptIn)).toEqual({ [A]: 'cancelled', [B]: 'cancelled' });
  });
});

describe('US-11 AC15: an erase cancels every active row of every copy it reads', () => {
  it('own active B with a cloud cancelled A: the erase cancels B', async () => {
    const t = await setUp(row(B, 'active', 1));
    t.cloudWrites(row(A, 'cancelled', 3)); // another device, not yet read here
    expect((await t.data.deleteUserData()).success).toBe(true);
    expect(t.cancels()).toEqual([B]);
  });

  it('a nested active token present only in the cloud copy is cancelled', async () => {
    const t = await setUp(row(A, 'cancelled', 2));
    t.cloudWrites(nest(row(A, 'cancelled', 2), row(C, 'active', 1)));
    expect((await t.data.deleteUserData()).success).toBe(true);
    expect(t.cancels()).toEqual([C]);
  });

  it('a nested-only change taken in during the proof wait, which announces nothing, is cancelled', async () => {
    const t = await setUp(row(A, 'active', 2, { provider: 'google-drive' }));
    const announced: unknown[] = [];
    window.addEventListener('hr:remote-changed', (e) => announced.push((e as CustomEvent).detail));
    t.proof.mockImplementation(async () => {
      // The same address, an older token: nothing the control shows changes.
      t.cloudWrites(nest(row(A, 'active', 2, { provider: 'google-drive' }), row(C, 'active', 1, { email: `${A}@example.test` })));
      expect(await t.page().refreshFromRemote()).toBe(true);
      return 'test-proof-good';
    });
    expect((await t.data.deleteUserData()).success).toBe(true);
    expect(announced).toEqual([]);
    expect(t.posts.filter((p) => p.op === 'cancel')).toEqual([{ op: 'cancel', token: A, idToken: 'test-proof-good' }, { op: 'cancel', token: C }]);
  });

  it('a token re-enrolled at the new epoch, matching one this erase queued, survives beneath the marker and is not cancelled', async () => {
    const t = await setUp(row(B, 'active', 1, { provider: 'google-drive' }));
    t.proof.mockImplementation(async () => {
      // Another device erases to the same epoch, then turns token B on again.
      const { RoadmapStore } = await import('../src/storage/roadmap-store');
      const other = await RoadmapStore.create(new MemoryAdapter(t.cloud));
      expect((await other.deleteAllData()).success).toBe(true);
      expect(other.setReminderRows([{ status: 'active', token: B, email: `${B}@example.test`, provider: 'dropbox' }], other.eraseIdentity)).toBe(true);
      await other.flush();
      return null;
    });
    expect((await t.data.deleteUserData()).success).toBe(true);
    const standing = t.data.getReminderOptIn();
    expect(standing?.token).toBe(''); // the marker is the stored object
    expect(statusOf(standing)).toEqual({ [B]: 'active' });
    expect(t.cancels()).toEqual([]);
  });
});
