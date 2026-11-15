/**
 * upload-flow.ts over seeded random event sequences (US-12 AC26, AC28; the chat-turn.property.test.ts
 * pattern). mulberry32, no dependency: 600 sequences of 1-120 events, landings sometimes for the
 * current run and sometimes stale. Invariants after every step; a failure prints the seed and the
 * events. Reachability counts prove the generator visits the states the invariants are about.
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedExtractionResult } from './lab-extraction';
import {
  initialUpload, inFlight, saveEnabled, transition,
  type FileStage, type UploadEffect, type UploadEvent, type UploadState,
} from './upload-flow';
import { UPLOAD_LIMITS, type UploadPlatform } from './upload-rules';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXT: UnifiedExtractionResult = { classification: 'other', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: null };
const NAMES = ['a.pdf', 'b.jpg', 'c.docx', 'd.heic', '.hidden.pdf', '__MACOSX/e.pdf'];
const MB = 1024 * 1024;

/** `history`: every id minted so far, older runs' (closed, discarded, failed) included. */
function genEvent(r: () => number, s: UploadState, mint: () => string, history: string[]): UploadEvent {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  // Mostly the current run; else any older run (a closed or discarded one) or the next one.
  const run = coin(0.85) ? s.run : Math.floor(r() * (s.run + 2));
  const files = 'files' in s ? s.files : [];
  /** Mostly a file at the stage the event lands on; sometimes any file (a stopped one, say), an old run's id, or none. */
  const idAt = (stage: FileStage) => {
    const at = files.filter((f) => f.status.s === stage);
    if (run !== s.run && history.length && coin(0.7)) return pick(history);
    if (at.length && coin(0.75)) return pick(at).id;
    if (history.length && coin(0.1)) return pick(history);
    return files.length && coin(0.8) ? pick(files).id : 'nobody';
  };
  const id = idAt('failed');
  const kinds: Array<[number, () => UploadEvent]> = [
    [4, () => ({ type: 'picked', needsConsent: coin(0.2), now: 'T0', files: Array.from({ length: 1 + Math.floor(r() * 20) }, () => {
      const zip = coin(0.15);
      return { id: mint(), name: zip ? 'z.zip' : pick(NAMES), bytes: coin(0.1) ? 30 * MB : 1, kind: zip ? 'zip' as const : 'file' as const };
    }) })],
    [2, () => ({ type: 'consented' })],
    [4, () => ({ type: 'listed', run, zip: idAt('listing'),
      members: Array.from({ length: Math.floor(r() * 6) }, () => ({ id: mint(), name: pick(NAMES), bytes: coin(0.1) ? 30 * MB : 1 })) })],
    [1, () => ({ type: 'zipFailed', run, zip: idAt('listing') })],
    [14, () => ({ type: 'hashed', run, id: idAt('waiting'), hash: mint(), known: coin(0.25) ? { as: pick(['document', 'labReport'] as const), archiveOnly: coin(0.3) } : null })],
    [16, () => ({ type: 'converted', run, id: idAt('converting'), pages: 1, truncated: coin(0.1) })],
    [2, () => ({ type: 'convertFailed', run, id: idAt('converting'), reason: pick(['unreadable', 'timeout'] as const) })],
    [2, () => ({ type: 'answered', run, id: idAt('sending'), extraction: EXT, legacy: coin(0.1), now: 'T1' })],
    [2, () => ({ type: 'sendFailed', run, id: idAt('sending'), failure: coin(0.15) ? 'rate_limit' : pick(['busy', 'server_error', 'network', 'refused', 'too_long'] as const) })],
    [3, () => ({ type: 'retry', id: coin(0.5) ? 'all' : id })],
    [2, () => ({ type: 'stop' })],
    [2, () => ({ type: 'chose', id: idAt('read'), change: { tick: 'v', on: coin(0.5) } })],
    [3, () => ({ type: 'saveStarted' })],
    [3, () => ({ type: 'saved', run, attempt: 'attempt' in s && coin(0.8) ? s.attempt : 9, outcome: { values: 0, documents: 0, archived: 0 } })],
    [1, () => ({ type: 'saveFailed', run, attempt: 'attempt' in s && coin(0.8) ? s.attempt : 9, message: 'm' })],
    [1, () => ({ type: 'close' })],
    [1, () => ({ type: 'discard' })],
  ];
  let w = r() * kinds.reduce((n, [k]) => n + k, 0);
  for (const [k, make] of kinds) if ((w -= k) < 0) return make();
  return kinds[0][1]();
}

