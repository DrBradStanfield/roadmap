/**
 * US-12: UploadModal pipeline untested — pure-logic extraction tests.
 *
 * `extractFromPdf` needs pdfjs-dist page rendering to `canvas` (DOM/browser
 * API, not available in the node vitest environment) — untestable-in-node,
 * not covered here. `isPdf` is a pure filename/mime check and gets full
 * coverage. (Importing this module is safe in node — its only module-level
 * side effect is wiring a Blob/URL worker source, both of which are Node
 * globals — verified no canvas/Image touched until extractFromPdf() runs.)
 */
import { describe, it, expect } from 'vitest';
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
