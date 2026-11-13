// The fakes cloud.test.ts and cloud-erase-held.test.ts run the engine on (US-25 AC11):
// the engine bundle in an empty context, as in JavaScriptCore, an in-memory Dropbox
// behind the HTTP native, and the phone's record file as a string. Moved here from
// cloud.test.ts unchanged, so both files share one fake (S50b).
import { afterEach, expect } from 'vitest';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const here = dirname(fileURLToPath(import.meta.url));
export const NOW = '2026-10-21T08:00:00.000Z';

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
export class FakeDropbox {
  file: { text: string; rev: number } | null = null;
  /** `/chat-history.json`, which only the website writes (US-25 AC16). */
  chat: { text: string; rev: number } | null = null;
  /** False: the chat file's endpoints answer 500, the record's still work. */
  chatAnswers = true;
  online = true;
  /** Set: Swift refuses every request with these words, never sending it (S50b). */
  refusal?: string;
  delay = 0;
  delayFor?: Server['delayFor'];
  /** False: uploads fail with a 500; reads still work. */
  uploadsWork = true;
  /** True: record uploads are refused as a full Dropbox (409 path/insufficient_space), nothing written. */
  full = false;
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
    // An original the app filed, read back for My health's document page (US-73 AC12).
    if (url.endsWith('/files/download') && this.documents.has(arg.path)) return { status: 200, headers: {}, body: this.documents.get(arg.path)! };
    expect(['/health-roadmap.json', '/chat-history.json']).toContain(arg.path);
    const slot = arg.path === '/chat-history.json' ? 'chat' : 'file';
    const now = this[slot];
    if (slot === 'chat' && !this.chatAnswers) return { status: 500, headers: {}, body: 'internal_error' };
    if (url.endsWith('/files/download')) {
      if (!now) return { status: 409, headers: {}, body: '{"error_summary":"path/not_found/"}' };
      return { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `r${now.rev}` }) }, body: now.text };
    }
    if (!this.uploadsWork) return { status: 500, headers: {}, body: 'internal_error' };
    if (this.full) return { status: 409, headers: {}, body: '{"error_summary":"path/insufficient_space/"}' };
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

export interface Engine {
  newRecordJson(now: string, device: string, locale: string, zone: string): string;
  applyEditJson(record: string, edit: string, now: string, device: string): string;
  historyJson(record: string, metric: string, now: string, device: string, unitsJson?: string): string;
  cloudOpen(provider: string, device: string, first: boolean, mergePhone: boolean): Promise<string>;
  cloudLabImport(extraction: string, refs: string, reportDay: string, erase: string, units: string, now: string, unitsJson: string): string;
  labSaveSummaryJson(record: string, extraction: string, refs: string, reportDay: string, now: string, device: string): string;
  cloudEdit(edit: string, erase: string, units: string, now: string, unitsJson?: string, shownLpaUnit?: string): string;
  chatEditsJson(record: string, edits: string, now: string, device: string, today: string, unitsJson?: string): string;
  cloudVisible(): string;
  cloudHidden(): string;
  /** US-09 AC30 (lead A1 step e): Swift calls it when NWPathMonitor says the path is satisfied. */
  cloudOnline(): string;
  /** S50b (US-25 AC16i): is an erase made here unsent over a passing failure? */
  cloudEraseHeld(): Promise<string>;
  cloudFlush(): Promise<string>;
  cloudRefresh(): Promise<string>;
  cloudClose(copyDown: boolean): Promise<string>;
  cloudErase(historyText: string | null, now: string, keepChat?: (text: string) => string): Promise<string>;
  documentSave(record: string, extraction: string, choice: string, original: ArrayBuffer | null, erase: string, now: string, device: string): Promise<string>;
  documentOriginal(id: string): Promise<ArrayBuffer>;
}

const opened: Engine[] = [];
afterEach(async () => {
  for (const engine of opened.splice(0)) await engine.cloudClose(false);
});

/** The engine in an empty context, with the fake natives. */
/** A provider behind the HTTP native: the fake Dropbox, or the fake Drive. */
export interface Server {
  online: boolean;
  /** Set: every request is answered by Swift's own refusal with these words, never sent (S50b). */
  refusal?: string;
  answer(url: string, headers: Record<string, string>, body: string | null, method: string): { status: number; headers: Record<string, string>; body: string };
  /** Milliseconds every answer waits (an open still in flight). */
  delay?: number;
  /** Milliseconds one request's answer waits, in place of `delay`. */
  delayFor?(url: string, headers: Record<string, string>): number | undefined;
}

