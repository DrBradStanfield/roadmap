// US-12 AC10: the three usage counts an upload run adds to `upload_outcome`,
// derived from the shared upload state (design §7, R9). Counts only.
import { describe, expect, it } from 'vitest';
import type { FileStatus, UploadFile, UploadState } from './upload-flow';
import { uploadUsageCounts } from './upload-usage';
import { UPLOAD_OUTCOME_KEYS } from './upload-events';

const SECRET_NAME = 'NAME_SENTINEL_hiv_result.pdf';
const SECRET_HASH = 'HASH_SENTINEL_9f8e7d';
const file = (id: string, status: FileStatus): UploadFile => ({ id, name: SECRET_NAME, bytes: 10, hash: SECRET_HASH, pages: null, status });
const read: FileStatus = { s: 'read', extraction: { classification: 'lab_report', values: [{ metric: 'ldl', valueSI: 4.2 }] } as never, choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} } };
const state = (files: UploadFile[], o: { started?: string; firstRead?: string | null; phase?: 'open' | 'done' } = {}): UploadState => ({
  phase: 'open', platform: 'web', run: 1, files, started: o.started ?? '2026-11-15T10:00:00.000Z', firstRead: o.firstRead ?? null,
  ...(o.phase === 'done' ? { phase: 'done', outcome: { values: 1, documents: 0, archived: 0 } } : {}),
} as UploadState);

describe('US-12 AC10: usage counts from the upload state', () => {
  it('counts files skipped as already held, files still failed, and whole seconds to the first read', () => {
    const s = state([
      file('a', { s: 'known', as: 'labReport', archiveOnly: false }),
      file('b', { s: 'known', as: 'document', archiveOnly: true }),
      file('c', { s: 'failed', reason: 'timeout', attempt: 1 }),
      file('d', read),
      file('e', { s: 'stopped' }),
      file('f', { s: 'refused', verdict: 'tooLarge' }),
    ], { firstRead: '2026-11-15T10:00:12.900Z' });
    expect(uploadUsageCounts(s)).toEqual({ known: 2, failedFinal: 1, firstReadSeconds: 12 });
  });

  it('leaves out the first-read time when nothing was read yet', () => {
    expect(uploadUsageCounts(state([file('c', { s: 'failed', reason: 'server', attempt: 1 })]))).toEqual({ known: 0, failedFinal: 1 });
  });

  it('caps the first-read time at 1000 s, and never goes below 0', () => {
    expect(uploadUsageCounts(state([file('d', read)], { firstRead: '2026-11-15T12:00:00.000Z' })).firstReadSeconds).toBe(1000);
    expect(uploadUsageCounts(state([file('d', read)], { firstRead: '2026-11-15T09:59:00.000Z' })).firstReadSeconds).toBe(0);
  });

  it('leaves out a first-read time it cannot read', () => {
    expect(uploadUsageCounts(state([file('d', read)], { started: 'not a time', firstRead: '2026-11-15T10:00:05.000Z' }))).toEqual({ known: 0, failedFinal: 0 });
  });

  it('caps each count at 1000', () => {
    const many = Array.from({ length: 1005 }, (_, i) => file(`k${i}`, { s: 'known', as: 'legacy', archiveOnly: false }));
    expect(uploadUsageCounts(state(many)).known).toBe(1000);
  });

  it('counts on any phase that holds files, and nothing while choosing', () => {
    expect(uploadUsageCounts(state([file('c', { s: 'failed', reason: 'busy', attempt: 2 })], { phase: 'done' }))).toEqual({ known: 0, failedFinal: 1 });
    expect(uploadUsageCounts({ phase: 'choosing', platform: 'phone', run: 0 })).toEqual({});
  });

  it('carries only allow-listed numeric keys: never a name, hash or value', () => {
    const out = uploadUsageCounts(state([file('a', { s: 'known', as: 'labReport', archiveOnly: false }), file('d', read)], { firstRead: '2026-11-15T10:00:03.000Z' }));
    for (const [k, v] of Object.entries(out)) {
      expect(UPLOAD_OUTCOME_KEYS as readonly string[]).toContain(k);
      expect(Number.isInteger(v)).toBe(true);
    }
    const text = JSON.stringify(out);
    for (const s of [SECRET_NAME, SECRET_HASH, 'ldl', '4.2']) expect(text).not.toContain(s);
  });
});
