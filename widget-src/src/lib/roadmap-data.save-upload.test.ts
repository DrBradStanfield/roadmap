/**
 * Mount step 3a: the shared upload Save with no record open fails as today's writers do (an error, never an erase
 * refusal, which would tell the page the record moved) and sends no count.
 */
import { describe, expect, it, vi } from 'vitest';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { saveUpload } from './roadmap-data';
import { trackProductEvent } from './server-api';

vi.mock('./server-api', () => ({ trackProductEvent: vi.fn(), PROXY_PATH: '', parseJsonResponse: vi.fn() }));

describe('mount 3a: saveUpload with no record open', () => {
  it('answers no-record in the page\'s failed-save words, and counts nothing', async () => {
    const s: UploadState = { phase: 'saving', platform: 'web', run: 1, files: [], started: '', firstRead: null, attempt: 1 };
    const io = { holds: () => false, original: () => null, mimeType: () => '' };
    expect(await saveUpload({ uploadSave: vi.fn(), uploadReview: vi.fn() }, s, '2026-11-22T00:00:00.000Z', io)).toEqual({ ok: false, reason: 'no-record', message: 'Failed to save. Please try again.' });
    expect(trackProductEvent).not.toHaveBeenCalled();
  });
});
