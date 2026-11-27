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
  const answer = { of: (_body: Posted): Response | Promise<Response> => new Response('{}', { status: 200 }) };
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

  it('a token cancelled in the working copy and active in the device copy is cancelled exactly once (review E1)', async () => {
    const t = await setUp(row(A, 'cancelled', 2));
    const device = createEmptyFile({ deviceId: 'dev_tab', now: T(1) });
    device.reminderOptIn = row(A, 'active', 1);
    localStorage.setItem('health_roadmap_file_v2', JSON.stringify(device));
    expect((await t.data.deleteUserData()).success).toBe(true);
    expect(t.cancels()).toEqual([A]);
  });

  it.each([['carrying its own erase marker', true], ['holding no opt-in at all (review R2)', false]] as const)('a merge taken in while the erase first reads, %s, which drops this copy\'s active token, still leaves it cancelled and reminders off (review E2)', async (_case, marker) => {
    const t = await setUp(row(A, 'active', 1));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held = false;
    const read = MemoryAdapter.prototype.read;
    vi.spyOn(MemoryAdapter.prototype, 'read').mockImplementationOnce(async function (this: MemoryAdapter, ...args) {
      held = true;
      await gate;
      return read.apply(this, args);
    });
    const erasing = t.data.deleteUserData();
    await vi.waitFor(() => expect(held).toBe(true));
    // Another device erased meanwhile; this page takes it in while the erase's read is held.
    t.cloudWrites(marker ? row('', 'cancelled', 5, { email: '' }) : undefined, (f) => { f.meta.eraseEpoch = 1; f.meta.erasedAt = T(5); f.schemaVersion = 2; f.erasedRows = { fromEpoch: 1, ids: [] }; });
    expect(await t.page().refreshFromRemote()).toBe(true);
    expect(rowsOf(t.data.getReminderOptIn())).toEqual([]);
    release();
    expect((await erasing).success).toBe(true);
    expect(t.cancels()).toEqual([A]);
    // The erased record says reminders are off, so the next load enrols nobody (US-11 AC4).
    const stored = JSON.parse(t.cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(stored.reminderOptIn).toMatchObject({ status: 'cancelled', token: '', email: '' });
    t.posts.length = 0;
    await t.reminders.autoEnrolReminders('dropbox');
    expect(t.posts).toEqual([]);
  });

  it('a token another device re-enrols between the erase write and its check read gets no cancel (review E3)', async () => {
    const t = await setUp(row(A, 'active', 1));
    const write = MemoryAdapter.prototype.write;
    let erasedWritten = false;
    vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(async function (this: MemoryAdapter, ...args) {
      const out = await write.apply(this, args);
      if ((args[1] as RoadmapFile).meta.eraseEpoch === 1) erasedWritten = true;
      return out;
    });
    const read = MemoryAdapter.prototype.read;
    vi.spyOn(MemoryAdapter.prototype, 'read').mockImplementation(async function (this: MemoryAdapter, ...args) {
      if (erasedWritten) {
        erasedWritten = false;
        // Another device, at the new epoch, turns token A on again before this page reads back its write.
        const now = JSON.parse(t.cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
        t.cloudWrites(nest(row(A, 'active', 1, { updatedAt: '2026-12-01T00:00:00.000Z', lamport: 9 }), now.reminderOptIn as ReminderTokenRow));
      }
      return read.apply(this, args);
    });
    expect((await t.data.deleteUserData()).success).toBe(true);
    const stored = JSON.parse(t.cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;
    expect(statusOf(stored.reminderOptIn)).toEqual({ [A]: 'active' });
    // The check read reaches only the teardown's choice of what stands (review R1).
    expect(statusOf(t.data.getReminderOptIn())).toEqual({});
    expect(t.cancels()).toEqual([]);
  });

  it('every cancel leaves before any answer, so a tab closed after the first still sent the rest (review R3)', async () => {
    const t = await setUp(nest(row(A, 'active', 2), row(B, 'active', 1)));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    t.answer.of = async (body) => {
      if (body.op === 'cancel' && body.token === A) await held; // the first answer never comes before the page closes
      return new Response('{}', { status: 200 });
    };
    const erasing = t.data.deleteUserData();
    await vi.waitFor(() => expect(t.cancels().sort()).toEqual([A, B]));
    release();
    expect((await erasing).success).toBe(true);
  });

  it('a refused cloud write held in the device copy spares a token another tab re-enrolled there (review R5)', async () => {
    const t = await setUp(row(A, 'active', 1, { provider: 'google-drive' }));
    const { StorageError } = await import('@roadmap/health-core/adapter');
    const write = MemoryAdapter.prototype.write;
    vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(async function (this: MemoryAdapter, ...args) {
      if ((args[1] as RoadmapFile).meta.eraseEpoch === 1) throw new StorageError('Dropbox write failed (403)', undefined, undefined, 403, undefined, 'refused');
      return write.apply(this, args);
    });
    t.proof.mockImplementation(async () => {
      // Another tab, after this erase read the device copy: its own erase to the same epoch, then token A on again.
      const tab = createEmptyFile({ deviceId: 'dev_tab', now: T(5) });
      Object.assign(tab, { schemaVersion: 2, erasedRows: { fromEpoch: 1, ids: [] } });
      tab.meta.eraseEpoch = 1;
      tab.meta.erasedAt = T(5);
      tab.reminderOptIn = row(A, 'active', 1, { provider: 'google-drive', updatedAt: '2026-12-01T00:00:00.000Z', lamport: 9 });
      localStorage.setItem('health_roadmap_file_v2', JSON.stringify(tab));
      return null;
    });
    const before = t.data.getEraseIdentity();
    await t.data.deleteUserData();
    expect(t.data.getEraseIdentity()).not.toBe(before); // held in this browser for a retry
    const device = JSON.parse(localStorage.getItem('health_roadmap_file_v2')!) as RoadmapFile;
    expect(statusOf(device.reminderOptIn)).toEqual({ [A]: 'active' });
    expect(t.cancels()).toEqual([]);
  });

  it('a refused cloud write whose device writes also fail, with a readable device copy at the erase, spares the token re-enrolled there (review R2)', async () => {
    const t = await setUp(row(A, 'active', 1, { provider: 'google-drive' }));
    const { StorageError } = await import('@roadmap/health-core/adapter');
    const { LocalStorageAdapter } = await import('../src/storage/local-storage-adapter');
    const refuse = () => { throw new StorageError('write failed (403)', undefined, undefined, 403, undefined, 'refused'); };
    const write = MemoryAdapter.prototype.write;
    vi.spyOn(MemoryAdapter.prototype, 'write').mockImplementation(async function (this: MemoryAdapter, ...args) {
      if ((args[1] as RoadmapFile).meta.eraseEpoch === 1) refuse();
      return write.apply(this, args);
    });
    vi.spyOn(LocalStorageAdapter.prototype, 'write').mockImplementation(async () => refuse());
    t.proof.mockImplementation(async () => {
      // Another tab, after this erase read the device copy: its own erase to the same epoch, then token A on again.
      const tab = createEmptyFile({ deviceId: 'dev_tab', now: T(5) });
      Object.assign(tab, { schemaVersion: 2, erasedRows: { fromEpoch: 1, ids: [] } });
      tab.meta.eraseEpoch = 1;
      tab.meta.erasedAt = T(5);
      tab.reminderOptIn = row(A, 'active', 1, { provider: 'google-drive', updatedAt: '2026-12-01T00:00:00.000Z', lamport: 9 });
      localStorage.setItem('health_roadmap_file_v2', JSON.stringify(tab));
      return null;
    });
    const before = t.data.getEraseIdentity();
    await t.data.deleteUserData();
    expect(t.data.getEraseIdentity()).not.toBe(before); // held: the device copy carries the erase
    expect(t.cancels()).toEqual([]);
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

  // The clock is pinned, so which of the two is newer never rests on a millisecond (review T2).
  it.each([
    ['beneath the marker (our erase is newer)', 1_000, ''],
    ['above the marker (the re-enrolment is newer)', 9_000, B],
  ] as const)('a token re-enrolled at the new epoch, matching one this erase queued, survives %s and is not cancelled', async (_case, otherAt, top) => {
    const base = Date.parse('2026-11-27T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(base);
    try {
      const t = await setUp(row(B, 'active', 1, { provider: 'google-drive' }));
      t.proof.mockImplementation(async () => {
        // Another device, its clock at `otherAt`, erases to the same epoch, then turns token B on again.
        vi.setSystemTime(base + otherAt);
        const { RoadmapStore } = await import('../src/storage/roadmap-store');
        const other = await RoadmapStore.create(new MemoryAdapter(t.cloud));
        expect((await other.deleteAllData()).success).toBe(true);
        expect(other.setReminderRows([{ status: 'active', token: B, email: `${B}@example.test`, provider: 'dropbox' }], other.eraseIdentity)).toBe(true);
        await other.flush();
        vi.setSystemTime(base + 5_000); // this erase builds its marker now
        return null;
      });
      expect((await t.data.deleteUserData()).success).toBe(true);
      const standing = t.data.getReminderOptIn();
      expect(standing?.token).toBe(top);
      expect(statusOf(standing)).toEqual({ [B]: 'active' });
      expect(t.cancels()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
