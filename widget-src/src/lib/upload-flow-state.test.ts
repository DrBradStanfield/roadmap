/**
 * US-12 AC4, AC6, AC6c — the upload flow's one named state, changed only
 * through a pure transition. Every phase x every event names the phase that
 * follows; an event a phase does not take returns the same state object.
 */
import { describe, it, expect } from 'vitest';
import { transition, NO_OUTCOME, type UploadState, type UploadEvent, type UploadPhase, type SaveOutcome } from './upload-flow-state';
import type { FileNotice, FileResult } from './upload-pipeline';

const file = new File(['x'], 'a.pdf');
const notice: FileNotice = { name: 'big.pdf', reason: 'tooLarge' };
const result: FileResult = { fileName: 'a.pdf', reportDate: null, values: [], additionalValues: [] };
const outcome: SaveOutcome = {
  values: 2, labValues: 3, documents: ['sha256-a'], skippedValues: 1, skippedLabValues: 1, unstored: 1,
  refusedLabUnits: [{ key: 'k', unit: 'u' } as SaveOutcome['refusedLabUnits'][number]],
  refusedMeasurements: [{ metricType: 'ldl' } as SaveOutcome['refusedMeasurements'][number]],
};
const progress = { current: 40, total: 100, fileName: 'a.pdf' };

const STATES: Record<UploadPhase, UploadState> = {
  picking: { phase: 'picking', notices: [notice] },
  reading: { phase: 'reading', files: [file], notices: [notice], progress },
  readFailed: { phase: 'readFailed', files: [file], notices: [notice], message: 'No readable files found.' },
  reviewing: { phase: 'reviewing', results: [result], notices: [notice], outcome: NO_OUTCOME },
  saving: { phase: 'saving', results: [result], notices: [notice], outcome },
  saveFailed: { phase: 'saveFailed', results: [result], notices: [notice], outcome, message: 'Failed to save. Please try again.' },
  done: { phase: 'done', results: [result], notices: [notice], outcome },
};

const newProgress = { current: 70, total: 100, fileName: 'b.pdf' };
const EVENTS: Record<UploadEvent['type'], UploadEvent> = {
  picked: { type: 'picked', files: [file], notices: [] },
  progress: { type: 'progress', progress: newProgress },
  readFailed: { type: 'readFailed', message: 'Daily upload limit reached.', notices: [notice] },
  read: { type: 'read', results: [result], notices: [notice] },
  cancel: { type: 'cancel' },
  close: { type: 'close' },
  discard: { type: 'discard' },
  saveStarted: { type: 'saveStarted' },
  saveWritten: { type: 'saveWritten', outcome: { ...NO_OUTCOME, values: 5 } },
  saved: { type: 'saved' },
  saveFailed: { type: 'saveFailed', message: 'Some items could not be saved. Please try again.' },
};

/** The phase each event leads to; `same` = ignored, the identical object back. */
const TABLE: Record<UploadPhase, Record<UploadEvent['type'], UploadPhase | 'same'>> = {
  picking:    { picked: 'reading', progress: 'same',    readFailed: 'same',       read: 'same',      cancel: 'same',    close: 'picking', discard: 'picking', saveStarted: 'same',   saveWritten: 'same',   saved: 'same', saveFailed: 'same' },
  reading:    { picked: 'same',    progress: 'reading', readFailed: 'readFailed', read: 'reviewing', cancel: 'picking', close: 'same',    discard: 'picking', saveStarted: 'same',   saveWritten: 'same',   saved: 'same', saveFailed: 'same' },
  readFailed: { picked: 'reading', progress: 'same',    readFailed: 'same',       read: 'same',      cancel: 'same',    close: 'picking', discard: 'picking', saveStarted: 'same',   saveWritten: 'same',   saved: 'same', saveFailed: 'same' },
  reviewing:  { picked: 'same',    progress: 'same',    readFailed: 'same',       read: 'same',      cancel: 'same',    close: 'same',    discard: 'picking', saveStarted: 'saving', saveWritten: 'same',   saved: 'same', saveFailed: 'same' },
  saving:     { picked: 'same',    progress: 'same',    readFailed: 'same',       read: 'same',      cancel: 'same',    close: 'same',    discard: 'same',    saveStarted: 'same',   saveWritten: 'saving', saved: 'done', saveFailed: 'saveFailed' },
  saveFailed: { picked: 'same',    progress: 'same',    readFailed: 'same',       read: 'same',      cancel: 'same',    close: 'same',    discard: 'picking', saveStarted: 'saving', saveWritten: 'same',   saved: 'same', saveFailed: 'same' },
  done:       { picked: 'same',    progress: 'same',    readFailed: 'same',       read: 'same',      cancel: 'same',    close: 'picking', discard: 'picking', saveStarted: 'same',   saveWritten: 'same',   saved: 'same', saveFailed: 'same' },
};