export async function phone(dropbox: Server, phoneText: string | null = null) {
  const state = { phoneText, pending: false, generation: 1, events: [] as Array<[string, string]>, tokenRefreshes: 0, signedOut: false, phoneWriteError: '', sessions: [] as number[],
    /** The token Swift holds, and what a forced refresh replaces it with (null: unchanged). */
    token: 'token-1', refreshedToken: null as string | null,
    /** True: a forced refresh is refused (sign in again), while the token held is still handed out. */
    refreshRefused: false,
    /** Set: every token ask fails with these words and no sign-in, as Swift's TokenAnswer.failed (S50b). */
    tokenError: null as string | null,
    /** Phone writes that fail before one works (lead S54); `phoneRemoveFails`: removes that leave the file. */
    phoneWriteFailures: 0, phoneRemoveFails: 0 };
  const encode = (text: string) => new Uint8Array(Buffer.from(text, 'utf8')).buffer;
  const decode = (bytes: ArrayBuffer) => Buffer.from(new Uint8Array(bytes)).toString('utf8');
  let next = 1;
  const native = {
    http(method: string, url: string, headers: string, body: ArrayBuffer | null, done: (s: number, t: string, h: string, b: ArrayBuffer | null, e: string | null) => void) {
      const wait = dropbox.delayFor?.(url, JSON.parse(headers) as Record<string, string>) ?? dropbox.delay ?? 0;
      setTimeout(() => {
        if (dropbox.refusal) return done(0, '', '{}', null, dropbox.refusal);
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
      if (force && state.refreshedToken && !state.refreshRefused) state.token = state.refreshedToken;
      setImmediate(() => (state.signedOut || (force && state.refreshRefused) ? done(null, 'Dropbox refused the sign-in.', true)
        : state.tokenError !== null ? done(null, state.tokenError, false) : done(state.token, null, false)));
    },
    phoneRead: () => JSON.stringify({ text: state.phoneText }),
    phoneWrite: (text: string) => {
      if (state.phoneWriteError) return state.phoneWriteError;
      if (state.phoneWriteFailures > 0 && state.phoneWriteFailures--) return 'The disk is full.';
      state.phoneText = text;
      return '';
    },
    phoneRemove: () => {
      if (state.phoneRemoveFails > 0 && state.phoneRemoveFails--) return; // Swift's try? removeItem: a failure says nothing
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
  // The engine's clock, moved on by `advance` (S50b's 24-hour bound); real time otherwise.
  vm.runInContext('Date.now = ((real) => () => real() + (globalThis.__clockOffset || 0))(Date.now);', ctx);
  const advance = (ms: number) => { (ctx as { __clockOffset?: number }).__clockOffset = ((ctx as { __clockOffset?: number }).__clockOffset ?? 0) + ms; };
  const engine = (ctx as unknown as { HealthEngine: Engine }).HealthEngine;
  opened.push(engine);
  return { engine, state, advance };
}

/** A record with one weight row per day given, written by `device`. */
export async function recordWith(days: string[], device: string): Promise<RoadmapFile> {
  const { engine } = await phone(new FakeDropbox());
  let record = engine.newRecordJson(NOW, device, 'en-NZ', 'Pacific/Auckland');
  for (const day of days) {
    const outcome = JSON.parse(engine.applyEditJson(record, JSON.stringify({ kind: 'add', metric: 'weight', value: 80, day }), NOW, device)) as { record: string };
    record = outcome.record;
  }
  return JSON.parse(record) as RoadmapFile;
}

export const days = (file: RoadmapFile) => file.measurements.filter((m) => m.status === 'active').map((m) => m.recordedAt.slice(0, 10)).sort();
export const add = (day: string) => JSON.stringify({ kind: 'add', metric: 'weight', value: 81, day });
/** A record's Lp(a) rows: core lab rows (US-66 AC1). */
export const lpaRows = (file: RoadmapFile) => file.labValues.filter((row) => row.core === true && row.metricName === 'lpa');

export class FakeDrive implements Server {
  online = true;
  folderMade = false;
  /** A file name every search finds nothing for: a document deleted from Drive. */
  missing: string | null = null;
  file: { text: string; version: number } | null = null;
  /** Runs at the version read that comes right before an upload. */
  beforeVersionCheck: (() => void) | null = null;
  private versionReads = 0;
  /** Runs right after each PATCH lands, until it answers true. */
  afterPatch: ((body: string) => boolean) | null = null;
  /** True: every call answers 401, the token expired. */
  expired = false;
  /** The token Drive accepts; any other bearer answers 401, counted (lead S57b). */
  bearer = 'token-1';
  unauthorized = 0;
  patches = 0;
  /** Originals filed in Drive, by file name (US-73 AC12). */
  documents = new Map<string, string>();

  put(record: RoadmapFile): void {
    this.file = { text: JSON.stringify(record), version: (this.file?.version ?? 0) + 1 };
  }
  get record(): RoadmapFile {
    return JSON.parse(this.file!.text) as RoadmapFile;
  }

  answer(url: string, headers: Record<string, string>, body: string | null, method: string): ReturnType<Server['answer']> {
    const ok = (json: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(json) });
    if (this.expired) return { status: 401, headers: {}, body: 'expired' };
    if (headers.authorization !== `Bearer ${this.bearer}`) {
      this.unauthorized += 1;
      return { status: 401, headers: {}, body: 'expired' };
    }
    const u = new URL(url);
    const q = u.searchParams.get('q') ?? '';
    // EngineHTTP.swift's allow-list for a Drive search: no orderBy (US-10 AC4a).
    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      expect([...u.searchParams.keys()].filter((key) => !['q', 'spaces', 'fields', 'pageSize', 'pageToken'].includes(key))).toEqual([]);
    }
    if (method === 'GET' && u.pathname === '/drive/v3/files' && q.includes('application/vnd.google-apps.folder')) {
      return ok({ files: this.folderMade ? [{ id: 'folder-1', name: 'Health Plan by Dr Brad' }] : [] });
    }
    if (method === 'GET' && u.pathname === '/drive/v3/files' && this.missing && q.includes(this.missing)) return ok({ files: [] });
    const names = [...this.documents.keys()];
    const named = names.findIndex((name) => q.includes(name));
    if (method === 'GET' && u.pathname === '/drive/v3/files' && named >= 0) return ok({ files: [{ id: `doc-${named}` }] });
    const doc = /^\/drive\/v3\/files\/doc-(\d+)$/.exec(u.pathname);
    if (method === 'GET' && doc && u.searchParams.get('alt') === 'media') {
      return { status: 200, headers: { 'Content-Type': 'application/pdf' }, body: this.documents.get(names[Number(doc[1])])! };
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
      this.patches += 1;
      if (this.afterPatch?.(body!)) this.afterPatch = null;
      return ok({ id: 'file-1', version: String(this.file.version) });
    }
    throw new Error(`FakeDrive has no ${method} ${url}`);
  }
}
