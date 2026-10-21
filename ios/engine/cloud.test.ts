// US-25 AC11: the iPhone app's cloud sync (cloud.ts), run as the app runs it:
// the engine bundle in an empty context (no fetch, no timers, nothing but
// ECMAScript, as in JavaScriptCore), the web APIs from shim.ts, and fake
// natives in place of Swift: an in-memory Dropbox behind the HTTP native, the
// phone's record file as a string. Swift's own run of the same paths is
// ios/HealthRoadmapTests/CloudSyncTests.swift.
import { afterEach, describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildErasedFile } from '../../packages/health-core/src/erase';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-21T08:00:00.000Z';

let bundle: string | null = null;
async function engineSource(): Promise<string> {
  bundle ??= (await build({
    entryPoints: [join(here, 'entry.ts')], bundle: true, format: 'iife', globalName: 'HealthEngine',
    target: 'safari17', platform: 'neutral', mainFields: ['module', 'main'], write: false, logLevel: 'silent',
  })).outputFiles[0].text;
  return bundle;
}

/** Dropbox's two content endpoints, in memory, with its rev rules. */
class FakeDropbox {
  file: { text: string; rev: number } | null = null;
  online = true;
  delay = 0;
  /** False: uploads fail with a 500; reads still work. */
  uploadsWork = true;
  uploads = 0;
  /** Runs once, just before the next upload lands: another device writing first. */
  beforeNextUpload: (() => void) | null = null;

  put(record: RoadmapFile): void {
    this.file = { text: JSON.stringify(record), rev: (this.file?.rev ?? 0) + 1 };
  }
  get record(): RoadmapFile {
    return JSON.parse(this.file!.text) as RoadmapFile;
  }

  answer(url: string, headers: Record<string, string>, body: string | null): { status: number; headers: Record<string, string>; body: string } {
    if (headers.authorization !== 'Bearer token-1') return { status: 401, headers: {}, body: 'expired' };
    const arg = JSON.parse(headers['dropbox-api-arg']) as { path: string; mode?: { '.tag': string; update?: string } };
    expect(arg.path).toBe('/health-roadmap.json');
    if (url.endsWith('/files/download')) {
      if (!this.file) return { status: 409, headers: {}, body: '{"error_summary":"path/not_found/"}' };
      return { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `r${this.file.rev}` }) }, body: this.file.text };
    }
    if (!this.uploadsWork) return { status: 500, headers: {}, body: 'internal_error' };
    this.beforeNextUpload?.();
    this.beforeNextUpload = null;
    const expected = arg.mode?.['.tag'] === 'update' ? arg.mode.update : null;
    const current = this.file ? `r${this.file.rev}` : null;
    if (expected !== current) return { status: 409, headers: {}, body: '{"error_summary":"path/conflict/file/"}' };
    this.uploads += 1;
    this.file = { text: body!, rev: (this.file?.rev ?? 0) + 1 };
    return { status: 200, headers: {}, body: JSON.stringify({ rev: `r${this.file.rev}` }) };
  }
}

interface Engine {
  newRecordJson(now: string, device: string, locale: string, zone: string): string;
  applyEditJson(record: string, edit: string, now: string, device: string): string;
  cloudOpen(provider: string, device: string, first: boolean): Promise<string>;
  cloudEdit(edit: string, erase: string, units: string, now: string): string;
  cloudVisible(): string;
  cloudFlush(): Promise<string>;
  cloudRefresh(): Promise<string>;
  cloudClose(copyDown: boolean): Promise<string>;
  cloudErase(historyText: string | null, now: string): Promise<string>;
}

const opened: Engine[] = [];
afterEach(async () => {
  for (const engine of opened.splice(0)) await engine.cloudClose(false);
});

/** The engine in an empty context, with the fake natives. */
/** A provider behind the HTTP native: the fake Dropbox, or the fake Drive. */
interface Server {
  online: boolean;
  answer(url: string, headers: Record<string, string>, body: string | null, method: string): { status: number; headers: Record<string, string>; body: string };
  /** Milliseconds every answer waits (an open still in flight). */
  delay?: number;
}