const FILE_EVENTS = new Set(['listed', 'zipFailed', 'hashed', 'converted', 'convertFailed', 'answered', 'sendFailed', 'saved', 'saveFailed']);
const stageOf = (s: UploadState, id: string): FileStage | undefined => ('files' in s ? s.files.find((f) => f.id === id)?.status.s : undefined);
const count = (s: UploadState, stage: FileStage) => ('files' in s ? s.files.filter((f) => f.status.s === stage).length : 0);
const LEAVING = new Set(['choosing', 'failed', 'done']);

const ANSWER: Partial<Record<FileStage, UploadEffect['type']>> = { listing: 'list', waiting: 'hash', converting: 'convert', sending: 'send' };
const fileId = (e: UploadEvent) => ('id' in e ? e.id : 'zip' in e ? e.zip : null);

/**
 * Progress: in `open`, every file not at rest has an effect outstanding for its stage (`pending`, kept
 * by the loop), or waits only because its slots are full. A quiesced run strands nothing.
 */
function stranded(next: UploadState, pending: Map<string, string>, platform: UploadPlatform): string | null {
  if (next.phase !== 'open') return null;
  const limits = UPLOAD_LIMITS[platform];
  for (const f of next.files) {
    const want = ANSWER[f.status.s];
    if (want && pending.get(f.id) !== want) return `progress: ${f.status.s} file with no ${want} outstanding`;
    if (f.status.s === 'hashed' && count(next, 'converting') < limits.convertsInFlight) return 'progress: hashed file with a convert slot free';
    if (f.status.s === 'ready' && count(next, 'sending') < limits.sendsInFlight) return 'progress: ready file with a send slot free';
  }
  return null;
}

/** Returns the broken invariant, or null. `barred`: ids ever known or refused. */
function check(prev: UploadState, e: UploadEvent, next: UploadState, fx: UploadEffect[], platform: UploadPlatform, barred: Set<string>): string | null {
  const limits = UPLOAD_LIMITS[platform];
  // An answer for a file Stop reached first changes nothing (AC28).
  const target = fileId(e);
  if (FILE_EVENTS.has(e.type) && target !== null && stageOf(prev, target) === 'stopped' && (JSON.stringify(next) !== JSON.stringify(prev) || fx.length)) return 'an answer after Stop changed something';
  if (count(next, 'converting') > limits.convertsInFlight) return 'more converting than convertsInFlight';
  if (count(next, 'sending') > limits.sendsInFlight) return 'more sending than sendsInFlight';
  if (FILE_EVENTS.has(e.type) && 'run' in e && e.run !== prev.run && (JSON.stringify(next) !== JSON.stringify(prev) || fx.length)) return 'a stale run changed something';
  if (e.type === 'stop') {
    const sending = 'files' in prev ? prev.files.filter((f) => f.status.s === 'sending').map((f) => f.id) : [];
    const aborted = fx.filter((f) => f.type === 'abort').flatMap((f) => (f.type === 'abort' ? f.ids : []));
    if (JSON.stringify(aborted) !== JSON.stringify(sending)) return 'stop did not abort exactly the sending files';
    if (prev.phase === 'open' && (count(next, 'sending') || count(next, 'converting') || count(next, 'waiting') || count(next, 'hashed') || count(next, 'ready') || count(next, 'listing'))) return 'stop left a file in flight';
  }
  const busy = 'files' in next && next.files.some((f) => ['listing', 'waiting', 'hashed', 'converting', 'ready', 'sending'].includes(f.status.s));
  if (saveEnabled(next) !== (next.phase === 'open' && !busy)) return 'Save enabled is not "open with nothing in flight"';
  for (const f of fx) {
    if ('run' in f && f.run !== next.run) return `${f.type} for another run`;
    switch (f.type) {
      case 'hash': if (stageOf(next, f.id) !== 'waiting') return 'hash for a file not waiting'; break;
      case 'convert': if (stageOf(next, f.id) !== 'converting' || barred.has(f.id)) return 'convert for a file not converting, or known/refused'; break;
      case 'send': {
        const st = 'files' in next ? next.files.find((x) => x.id === f.id)?.status : undefined;
        if (st?.s !== 'sending' || st.attempt !== f.attempt || barred.has(f.id)) return 'send for a file not sending, or known/refused';
        break;
      }
      case 'list': if (next.phase !== 'open' || stageOf(next, f.id) !== 'listing') return 'list for a ZIP not listing'; break;
      case 'abort': if (f.ids.some((id) => stageOf(prev, id) !== 'sending') || f.ids.some((id) => !LEAVING.has(next.phase) && stageOf(next, id) !== 'stopped')) return 'abort for a file not sending, or left running'; break;
      case 'forget':
        if (!LEAVING.has(next.phase) && f.ids.some((id) => ['listing', 'waiting', 'hashed', 'converting', 'ready', 'sending', 'read'].includes(stageOf(next, id) ?? ''))) return 'forget for a file still needed';
        break;
      case 'save': if (next.phase !== 'saving' || next.attempt !== f.attempt) return 'save not the attempt in flight'; break;
    }
  }
  return null;
}

