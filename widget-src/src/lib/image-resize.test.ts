/**
 * US-12: UploadModal pipeline untested — pure-logic extraction tests.
 *
 * `resizeImage` needs `Image`/`canvas` (DOM/browser APIs, not available in
 * the node vitest environment) — untestable-in-node, not covered here.
 * `isImage` is a pure filename/mime check and gets full coverage.
 */
import { describe, it, expect } from 'vitest';
import { isImage } from './image-resize';

function file(name: string, type: string): File {
  return new File([], name, { type });
}

describe('US-12: isImage', () => {
  it('recognizes jpg/jpeg/png/heic by extension', () => {
    expect(isImage(file('photo.jpg', ''))).toBe(true);
    expect(isImage(file('photo.jpeg', ''))).toBe(true);
    expect(isImage(file('photo.png', ''))).toBe(true);
    expect(isImage(file('photo.heic', ''))).toBe(true);
  });

  it('is case-insensitive on extension', () => {
    expect(isImage(file('PHOTO.JPG', ''))).toBe(true);
  });

  it('falls back to mime type when extension is unrecognized', () => {
    expect(isImage(file('blob', 'image/webp'))).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(isImage(file('report.pdf', 'application/pdf'))).toBe(false);
    expect(isImage(file('archive.zip', 'application/zip'))).toBe(false);
  });
});
