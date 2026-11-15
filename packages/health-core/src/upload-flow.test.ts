/**
 * upload-flow.ts as a caller sees it (US-12 AC26, AC28; design docs/drafts/upload-shared-engine.md §1, §3):
 * a table of every per-file status against every file event, a table of every phase against every
 * flow event, then the effects the platform is asked to run.
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedExtractionResult } from './lab-extraction';
import {
  initialUpload, inFlight, saveEnabled, transition,
  type FileStatus, type UploadEvent, type UploadFile, type UploadState,
} from './upload-flow';
import { requestFlags, UPLOAD_LIMITS } from './upload-rules';

const WEB_FLAGS = requestFlags('web');

const EXT: UnifiedExtractionResult = { classification: 'lab_report', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: null };
const CHOICES = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const NOW = '2026-11-15T00:00:00Z';
const MB = 1024 * 1024;

const file = (id: string, status: FileStatus, hash: string | null = 'h'): UploadFile => ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: null, status });
function open(files: UploadFile[], over: Partial<Extract<UploadState, { phase: 'open' }>> = {}): Extract<UploadState, { phase: 'open' }> {
  return { phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: null, ...over };
}
const statusOf = (s: UploadState, id: string) => ('files' in s ? s.files.find((f) => f.id === id)?.status : undefined);

// --- per-file status x file event ------------------------------------------------

const STATUSES: Record<string, UploadFile> = {
  listing: file('x', { s: 'listing' }, null),
  waiting: file('x', { s: 'waiting' }, null),
  hashing: file('x', { s: 'hashing' }, null),
  hashed: file('x', { s: 'hashed' }),
  known: file('x', { s: 'known', as: 'document', archiveOnly: false }),
  refused: file('x', { s: 'refused', verdict: 'tooLarge' }, null),
  converting: file('x', { s: 'converting' }),
  ready: file('x', { s: 'ready', attempt: 1 }),
  sending: file('x', { s: 'sending', attempt: 2 }),
  read: file('x', { s: 'read', extraction: EXT, choices: CHOICES }),
  failedSend: { ...file('x', { s: 'failed', reason: 'busy', attempt: 2 }), pages: { count: 1, truncated: false } }, // pages still held
  failedConvert: file('x', { s: 'failed', reason: 'timeout', attempt: 0 }),
  failedFinal: file('x', { s: 'failed', reason: 'dailyLimit', attempt: 1 }),
  stopped: file('x', { s: 'stopped' }),
};
const FILE_EVENTS: Record<string, UploadEvent> = {
  hashed: { type: 'hashed', run: 1, id: 'x', hash: 'h2', known: null },
  hashedKnown: { type: 'hashed', run: 1, id: 'x', hash: 'h2', known: { as: 'labReport', archiveOnly: false } },
  converted: { type: 'converted', run: 1, id: 'x', pages: 3, truncated: false },
  convertFailed: { type: 'convertFailed', run: 1, id: 'x', reason: 'unreadable' },
  answered: { type: 'answered', run: 1, id: 'x', extraction: EXT, legacy: false, now: NOW },
  answeredLegacy: { type: 'answered', run: 1, id: 'x', extraction: EXT, legacy: true, now: NOW },
  sendFailed: { type: 'sendFailed', run: 1, id: 'x', failure: 'server_error' },
  hashFailed: { type: 'hashFailed', run: 1, id: 'x' },
  listed: { type: 'listed', run: 1, zip: 'x', members: [{ id: 'm', name: 'm.pdf', bytes: 1 }] },
  zipFailed: { type: 'zipFailed', run: 1, zip: 'x' },
  retry: { type: 'retry', id: 'x' },
  chose: { type: 'chose', now: '2026-11-15T00:00:00.000Z', id: 'x', change: { tick: 'v0', on: false } },
};
// The status each event leaves the file in ('=' unchanged). With one file the freed slot is taken at once,
// so `hashed` goes on to converting and `converted` on to sending.
const FILE_TABLE: Record<string, Record<string, string>> = {
  listing: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: 'gone', zipFailed: 'failed' , hashFailed: '=' },
  waiting: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  hashing: { hashed: 'converting', hashedKnown: 'known', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: 'failed' },
  hashed: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  known: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  refused: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  converting: { hashed: '=', hashedKnown: '=', converted: 'sending', convertFailed: 'failed', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  ready: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  sending: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: 'read', answeredLegacy: 'known', sendFailed: 'failed', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  read: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: 'read', listed: '=', zipFailed: '=' , hashFailed: '=' },
  failedSend: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: 'sending', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  failedConvert: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: 'converting', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  failedFinal: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
  stopped: { hashed: '=', hashedKnown: '=', converted: '=', convertFailed: '=', answered: '=', answeredLegacy: '=', sendFailed: '=', retry: '=', chose: '=', listed: '=', zipFailed: '=' , hashFailed: '=' },
};

describe('upload-flow: every file status x every file event (US-12 AC26)', () => {
  for (const [status, f] of Object.entries(STATUSES)) {
    for (const [name, e] of Object.entries(FILE_EVENTS)) {
      const want = FILE_TABLE[status][name];
      it(`${status} + ${name} -> ${want}`, () => {
        const s = open([f]);
        const { state, effects } = transition(s, e);
        if (want === '=') {
          expect(state).toEqual(s);
          expect(effects).toEqual([]);
        } else {
          expect(statusOf(state, 'x')?.s).toBe(want === 'gone' ? undefined : want); // gone: its members took its place
        }
      });
    }
  }

  it('a file event for another run, or another phase, changes nothing (US-12 AC5)', () => {
    const s = open([STATUSES.sending]);
    for (const e of Object.values(FILE_EVENTS)) {
      if (!('run' in e)) continue;
      expect(transition(s, { ...e, run: 0 })).toEqual({ state: s, effects: [] });
      expect(transition(s, { ...e, run: 2 })).toEqual({ state: s, effects: [] });
      const saving: UploadState = { phase: 'saving', platform: 'web', run: 1, files: [STATUSES.sending], started: NOW, firstRead: null, attempt: 1 };
      expect(transition(saving, e)).toEqual({ state: saving, effects: [] });
    }
  });
});

// --- phase x flow event ----------------------------------------------------------

const readFile = STATUSES.read;
const PHASES: Record<string, UploadState> = {
  choosing: initialUpload('web'),
  consent: { phase: 'consent', platform: 'phone', run: 1, files: [file('a', { s: 'waiting' }, null)], started: NOW, firstRead: null },
  open: open([readFile]),
  saving: { phase: 'saving', platform: 'web', run: 1, files: [readFile], started: NOW, firstRead: null, attempt: 1 },
  saveFailed: { phase: 'saveFailed', platform: 'web', run: 1, files: [readFile], started: NOW, firstRead: null, attempt: 1, message: 'm' },
  done: { phase: 'done', platform: 'web', run: 1, files: [readFile], started: NOW, firstRead: null, outcome: { values: 1, documents: 0, archived: 0 } },
  failed: { phase: 'failed', platform: 'web', run: 1, files: [file('z', { s: 'failed', reason: 'zipUnreadable', attempt: 0 })], started: NOW, firstRead: null },
};
const FLOW_EVENTS: Record<string, UploadEvent> = {
  picked: { type: 'picked', files: [{ id: 'p', name: 'p.pdf', bytes: 1, kind: 'file' }], needsConsent: false, now: NOW },
  consented: { type: 'consented' },
  listed: { type: 'listed', run: 1, zip: 'z', members: [] },
  zipFailed: { type: 'zipFailed', run: 1, zip: 'z' },
  stop: { type: 'stop' },
  saveStarted: { type: 'saveStarted' },
  saved: { type: 'saved', run: 1, attempt: 1, outcome: { values: 1, documents: 0, archived: 0 } },
  saveFailed: { type: 'saveFailed', run: 1, attempt: 1, message: 'm' },
  close: { type: 'close' },
  discard: { type: 'discard' },
};
// The phase each event leaves ('=' unchanged). Open holds one read file and nothing in flight, so no
// ZIP to list or fail (a failing ZIP: upload-flow.zip-limit.test.ts).
const PHASE_TABLE: Record<string, Record<string, string>> = {
  choosing: { picked: 'open', consented: '=', listed: '=', zipFailed: '=', stop: '=', saveStarted: '=', saved: '=', saveFailed: '=', close: '=', discard: '=' },
  consent: { picked: '=', consented: 'open', listed: '=', zipFailed: '=', stop: '=', saveStarted: '=', saved: '=', saveFailed: '=', close: 'choosing', discard: 'choosing' },
  open: { picked: '=', consented: '=', listed: '=', zipFailed: '=', stop: '=', saveStarted: 'saving', saved: '=', saveFailed: '=', close: '=', discard: 'choosing' },
  saving: { picked: '=', consented: '=', listed: '=', zipFailed: '=', stop: '=', saveStarted: '=', saved: 'done', saveFailed: 'saveFailed', close: '=', discard: '=' },
  saveFailed: { picked: '=', consented: '=', listed: '=', zipFailed: '=', stop: '=', saveStarted: 'saving', saved: '=', saveFailed: '=', close: '=', discard: 'choosing' },
  done: { picked: '=', consented: '=', listed: '=', zipFailed: '=', stop: '=', saveStarted: '=', saved: '=', saveFailed: '=', close: 'choosing', discard: 'choosing' },
  failed: { picked: '=', consented: '=', listed: '=', zipFailed: '=', stop: '=', saveStarted: '=', saved: '=', saveFailed: '=', close: 'choosing', discard: 'choosing' },
};

describe('upload-flow: every phase x every flow event', () => {
  for (const [phase, s] of Object.entries(PHASES)) {
    for (const [name, e] of Object.entries(FLOW_EVENTS)) {
      const want = PHASE_TABLE[phase][name];
      it(`${phase} + ${name} -> ${want}`, () => {
        const { state, effects } = transition(s, e);
        if (want === '=') expect({ state, effects }).toEqual({ state: s, effects: [] });
        else expect(state.phase).toBe(want);
      });
    }
  }
});

// --- what the platform is asked to do ---------------------------------------------

const pick = (files: Array<{ id: string; name: string; bytes?: number; kind?: 'file' | 'zip' }>, needsConsent = false): UploadEvent =>
  ({ type: 'picked', files: files.map((f) => ({ bytes: 1, kind: 'file', ...f })), needsConsent, now: NOW });

describe('upload-flow: effects', () => {
  it('a pick hashes each kept file first, lists each ZIP, and drops what upload-rules refuse', () => {
    const { state, effects } = transition(initialUpload('web'), pick([
      { id: 'a', name: 'a.pdf' }, { id: 'big', name: 'big.pdf', bytes: 11 * MB }, { id: 'z', name: 'z.zip', kind: 'zip' },
    ]));
    expect(state).toMatchObject({ phase: 'open', run: 1 });
    expect(statusOf(state, 'z')).toEqual({ s: 'listing' });
    expect(statusOf(state, 'big')).toEqual({ s: 'refused', verdict: 'tooLarge' });
    expect(effects).toEqual([
      { type: 'list', run: 1, id: 'z' }, { type: 'forget', run: 1, ids: ['big'] }, { type: 'hash', run: 1, id: 'a' },
    ]);
    expect(saveEnabled(state)).toBe(false); // a ZIP still to list counts as in flight
  });

  it('the phone refuses a kind it cannot read; each pick is a new run', () => {
    const first = transition(initialUpload('phone'), pick([{ id: 'd', name: 'd.docx' }])).state;
    expect(statusOf(first, 'd')).toEqual({ s: 'refused', verdict: 'unsupported' });
    const again = transition(transition(first, { type: 'close' }).state, pick([{ id: 'e', name: 'e.pdf' }]));
    expect(again.state.run).toBe(2);
    expect(again.effects).toEqual([{ type: 'hash', run: 2, id: 'e' }]);
  });

  it('consent holds everything, even the hash, until the person agrees (AC13e)', () => {
    const asked = transition(initialUpload('phone'), pick([{ id: 'a', name: 'a.pdf' }, { id: 'z', name: 'z.zip', kind: 'zip' }], true));
    expect(asked.state.phase).toBe('consent');
    expect(asked.effects).toEqual([]);
    expect(transition(asked.state, { type: 'consented' }).effects).toEqual([{ type: 'list', run: 1, id: 'z' }, { type: 'hash', run: 1, id: 'a' }]);
  });

  it('a listed ZIP adds its members by its name, hashes the kept ones, drops hidden and refused ones', () => {
    const s = open([{ ...file('z', { s: 'listing' }, null), name: 'z.zip' }], { platform: 'phone' });
    const { state, effects } = transition(s, { type: 'listed', run: 1, zip: 'z', members: [
      { id: 'm1', name: 'in/a.pdf', bytes: 1 }, { id: 'm2', name: '__MACOSX/._a.pdf', bytes: 1 }, { id: 'm3', name: 'b.heic', bytes: 1 },
    ] });
    expect(state).toMatchObject({ files: [{ id: 'm1', zip: 'z.zip', status: { s: 'hashing' } }, { id: 'm3', status: { s: 'refused', verdict: 'unsupported' } }] });
    expect(effects).toEqual([{ type: 'forget', run: 1, ids: ['m3', 'm2'] }, { type: 'hash', run: 1, id: 'm1' }]);
  });

  it('converts and sends never pass the platform counts; the first send starts as soon as one file is ready', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `f${i}`);
    let s: UploadState = open(ids.map((id) => file(id, { s: 'hashing' }, null)));
    const convertsOf = (fx: ReturnType<typeof transition>['effects']) => fx.filter((f) => f.type === 'convert').map((f) => 'id' in f && f.id);
    const started: unknown[] = [];
    for (const id of ids) { const st = transition(s, { type: 'hashed', run: 1, id, hash: id, known: null }); s = st.state; started.push(...convertsOf(st.effects)); }
    expect(started).toEqual(['f0', 'f1', 'f2']);
    const sent = transition(s, { type: 'converted', run: 1, id: 'f0', pages: 2, truncated: false });
    expect(sent.effects).toEqual([{ type: 'send', run: 1, id: 'f0', attempt: 1, flags: WEB_FLAGS }, { type: 'convert', run: 1, id: 'f3' }]);
    const full = open([...ids.slice(0, 5).map((id) => file(id, { s: 'sending', attempt: 1 })), file('c', { s: 'converting' })]);
    const queued = transition(full, { type: 'converted', run: 1, id: 'c', pages: 1, truncated: false });
    expect(queued.effects).toEqual([]); // five sending: the ready file waits
    expect(statusOf(queued.state, 'c')).toEqual({ s: 'ready', attempt: 1 });
    const oneFreed = transition(queued.state, { type: 'answered', run: 1, id: 'f0', extraction: EXT, legacy: false, now: NOW });
    expect(oneFreed.effects).toEqual([{ type: 'send', run: 1, id: 'c', attempt: 1, flags: WEB_FLAGS }]);
    const fullConverts = open([...ids.slice(0, 3).map((id) => file(id, { s: 'converting' })), file('w', { s: 'hashing' }, null)]);
    expect(transition(fullConverts, { type: 'hashed', run: 1, id: 'w', hash: 'hw', known: null }).effects).toEqual([]);
    expect(UPLOAD_LIMITS.web).toMatchObject({ sendsInFlight: 5, convertsInFlight: 3 });
    expect(UPLOAD_LIMITS.phone).toMatchObject({ sendsInFlight: 5, convertsInFlight: 3 });
  });

  it('a known file is never converted or sent; an archive-only one keeps its bytes for Save (design §2)', () => {
    const s = open([file('a', { s: 'hashing' }, null), file('b', { s: 'hashing' }, null)]);
    const a = transition(s, { type: 'hashed', run: 1, id: 'a', hash: 'ha', known: { as: 'document', archiveOnly: false } });
    expect(a.effects).toEqual([{ type: 'forget', run: 1, ids: ['a'] }]);
    const b = transition(a.state, { type: 'hashed', run: 1, id: 'b', hash: 'hb', known: { as: 'document', archiveOnly: true } });
    expect(b.effects).toEqual([]);
    expect(statusOf(b.state, 'b')).toEqual({ s: 'known', as: 'document', archiveOnly: true });
    expect(saveEnabled(b.state)).toBe(true);
  });

  it('stop aborts every send in flight, drops what was not read, and keeps the review (AC28)', () => {
    const s = open([
      file('r', { s: 'read', extraction: EXT, choices: CHOICES }), file('s1', { s: 'sending', attempt: 1 }), file('s2', { s: 'sending', attempt: 1 }),
      file('c', { s: 'converting' }), file('w', { s: 'waiting' }), file('f', { s: 'failed', reason: 'busy', attempt: 1 }), file('z', { s: 'listing' }),
    ]);
    const { state, effects } = transition(s, { type: 'stop' });
    expect(effects).toEqual([{ type: 'abort', run: 1, ids: ['s1', 's2'] }, { type: 'forget', run: 1, ids: ['s1', 's2', 'c', 'w', 'z'] }]);
    expect(state.phase).toBe('open');
    expect(['r', 's1', 'c', 'w', 'f'].map((id) => statusOf(state, id)?.s)).toEqual(['read', 'stopped', 'stopped', 'stopped', 'failed']);
    expect(saveEnabled(state)).toBe(true);
    // A late answer for a stopped file changes nothing.
    expect(transition(state, { type: 'answered', run: 1, id: 's1', extraction: EXT, legacy: false, now: NOW }).state).toEqual(state);
  });

  it('Save waits for every file in flight, never for a failed one (US-12 AC26)', () => {
    for (const stage of ['listing', 'waiting', 'hashing', 'hashed', 'converting', 'ready', 'sending'] as const) {
      const status = (stage === 'ready' || stage === 'sending' ? { s: stage, attempt: 1 } : { s: stage }) as FileStatus;
      const s = open([readFile, file('b', status)]);
      expect([stage, saveEnabled(s), inFlight(s)]).toEqual([stage, false, 1]);
      expect(transition(s, { type: 'saveStarted' }).effects).toEqual([]);
    }
    const failedOnly = open([readFile, STATUSES.failedFinal]);
    expect(saveEnabled(failedOnly)).toBe(true);
    expect(transition(failedOnly, { type: 'saveStarted' }).effects).toEqual([{ type: 'save', run: 1, attempt: 1 }]);
  });

  it('retry: a failed send goes back with its pages and the next attempt; a failed convert starts from the bytes', () => {
    const s = open([STATUSES.failedSend, { ...STATUSES.failedConvert, id: 'y' }, { ...STATUSES.failedFinal, id: 'z' }]);
    const { state, effects } = transition(s, { type: 'retry', id: 'all' });
    expect(effects).toEqual([{ type: 'send', run: 1, id: 'x', attempt: 3, flags: WEB_FLAGS }, { type: 'convert', run: 1, id: 'y' }]);
    expect(statusOf(state, 'z')?.s).toBe('failed'); // not retryable: stays
  });

  it('a save answer for another attempt changes nothing; a failed save retries as the next attempt', () => {
    const saving = transition(open([readFile]), { type: 'saveStarted' }).state;
    expect(transition(saving, { type: 'saved', run: 1, attempt: 2, outcome: { values: 0, documents: 0, archived: 0 } }).state).toBe(saving);
    const failed = transition(saving, { type: 'saveFailed', run: 1, attempt: 1, message: 'm' }).state;
    expect(transition(failed, { type: 'saveStarted' }).effects).toEqual([{ type: 'save', run: 1, attempt: 2 }]);
    const done = transition(saving, { type: 'saved', run: 1, attempt: 1, outcome: { values: 1, documents: 0, archived: 0 } });
    expect(done.effects).toEqual([{ type: 'forget', run: 1, ids: ['x'] }]);
  });

  it('close leaves only when nothing read would be lost; discard always aborts and drops', () => {
    const s = open([readFile, file('s', { s: 'sending', attempt: 1 })]);
    expect(transition(s, { type: 'close' }).state).toBe(s);
    expect(transition(s, { type: 'discard' })).toEqual({
      state: { phase: 'choosing', platform: 'web', run: 1 },
      effects: [{ type: 'abort', run: 1, ids: ['s'] }, { type: 'forget', run: 1, ids: ['x', 's'] }],
    });
    const nothingRead = open([file('w', { s: 'waiting' })]);
    expect(transition(nothingRead, { type: 'close' }).effects).toEqual([{ type: 'forget', run: 1, ids: ['w'] }]);
  });

  it('the first answer stamps the first-read time once; a legacy match is known, not read', () => {
    const s = open([file('a', { s: 'sending', attempt: 1 }), file('b', { s: 'sending', attempt: 1 })]);
    const one = transition(s, { type: 'answered', run: 1, id: 'a', extraction: EXT, legacy: true, now: 'T1' });
    expect(one.effects).toEqual([{ type: 'forget', run: 1, ids: ['a'] }]);
    expect(statusOf(one.state, 'a')).toEqual({ s: 'known', as: 'legacy', archiveOnly: false });
    const two = transition(one.state, { type: 'answered', run: 1, id: 'b', extraction: EXT, legacy: false, now: 'T2' }).state;
    expect(two).toMatchObject({ firstRead: 'T1' });
  });

  it('a choice lands on a read file only', () => {
    const { state } = transition(open([readFile]), { type: 'chose', now: '2026-11-15T00:00:00.000Z', id: 'x', change: { document: { title: 't' } } });
    const after = transition(state, { type: 'chose', now: '2026-11-15T00:00:00.000Z', id: 'x', change: { testDay: '2026-11-01' } }).state;
    expect(statusOf(after, 'x')).toMatchObject({ choices: { ticks: {}, testDay: '2026-11-01', document: { title: 't' } } });
  });
});