describe('upload-flow property: invariants over random sequences (US-12 AC26, AC28)', () => {
  it('holds for 600 seeded sequences of 1-120 events', () => {
    let steps = 0;
    const seen = { staleOldRun: 0, afterStopAnswer: 0, dailyLimit: 0, zipFailedOpen: 0, quiesced: 0, fullConverts: 0, fullSends: 0, staleLanding: 0, stopAborted: 0, saveEnabledWithFailed: 0, knownArchive: 0, readyBehindFullSends: 0, retried: 0, done: 0, listedMembers: 0 };
    for (let seed = 1; seed <= 600; seed++) {
      const r = mulberry32(seed);
      const platform: UploadPlatform = seed % 2 ? 'web' : 'phone';
      let n = 0;
      const mint = () => `i${seed}-${n++}`;
      let s = initialUpload(platform);
      const barred = new Set<string>();
      const history: string[] = [];
      const pending = new Map<string, string>();
      const events: UploadEvent[] = [];
      const len = 1 + Math.floor(r() * 120);
      for (let i = 0; i < len; i++) {
        const e = genEvent(r, s, mint, history);
        events.push(e);
        const before = JSON.stringify(s);
        const { state, effects } = transition(s, e);
        for (const f of 'files' in state ? state.files : []) {
          const asked = effects.find((x) => 'id' in x && x.id === f.id && Object.values(ANSWER).includes(x.type));
          if (asked) pending.set(f.id, asked.type);
          else if (stageOf(s, f.id) !== f.status.s) pending.delete(f.id);
        }
        const broken = JSON.stringify(s) !== before ? 'purity: the input state was mutated'
          : check(s, e, state, effects, platform, barred) ?? stranded(state, pending, platform);
        if (broken) throw new Error(`${broken}\nseed ${seed}, step ${i}\nevents: ${JSON.stringify(events)}\nprev: ${before}\nnext: ${JSON.stringify(state)}\neffects: ${JSON.stringify(effects)}`);
        if ('files' in state) for (const f of state.files) {
          if (f.status.s === 'known' || f.status.s === 'refused') barred.add(f.id);
          if (!history.includes(f.id)) history.push(f.id);
        }
        if ('run' in e && e.run < s.run - 1) seen.staleOldRun++;
        const target = fileId(e);
        if (FILE_EVENTS.has(e.type) && target !== null && stageOf(s, target) === 'stopped') seen.afterStopAnswer++;
        if ('files' in state && state.files.some((f) => f.status.s === 'failed' && f.status.reason === 'dailyLimit') && count(state, 'sending')) seen.dailyLimit++;
        if (e.type === 'zipFailed' && state.phase === 'open' && state !== s) seen.zipFailedOpen++;
        if (state.phase === 'open' && inFlight(state) === 0 && inFlight(s) > 0) seen.quiesced++; // settled: nothing stranded on the way
        if (count(state, 'converting') === UPLOAD_LIMITS[platform].convertsInFlight) seen.fullConverts++;
        if (count(state, 'sending') === UPLOAD_LIMITS[platform].sendsInFlight) seen.fullSends++;
        if (count(state, 'sending') === UPLOAD_LIMITS[platform].sendsInFlight && count(state, 'ready')) seen.readyBehindFullSends++;
        if (FILE_EVENTS.has(e.type) && 'run' in e && e.run !== s.run && 'files' in s) seen.staleLanding++;
        if (effects.some((f) => f.type === 'abort') && e.type === 'stop') seen.stopAborted++;
        if (saveEnabled(state) && count(state, 'failed')) seen.saveEnabledWithFailed++;
        if ('files' in state && state.files.some((f) => f.status.s === 'known' && f.status.archiveOnly)) seen.knownArchive++;
        if (e.type === 'retry' && effects.length) seen.retried++;
        if (state.phase === 'done') seen.done++;
        if (e.type === 'listed' && effects.some((f) => f.type === 'hash')) seen.listedMembers++;
        s = state;
        steps++;
      }
    }
    expect(steps).toBeGreaterThan(10000);
    for (const [name, k] of Object.entries(seen)) expect([name, k > 0]).toEqual([name, true]);
  });
});
