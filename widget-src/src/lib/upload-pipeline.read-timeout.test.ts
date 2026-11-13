// US-12 AC7b (U15): a file read that passes the 30 s limit is noted as not opened, its late
// result never reaches the review, and the read is told to stop at the limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthUploadAPI } from '../upload-entry';
import type { PageContent } from './api-types';
import type { FileNotice } from './upload-pipeline';

vi.mock('./upload-api', () => ({
  labImport: vi.fn(async (pages: PageContent[]) => ({
    result: { classification: 'lab_report', reportDate: null, values: [{ metric: 'ldl', value: 3.1, unit: 'mmol/L', confidence: 'high', name: pages[0].content }], additionalValues: [], document: null },
  })),
  labImportBatch: vi.fn(),
  pollBatchStatus: vi.fn(),
}));

const { processPipeline } = await import('./upload-pipeline');

const LIMIT_MS = 30_000;
const pdf = (name: string) => ({ fileName: name, getFile: async () => new File(['x'], name, { type: 'application/pdf' }) });
const docx = (name: string) => ({
  fileName: name,
  getFile: async () => new File(['x'], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('US-12 AC7b (U15): a read that passes the time limit', () => {
  it('is listed as not opened, and its late pages never reach the review', async () => {
    let finishLate!: () => void;
    const upload = {
      isPdf: () => true,
      isImage: () => false,
      extractFromPdf: vi.fn((file: File) => (file.name === 'slow.pdf'
        ? new Promise((resolve) => { finishLate = () => resolve({ pages: [{ type: 'text', content: 'slow.pdf' }], truncated: false }); })
        : Promise.resolve({ pages: [{ type: 'text', content: file.name }], truncated: false }))),
    } as unknown as HealthUploadAPI;
    const notices: FileNotice[] = [];
    const run = processPipeline(upload, [pdf('quick.pdf'), pdf('slow.pdf')], new AbortController(), () => {}, 'si', notices);
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    const results = await run;

    finishLate(); // the read ends after the person was told it failed
    await vi.advanceTimersByTimeAsync(LIMIT_MS);
    expect(results.map((r) => r.fileName)).toEqual(['quick.pdf']);
    // The existing words: openFailed with no text of its own (UploadNotices).
    expect(notices).toEqual([{ name: 'slow.pdf', reason: 'openFailed' }]);
  });

  for (const kind of ['pdf', 'docx'] as const) {
    it(`a ${kind} read is told to stop at the limit, not before`, async () => {
      const signals: AbortSignal[] = [];
      const hang = (signal: AbortSignal) => { signals.push(signal); return new Promise(() => {}); };
      const upload = {
        isPdf: (f: File) => f.name.endsWith('.pdf'),
        isImage: () => false,
        extractFromPdf: vi.fn((_f: File, signal: AbortSignal) => hang(signal)),
        docxToText: vi.fn((_b: ArrayBuffer, signal: AbortSignal) => hang(signal)),
      } as unknown as HealthUploadAPI;
      const notices: FileNotice[] = [];
      const input = kind === 'pdf' ? pdf('slow.pdf') : docx('slow.docx');
      const run = processPipeline(upload, [input], new AbortController(), () => {}, 'si', notices).catch((e: Error) => e);

      await vi.advanceTimersByTimeAsync(LIMIT_MS - 1);
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);
      expect(await run).toMatchObject({ message: 'No readable files found.' });
      expect(notices).toEqual([{ name: input.fileName, reason: 'openFailed' }]);
    });
  }
});
