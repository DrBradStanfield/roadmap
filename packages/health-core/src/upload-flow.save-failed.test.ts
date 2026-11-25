// PR 1906 fix round, item 2 (US-12 AC6): a choice made after a failed Save is the state's, so the retry
// writes what the screen shows. The choice returns the upload to an ordinary review (`open`), validated
// as any review is; the failed Save's words go with it.
import { describe, expect, it } from 'vitest';
import { core, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES } from './upload-choices';
import { transition, type UploadFile, type UploadState } from './upload-flow';

const lab: UnifiedExtractionResult = { classification: 'lab_report', reportDate: '2026-10-01', values: [core()], additionalValues: [], unrecognized: [], document: null };
const read: UploadFile = { id: 'a', name: 'a.pdf', bytes: 1, hash: 'h-a', pages: null, status: { s: 'read', extraction: lab, choices: NO_CHOICES } };
const failed: UploadState = { phase: 'saveFailed', platform: 'web', run: 1, files: [read], started: NOW, firstRead: NOW, attempt: 1, message: 'Failed to save. Please try again.' };

describe('a choice after a failed Save (US-12 AC6)', () => {
  it('is kept, and the upload is an ordinary review again', () => {
    const next = transition(failed, { type: 'chose', id: 'a', change: { edit: 'v0', value: 4.4 }, now: NOW }).state;
    expect(next.phase).toBe('open');
    const f = 'files' in next ? next.files[0] : null;
    expect(f?.status.s === 'read' && f.status.choices.edits).toEqual({ v0: 4.4 });
  });

  it('a clear is kept too, and the next Save is a new attempt from the review', () => {
    const open = transition(failed, { type: 'chose', id: 'a', change: { tick: 'v0', on: false }, now: NOW }).state;
    const f = 'files' in open ? open.files[0] : null;
    expect(f?.status.s === 'read' && f.status.choices.ticks).toEqual({ v0: false });
    const step = transition(open, { type: 'saveStarted' });
    expect(step.state).toMatchObject({ phase: 'saving' });
  });

  it('a refused choice (an impossible document date) changes nothing', () => {
    const next = transition(failed, { type: 'chose', id: 'x', change: { tick: 'v0', on: false }, now: NOW }).state;
    expect(next).toBe(failed);
  });
});

// US-16 AC2a (lead H18): the web's Save carries the erase the page showed at its press, each press its own.
describe('a Save carries the erase of its own press (US-16 AC2a)', () => {
  it('the saving state holds the press\'s erase; a retry after a failure holds the retry\'s; leaving saving drops it', () => {
    const first = transition(failed, { type: 'saveStarted', erase: '[1,"erase-a"]' }).state;
    expect(first).toMatchObject({ phase: 'saving', attempt: 2, erase: '[1,"erase-a"]' });
    const again = transition(transition(first, { type: 'saveFailed', run: 1, attempt: 2, message: 'no' }).state, { type: 'saveStarted', erase: '[2,"erase-b"]' }).state;
    expect(again).toMatchObject({ phase: 'saving', attempt: 3, erase: '[2,"erase-b"]' });
    expect(transition(again, { type: 'saveFailed', run: 1, attempt: 3, message: 'no' }).state).not.toHaveProperty('erase');
  });

  it('a Save with no erase (the phone\'s) holds none', () => {
    expect(transition(failed, { type: 'saveStarted' }).state).not.toHaveProperty('erase');
  });
});