async function phone(dropbox: Server, phoneText: string | null = null) {
  const state = { phoneText, pending: false, events: [] as Array<[string, string]>, tokenRefreshes: 0, signedOut: false, phoneWriteError: '', sessions: [] as number[] };
  const encode = (text: string) => new Uint8Array(Buffer.from(text, 'utf8')).buffer;
  const decode = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString('utf8');
  let next = 1;
  const native = {
    http(method: string, url: string, headers: string, body: ArrayBuffer | null, done: (s: number, t: string, h: string, b: ArrayBuffer | null, e: string | null) => void) {
      const wait = dropbox.delay ?? 0;
      setTimeout(() => {
        if (!dropbox.online) return done(0, '', '{}', null, 'The Internet connection appears to be offline.');
        const answer = dropbox.answer(url, JSON.parse(headers) as Record<string, string>, body ? decode(body) : null, method);
        done(answer.status, '', JSON.stringify(answer.headers), encode(answer.body), null);
      }, wait);
      return next++;
    },
    cancelHttp() {},
    // The save's 800 ms debounce runs at once; the minute poll and the 5 s
    // throttle never fire, so each test decides when to re-read.
    setTimer: (ms: number, run: () => void) => setTimeout(ms <= 1000 ? run : () => {}, ms <= 1000 ? 5 : 0) as unknown as number,
    clearTimer: (id: number) => clearTimeout(id),
    utf8Encode: encode,
    utf8Decode: decode,
    accessToken(_provider: string, force: boolean, done: (t: string | null, e: string | null, signIn: boolean) => void) {
      if (force) state.tokenRefreshes += 1;
      setImmediate(() => (state.signedOut ? done(null, 'Dropbox refused the sign-in.', true) : done('token-1', null, false)));
    },
    phoneRead: () => JSON.stringify({ text: state.phoneText }),
    phoneWrite: (text: string) => {
      if (state.phoneWriteError) return state.phoneWriteError;
      state.phoneText = text;
      return '';
    },
    phoneRemove: () => {
      state.phoneText = null;
    },
    pending(op: string) {
      if (op === 'set') state.pending = true;
      if (op === 'clear') state.pending = false;
      return state.pending;
    },
    notify: (event: string, payload: string, session: number) => {
      state.events.push([event, payload]);
      state.sessions.push(session);
    },
  };
  // crypto.randomUUID is HealthEngine.swift's, as in the app.
  const ctx = vm.createContext({ __native: native, crypto: { randomUUID: () => crypto.randomUUID() } });
  vm.runInContext(await engineSource(), ctx);
  const engine = (ctx as unknown as { HealthEngine: Engine }).HealthEngine;
  opened.push(engine);
  return { engine, state };
}

/** A record with one weight row per day given, written by `device`. */
async function recordWith(days: string[], device: string): Promise<RoadmapFile> {
  const { engine } = await phone(new FakeDropbox());
  let record = engine.newRecordJson(NOW, device, 'en-NZ', 'Pacific/Auckland');
  for (const day of days) {
    const outcome = JSON.parse(engine.applyEditJson(record, JSON.stringify({ kind: 'add', metric: 'weight', value: 80, day }), NOW, device)) as { record: string };
    record = outcome.record;
  }
  return JSON.parse(record) as RoadmapFile;
}

const days = (file: RoadmapFile) => file.measurements.filter((m) => m.status === 'active').map((m) => m.recordedAt.slice(0, 10)).sort();
const add = (day: string) => JSON.stringify({ kind: 'add', metric: 'weight', value: 81, day });

