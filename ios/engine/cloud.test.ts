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
import { createHash } from 'node:crypto';
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

/** Dropbox's two content endpoints, in memory, with its rev rules: the record,
 *  and the chat history the website keeps beside it. */
class FakeDropbox {
  file: { text: string; rev: number } | null = null;
  /** `/chat-history.json`, which only the website writes (US-25 AC16). */
  chat: { text: string; rev: number } | null = null;
  /** False: the chat file's endpoints answer 500, the record's still work. */
  chatAnswers = true;
  online = true;
  delay = 0;
  delayFor?: Server['delayFor'];
  /** False: uploads fail with a 500; reads still work. */
  uploadsWork = true;
  uploads = 0;
  /** Runs once, just before the next upload lands: another device writing first. */
  beforeNextUpload: (() => void) | null = null;
  /** Originals the app filed, by path (US-52 AC13d). */
  documents = new Map<string, string>();
  /** False: document uploads fail with a 500; the record's still work. */
  documentsWork = true;

  put(record: RoadmapFile): void {
    this.file = { text: JSON.stringify(record), rev: (this.file?.rev ?? 0) + 1 };
  }
  get record(): RoadmapFile {
    return JSON.parse(this.file!.text) as RoadmapFile;
  }

  answer(url: string, headers: Record<string, string>, body: string | null): { status: number; headers: Record<string, string>; body: string } {
    if (headers.authorization !== 'Bearer token-1') return { status: 401, headers: {}, body: 'expired' };
    const arg = JSON.parse(headers['dropbox-api-arg']) as { path: string; mode?: { '.tag': string; update?: string } };
    if (url.endsWith('/files/upload') && !['/health-roadmap.json', '/chat-history.json'].includes(arg.path)) {
      if (!this.documentsWork) return { status: 500, headers: {}, body: 'internal_error' };
      expect(arg.mode).toEqual({ '.tag': 'overwrite' });
      this.documents.set(arg.path, body!);
      return { status: 200, headers: {}, body: '{}' };
    }
    expect(['/health-roadmap.json', '/chat-history.json']).toContain(arg.path);
    const slot = arg.path === '/chat-history.json' ? 'chat' : 'file';
    const now = this[slot];
    if (slot === 'chat' && !this.chatAnswers) return { status: 500, headers: {}, body: 'internal_error' };
    if (url.endsWith('/files/download')) {
      if (!now) return { status: 409, headers: {}, body: '{"error_summary":"path/not_found/"}' };
      return { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `r${now.rev}` }) }, body: now.text };
    }
    if (!this.uploadsWork) return { status: 500, headers: {}, body: 'internal_error' };
    if (slot === 'file') {
      this.beforeNextUpload?.();
      this.beforeNextUpload = null;
    }
    const expected = arg.mode?.['.tag'] === 'update' ? arg.mode.update : null;
    const current = this[slot] ? `r${this[slot]!.rev}` : null;
    if (expected !== current) return { status: 409, headers: {}, body: '{"error_summary":"path/conflict/file/"}' };
    if (slot === 'file') this.uploads += 1;
    this[slot] = { text: body!, rev: (this[slot]?.rev ?? 0) + 1 };
    return { status: 200, headers: {}, body: JSON.stringify({ rev: `r${this[slot]!.rev}` }) };
  }
}

interface Engine {
  newRecordJson(now: string, device: string, locale: string, zone: string): string;
  applyEditJson(record: string, edit: string, now: string, device: string): string;
  cloudOpen(provider: string, device: string, first: boolean, mergePhone?: boolean): Promise<string>;
  cloudLabImport(extraction: string, refs: string, reportDay: string, erase: string, units: string, now: string, unitsJson: string): string;
  labSaveSummaryJson(record: string, extraction: string, refs: string, reportDay: string, now: string, device: string): string;
  cloudEdit(edit: string, erase: string, units: string, now: string, unitsJson?: string, shownLpaUnit?: string): string;
  cloudVisible(): string;
  cloudFlush(): Promise<string>;
  cloudRefresh(): Promise<string>;
  cloudClose(copyDown: boolean): Promise<string>;
  cloudErase(historyText: string | null, now: string, keepChat?: (text: string) => string): Promise<string>;
  labFolderJson(folder: string): Promise<string>;
  labFolderFilesJson(folder: string): Promise<string>;
  labFile(id: string, folder: string): Promise<{ name: string; bytes: ArrayBuffer }>;
  documentSave(record: string, extraction: string, choice: string, original: ArrayBuffer | null, erase: string, now: string, device: string): Promise<string>;
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
  /** Milliseconds one request's answer waits, in place of `delay`. */
  delayFor?(url: string, headers: Record<string, string>): number | undefined;
}

