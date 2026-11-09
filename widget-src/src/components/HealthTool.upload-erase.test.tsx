// @vitest-environment jsdom
/**
 * US-16 AC2c (2026-11-09, from the state-machine survey): an upload's review
 * read before an erase ends with that erase. Before, closing the modal only
 * hid it, so a review read, hidden, then left through "Delete all my data"
 * could be reopened from its indicator and saved into the erased record: the
 * save took the erase the screen showed as Save was pressed, the new one.
 *
 * The whole widget renders over a REAL RoadmapStore on this browser's
 * localStorage, with the REAL UploadModal; only the network edges (the quota,
 * the lab read, the upload bundle) and the chat's own UI are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, act, screen } from '@testing-library/react';
import { createEmptyFile, type RoadmapFile } from '@roadmap/health-core/roadmap-file';
import { ROADMAP_FILE_NAME } from '@roadmap/health-core/adapter';
import { REMOTE_CHANGED_EVENT, RoadmapStore } from '../storage/roadmap-store';
import { LocalStorageAdapter } from '../storage/local-storage-adapter';
import { addMeasurement, deleteUserData, loadAllHistorySync, flushRoadmapStore } from '../lib/roadmap-data';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import { deleteButton } from '../testing/settings';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));

import { HealthTool } from './HealthTool';

/** A synthetic report: one LDL, a value the record does not hold. */
const extraction = { result: { classification: 'lab_report', document: null, reportDate: '2024-06-01', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] } };

async function recordOnDisk(): Promise<RoadmapFile> {
  await act(async () => { await flushRoadmapStore(); });
  const { body } = await new LocalStorageAdapter().read(ROADMAP_FILE_NAME);
  return (body ?? createEmptyFile({ deviceId: 'test', now: new Date().toISOString() })) as RoadmapFile;
}
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** LDL rows in the record: the store's copy, which the next write saves, and the copy on disk. */
const ldlRows = async () => [...loadAllHistorySync(), ...(await recordOnDisk()).measurements].filter(m => m.metricType === 'ldl');
const resumeButton = () => screen.queryByRole('button', { name: /Ready for review/ });

/** A guest with a plan, the upload read and its review showing, then hidden. */
async function reviewReadThenHidden() {
  await seedGuest({ birthYear: 1974, birthMonth: 1, sex: 'male', heightCm: 178 }, [['weight', 82]]);
  render(<HealthTool />);
  await wait(600);
  fireEvent.click(await screen.findByRole('button', { name: 'Upload lab results' }));
  // A guest on this device is first offered a place to keep originals.
  fireEvent.click(screen.getByRole('button', { name: /Continue without keeping my files/ }));
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } });
  await screen.findByDisplayValue('3.9');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(resumeButton()).not.toBeNull();
}

useHealthToolLifecycle();
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(RoadmapStore.prototype, 'startLiveRefresh').mockImplementation(() => () => {});
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockResolvedValue(extraction as Awaited<ReturnType<typeof labImport>>);
  vi.stubGlobal('HealthUpload', {
    extractFromPdf: vi.fn(async () => ({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false })),
    isPdf: () => true, isZip: () => false, isImage: () => false,
  });
});
// Registered after the lifecycle, so it runs first: real timers before its flush.
afterEach(() => { vi.useRealTimers(); });

describe('US-16 AC2c: an upload review read before an erase ends with it', () => {
  it("this tab's erase: the hidden review is gone, and nothing from it can reach the erased record", async () => {
    await reviewReadThenHidden();
    vi.stubGlobal('confirm', () => true);
    vi.stubGlobal('alert', () => {});
    fireEvent.click(await waitFor(() => deleteButton()));
    await wait(1500);

    // Before the fix the indicator stayed, and its Save wrote the pre-erase LDL.
    const resume = resumeButton();
    if (resume) {
      fireEvent.click(resume);
      fireEvent.click(screen.getByRole('button', { name: /^Save 1 Value/ }));
      await wait(600);
    }
    expect(await ldlRows()).toEqual([]);
    expect(resume).toBeNull();
    expect(screen.queryByDisplayValue('3.9')).toBeNull();
  });

  it('a review of this record survives a re-read that brings no erase', async () => {
    await reviewReadThenHidden();
    await act(async () => { await addMeasurement('weight', 83, '2026-09-02'); });
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await wait(600);
    fireEvent.click(resumeButton()!);
    expect(screen.getByDisplayValue('3.9')).toBeTruthy();
  });

  it("another device's erase, once this tab shows it: the hidden review is gone", async () => {
    await reviewReadThenHidden();
    // deleteUserData is the erase as another writer of this record makes it;
    // the page learns of it through its re-read, as from another device.
    await act(async () => { await deleteUserData(); });
    act(() => { window.dispatchEvent(new Event(REMOTE_CHANGED_EVENT)); });
    await wait(1500);
    expect(resumeButton()).toBeNull();
    expect(await ldlRows()).toEqual([]);
  });
});
