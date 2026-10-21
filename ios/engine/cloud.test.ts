// US-25 AC8: the iPhone app's cloud sync (cloud.ts), run as the app runs it:
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
  cloudEdit(edit: string, erase: string, now: string): string;
  cloudFlush(): Promise<string>;
  cloudRefresh(): Promise<string>;
  cloudClose(copyDown: boolean): Promise<string>;
}

const opened: Engine[] = [];
afterEach(async () => {
  for (const engine of opened.splice(0)) await engine.cloudClose(false);
});

/** The engine in an empty context, with the fake natives. */
async function phone(dropbox: FakeDropbox, phoneText: string | null = null) {
  const state = { phoneText, pending: false, events: [] as Array<[string, string]>, tokenRefreshes: 0 };
  const encode = (text: string) => new Uint8Array(Buffer.from(text, 'utf8')).buffer;
  const decode = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString('utf8');
  let next = 1;
  const native = {
    http(_method: string, url: string, headers: string, body: ArrayBuffer | null, done: (s: number, t: string, h: string, b: ArrayBuffer | null, e: string | null) => void) {
      setImmediate(() => {
        if (!dropbox.online) return done(0, '', '{}', null, 'The Internet connection appears to be offline.');
        const answer = dropbox.answer(url, JSON.parse(headers) as Record<string, string>, body ? decode(body) : null);
        done(answer.status, '', JSON.stringify(answer.headers), encode(answer.body), null);
      });
      return next++;
    },
    cancelHttp() {},
    // The save's 800 ms debounce runs at once; the minute poll and the 5 s
    // throttle never fire, so each test decides when to re-read.
    setTimer: (ms: number, run: () => void) => setTimeout(ms <= 1000 ? run : () => {}, ms <= 1000 ? 5 : 0) as unknown as number,
    clearTimer: (id: number) => clearTimeout(id),
    utf8Encode: encode,
    utf8Decode: decode,
    accessToken(_provider: string, force: boolean, done: (t: string | null, e: string | null) => void) {
      if (force) state.tokenRefreshes += 1;
      setImmediate(() => done('token-1', null));
    },
    phoneRead: () => JSON.stringify({ text: state.phoneText }),
    phoneWrite: (text: string) => {
      state.phoneText = text;
      return null;
    },
    phoneRemove: () => {
      state.phoneText = null;
    },
    pending(op: string) {
      if (op === 'set') state.pending = true;
      if (op === 'clear') state.pending = false;
      return state.pending;
    },
    notify: (event: string, payload: string) => state.events.push([event, payload]),
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

describe('cloud sync in the engine (US-25 AC8)', () => {
  it('AC8a: first connect merges the phone record and the cloud record, dropping neither', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine } = await phone(dropbox, JSON.stringify(await recordWith(['2026-10-02'], 'ios-1')));
    const view = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', true)) as { record: string; erase: string };
    expect(days(JSON.parse(view.record) as RoadmapFile)).toEqual(['2026-10-01', '2026-10-02']);
    expect(days(dropbox.record)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('AC8b: an edit whose first write conflicts with another device ends with both rows', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    const web = await recordWith(['2026-10-03'], 'web');
    dropbox.beforeNextUpload = () => dropbox.put(web);
    const outcome = JSON.parse(engine.cloudEdit(add('2026-10-04'), erase, NOW)) as { ok: boolean };
    expect(outcome.ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(days(dropbox.record)).toEqual(['2026-10-03', '2026-10-04']);
    // The web's row came back to the screen with the save that folded it in.
    const changed = state.events.filter(([event]) => event === 'changed').at(-1)!;
    expect(days(JSON.parse((JSON.parse(changed[1]) as { record: string }).record) as RoadmapFile)).toEqual(['2026-10-03', '2026-10-04']);
    expect(state.pending).toBe(false);
  });

  it('AC8c: a row the web added is taken in on a re-read', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    dropbox.put(await recordWith(['2026-10-01', '2026-10-05'], 'web'));
    expect(await engine.cloudRefresh()).toBe('changed');
    const [, payload] = state.events.filter(([event]) => event === 'changed').at(-1)!;
    expect(days(JSON.parse((JSON.parse(payload) as { record: string }).record) as RoadmapFile)).toContain('2026-10-05');
  });

  it('AC8c: an erase made on another device is taken in, and a write made for the old screen is refused', async () => {
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
    expect((JSON.parse(engine.cloudEdit(add('2026-10-06'), erase, NOW)) as { reason: string }).reason).toBe('erased');
    expect((JSON.parse(engine.cloudEdit(add('2026-10-06'), view.erase, NOW)) as { ok: boolean }).ok).toBe(true);
  });

  it('AC8d: a save the cloud cannot take waits on the phone, marked pending, and goes up with the next session', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const first = await phone(dropbox);
    const { erase } = JSON.parse(await first.engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    dropbox.online = false;
    first.engine.cloudEdit(add('2026-10-07'), erase, NOW);
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

  it('AC8e: Disconnect copies the cloud record down onto the phone, and never writes the cloud', async () => {
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
});