async function phone(dropbox: Server, phoneText: string | null = null) {
  const state = { phoneText, pending: false, generation: 1, events: [] as Array<[string, string]>, tokenRefreshes: 0, signedOut: false, phoneWriteError: '', sessions: [] as number[] };
  const encode = (text: string) => new Uint8Array(Buffer.from(text, 'utf8')).buffer;
  const decode = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString('utf8');
  let next = 1;
  const native = {
    http(method: string, url: string, headers: string, body: ArrayBuffer | null, done: (s: number, t: string, h: string, b: ArrayBuffer | null, e: string | null) => void) {
      const wait = dropbox.delayFor?.(url, JSON.parse(headers) as Record<string, string>) ?? dropbox.delay ?? 0;
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
    // The marker as Swift keeps it (PhoneFiles): a generation that rises at every set.
    pending(op: string) {
      if (op === 'set') {
        state.pending = true;
        state.generation += 1;
      }
      if (op === `clear-if:${state.generation}`) state.pending = false;
      return state.pending ? state.generation : 0;
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

  it('AC17e: a value typed in a test\'s own units is stored right in the cloud record', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    // 180 lb on a metric record, weight switched to US: about 81.6 kg, never 180 kg.
    const typed = JSON.stringify({ kind: 'add', metric: 'weight', value: 180, day: '2026-10-05' });
    expect((JSON.parse(engine.cloudEdit(typed, erase, 'si', NOW, '{"weight":"conventional"}')) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    const weight = dropbox.record.measurements.find((row) => row.recordedAt.startsWith('2026-10-05'))!;
    expect(weight.value).toBeCloseTo(81.6, 1);
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

  it('US-25 AC21: a marker set after the session read the phone outlives that session\'s save', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false, false)) as { erase: string };
    // Swift's phone path while the screen still showed the phone: the file takes an edit, marked.
    state.phoneText = JSON.stringify(await recordWith(['2026-10-05'], 'ios-1'));
    state.pending = true;
    state.generation += 1;
    engine.cloudEdit(add('2026-10-06'), erase, 'si', NOW);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(days(dropbox.record)).toEqual(['2026-10-06']);
    expect(state.pending).toBe(true); // the phone's own edit is still waiting
  });

  it('US-25 AC21: a reopen after edits made during an open merges the phone file whatever the marker says', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false, false);
    state.phoneText = JSON.stringify(await recordWith(['2026-10-05'], 'ios-1'));
    state.pending = false; // cleared by the session the reopen replaces
    const view = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false, true)) as { record: string };
    expect(days(JSON.parse(view.record) as RoadmapFile)).toEqual(['2026-10-01', '2026-10-05']);
    await engine.cloudFlush();
    await engine.cloudClose(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(days(dropbox.record)).toEqual(['2026-10-01', '2026-10-05']);
  });

  it('US-52 AC8: a lab import takes its summary against the session it lands on, after a re-read brought a value in', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine } = await phone(dropbox);
    const opened = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false, false)) as { record: string; erase: string };
    // Another device fills the report's LDL slot; the session's re-read takes it in.
    const web = JSON.parse(engine.applyEditJson(JSON.stringify(dropbox.record), JSON.stringify({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' }), NOW, 'web')) as { record: string };
    dropbox.put(JSON.parse(web.record) as RoadmapFile);
    expect(await engine.cloudRefresh()).toBe('changed');
    const extraction = JSON.stringify({ classification: 'lab_report', reportDate: '2026-10-01',
      values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
        { metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', displaySystem: 'si', confidence: 'medium', recordedAt: '2025-04-02' }],
      additionalValues: [{ name: 'Ferritin', value: 85, unit: 'µg/L' }], refusedValues: [] });
    const refs = JSON.stringify(['v0', 'v1', 'a0']);
    // The old way: a summary of the record the screen showed before the re-read counts the LDL as saved.
    const stale = JSON.parse(engine.labSaveSummaryJson(opened.record, extraction, refs, '2026-10-01', NOW, 'ios-1')) as { summary: { saved: number } };
    expect(stale.summary.saved).toBe(3);
    const answer = JSON.parse(engine.cloudLabImport(extraction, refs, '2026-10-01', opened.erase, 'si', NOW, '{}')) as { ok: boolean; record: string; summary: { saved: number; skipped: number } };
    expect(answer.ok).toBe(true);
    expect(answer.summary).toMatchObject({ saved: 2, skipped: 1 });
    const record = JSON.parse(answer.record) as RoadmapFile;
    const imported = record.measurements.filter((m) => m.source === 'lab_import').length + (record.labValues?.length ?? 0);
    expect(imported).toBe(answer.summary.saved);
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

  it('AC20: Lp(a) is read in the record\'s unit, and a value typed before another device changed it is refused', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    const lpa = (value: number, day: string) => JSON.stringify({ kind: 'add', metric: 'lpa', value, day });
    // The phone's menu writes the unit through the session, so it reaches the web's file.
    const chosen = JSON.parse(engine.cloudEdit(JSON.stringify({ kind: 'lpaUnit', unit: 'mg/dL' }), erase, 'si', NOW, '{}', 'nmol/L')) as { ok: boolean; record: string };
    expect(chosen.ok).toBe(true);
    // 156 mg/dL typed with mg/dL shown: 390 nmol/L.
    expect((JSON.parse(engine.cloudEdit(lpa(156, '2026-10-02'), erase, 'si', NOW, '{}', 'mg/dL')) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(dropbox.record.profile.lpaUnit).toBe('mg/dL');
    expect(dropbox.record.measurements.find((row) => row.metricType === 'lpa')!.value).toBeCloseTo(390, 9);
    // The web switches Lp(a) to mg/L.
    const web = JSON.parse(engine.applyEditJson(dropbox.file!.text, JSON.stringify({ kind: 'lpaUnit', unit: 'mg/L' }), '2026-10-21T09:00:00.000Z', 'web')) as { record: string };
    dropbox.put(JSON.parse(web.record) as RoadmapFile);
    expect(await engine.cloudRefresh()).toBe('changed');
    // A sheet that showed mg/dL: its value and its correction are refused, never read as mg/L.
    expect(JSON.parse(engine.cloudEdit(lpa(50, '2026-10-03'), erase, 'si', NOW, '{}', 'mg/dL'))).toMatchObject({ ok: false, reason: 'units-changed' });
    const rowId = dropbox.record.measurements.find((row) => row.metricType === 'lpa')!.id;
    expect(JSON.parse(engine.cloudEdit(JSON.stringify({ kind: 'correct', id: rowId, value: 150 }), erase, 'si', NOW, '{}', 'mg/dL'))).toMatchObject({ reason: 'units-changed' });
    // Another test's value is not Lp(a)'s: it saves.
    expect((JSON.parse(engine.cloudEdit(add('2026-10-03'), erase, 'si', NOW, '{}', 'mg/dL')) as { ok: boolean }).ok).toBe(true);
    // A sheet opened in mg/L saves, read in mg/L: 500 mg/L is 125 nmol/L.
    expect((JSON.parse(engine.cloudEdit(lpa(500, '2026-10-03'), erase, 'si', NOW, '{}', 'mg/L')) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(dropbox.record.measurements.find((row) => row.metricType === 'lpa' && row.recordedAt.startsWith('2026-10-03'))!.value).toBeCloseTo(125, 9);
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

  it('R2 (re-check): an open that waits on a slow flush of the old session never beats a later open', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const first = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    engine.cloudEdit(add('2026-10-13'), first.erase, 'si', NOW); // the old session has a save to flush
    dropbox.delay = 60;
    const older = engine.cloudOpen('dropbox', 'ios-1', false); // waits on that flush
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string; session: number };
    await expect(older).rejects.toThrow('superseded');
    await new Promise((resolve) => setTimeout(resolve, 200));
    dropbox.delay = 0;
    state.sessions.length = 0;
    expect((JSON.parse(engine.cloudEdit(add('2026-10-14'), newer.erase, 'si', NOW)) as { ok: boolean }).ok).toBe(true);
    expect(await engine.cloudFlush()).toBe('saved');
    expect(new Set(state.sessions)).toEqual(new Set([newer.session]));
    expect(days(dropbox.record)).toEqual(['2026-10-13', '2026-10-14']);
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

  it('US-25 AC17 (Codex R1): a blood pressure replace is refused when another device corrected the day before Save', async () => {
    const dropbox = new FakeDropbox();
    const { engine: maker } = await phone(new FakeDropbox());
    const pair = JSON.parse(maker.applyEditJson(maker.newRecordJson(NOW, 'web', 'en-NZ', 'Pacific/Auckland'),
      JSON.stringify({ kind: 'bloodPressure', systolic: 120, diastolic: 80, day: '2026-10-20' }), NOW, 'web')) as { record: string };
    const before = JSON.parse(pair.record) as RoadmapFile;
    dropbox.put(before);
    const { engine } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    const shown = before.measurements.map((row) => row.id);
    // The web corrects the diastolic 80 to 78; the phone takes it in while its sheet is open.
    const web = JSON.parse(maker.applyEditJson(pair.record, JSON.stringify({ kind: 'correct', id: before.measurements[1].id, value: 78 }), '2026-10-21T09:00:00.000Z', 'web')) as { record: string };
    dropbox.put(JSON.parse(web.record) as RoadmapFile);
    expect(await engine.cloudRefresh()).toBe('changed');
    const replace = (seenIds: string[]) => JSON.stringify({ kind: 'bloodPressure', systolic: 130, diastolic: 80, day: '2026-10-20', replace: true, seenIds });
    expect(JSON.parse(engine.cloudEdit(replace(shown), erase, 'si', NOW))).toMatchObject({ ok: false, reason: 'record-changed' });
    // The web's 78 stands.
    expect(dropbox.record.measurements.filter((row) => row.status === 'active').map((row) => row.value).sort()).toEqual([120, 78].sort());
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

// US-25 AC16 (US-11 on the iPhone): "Delete all my data" with a cloud open.
// The engine runs RecordSession.deleteAllData, the web's own order and guard.
describe('cloudErase (US-25 AC16, US-11)', () => {
  interface Erased { success: boolean; error?: string; chatErased: boolean; cloudChatErased: boolean; cloudChatProblem: string | null; chatHistory: string | null; erased: boolean; view: { record: string; erase: string; session: number } | null }
  const chat = JSON.stringify({ schemaVersion: 1, conversations: [{ id: 'c1', title: 'Is my LDL high?', createdAt: NOW, updatedAt: NOW, messages: [{ id: 'u-1', role: 'user', content: 'Is my LDL high?', createdAt: NOW }] }], meta: { updatedAt: NOW, lamport: 1, lastDeviceId: 'ios-1' } });

  it('erases the cloud record by eraseEpoch, never deleting the file; the phone keeps only the erased copy, nothing pending', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    engine.cloudEdit(add('2026-10-02'), erase, 'si', NOW);
    expect(state.pending).toBe(true);

    // The chat tombstones are written by Swift inside the erase's own step, after
    // the read and before the record goes up (Codex R3): a kill between the two
    // never leaves the record erased and the chat whole.
    const kept: Array<{ text: string; cloudEpoch: number | undefined }> = [];
    const keepChat = (text: string) => { kept.push({ text, cloudEpoch: dropbox.record.meta.eraseEpoch }); return ''; };
    const result = JSON.parse(await engine.cloudErase(chat, NOW, keepChat)) as Erased;
    expect(result).toMatchObject({ success: true, erased: true, chatErased: true });
    expect(kept).toHaveLength(1);
    expect(kept[0].cloudEpoch ?? 0).toBe(0);
    expect(kept[0].text).not.toContain('Is my LDL high?');
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

  it('a chat file the phone refuses to write is reported, and the record erase still goes on', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    const { engine } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    const result = JSON.parse(await engine.cloudErase(chat, NOW, () => 'disk full')) as Erased;
    expect(result).toMatchObject({ success: true, erased: true, chatErased: false });
    expect(dropbox.record.meta.eraseEpoch).toBe(1);
  });

  it('tombstones the chat history the website saved in the cloud, before the record goes up', async () => {
    const dropbox = new FakeDropbox();
    dropbox.put(await recordWith(['2026-10-01'], 'web'));
    dropbox.chat = { text: chat.replace(/Is my LDL high\?/g, 'Website question'), rev: 1 };
    const { engine, state } = await phone(dropbox);
    await engine.cloudOpen('dropbox', 'ios-1', false);
    state.events.length = 0;
    const recordUploads = dropbox.uploads;

    const order: string[] = [];
    dropbox.beforeNextUpload = () => order.push(dropbox.chat!.text.includes('Website question') ? 'record before chat' : 'record after chat');
    const kept: string[] = [];
    const result = JSON.parse(await engine.cloudErase(chat, NOW, (text) => { kept.push(text); return ''; })) as Erased;
    expect(result).toMatchObject({ success: true, erased: true, chatErased: true, cloudChatErased: true, cloudChatProblem: null });
    expect(order).toEqual(['record after chat']);
    // Sync status follows the record file only: one saving and one saved per
    // record upload, none for the chat file's (adversary R3).
    const recordWrites = dropbox.uploads - recordUploads;
    expect(recordWrites).toBeGreaterThan(0);
    expect(state.events.filter(([event]) => event === 'saving')).toHaveLength(recordWrites);
    expect(state.events.filter(([event]) => event === 'saved')).toHaveLength(recordWrites);
    // The cloud file: every conversation a tombstone, the user's words gone.
    expect(dropbox.chat!.text).not.toContain('Website question');
    const cloudChat = JSON.parse(dropbox.chat!.text) as { conversations: Array<{ deleted?: boolean }> };
    expect(cloudChat.conversations.length).toBe(1);
    expect(cloudChat.conversations.every((c) => c.deleted === true)).toBe(true);
    // The phone's own chat history is still tombstoned, as before.
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toContain('Is my LDL high?');
    expect(dropbox.record.meta.eraseEpoch).toBe(1);
  });

  // Adversary R1: a cloud chat file the app cannot erase never blocks the phone's
  // chat erase, on this try or any retry. Each result is reported on its own,
  // with why (M1): 'unreadable' will not mend on a retry, 'unreachable' may.
  for (const [why, text, problem] of [
    ['unreadable', '{not json', 'unreadable'],
    ['written by a newer website (SchemaTooNewError)', JSON.stringify({ schemaVersion: 99, conversations: [], meta: { updatedAt: NOW, lamport: 1, lastDeviceId: 'web' } }), 'unreadable'],
    ['unreachable (the provider answers 500)', chat, 'unreachable'],
  ] as const) {
    it(`a cloud chat history that is ${why} is reported; the phone chat and the record are still erased`, async () => {
      const dropbox = new FakeDropbox();
      dropbox.put(await recordWith(['2026-10-01'], 'web'));
      dropbox.chat = { text, rev: 1 };
      dropbox.chatAnswers = problem !== 'unreachable';
      const { engine } = await phone(dropbox);
      await engine.cloudOpen('dropbox', 'ios-1', false);
      const kept: string[] = [];
      const result = JSON.parse(await engine.cloudErase(chat, NOW, (t) => { kept.push(t); return ''; })) as Erased;
      expect(result).toMatchObject({ success: true, erased: true, chatErased: true, cloudChatErased: false, cloudChatProblem: problem });
      expect(kept).toHaveLength(1);
      expect(kept[0]).not.toContain('Is my LDL high?');
      expect(dropbox.chat!.text).toBe(text);
      expect(dropbox.record.meta.eraseEpoch).toBe(1);
    });
  }

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

    const kept: string[] = [];
    const result = JSON.parse(await engine.cloudErase(chat, NOW, (text) => { kept.push(text); return ''; })) as Erased;
    expect(result).toMatchObject({ success: false, erased: false, chatErased: false, chatHistory: null, view: null });
    expect(kept).toEqual([]);
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
    // EngineHTTP.swift's allow-list for a Drive search: no orderBy (US-10 AC4a).
    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      expect([...u.searchParams.keys()].filter((key) => !['q', 'spaces', 'fields', 'pageSize', 'pageToken'].includes(key))).toEqual([]);
    }
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

/** The Dropbox app folder as the "+" lists it: list_folder (one level, or
 *  recursive) and download by id. An entry without a path is at the root. */
class FakeLabFolder implements Server {
  online = true;
  listed: Array<{ path: string; recursive?: boolean }> = [];
  downloads: string[] = [];
  /** Answers 401 to this many calls first (an access token Dropbox refused). */
  refuse = 0;
  /** A download's body in place of the default one, when it gives one. */
  bodyFor: (id: string) => string | null = () => null;
  /** A download's whole answer, in place of the file (a file gone since the listing). */
  answerDownload?: () => { status: number; headers: Record<string, string>; body: string };
  entries: Array<Record<string, unknown>> = [
    { '.tag': 'file', id: 'id:record', name: 'health-roadmap.json', size: 900, server_modified: '2026-10-22T01:00:00Z' },
    { '.tag': 'folder', id: 'id:imports', name: 'imports' },
    { '.tag': 'file', id: 'id:old', name: 'Lipids 2025.pdf', size: 2000, server_modified: '2025-03-01T00:00:00Z' },
    { '.tag': 'file', id: 'id:new', name: 'Bloods October.PDF', size: 3000, server_modified: '2026-10-20T00:00:00Z' },
    { '.tag': 'file', id: 'id:zip', name: 'Portal export.zip', size: 4000, server_modified: '2026-06-01T00:00:00Z' },
    { '.tag': 'file', id: 'id:photo', name: 'report.jpg', size: 5000, server_modified: '2026-09-01T00:00:00Z' },
    { '.tag': 'file', id: 'id:ds', name: '.DS_Store', size: 10, server_modified: '2026-10-21T00:00:00Z' },
    { '.tag': 'file', id: 'id:notes', name: 'notes.txt', size: 10, server_modified: '2026-10-21T00:00:00Z' },
    { '.tag': 'file', id: 'id:backup', name: 'health-roadmap.json.bak', size: 900, server_modified: '2026-10-21T00:00:00Z' },
  ];

  answer(url: string, headers: Record<string, string>, body: string | null): { status: number; headers: Record<string, string>; body: string } {
    if (this.refuse > 0) {
      this.refuse -= 1;
      return { status: 401, headers: {}, body: 'expired_access_token' };
    }
    if (headers.authorization !== 'Bearer token-1') return { status: 401, headers: {}, body: 'expired' };
    if (url.endsWith('/files/list_folder')) {
      const asked = JSON.parse(body!) as { path: string; recursive: boolean };
      this.listed.push(asked);
      const entries = this.entries.map((e) => ({ path_display: `/${String(e.name)}`, ...e })).filter((e) => {
        const parent = e.path_display.slice(0, e.path_display.lastIndexOf('/'));
        return asked.recursive ? e.path_display.startsWith(`${asked.path}/`) : parent === asked.path;
      });
      return { status: 200, headers: {}, body: JSON.stringify({ entries, has_more: false }) };
    }
    if (url.endsWith('/files/download')) {
      const { path } = JSON.parse(headers['dropbox-api-arg']) as { path: string };
      const answer = this.answerDownload?.();
      if (answer) return answer;
      this.downloads.push(path);
      return { status: 200, headers: {}, body: this.bodyFor(path) ?? `%PDF bytes of ${path}` };
    }
    throw new Error(`FakeLabFolder has no ${url}`);
  }
}

describe('lab files from the Dropbox app folder (US-52 AC11)', () => {
  it('lists the lab files at the folder root, newest first, and never the record, folders or other files', async () => {
    const folder = new FakeLabFolder();
    const { engine } = await phone(folder);
    const files = (JSON.parse(await engine.labFolderJson('')) as { files: Array<{ id: string; name: string; size: number; modified: string }> }).files;
    expect(files.map((f) => f.name)).toEqual(['Bloods October.PDF', 'report.jpg', 'Portal export.zip', 'Lipids 2025.pdf']);
    expect(files[0]).toEqual({ id: 'id:new', name: 'Bloods October.PDF', size: 3000, modified: '2026-10-20T00:00:00Z', folder: '', path: 'Bloods October.PDF' });
    expect(folder.listed).toEqual([expect.objectContaining({ path: '' })]);
  });

  it('downloads a listed file by its id and answers its bytes', async () => {
    const folder = new FakeLabFolder();
    const { engine } = await phone(folder);
    const file = await engine.labFile('id:new', '');
    expect(file.name).toBe('Bloods October.PDF'); // the fresh listing's name, which Swift reads it under (re-check R3)
    expect(Buffer.from(new Uint8Array(file.bytes)).toString('utf8')).toBe('%PDF bytes of id:new');
    expect(folder.downloads).toEqual(['id:new']);
  });

  it('downloads only by a listing id, never by a path', async () => {
    const folder = new FakeLabFolder();
    const { engine } = await phone(folder);
    await expect(engine.labFile('health-roadmap.json', '')).rejects.toThrow();
    await expect(engine.labFile('/Other/thing.pdf', '')).rejects.toThrow();
    expect(folder.downloads).toEqual([]);
  });

  it('R3: downloads only an id a fresh listing offers as a lab file, never the record or an unlisted id', async () => {
    const folder = new FakeLabFolder();
    const { engine } = await phone(folder);
    // A refusal is marked as one, so Swift never reads a name like "{scan}.pdf" as a failure's JSON (re-check R1).
    const refusal = await engine.labFile('id:record', '').then(() => ({} as { refused?: string }), (error: Error) => JSON.parse(error.message) as { refused?: string });
    expect(refusal.refused).toContain('not a lab file in the folder');
    await expect(engine.labFile('id:backup', '')).rejects.toThrow('not a lab file in the folder');
    await expect(engine.labFile('id:chat-history', '')).rejects.toThrow('not a lab file in the folder');
    expect(folder.downloads).toEqual([]);
    expect(folder.listed).toHaveLength(3); // each read lists the folder afresh
  });

  it('R5: a file over the size limit, or with no size, is refused before it downloads; a body over it after', async () => {
    const folder = new FakeLabFolder();
    folder.entries.push(
      { '.tag': 'file', id: 'id:big', name: 'Big.pdf', size: 10 * 1024 * 1024 + 1, server_modified: '2026-10-19T00:00:00Z' },
      { '.tag': 'file', id: 'id:bigzip', name: 'Big.zip', size: 20 * 1024 * 1024 + 1, server_modified: '2026-10-19T00:00:00Z' },
      { '.tag': 'file', id: 'id:nosize', name: 'Nosize.pdf', server_modified: '2026-10-19T00:00:00Z' },
      { '.tag': 'file', id: 'id:liar', name: 'Liar.pdf', size: 10, server_modified: '2026-10-19T00:00:00Z' },
    );
    folder.bodyFor = (id) => (id === 'id:liar' ? 'x'.repeat(10 * 1024 * 1024 + 1) : null);
    const { engine } = await phone(folder);
    for (const id of ['id:big', 'id:bigzip']) await expect(engine.labFile(id, '')).rejects.toThrow('larger than');
    // No size reads as 0 (dropboxListFolder), so it is refused as empty, never downloaded.
    await expect(engine.labFile('id:nosize', '')).rejects.toThrow('Nosize.pdf is empty.');
    expect(folder.downloads).toEqual([]);
    await expect(engine.labFile('id:liar', '')).rejects.toThrow('larger than');
  });

  it('re-check R2: an empty file is called empty, not too large, before and after the download', async () => {
    const folder = new FakeLabFolder();
    folder.entries.push(
      { '.tag': 'file', id: 'id:empty', name: '{scan}.pdf', size: 0, server_modified: '2026-10-19T00:00:00Z' },
      { '.tag': 'file', id: 'id:hollow', name: 'Hollow.pdf', size: 10, server_modified: '2026-10-19T00:00:00Z' },
    );
    folder.bodyFor = (id) => (id === 'id:hollow' ? '' : null);
    const { engine } = await phone(folder);
    const empty = await engine.labFile('id:empty', '').then(() => ({} as { refused?: string }), (error: Error) => JSON.parse(error.message) as { refused?: string });
    expect(empty.refused).toBe('{scan}.pdf is empty.');
    expect(folder.downloads).toEqual([]);
    await expect(engine.labFile('id:hollow', '')).rejects.toThrow('Hollow.pdf is empty.');
  });

  describe('US-52 AC13c: subfolders and a whole folder', () => {
    const tree = (folder: FakeLabFolder) => folder.entries.push(
      { '.tag': 'folder', id: 'id:labs', name: 'Labs' },
      { '.tag': 'folder', id: 'id:hidden', name: '.git' },
      { '.tag': 'folder', id: 'id:2025', name: '2025', path_display: '/Labs/2025' },
      { '.tag': 'folder', id: 'id:mac', name: '__MACOSX', path_display: '/Labs/__MACOSX' },
      { '.tag': 'file', id: 'id:a', name: 'a.pdf', path_display: '/Labs/a.pdf', size: 10, server_modified: '2026-01-01T00:00:00Z' },
      { '.tag': 'file', id: 'id:b', name: 'b.PNG', path_display: '/Labs/2025/b.PNG', size: 10, server_modified: '2026-02-01T00:00:00Z' },
      { '.tag': 'file', id: 'id:mac', name: 'c.pdf', path_display: '/Labs/__MACOSX/c.pdf', size: 10 },
      { '.tag': 'file', id: 'id:txt', name: 'notes.txt', path_display: '/Labs/notes.txt', size: 10 },
    );

    it('a folder lists its subfolders by name, hidden ones left out, and its own lab files only', async () => {
      const folder = new FakeLabFolder();
      tree(folder);
      const { engine } = await phone(folder);
      const root = JSON.parse(await engine.labFolderJson('')) as { folders: Array<{ name: string; path: string }>; files: unknown[] };
      expect(root.folders).toEqual([{ name: 'Labs', path: 'Labs' }]); // imports/ is the app's own
      expect(root.files).toHaveLength(4);
      const labs = JSON.parse(await engine.labFolderJson('Labs')) as { folders: Array<{ name: string; path: string }>; files: unknown[] };
      expect(labs.folders).toEqual([{ name: '2025', path: 'Labs/2025' }]);
      expect(labs.files).toEqual([{ id: 'id:a', name: 'a.pdf', size: 10, modified: '2026-01-01T00:00:00Z', folder: 'Labs', path: 'a.pdf' }]);
      expect(folder.listed.at(-1)).toEqual({ path: '/Labs', recursive: false, include_deleted: false });
    });

    it('a whole folder lists every lab file below it, each with its own folder, never a __MACOSX one', async () => {
      const folder = new FakeLabFolder();
      tree(folder);
      const { engine } = await phone(folder);
      const files = JSON.parse(await engine.labFolderFilesJson('Labs')) as Array<{ id: string; folder: string; path: string }>;
      expect(files.map((f) => [f.id, f.folder, f.path])).toEqual([['id:a', 'Labs', 'a.pdf'], ['id:b', 'Labs/2025', '2025/b.PNG']]);
      expect(folder.listed).toEqual([{ path: '/Labs', recursive: true, include_deleted: false }]);
    });

    it('at the root, the app\'s own folders (imports/, the stored originals\' folders) neither list nor read', async () => {
      const folder = new FakeLabFolder();
      tree(folder);
      folder.entries.push(
        { '.tag': 'folder', id: 'id:lr', name: 'Lab results' },
        { '.tag': 'file', id: 'id:kept', name: 'x.pdf', path_display: '/Lab results/x.pdf', size: 10 },
        { '.tag': 'folder', id: 'id:cl', name: 'clinic letters' },
        { '.tag': 'file', id: 'id:letter', name: 'y.pdf', path_display: '/clinic letters/y.pdf', size: 10 },
        { '.tag': 'file', id: 'id:parked', name: 'z.pdf', path_display: '/imports/z.pdf', size: 10 },
        { '.tag': 'folder', id: 'id:inner', name: 'Lab results', path_display: '/Labs/Lab results' },
        { '.tag': 'file', id: 'id:inner-file', name: 'w.pdf', path_display: '/Labs/Lab results/w.pdf', size: 10 },
      );
      const { engine } = await phone(folder);
      const root = JSON.parse(await engine.labFolderJson('')) as { folders: Array<{ name: string }>; hidden: string[] };
      expect(root.folders.map((f) => f.name)).toEqual(['Labs']);
      expect(root.hidden).toEqual(['clinic letters', 'imports', 'Lab results']);
      // R7: the engine itself refuses them, whatever the phone asks.
      for (const ask of [engine.labFolderJson('Lab results'), engine.labFolderFilesJson('imports'), engine.labFile('id:kept', 'Lab results'), engine.labFolderJson('Clinic Letters/old')]) {
        await expect(ask).rejects.toThrow("the app's own files");
      }
      expect(folder.downloads).toEqual([]);
      const all = (JSON.parse(await engine.labFolderFilesJson('')) as Array<{ id: string }>).map((f) => f.id);
      for (const id of ['id:kept', 'id:letter', 'id:parked']) expect(all).not.toContain(id);
      // Below the root, a folder of that name is the person's own.
      expect(all).toContain('id:inner-file');
      expect((JSON.parse(await engine.labFolderJson('Labs')) as { folders: Array<{ name: string }> }).folders.map((f) => f.name)).toEqual(['2025', 'Lab results']);
    });

    it('R2: a whole-folder read lists once, then downloads each offered id without listing again', async () => {
      const folder = new FakeLabFolder();
      tree(folder);
      const { engine } = await phone(folder);
      const files = JSON.parse(await engine.labFolderFilesJson('Labs')) as Array<{ id: string; folder: string }>;
      for (const file of files) await engine.labFile(file.id, file.folder);
      expect(folder.listed).toHaveLength(1);
      expect(folder.downloads).toEqual(['id:a', 'id:b']);
      // Still only ids that listing offered (R3): the record is refused, after a fresh listing of its folder.
      await expect(engine.labFile('id:record', '')).rejects.toThrow('not a lab file in the folder');
      expect(folder.downloads).toEqual(['id:a', 'id:b']);
      // Any other listing ends the read: a later tap lists afresh.
      await engine.labFolderJson('Labs');
      const before = folder.listed.length;
      await engine.labFile('id:a', 'Labs');
      expect(folder.listed).toHaveLength(before + 1);
    });

    it('R5: a file gone since the listing is refused as gone', async () => {
      const folder = new FakeLabFolder();
      tree(folder);
      const { engine } = await phone(folder);
      await engine.labFolderFilesJson('Labs');
      folder.answerDownload = () => ({ status: 409, headers: {}, body: '{"error_summary":"path/not_found/"}' });
      const gone = await engine.labFile('id:a', 'Labs').catch((error: Error) => JSON.parse(error.message) as { refused?: string; gone?: boolean });
      expect(gone).toEqual({ refused: 'a.pdf is not in the folder any more.', gone: true });
    });

    it('R3 still holds in a subfolder: a file downloads only when a fresh listing of its own folder offers it', async () => {
      const folder = new FakeLabFolder();
      tree(folder);
      const { engine } = await phone(folder);
      const file = await engine.labFile('id:b', 'Labs/2025');
      expect(file.name).toBe('b.PNG');
      await expect(engine.labFile('id:b', '')).rejects.toThrow('not a lab file in the folder');
      await expect(engine.labFile('id:record', 'Labs')).rejects.toThrow('not a lab file in the folder');
      expect(folder.downloads).toEqual(['id:b']);
    });
  });

  it('a refused token is refreshed once and the listing repeated', async () => {
    const folder = new FakeLabFolder();
    folder.refuse = 1;
    const { engine, state } = await phone(folder);
    expect(JSON.parse(await engine.labFolderJson('')).files).toHaveLength(4);
    expect(state.tokenRefreshes).toBe(1);
  });

  it('a failure rejects with its kind, for Swift to word: sign-in or unreachable', async () => {
    const folder = new FakeLabFolder();
    const signedOut = await phone(folder);
    signedOut.state.signedOut = true;
    await expect(signedOut.engine.labFolderJson('')).rejects.toThrow('"kind":"sign-in"');
    folder.online = false;
    const offline = await phone(folder);
    await expect(offline.engine.labFolderJson('')).rejects.toThrow('"kind":"unreachable"');
    await expect(offline.engine.labFile('id:new', '')).rejects.toThrow('"kind":"unreachable"');
  });
});

// US-52 AC13d: a clinic letter, and a lab report's original, filed as the web
// files them, through health-core's saveDocuments, from the engine bundle.
describe('documents from "Add medical records" (US-52 AC13d)', () => {
  const letter = JSON.stringify({
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
    document: { classification: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2026-09-14', contentMarkdown: '# Letter text', metadata: { specialty: 'cardiology' } },
  });
  const labs = JSON.stringify({ classification: 'lab_report', reportDate: '2026-10-01', values: [], additionalValues: [] });
  const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8')).buffer;
  const hashOf = (text: string) => `sha256-${createHash('sha256').update(text).digest('hex')}`;
  /** The review's choice; `of` names the original the phone read (its hash). */
  const choice = (over: object = {}, of = '%PDF letter') => JSON.stringify({ kind: 'document', sourceFileName: 'Letter.pdf', title: 'Heart clinic', documentDate: null, mimeType: 'application/pdf', contentHash: hashOf(of), ...over });
  type Answer = { ok: boolean; record: string; erase?: string; saved: number; unstored: number; stored: boolean | null; stale: boolean; reason?: string };
  async function opened(dropbox = new FakeDropbox()) {
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false)) as { erase: string };
    return { dropbox, engine, state, erase };
  }

  it('in the cloud: the original lands in the provider first, then the row, with the phone\'s hash, through the session', async () => {
    const { dropbox, engine, state, erase } = await opened();
    const answer = JSON.parse(await engine.documentSave('', letter, choice(), bytes('%PDF letter'), erase, NOW, 'ios-1')) as Answer;
    expect(answer).toMatchObject({ ok: true, saved: 1, unstored: 0, stored: true, stale: false });
    const ref = [...dropbox.documents.keys()][0];
    // The review's title, and no day: the ref takes today's (buildDocumentRef), the row keeps null.
    expect(ref).toMatch(/^\/Clinic letters\/\d{4}-\d{2}-\d{2} Heart clinic\.pdf$/);
    expect(dropbox.documents.get(ref)).toBe('%PDF letter');
    // On the phone first, marked pending, before the cloud save (US-09 AC4).
    expect(state.pending).toBe(true);
    expect((JSON.parse(state.phoneText!) as RoadmapFile).documents).toHaveLength(1);
    expect(await engine.cloudFlush()).toBe('saved');
    const [row] = dropbox.record.documents;
    expect(row).toMatchObject({
      type: 'clinic_letter', title: 'Heart clinic', date: null, fileRef: ref.slice(1), contentHash: hashOf('%PDF letter'),
      mimeType: 'application/pdf', extractedText: '# Letter text', metadata: { specialty: 'cardiology' }, sourceFileName: 'Letter.pdf',
    });
    // The same bytes again are already archived: nothing new (the web's contentHash dedup).
    const again = JSON.parse(await engine.documentSave('', letter, choice(), bytes('%PDF letter'), erase, NOW, 'ios-1')) as Answer;
    expect(again).toMatchObject({ ok: true, saved: 0 });
    expect(dropbox.documents.size).toBe(1);
  });

  it('R1: two saves at once with the same title and day get two refs, and both originals survive', async () => {
    const { dropbox, engine, erase } = await opened();
    const day = { documentDate: '2026-09-14' };
    const [a, b] = await Promise.all([
      engine.documentSave('', letter, choice(day, 'first'), bytes('first'), erase, NOW, 'ios-1'),
      engine.documentSave('', letter, choice({ ...day, sourceFileName: 'Letter 2.pdf' }, 'second'), bytes('second'), erase, NOW, 'ios-1'),
    ]);
    expect([JSON.parse(a), JSON.parse(b)]).toEqual([expect.objectContaining({ saved: 1, stored: true }), expect.objectContaining({ saved: 1, stored: true })]);
    expect(Object.fromEntries(dropbox.documents)).toEqual({
      '/Clinic letters/2026-09-14 Heart clinic.pdf': 'first',
      '/Clinic letters/2026-09-14 Heart clinic (2).pdf': 'second',
    });
    await engine.cloudFlush();
    expect(dropbox.record.documents.map((d) => d.fileRef).sort()).toEqual(['Clinic letters/2026-09-14 Heart clinic (2).pdf', 'Clinic letters/2026-09-14 Heart clinic.pdf']);
  });

  it('in the cloud: a lab report\'s original is kept as the web\'s hidden lab-archive row', async () => {
    const { dropbox, engine, erase } = await opened();
    const archive = JSON.stringify({ kind: 'labArchive', sourceFileName: 'Bloods.pdf', reportDay: '2026-10-01', mimeType: 'application/pdf', contentHash: hashOf('%PDF labs') });
    expect(JSON.parse(await engine.documentSave('', labs, archive, bytes('%PDF labs'), erase, NOW, 'ios-1'))).toMatchObject({ ok: true, saved: 1, stored: true });
    await engine.cloudFlush();
    expect(dropbox.record.documents[0]).toMatchObject({
      type: 'pathology_report', title: 'Blood test results', date: '2026-10-01', extractedText: '', metadata: { labArchive: true },
      fileRef: 'Lab results/2026-10-01 Blood test results.pdf', contentHash: hashOf('%PDF labs'),
    });
  });

  it('in the cloud: an original the provider refuses still files the row, metadata-only with its hash', async () => {
    const dropbox = new FakeDropbox();
    dropbox.documentsWork = false;
    const { engine, erase } = await opened(dropbox);
    expect(JSON.parse(await engine.documentSave('', letter, choice(), bytes('%PDF letter'), erase, NOW, 'ios-1'))).toMatchObject({ ok: true, saved: 1, stored: false, stale: false });
    await engine.cloudFlush();
    expect(dropbox.record.documents[0]).toMatchObject({ fileRef: '', mimeType: '', contentHash: hashOf('%PDF letter'), extractedText: '# Letter text' });
  });

  it('in the cloud: an original that changed or could not be read since the review is not uploaded; the row keeps the reviewed hash', async () => {
    const { dropbox, engine, erase } = await opened();
    const answer = JSON.parse(await engine.documentSave('', letter, choice(), null, erase, NOW, 'ios-1')) as Answer;
    expect(answer).toMatchObject({ ok: true, saved: 1, stored: false, stale: true });
    expect(dropbox.documents.size).toBe(0);
    await engine.cloudFlush();
    expect(dropbox.record.documents[0]).toMatchObject({ fileRef: '', contentHash: hashOf('%PDF letter'), extractedText: '# Letter text' });
  });

  it('US-14 AC4: an upload behind a held metadata-only row lands the original and replaces that row', async () => {
    const { dropbox, engine, erase } = await opened();
    // A first save whose original could not be read leaves a held row with the hash.
    await engine.documentSave('', letter, choice({ title: 'Edited' }), null, erase, NOW, 'ios-1');
    const answer = JSON.parse(await engine.documentSave('', letter, choice({ title: 'Edited' }), bytes('%PDF letter'), erase, NOW, 'ios-1')) as Answer;
    expect(answer).toMatchObject({ saved: 1, stored: true });
    await engine.cloudFlush();
    const live = dropbox.record.documents.filter((d) => !d.deleted);
    expect(live).toEqual([expect.objectContaining({ title: 'Edited', fileRef: expect.stringMatching(/^Clinic letters\//) })]);
    expect(dropbox.record.documents.filter((d) => d.deleted)).toHaveLength(1);
  });

  it('in the cloud: a save made for an erase the record is no longer at is refused, and nothing is uploaded', async () => {
    const { dropbox, engine } = await opened();
    const answer = JSON.parse(await engine.documentSave('', letter, choice(), bytes('%PDF letter'), '{"stale":true}', NOW, 'ios-1')) as Answer;
    expect(answer).toMatchObject({ ok: false, reason: 'erased' });
    expect(dropbox.documents.size).toBe(0);
  });

  it('R5: an erase that arrives while the original uploads refuses the row', async () => {
    const dropbox = new FakeDropbox();
    const { engine, erase } = await opened(dropbox);
    const before = dropbox.record;
    dropbox.delayFor = (url, headers) => (url.endsWith('/files/upload') && headers['dropbox-api-arg']?.includes('Clinic letters') ? 50 : undefined);
    const saving = engine.documentSave('', letter, choice(), bytes('%PDF letter'), erase, NOW, 'ios-1');
    dropbox.put(buildErasedFile({ stored: before, own: before, device: null, ctx: { deviceId: 'web', now: '2026-10-21T09:00:00.000Z' } }));
    expect(await engine.cloudRefresh()).toBe('changed');
    expect(JSON.parse(await saving)).toMatchObject({ ok: false, reason: 'erased' });
    await engine.cloudFlush();
    expect(dropbox.record.documents).toEqual([]);
  });

  it('R5: a session that closes while the original uploads files no row', async () => {
    const dropbox = new FakeDropbox();
    const { engine, state, erase } = await opened(dropbox);
    dropbox.delayFor = (url, headers) => (url.endsWith('/files/upload') && headers['dropbox-api-arg']?.includes('Clinic letters') ? 50 : undefined);
    const saving = engine.documentSave('', letter, choice(), bytes('%PDF letter'), erase, NOW, 'ios-1');
    await engine.cloudClose(false);
    expect(JSON.parse(await saving)).toMatchObject({ ok: false, reason: 'not-open' });
    expect((JSON.parse(state.phoneText!) as RoadmapFile).documents).toEqual([]);
  });

  it('on the phone alone: a text-only row (no original, no hash) added to the record Swift passed, as the web saves off-cloud', async () => {
    const { engine } = await phone(new FakeDropbox());
    const record = engine.newRecordJson(NOW, 'ios-1', 'en-NZ', 'Pacific/Auckland');
    const answer = JSON.parse(await engine.documentSave(record, letter, choice({ documentDate: '2026-09-14' }), bytes('%PDF letter'), '', NOW, 'ios-1')) as Answer;
    expect(answer).toMatchObject({ ok: true, saved: 1, stored: null, stale: false });
    expect((JSON.parse(answer.record) as RoadmapFile).documents).toEqual([expect.objectContaining({
      type: 'clinic_letter', title: 'Heart clinic', date: '2026-09-14', fileRef: '', contentHash: '', mimeType: '', extractedText: '# Letter text',
    })]);
    // A lab report's original is kept only in a cloud: off-cloud, nothing is filed.
    const archive = JSON.stringify({ kind: 'labArchive', sourceFileName: 'Bloods.pdf', reportDay: '2026-10-01', mimeType: 'application/pdf', contentHash: hashOf('x') });
    expect(JSON.parse(await engine.documentSave(record, labs, archive, bytes('x'), '', NOW, 'ios-1'))).toMatchObject({ ok: true, saved: 0, record });
    // An empty title keeps the model's, as the web's `docTitles[fi] || title`; a future day is unknown.
    const plain = JSON.parse(await engine.documentSave(record, letter, choice({ title: '', documentDate: '2099-01-01' }), null, '', NOW, 'ios-1')) as Answer;
    expect((JSON.parse(plain.record) as RoadmapFile).documents[0]).toMatchObject({ title: 'Cardiology follow-up', date: null });
  });

  it('refuses a document save for a lab report, and a cloud save with no session open', async () => {
    const { engine } = await phone(new FakeDropbox());
    const record = engine.newRecordJson(NOW, 'ios-1', 'en-NZ', 'Pacific/Auckland');
    expect(JSON.parse(await engine.documentSave(record, labs, choice(), null, '', NOW, 'ios-1'))).toMatchObject({ ok: false, reason: 'not-found' });
    expect(JSON.parse(await engine.documentSave('', letter, choice(), null, '{}', NOW, 'ios-1'))).toMatchObject({ ok: false, reason: 'not-open' });
  });
});
