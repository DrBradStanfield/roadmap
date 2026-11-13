// US-12 AC5b: on the Pages build the 10-minute batch deadline stops the queue
// of direct calls on the person's own key, as Cancel does (AC5a): no file still
// queued is sent after "Processing took too long". The batch loop as its caller
// sees it, over the real BYOK transport; only fetch and the clock are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./byok-chat', () => ({ getAnthropicKey: () => 'sk-ant-synthetic' }));
// The Pages build swaps upload-api.ts for byok-upload.ts (vite.config.pages.ts).
vi.mock('./upload-api', async () => await import('./byok-upload'));

import type { HealthUploadAPI } from '../upload-entry';
import { processBatch, type FileNotice } from './upload-pipeline';

const N = 20;
const MODEL_CALL_MS = 4 * 60_000; // each file takes 4 minutes, so the deadline lands mid-queue
const VALID = '{"classification":"other","reportDate":null,"values":[],"additionalValues":[],"document":null}';
const upload = {
  isPdf: () => true,
  isImage: () => false,
  extractFromPdf: vi.fn(async (file: File) => ({ pages: [{ type: 'text' as const, content: file.name }], truncated: false })),
} as unknown as HealthUploadAPI;
const queue = Array.from({ length: N }, (_, i) => `r${i}.pdf`)
  .map(fileName => ({ fileName, getFile: async () => new File(['x'], fileName, { type: 'application/pdf' }) }));

let modelCalls: number;
beforeEach(() => {
  vi.useFakeTimers();
  modelCalls = 0;
  vi.stubGlobal('fetch', vi.fn(() => {
    modelCalls++;
    return new Promise<Response>(resolve => setTimeout(
      () => resolve(Response.json({ content: [{ type: 'text', text: VALID }] })), MODEL_CALL_MS));
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('US-12 AC5b: the batch deadline stops the BYOK queue', () => {
  it('after the timeout no further model call is made on the person\'s key', async () => {
    let settled: unknown;
    processBatch(upload, queue, new AbortController(), () => {}, [] as FileNotice[])
      .then(() => { settled = 'resolved'; }, (error: unknown) => { settled = error; });
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10_000);
    expect(settled).toMatchObject({ code: 'timeout' });
    const atDeadline = modelCalls;
    expect(atDeadline).toBeLessThan(N); // files were still queued
    // Long enough for the whole queue to drain if nothing stopped it.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(modelCalls).toBe(atDeadline);
  });
});
