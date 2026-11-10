/**
 * US-12 AC4, AC6, AC6c — the upload flow's one named state, changed only
 * through a pure transition. Every phase x every event names the exact state
 * that follows; an event a phase does not take returns the same state object.
 */
import { describe, it, expect } from 'vitest';
import { transition, NO_OUTCOME, INITIAL_UPLOAD, type UploadState, type UploadEvent, type UploadPhase, type SaveOutcome } from './upload-flow-state';
import type { FileNotice, FileResult } from './upload-pipeline';

const file = new File(['x'], 'a.pdf');
const notice: FileNotice = { name: 'big.pdf', reason: 'tooLarge' };
const result: FileResult = { fileName: 'a.pdf', reportDate: null, values: [], additionalValues: [] };
const refusedLab = { key: 'k', unit: 'u' } as SaveOutcome['refusedLabUnits'][number];
const refusedCore = { metricType: 'ldl' } as SaveOutcome['refusedMeasurements'][number];
const outcome: SaveOutcome = {
  values: 2, labValues: 3, documents: ['sha256-a'], skippedValues: 1, skippedLabValues: 1, unstored: 1,
  refusedLabUnits: [refusedLab], refusedMeasurements: [refusedCore],
};
const progress = { current: 40, total: 100, fileName: 'a.pdf' };
const RUN = 1;

const STATES: Record<UploadPhase, UploadState> = {
  picking: { phase: 'picking', notices: [notice], skipArchive: false },
  reading: { phase: 'reading', run: RUN, files: [file], notices: [notice], progress, skipArchive: false },
  readFailed: { phase: 'readFailed', run: RUN, files: [file], notices: [notice], message: 'No readable files found.', skipArchive: false },
  reviewing: { phase: 'reviewing', run: RUN, results: [result], notices: [notice], outcome: NO_OUTCOME, skipArchive: false },
  saving: { phase: 'saving', results: [result], notices: [notice], outcome, skipArchive: false },
  saveFailed: { phase: 'saveFailed', results: [result], notices: [notice], outcome, message: 'Failed to save. Please try again.', skipArchive: false },
  done: { phase: 'done', results: [result], notices: [notice], outcome, skipArchive: false },
};

const newProgress = { current: 70, total: 100, fileName: 'b.pdf' };
/** An attempt: one value, a new and a repeat document, its own skips. */
const attempt: SaveOutcome = { ...NO_OUTCOME, values: 1, documents: ['sha256-a', 'sha256-b'], skippedValues: 4 };
/** `outcome` plus `attempt`: counts add, documents once, the rest the attempt's. */
const merged: SaveOutcome = { ...NO_OUTCOME, values: 3, labValues: 3, documents: ['sha256-a', 'sha256-b'], skippedValues: 4 };
const EVENTS: Record<UploadEvent['type'], UploadEvent> = {
  picked: { type: 'picked', run: 2, files: [file], notices: [] },
  progress: { type: 'progress', run: RUN, progress: newProgress },
  readFailed: { type: 'readFailed', run: RUN, message: 'Daily upload limit reached.', notices: [] },
  read: { type: 'read', run: RUN, results: [result], notices: [] },
  cancel: { type: 'cancel', run: RUN },
  close: { type: 'close' },
  discard: { type: 'discard' },
  skipConnect: { type: 'skipConnect' },
  saveStarted: { type: 'saveStarted' },
  saved: { type: 'saved', attempt },
  saveFailed: { type: 'saveFailed', message: 'Some items could not be saved. Please try again.', attempt },
};

const PREPARING = { current: 0, total: 100, fileName: 'Preparing upload...' };
const reset: UploadState = INITIAL_UPLOAD;
const skipped = (phase: UploadPhase): UploadState => ({ ...STATES[phase], skipArchive: true });
const reading2: UploadState = { phase: 'reading', run: 2, files: [file], notices: [], progress: PREPARING, skipArchive: false };

