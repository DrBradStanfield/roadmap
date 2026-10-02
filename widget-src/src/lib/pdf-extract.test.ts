/**
 * US-12: UploadModal pipeline untested — pure-logic extraction tests.
 *
 * `extractFromPdf` needs pdfjs-dist page rendering to `canvas` (DOM/browser
 * API, not available in the node vitest environment) — untestable-in-node,
 * not covered here. `isPdf` is a pure filename/mime check and gets full
 * coverage. (Importing this module is safe in node — its module-level side
 * effects are wiring a Blob/URL worker source, both Node globals, and the
 * Promise.withResolvers fallback, a no-op on Node 22 — verified no
 * canvas/Image touched until extractFromPdf() runs.)
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { resolveObjectURL } from 'node:buffer';
import * as pdfjsLib from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import { isPdf } from './pdf-extract';

function file(name: string, type: string): File {
  return new File([], name, { type });
}

describe('US-12: isPdf', () => {
  it('recognizes application/pdf mime type', () => {
    expect(isPdf(file('report', 'application/pdf'))).toBe(true);
  });

  it('falls back to the .pdf extension', () => {
    expect(isPdf(file('report.pdf', ''))).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isPdf(file('REPORT.PDF', ''))).toBe(true);
  });

  it('rejects non-pdf files', () => {
    expect(isPdf(file('photo.jpg', 'image/jpeg'))).toBe(false);
    expect(isPdf(file('archive.zip', 'application/zip'))).toBe(false);
  });
});

describe('US-12 AC7: the pdf.js worker blob installs Promise.withResolvers first', () => {
  it('runs a self-contained installer before the worker code', async () => {
    const blob = resolveObjectURL(pdfjsLib.GlobalWorkerOptions.workerSrc);
    expect(blob).toBeDefined();
    const text = await blob!.text();
    expect(text.endsWith(workerCode)).toBe(true);
    const prefix = text.slice(0, text.length - workerCode.length);

    const ctx = vm.createContext({});
    vm.runInContext('delete Promise.withResolvers', ctx);
    vm.runInContext(prefix, ctx);
    expect(vm.runInContext('typeof Promise.withResolvers', ctx)).toBe('function');
  });
});
