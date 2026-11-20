// @vitest-environment jsdom
/**
 * PR 1906 fix round, items 8 and 9 (US-12 AC6, US-11 AC1a): a Save whose rows landed is never reported
 * as failed because a usage count threw afterwards; an erase refusal says so in the page's words for a
 * refused write (erase-copy WRITE_REFUSED). Synthetic values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter, MemoryCloud } from '@roadmap/health-core/memory-adapter';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UnifiedExtractionResult } from '@roadmap/health-core/lab-extraction';
import type { UploadState } from '@roadmap/health-core/upload-flow';
import { SAVE_FAILED_TEXT } from '@roadmap/health-core/upload-text';
import { initRoadmapStore, loadAllHistorySync } from './roadmap-data';
import { trackProductEvent } from './server-api';
import { WRITE_REFUSED } from './erase-copy';
import { emptyHeld } from './upload-read';
import { saveAttempt } from './upload-save';

vi.mock('./server-api', async (original) => ({ ...(await original<typeof import('./server-api')>()), trackProductEvent: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const NOW = '2026-11-02T00:00:00.000Z';
// One value that saves, and a lab in a unit its test does not take: the refused spelling is counted after the edit lands.
const lab: UnifiedExtractionResult = {
  classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null,
  values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
  additionalValues: [{ name: 'Ferritin', value: 10, unit: 'mg/dL' }],
};
const saving: UploadState = { phase: 'saving', platform: 'web', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'f', name: 'labs.pdf', bytes: 1, hash: 'h-labs', pages: null, status: { s: 'read', extraction: lab, choices: NO_CHOICES } }] };

beforeEach(async () => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no external calls'); })); await initRoadmapStore(new MemoryAdapter(new MemoryCloud())); });
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(trackProductEvent).mockReset(); });

describe('the upload Save after its rows landed (item 8)', () => {
  it('a usage count that throws does not report the landed Save as failed', async () => {
    vi.mocked(trackProductEvent).mockImplementation(() => { throw new Error('synthetic counter failure'); });
    const answer = await saveAttempt(saving, emptyHeld(1), false, {});
    expect(answer).toEqual({ outcome: expect.objectContaining({ values: 1 }) });
    expect(loadAllHistorySync().map((r) => r.metricType)).toContain('ldl');
  });
});

describe('an erase refusal (item 9)', () => {
  it('says the change was not saved because the data was just deleted, not "Failed to save"', async () => {
    const { getEraseIdentity, markEraseShown } = await import('./roadmap-data');
    markEraseShown(`${getEraseIdentity()}-older`);
    const answer = await saveAttempt(saving, emptyHeld(1), false, {});
    expect(answer).toEqual({ message: WRITE_REFUSED });
    expect(answer).not.toEqual({ message: SAVE_FAILED_TEXT });
  });
});