/** The state each event leads to; `same` = ignored, the identical object back. */
type Next = UploadState | 'same';
const s = 'same' as const;
const TABLE: Record<UploadPhase, Record<UploadEvent['type'], Next>> = {
  picking: {
    picked: reading2, progress: s, readFailed: s, read: s, cancel: s, close: reset, discard: reset,
    skipConnect: skipped('picking'), saveStarted: s, saved: s, saveFailed: s,
  },
  reading: {
    picked: s, progress: { ...STATES.reading, progress: newProgress } as UploadState,
    readFailed: { phase: 'readFailed', run: RUN, files: [file], notices: [], message: 'Daily upload limit reached.', skipArchive: false },
    read: { phase: 'reviewing', run: RUN, results: [result], notices: [], outcome: NO_OUTCOME, skipArchive: false },
    cancel: reset, close: s, discard: reset, skipConnect: skipped('reading'), saveStarted: s, saved: s, saveFailed: s,
  },
  readFailed: {
    picked: reading2, progress: s, readFailed: s, read: s, cancel: reset, close: reset, discard: reset,
    skipConnect: skipped('readFailed'), saveStarted: s, saved: s, saveFailed: s,
  },
  reviewing: {
    picked: s, progress: s, readFailed: s, read: s, cancel: reset, close: s, discard: reset, skipConnect: skipped('reviewing'),
    saveStarted: { phase: 'saving', results: [result], notices: [notice], outcome: NO_OUTCOME, skipArchive: false },
    saved: s, saveFailed: s,
  },
  saving: {
    picked: s, progress: s, readFailed: s, read: s, cancel: s, close: s, discard: s, skipConnect: skipped('saving'), saveStarted: s,
    saved: { phase: 'done', results: [result], notices: [notice], outcome: merged, skipArchive: false },
    saveFailed: { phase: 'saveFailed', results: [result], notices: [notice], outcome: merged, message: 'Some items could not be saved. Please try again.', skipArchive: false },
  },
  saveFailed: {
    picked: s, progress: s, readFailed: s, read: s, cancel: s, close: s, discard: reset, skipConnect: skipped('saveFailed'),
    saveStarted: { phase: 'saving', results: [result], notices: [notice], outcome: { ...NO_OUTCOME, values: 2, labValues: 3, documents: ['sha256-a'] }, skipArchive: false },
    saved: s, saveFailed: s,
  },
  done: {
    picked: s, progress: s, readFailed: s, read: s, cancel: s, close: reset, discard: reset,
    skipConnect: skipped('done'), saveStarted: s, saved: s, saveFailed: s,
  },
};

const ROWS = (Object.keys(TABLE) as UploadPhase[]).flatMap(phase =>
  (Object.keys(TABLE[phase]) as UploadEvent['type'][]).map(event => [phase, event, TABLE[phase][event]] as const));