const ROWS = (Object.keys(TABLE) as UploadPhase[]).flatMap(phase =>
  (Object.keys(TABLE[phase]) as UploadEvent['type'][]).map(event => [phase, event, TABLE[phase][event]] as const));

describe('US-12 AC4, AC6, AC6c — the upload flow transition', () => {
  it('covers every phase x every event', () => {
    expect(ROWS).toHaveLength(Object.keys(STATES).length * Object.keys(EVENTS).length);
  });

  it.each(ROWS)('%s + %s -> %s', (phase, event, next) => {
    const state = STATES[phase];
    const after = transition(state, EVENTS[event]);
    if (next === 'same') expect(after).toBe(state);
    else expect(after.phase).toBe(next);
  });

  it('a pick with files starts the read at "Preparing upload..."', () => {
    expect(transition(STATES.readFailed, EVENTS.picked)).toEqual({
      phase: 'reading', files: [file], notices: [], progress: { current: 0, total: 100, fileName: 'Preparing upload...' },
    });
  });

  it('a pick without files stays on the dropzone with its notices (oversize only)', () => {
    const pick: UploadEvent = { type: 'picked', files: [], notices: [notice] };
    expect(transition({ phase: 'picking', notices: [] }, pick)).toEqual({ phase: 'picking', notices: [notice] });
    expect(transition(STATES.readFailed, pick)).toEqual({ phase: 'picking', notices: [notice] });
  });

  it('progress replaces the progress and keeps the files', () => {
    expect(transition(STATES.reading, EVENTS.progress)).toEqual({ ...STATES.reading, progress: newProgress });
  });

  it('a failed read keeps its files and takes the run notices', () => {
    expect(transition(STATES.reading, EVENTS.readFailed)).toEqual({
      phase: 'readFailed', files: [file], notices: [notice], message: 'Daily upload limit reached.',
    });
  });

  it('a finished read opens the review with no outcome yet', () => {
    expect(transition(STATES.reading, EVENTS.read)).toEqual({ phase: 'reviewing', results: [result], notices: [notice], outcome: NO_OUTCOME });
  });

  it.each(['cancel', 'close', 'discard'] as const)('%s returns to an empty dropzone', event => {
    const from = event === 'close' ? STATES.done : STATES.reading;
    expect(transition(from, EVENTS[event])).toEqual({ phase: 'picking', notices: [] });
  });

  it('AC6c: a save keeps only what earlier attempts saved; the last attempt\'s skips and refusals go', () => {
    const after = transition(STATES.saveFailed, EVENTS.saveStarted);
    expect(after).toEqual({
      phase: 'saving', results: [result], notices: [notice],
      outcome: { ...NO_OUTCOME, values: 2, labValues: 3, documents: ['sha256-a'] },
    });
  });

  it('AC6: the written outcome shows while Save is still busy', () => {
    expect(transition(STATES.saving, EVENTS.saveWritten)).toEqual({ ...STATES.saving, outcome: { ...NO_OUTCOME, values: 5 } });
  });

  it('a finished save is done, with its notices, results and outcome', () => {
    expect(transition(STATES.saving, EVENTS.saved)).toEqual({ phase: 'done', results: [result], notices: [notice], outcome });
  });

  it('AC6: a failed save keeps the review and its outcome, with the message', () => {
    expect(transition(STATES.saving, EVENTS.saveFailed)).toEqual({
      ...STATES.saving, phase: 'saveFailed', message: 'Some items could not be saved. Please try again.',
    });
  });
});
