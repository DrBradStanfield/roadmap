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

  it('falls back to an allowed mime type when extension is unrecognized', () => {
    expect(isImage(file('blob', 'image/jpeg'))).toBe(true);
    expect(isImage(file('blob', 'image/png'))).toBe(true);
    expect(isImage(file('blob', 'image/heic'))).toBe(true);
  });

  // US-14 AC3: an SVG can carry script, and its original would be archived as
  // image/svg+xml. Only the listed types are images; any other image/* is not.
  it('US-14 AC3: rejects SVG and every other image type off the allow-list', () => {
    expect(isImage(file('chart.svg', 'image/svg+xml'))).toBe(false);
    expect(isImage(file('blob', 'image/svg+xml'))).toBe(false);
    expect(isImage(file('photo.webp', 'image/webp'))).toBe(false);
    expect(isImage(file('photo.gif', 'image/gif'))).toBe(false);
  });

  it('rejects non-image files', () => {
    expect(isImage(file('report.pdf', 'application/pdf'))).toBe(false);
    expect(isImage(file('archive.zip', 'application/zip'))).toBe(false);
  });
});