describe('US-12 AC4, AC6, AC6c — the upload flow transition', () => {
  it('covers every phase x every event', () => {
    expect(ROWS).toHaveLength(Object.keys(STATES).length * Object.keys(EVENTS).length);
  });

  it.each(ROWS)('%s + %s', (phase, event, next) => {
    const state = STATES[phase];
    const after = transition(state, EVENTS[event]);
    if (next === 'same') expect(after).toBe(state);
    else expect(after).toEqual(next);
  });

  it('a pick without files stays on the dropzone with its notices (oversize only)', () => {
    const pick: UploadEvent = { type: 'picked', run: 2, files: [], notices: [notice] };
    expect(transition(INITIAL_UPLOAD, pick)).toEqual({ phase: 'picking', notices: [notice], skipArchive: false });
    expect(transition(STATES.readFailed, pick)).toEqual({ phase: 'picking', notices: [notice], skipArchive: false });
  });

  describe('US-12 AC4: run identity — a stale run lands nowhere', () => {
    const stale = 2;
    it.each<UploadEvent>([
      { type: 'progress', run: stale, progress: newProgress },
      { type: 'read', run: stale, results: [result], notices: [] },
      { type: 'readFailed', run: stale, message: 'stale', notices: [] },
      { type: 'cancel', run: stale },
    ])('reading run 1 ignores $type from run 2', event => {
      expect(transition(STATES.reading, event)).toBe(STATES.reading);
    });
    it.each(['readFailed', 'reviewing'] as const)('a Cancel from another run leaves %s alone', phase => {
      expect(transition(STATES[phase], { type: 'cancel', run: stale })).toBe(STATES[phase]);
    });
  });

  describe('US-12 AC4: the connect-first gate', () => {
    it('cancel keeps a skipped gate skipped', () => {
      expect(transition(skipped('reading'), EVENTS.cancel)).toEqual({ ...INITIAL_UPLOAD, skipArchive: true });
    });
    it.each(['picking', 'readFailed', 'done'] as const)('close from %s resets the gate', phase => {
      expect(transition(skipped(phase), EVENTS.close)).toEqual(INITIAL_UPLOAD);
    });
    it('close elsewhere only hides: the gate stays skipped', () => {
      const state = skipped('reviewing');
      expect(transition(state, EVENTS.close)).toBe(state);
    });
    it('discard resets the gate', () => {
      expect(transition(skipped('reviewing'), EVENTS.discard)).toEqual(INITIAL_UPLOAD);
    });
    it('a pick keeps the gate skipped into the read and the review', () => {
      const read = transition(transition(skipped('picking'), EVENTS.picked), { type: 'read', run: 2, results: [result], notices: [] });
      expect(read).toMatchObject({ phase: 'reviewing', skipArchive: true });
    });
    it('skipConnect on a skipped gate is ignored', () => {
      const state = skipped('picking');
      expect(transition(state, EVENTS.skipConnect)).toBe(state);
    });
  });

  describe('US-12 AC6c: a first attempt, then a retry that adds to it', () => {
    const first: SaveOutcome = { ...NO_OUTCOME, values: 2, documents: ['sha256-a'], skippedLabValues: 1, refusedLabUnits: [refusedLab] };
    const retry: SaveOutcome = { ...NO_OUTCOME, values: 1, labValues: 4, documents: ['sha256-a', 'sha256-b'], unstored: 1, refusedMeasurements: [refusedCore] };
    const failed = [
      { type: 'saveStarted' } as const,
      { type: 'saveFailed', message: 'Some items could not be saved. Please try again.', attempt: first } as const,
    ].reduce(transition, STATES.reviewing);

    it('the failed first attempt shows what it saved, skipped and refused', () => {
      expect(failed).toMatchObject({ phase: 'saveFailed', outcome: first });
    });
    it('the retry starts from the saved counts alone', () => {
      expect(transition(failed, EVENTS.saveStarted)).toMatchObject({
        phase: 'saving', outcome: { ...NO_OUTCOME, values: 2, documents: ['sha256-a'] },
      });
    });
    it('the retry adds its counts; skips, unstored and refusals are its own', () => {
      const done = [{ type: 'saveStarted' } as const, { type: 'saved', attempt: retry } as const].reduce(transition, failed);
      expect(done).toEqual({
        phase: 'done', results: [result], notices: [notice], skipArchive: false,
        outcome: { ...NO_OUTCOME, values: 3, labValues: 4, documents: ['sha256-a', 'sha256-b'], unstored: 1, refusedMeasurements: [refusedCore] },
      });
    });
    it('a save that fails before it has counts keeps the saved counts', () => {
      const saving = transition(failed, EVENTS.saveStarted);
      expect(transition(saving, { type: 'saveFailed', message: 'Failed to save. Please try again.' })).toMatchObject({
        phase: 'saveFailed', outcome: { ...NO_OUTCOME, values: 2, documents: ['sha256-a'] },
      });
    });
  });
});