describe('cloud sync in the engine (US-25 AC11)', () => {
  it('AC11a: first connect merges the phone record and the cloud record, dropping neither', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine } = await phone(dropbox, JSON.stringify(await recordWith(['2026-10-02'], 'ios-1')));
    const view = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', true)) as { record: string; erase: string };
    expect(days(JSON.parse(view.record) as RoadmapFile)).toEqual(['2026-10-01', '2026-10-02']);
    expect(days(dropbox.record)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('AC11b: an edit whose first write conflicts with another device ends with both rows', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    const web = await recordWith(['2026-10-03'], 'web');
    dropbox.beforeNextUpload = () => dropbox.put(web);
    const outcome = JSON.parse(engine.cloudEdit(add('2026-10-04'), erase, 'si', NOW)) as { ok: boolean };
    expect(outcome.ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(days(dropbox.record)).toEqual(['2026-10-03', '2026-10-04']);
    // The web's row came back to the screen with the save that folded it in.
    const changed = state.events.filter(([event]) => event === 'changed').at(-1)!;
    expect(days(JSON.parse((JSON.parse(changed[1]) as { record: string }).record) as RoadmapFile)).toEqual(['2026-10-03', '2026-10-04']);
    expect(state.pending).toBe(false);
  });

  it('AC11c: a row the web added is taken in on a re-read', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    dropbox.put(await recordWith(['2026-10-01', '2026-10-05'], 'web'));
    expect(await engine.cloudRefresh()).toBe('changed');
    const [, payload] = state.events.filter(([event]) => event === 'changed').at(-1)!;
    expect(days(JSON.parse((JSON.parse(payload) as { record: string }).record) as RoadmapFile)).toContain('2026-10-05');
  });

  it('AC11c: an erase made on another device is taken in, and a write made for the old screen is refused', async () => {
    const dropbox = new FakeDropbox();
    const before = await recordWith(['2026-10-01'], 'web');
    dropbox.put(before);
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    dropbox.put(buildErasedFile({ stored: before, own: before, device: null, ctx: { deviceId: 'web', now: '2026-10-21T09:00:00.000Z' } }));
    expect(await engine.cloudRefresh()).toBe('changed');
    const view = JSON.parse(state.events.filter(([event]) => event === 'changed').at(-1)![1]) as { record: string; erase: string };
    const record = JSON.parse(view.record) as RoadmapFile;
    expect(record.meta.eraseEpoch).toBe(1);
    expect(days(record)).toEqual([]);
    // The screen still showed the old erase: the engine refuses the write (US-16 AC2a).
    expect((JSON.parse(engine.cloudEdit(add('2026-10-06'), erase, 'si', NOW)) as { reason: string }).reason).toBe('erased');
    expect((JSON.parse(engine.cloudEdit(add('2026-10-06'), view.erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
  });

  it('AC11d: a save the cloud cannot take waits on the phone, marked pending, and goes up with the next session', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const first = await phone(dropbox);
    const { erase } = JSON.parse(await first.engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    dropbox.online = false;
    first.engine.cloudEdit(add('2026-10-07'), erase, 'si', NOW);
    expect(await first.engine.cloudFlush()).toBe('failed');
    const failed = first.state.events.filter(([event]) => event === 'failed').at(-1)!;
    expect(JSON.parse(failed[1])).toMatchObject({ kind: 'unreachable' });
    expect(first.state.pending).toBe(true);
    expect(days(JSON.parse(first.state.phoneText!) as RoadmapFile)).toEqual(['2026-10-07']);
    await first.engine.cloudClose(false);

    dropbox.online = true;
    const second = await phone(dropbox, first.state.phoneText);
    second.state.pending = true;
    await second.engine.cloudOpen('dropbox', 'ios-1', false);
    await second.engine.cloudClose(false); // the session's debounced save runs as it closes
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(days(dropbox.record)).toEqual(['2026-10-07']);
    expect(second.state.pending).toBe(false);
  });

  it('AC11e: Disconnect copies the cloud record down onto the phone, and never writes the cloud', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01', '2026-10-02'], 'web'));
    const { engine, state } = await phone(dropbox, JSON.stringify(await recordWith([], 'ios-1')));
    await engine.cloudOpen('dropbox', 'ios-1', false);
    const uploads = dropbox.uploads;
    expect(await engine.cloudClose(true)).toBe('copied');
    expect(dropbox.uploads).toBe(uploads);
    expect(days(JSON.parse(state.phoneText!) as RoadmapFile)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('a refused token is refreshed once and the call repeated', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    let calls = 0;
    const answer = dropbox.answer.bind(dropbox);
    dropbox.answer = (url, headers, body) => (calls++ === 0 ? { status: 401, headers: {}, body: 'expired_access_token' } : answer(url, headers, body));
    await engine.cloudOpen('dropbox', 'ios-1', false);
    expect(state.tokenRefreshes).toBe(1);
  });

  it('an open that cannot read the cloud rejects with the kind of failure, for Swift to word', async () => {
    const dropbox = new FakeDropbox();
    dropbox.online = false;
    const offline = await phone(dropbox);
    await expect(offline.engine.cloudOpen('dropbox', 'ios-1', false)).rejects.toThrow('"kind":"unreachable"');
    dropbox.online = true;
    const signedOut = await phone(dropbox);
    signedOut.state.signedOut = true;
    await expect(signedOut.engine.cloudOpen('dropbox', 'ios-1', false)).rejects.toThrow('"kind":"sign-in"');
  });

  it('R2: an edit typed in the units the screen showed is refused after another device changed the units', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine } = await phone(dropbox);
    const { erase, record } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string; record: string };
    // The web switches the record to US units.
    const us = JSON.parse(engine.applyEditJson(record, JSON.stringify({ kind: 'units', unitSystem: 'conventional' }), '2026-10-21T09:00:00.000Z', 'web')) as { record: string };
    dropbox.put(JSON.parse(us.record) as RoadmapFile);
    expect(await engine.cloudRefresh()).toBe('changed');
    // A sheet opened in metric saves 80 (kg): refused, never stored as 80 lb. The replace path too.
    expect(JSON.parse(engine.cloudEdit(add('2026-10-02'), erase, 'si', NOW))).toMatchObject({ ok: false, reason: 'units-changed' });
    const rowId = (JSON.parse(us.record) as RoadmapFile).measurements[0].id;
    expect(JSON.parse(engine.cloudEdit(JSON.stringify({ kind: 'correct', id: rowId, value: 79 }), erase, 'si', NOW))).toMatchObject({ reason: 'units-changed' });
    // An edit made in the units now shown goes through.
    expect((JSON.parse(engine.cloudEdit(add('2026-10-02'), erase, 'conventional', NOW)) as { ok: boolean }).ok).toBe(true);
  });

  it('R3: an edit is refused, and nothing changes, when the phone copy cannot be written', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    state.phoneWriteError = 'The disk is full.';
    const outcome = JSON.parse(engine.cloudEdit(add('2026-10-08'), erase, 'si', NOW)) as { ok: boolean; reason: string; message: string };
    expect(outcome).toMatchObject({ ok: false, reason: 'phone-write' });
    expect(outcome.message).toContain('The disk is full.');
    // The session never took it: no save carries it.
    state.phoneWriteError = '';
    await engine.cloudClose(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(days(dropbox.record)).toEqual([]);
  });

  it('R3: an accepted edit is on the phone, marked pending, before cloudEdit answers', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    expect((JSON.parse(engine.cloudEdit(add('2026-10-09'), erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    // Synchronously: no await between the answer and these checks.
    expect(state.pending).toBe(true);
    expect(days(JSON.parse(state.phoneText!) as RoadmapFile)).toEqual(['2026-10-09']);
  });

  it('R6: a refresh with a revoked grant says sign-in', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    state.signedOut = true;
    dropbox.answer = () => ({ status: 401, headers: {}, body: 'invalid_access_token' });
    await expect(engine.cloudRefresh()).rejects.toThrow('"kind":"sign-in"');
  });

  it('R6: an idle re-read on return with a revoked grant says sign-in', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    state.signedOut = true;
    dropbox.answer = () => ({ status: 401, headers: {}, body: 'invalid_access_token' });
    state.events.length = 0;
    engine.cloudVisible();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const failed = state.events.filter(([event]) => event === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.parse(failed.at(-1)![1])).toMatchObject({ kind: 'sign-in' });
  });

  it('R6: a re-read that works says synced, so a passing failure clears', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    state.events.length = 0;
    await engine.cloudRefresh();
    expect(state.events.map(([event]) => event)).toContain('synced');
  });

  it.each([
    ['userRateLimitExceeded', 'unreachable'],
    ['rateLimitExceeded', 'unreachable'],
    ['insufficientPermissions', 'sign-in'],
  ])('A8: a 403 with reason %s is %s', async (reason, kind) => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    dropbox.answer = () => ({ status: 403, headers: {}, body: `{"error":{"errors":[{"reason":"${reason}"}]}}` });
    await expect(engine.cloudRefresh()).rejects.toThrow(`"kind":"${kind}"`);
  });

  it('A10: Google Drive through the shim: the first save makes the folder and file, a moved version re-merges, a web change is taken in', async () => {
    const drive = new FakeDrive();
    const { engine } = await phone(drive);
    const { erase } = JSON.parse(await engine.cloudOpen('google-drive', 'ios-1', false)) as { erase: string };
    expect((JSON.parse(engine.cloudEdit(add('2026-10-01'), erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(drive.folderMade).toBe(true);
    expect(days(drive.record)).toEqual(['2026-10-01']);

    // Another device writes after the phone read and before its version check:
    // the check refuses (design §7 step 2) and the save re-reads and merges.
    const web = await recordWith(['2026-10-02'], 'web');
    const merged = { ...web, measurements: [...drive.record.measurements, ...web.measurements] };
    drive.beforeVersionCheck = () => drive.put(merged);
    expect((JSON.parse(engine.cloudEdit(add('2026-10-03'), erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(days(drive.record)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);

    const later = await recordWith(['2026-10-04'], 'web');
    drive.put({ ...drive.record, measurements: [...drive.record.measurements, ...later.measurements] });
    expect(await engine.cloudRefresh()).toBe('changed');
  });
  it('F1: a re-read never says synced while an edit waits on the phone', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    dropbox.uploadsWork = false;
    engine.cloudEdit(add('2026-10-10'), erase, 'si', NOW);
    expect(await engine.cloudFlush()).toBe('failed');
    state.events.length = 0;
    await engine.cloudRefresh();
    expect(state.events.map(([event]) => event)).not.toContain('synced');
    expect(state.pending).toBe(true);
  });

  it('F2/F4: of two opens, the newer wins whichever finishes last; the older closes itself and its events carry its own id', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    dropbox.delay = 80;
    const older = engine.cloudOpen('dropbox', 'ios-1', false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    dropbox.delay = 0;
    const newer = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string; session: number };
    await expect(older).rejects.toThrow('superseded');
    // The newer session is the open one: an edit goes through it and reaches the cloud.
    state.sessions.length = 0;
    expect((JSON.parse(engine.cloudEdit(add('2026-10-11'), newer.erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(days(dropbox.record)).toEqual(['2026-10-11']);
    expect(new Set(state.sessions)).toEqual(new Set([newer.session]));
  });

  it('F2: a close while an open is in flight makes that open close itself', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine } = await phone(dropbox);
    dropbox.delay = 50;
    const opening = engine.cloudOpen('dropbox', 'ios-1', false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await engine.cloudClose(true)).toBe('none');
    await expect(opening).rejects.toThrow('superseded');
    expect(JSON.parse(engine.cloudEdit(add('2026-10-12'), 'x', 'si', NOW))).toMatchObject({ reason: 'not-open' });
  });

  it('F5: a unit change refuses only edits whose number depends on units', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine } = await phone(dropbox);
    const { erase, record } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string; record: string };
    const us = JSON.parse(engine.applyEditJson(record, JSON.stringify({ kind: 'units', unitSystem: 'conventional' }), '2026-10-21T09:00:00.000Z', 'web')) as { record: string };
    dropbox.put(JSON.parse(us.record) as RoadmapFile);
    await engine.cloudRefresh();
    expect((JSON.parse(engine.cloudEdit(JSON.stringify({ kind: 'profile', sex: 'female' }), erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    expect(JSON.parse(engine.cloudEdit(JSON.stringify({ kind: 'profile', height: 170 }), erase, 'si', NOW))).toMatchObject({ reason: 'units-changed' });
  });

  it.each([
    ['storageQuotaExceeded', 'storage-full'],
    ['dailyLimitExceeded', 'unreachable'],
  ])('Drive 403 %s is %s, never a sign-in', async (reason, kind) => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    dropbox.answer = () => ({ status: 403, headers: {}, body: `{"error":{"errors":[{"reason":"${reason}"}]}}` });
    await expect(engine.cloudRefresh()).rejects.toThrow(`"kind":"${kind}"`);
  });

});

// US-25 AC13 (US-11 on the iPhone): "Delete all my data" with a cloud open.
// The engine runs RecordSession.deleteAllData, the web's own order and guard.
describe('cloudErase (US-25 AC13, US-11)', () => {
  interface Erased { success: boolean; error?: string; chatErased: boolean; chatHistory: string | null; erased: boolean; view: { record: string; erase: string; session: number } | null }
  const chat = JSON.stringify({ schemaVersion: 1, conversations: [{ id: 'c1', title: 'Is my LDL high?', createdAt: NOW, updatedAt: NOW, messages: [{ id: 'u-1', role: 'user', content: 'Is my LDL high?', createdAt: NOW }] }], meta: { updatedAt: NOW, lamport: 1, lastDeviceId: 'ios-1' } });

  it('erases the cloud record by eraseEpoch, never deleting the file; the phone keeps only the erased copy, nothing pending', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    engine.cloudEdit(add('2026-10-02'), erase, 'si', NOW);
    expect(state.pending).toBe(true);

    const result = JSON.parse(await engine.cloudErase(chat, NOW)) as Erased;
    expect(result).toMatchObject({ success: true, erased: true, chatErased: true });
    // The file stays, with the erase in it, so other devices take it in (US-11 AC6).
    expect(dropbox.record.meta.eraseEpoch).toBe(1);
    expect(dropbox.record.measurements).toEqual([]);
    expect(dropbox.record.erasedRows?.ids.length).toBe(2);
    const shown = JSON.parse(result.view!.record) as RoadmapFile;
    expect(shown.meta.eraseEpoch).toBe(1);
    expect(result.view!.erase).not.toBe(erase);
    // The phone's copy: the pre-erase mirror gone, the erased record in its place.
    expect(state.pending).toBe(false);
    const onPhone = JSON.parse(state.phoneText!) as RoadmapFile;
    expect(onPhone.meta.eraseEpoch).toBe(1);
    expect(onPhone.measurements).toEqual([]);
    expect(result.chatHistory).not.toContain('Is my LDL high?');
    // A write made for the screen before the erase is refused (US-16 AC2a).
    expect(JSON.parse(engine.cloudEdit(add('2026-10-03'), erase, 'si', NOW))).toMatchObject({ reason: 'erased' });
  });

  it('another device takes the erase in on its next re-read', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const other = await phone(dropbox);
    await other.engine.cloudOpen('dropbox', 'ios-2', false);
    const { engine } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    expect((JSON.parse(await engine.cloudErase(null, NOW)) as Erased).success).toBe(true);

    expect(await other.engine.cloudRefresh()).toBe('changed');
    const [, payload] = other.state.events.filter(([event]) => event === 'changed').at(-1)!;
    const record = JSON.parse((JSON.parse(payload) as { record: string }).record) as RoadmapFile;
    expect(record.meta.eraseEpoch).toBe(1);
    expect(days(record)).toEqual([]);
  });

  it('an unreachable cloud erases nothing anywhere, chat included, and says so', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const phoneBefore = state.phoneText;
    dropbox.online = false;

    const result = JSON.parse(await engine.cloudErase(chat, NOW)) as Erased;
    expect(result).toMatchObject({ success: false, erased: false, chatErased: false, chatHistory: null, view: null });
    expect(result.error).toMatch(/could not be reached, so nothing was deleted/);
    dropbox.online = true;
    expect(days(dropbox.record)).toEqual(['2026-10-01']);
    expect(state.phoneText).toBe(phoneBefore);
  });

  it('an erase whose write fails after the read is kept on the phone, pending, and sent by the next flush', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    dropbox.uploadsWork = false;

    const result = JSON.parse(await engine.cloudErase(chat, NOW)) as Erased;
    expect(result).toMatchObject({ success: false, erased: true, chatErased: true });
    expect((JSON.parse(result.view!.record) as RoadmapFile).meta.eraseEpoch).toBe(1);
    expect(state.pending).toBe(true);
    expect((JSON.parse(state.phoneText!) as RoadmapFile).meta.eraseEpoch).toBe(1);
    expect(days(dropbox.record)).toEqual(['2026-10-01']);

    dropbox.uploadsWork = true;
    expect(await engine.cloudFlush()).toBe('saved');
    expect(dropbox.record.meta.eraseEpoch).toBe(1);
    expect(days(dropbox.record)).toEqual([]);
  });
});

/** Google Drive v3's files endpoints, in memory: one folder, one record, a version counter. */
class FakeDrive implements Server {
  online = true;
  folderMade = false;
  file: { text: string; version: number } | null = null;
  /** Runs at the version read that comes right before an upload. */
  beforeVersionCheck: (() => void) | null = null;
  private versionReads = 0;

  put(record: RoadmapFile): void {
    this.file = { text: JSON.stringify(record), version: (this.file?.version ?? 0) + 1 };
  }
  get record(): RoadmapFile {
    return JSON.parse(this.file!.text) as RoadmapFile;
  }

  answer(url: string, headers: Record<string, string>, body: string | null, method: string) {
    const ok = (json: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(json) });
    expect(headers.authorization).toBe('Bearer token-1');
    const u = new URL(url);
    const q = u.searchParams.get('q') ?? '';
    if (method === 'GET' && u.pathname === '/drive/v3/files' && q.includes('application/vnd.google-apps.folder')) {
      return ok({ files: this.folderMade ? [{ id: 'folder-1', name: 'Health Plan by Dr Brad' }] : [] });
    }
    if (method === 'GET' && u.pathname === '/drive/v3/files') return ok({ files: this.file ? [{ id: 'file-1' }] : [] });
    if (method === 'POST' && u.pathname === '/drive/v3/files') {
      this.folderMade = true;
      return ok({ id: 'folder-1' });
    }
    if (method === 'GET' && u.pathname === '/drive/v3/files/file-1') {
      if (u.searchParams.get('alt') !== 'media') {
        // The save reads the version twice: with the bytes, then before the upload.
        if (this.beforeVersionCheck && ++this.versionReads === 2) {
          this.beforeVersionCheck();
          this.beforeVersionCheck = null;
          this.versionReads = 0;
        }
        return this.file ? ok({ version: String(this.file.version) }) : { status: 404, headers: {}, body: '' };
      }
      return this.file ? { status: 200, headers: {}, body: this.file.text } : { status: 404, headers: {}, body: '' };
    }
    if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const json = body!.split('\r\n\r\n')[2].split('\r\n--')[0];
      this.file = { text: json, version: 1 };
      return ok({ id: 'file-1', version: '1' });
    }
    if (method === 'PATCH' && u.pathname === '/upload/drive/v3/files/file-1') {
      this.file = { text: body!, version: (this.file?.version ?? 0) + 1 };
      return ok({ id: 'file-1', version: String(this.file.version) });
    }
    throw new Error(`FakeDrive has no ${method} ${url}`);
  }
}
