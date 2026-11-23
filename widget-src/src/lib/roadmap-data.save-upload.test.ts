// @vitest-environment jsdom
/**
 * Mount step 3a: the shared upload Save's usage counts in lib/roadmap-data.ts. With no record open it fails as today's
 * writers do (an error, never an erase refusal, which would tell the page the record moved) and counts nothing. A row
 * the commit refused (US-12 AC6) is counted as today's writers count it: a core value's `measurement_refused` with the
 * same keys and throttle key, a lab unit's `lab_unit_refused`; a refused lab number sends nothing (no event exists).
 */
import { describe, expect, it, vi } from 'vitest';
import type { RefusedCode, UploadState } from '@roadmap/health-core/upload-flow';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import type { UploadEngine } from '../storage/upload-save-store';
import { initRoadmapStore, saveUpload } from './roadmap-data';
import { trackProductEvent } from './server-api';

vi.mock('./server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '', parseJsonResponse: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const s: UploadState = { phase: 'saving', platform: 'web', run: 1, files: [], started: '', firstRead: null, attempt: 1 };
const io = { holds: () => false, original: () => null, mimeType: () => '' };
/** An engine whose commit refused `codes`, writing nothing else. */
const refusing = (codes: RefusedCode[]): UploadEngine => ({
  uploadReview: (() => ({ classification: { values: [] } })) as unknown as UploadEngine['uploadReview'],
  uploadSave: (async () => ({ ok: true, commit: (file: unknown) => ({ file, outcome: { values: 0, documents: 0, archived: 0, unstored: 0, refused: codes.map(() => ({ line: 'Synthetic' })), refusedCodes: codes } }) })) as unknown as UploadEngine['uploadSave'],
});

describe('mount 3a: saveUpload\'s counts', () => {
  it('with no record open: no-record, in the page\'s failed-save words, and nothing counted', async () => {
    expect(await saveUpload(refusing([]), s, '2026-11-22T00:00:00.000Z', io)).toEqual({ ok: false, reason: 'no-record', message: 'Failed to save. Please try again.' });
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('each refusal the commit made is counted as today\'s writers count it', async () => {
    await initRoadmapStore(new LocalStorageAdapter());
    vi.mocked(trackProductEvent).mockClear();
    await saveUpload(refusing([
      { kind: 'measurement', reason: 'out-of-range', metricType: 'systolic_bp' },
      { kind: 'measurement', reason: 'unknown-metric' },
      { kind: 'lab', key: 'ferritin', reason: 'unit', unit: 'mmol/L' },
      { kind: 'lab', key: 'ferritin', reason: 'unit' },
      { kind: 'lab', key: 'ferritin', reason: 'value' },
    ]), s, '2026-11-22T00:00:00.000Z', io);
    expect(vi.mocked(trackProductEvent).mock.calls).toEqual([
      ['measurement_refused', { refusal: 'out-of-range' }, 'systolic_bp'],
      ['measurement_refused', { refusal: 'unknown-metric' }],
      ['lab_unit_refused', { key: 'ferritin', unit: 'mmol/L' }],
      ['lab_unit_refused', { key: 'ferritin' }],
    ]);
  });
});
