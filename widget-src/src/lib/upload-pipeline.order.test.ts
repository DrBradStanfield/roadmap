// US-12 AC23 (D12): the review lists files in the order they were picked, whatever order they finish in.
import { describe, it, expect, vi } from 'vitest';
import type { HealthUploadAPI } from '../upload-entry';
import type { PageContent } from './api-types';

const pending = new Map<string, (ok: boolean) => void>();
vi.mock('./upload-api', () => ({
  labImport: vi.fn((pages: PageContent[]) => new Promise(resolve => {
    pending.set(pages[0].content, ok => resolve(ok
      ? { result: { classification: 'lab_report', reportDate: null, values: [], additionalValues: [], document: null } }
      : { result: null, error: 'Extraction failed', errorCode: 'server_error' }));
  })),
  labImportBatch: vi.fn(),
  pollBatchStatus: vi.fn(),
}));

const { processPipeline } = await import('./upload-pipeline');

/** Every file opens as a PDF whose one page is its own name, so each send is answered by name. */
const upload = {
  isPdf: () => true,
  isImage: () => false,
  extractFromPdf: vi.fn(async (file: File) => ({ pages: [{ type: 'text' as const, content: file.name }], truncated: false })),
} as unknown as HealthUploadAPI;

const until = async (n: number) => { for (let i = 0; i < 50 && pending.size < n; i++) await new Promise(r => setTimeout(r, 0)); };

describe('US-12 AC23: the review lists files in picked order (D12)', () => {
  it('later-picked files that finish first are still listed after the earlier ones', async () => {
    pending.clear();
    const names = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'];
    const inputs = names.map(fileName => ({ fileName, getFile: async () => new File(['x'], fileName, { type: 'application/pdf' }) }));
    const run = processPipeline(upload, inputs, new AbortController(), () => {}, 'si', []);
    await until(names.length);
    // Answer last-picked first; one fails, and keeps its place too.
    pending.get('d.pdf')!(true);
    pending.get('c.pdf')!(false);
    pending.get('b.pdf')!(true);
    pending.get('a.pdf')!(true);
    const results = await run;
    expect(results.map(r => r.fileName)).toEqual(names);
    expect(results[2].error).toBe('Extraction failed');
  });
});
