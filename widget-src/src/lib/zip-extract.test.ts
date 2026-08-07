/**
 * US-12: UploadModal pipeline untested — pure-logic extraction tests.
 *
 * getZipEntries/isZip are the client-side zip-unpacking layer feeding
 * UploadModal. Covered here with (a) small synthetic zips built in-test via
 * JSZip (nested folders, junk filtering, empty zip, MAX_FILES cap) and
 * (b) Brad's real lab zip when present locally.
 *
 * PRIVACY: the real-zip test asserts on STRUCTURE ONLY (entry count, name
 * extensions, non-empty blobs) — never real health values — and is gated so
 * CI (which doesn't have the fixture) skips it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import JSZip from 'jszip';
import { getZipEntries, isZip } from './zip-extract';

const REAL_ZIP_PATH = '/Users/bradstanfield/Library/CloudStorage/Dropbox/health.zip';

function file(name: string, type: string): File {
  return new File([], name, { type });
}

describe('US-12: isZip', () => {
  it('recognizes the canonical application/zip mime type', () => {
    expect(isZip(file('archive.zip', 'application/zip'))).toBe(true);
  });

  it('recognizes application/x-zip-compressed', () => {
    expect(isZip(file('archive.zip', 'application/x-zip-compressed'))).toBe(true);
  });

  it('falls back to the .zip extension when mime type is empty', () => {
    expect(isZip(file('archive.zip', ''))).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isZip(file('Archive.ZIP', ''))).toBe(true);
  });

  it('rejects non-zip files', () => {
    expect(isZip(file('report.pdf', 'application/pdf'))).toBe(false);
    expect(isZip(file('scan.jpg', 'image/jpeg'))).toBe(false);
  });
});

describe('US-12: getZipEntries — synthetic zips', () => {
  it('returns an empty array for an empty zip', async () => {
    const zip = new JSZip();
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const entries = await getZipEntries(new File([buf], 'empty.zip', { type: 'application/zip' }));
    expect(entries).toEqual([]);
  });

  it('extracts entries from nested folders', async () => {
    const zip = new JSZip();
    zip.file('blood tests/lipids.pdf', 'pdf-bytes');
    zip.file('eyes/Auckland Eye/letter.pdf', 'pdf-bytes');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const entries = await getZipEntries(new File([buf], 'nested.zip', { type: 'application/zip' }));
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['blood tests/lipids.pdf', 'eyes/Auckland Eye/letter.pdf']);
  });

  it('filters __MACOSX, .DS_Store, and dotfile junk entries', async () => {
    const zip = new JSZip();
    zip.file('report.pdf', 'pdf-bytes');
    zip.file('__MACOSX/._report.pdf', 'junk');
    zip.file('.DS_Store', 'junk');
    zip.file('folder/.DS_Store', 'junk');
    zip.file('.hidden.pdf', 'junk'); // dotfile — filtered by the leading-dot check
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const entries = await getZipEntries(new File([buf], 'junk.zip', { type: 'application/zip' }));
    expect(entries.map(e => e.name)).toEqual(['report.pdf']);
  });

  it('filters unsupported extensions but keeps pdf/jpg/jpeg/png', async () => {
    const zip = new JSZip();
    zip.file('report.pdf', 'x');
    zip.file('photo.jpg', 'x');
    zip.file('photo2.jpeg', 'x');
    zip.file('scan.png', 'x');
    zip.file('notes.txt', 'x');
    zip.file('data.csv', 'x');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const entries = await getZipEntries(new File([buf], 'mixed.zip', { type: 'application/zip' }));
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['photo.jpg', 'photo2.jpeg', 'report.pdf', 'scan.png']);
  });

  it('excludes directory entries (0-byte folder markers)', async () => {
    const zip = new JSZip();
    zip.folder('empty-folder');
    zip.file('report.pdf', 'x');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const entries = await getZipEntries(new File([buf], 'dirs.zip', { type: 'application/zip' }));
    expect(entries.map(e => e.name)).toEqual(['report.pdf']);
  });

  it('caps entries at MAX_FILES (200)', async () => {
    const zip = new JSZip();
    for (let i = 0; i < 205; i++) {
      zip.file(`file-${i}.pdf`, 'x');
    }
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const entries = await getZipEntries(new File([buf], 'many.zip', { type: 'application/zip' }));
    expect(entries).toHaveLength(200);
  });
});

describe.skipIf(!existsSync(REAL_ZIP_PATH))('US-12: getZipEntries — real fixture (Brad\'s lab zip, local only)', () => {
  it('extracts only supported, non-junk entries with structural sanity checks (no value assertions)', async () => {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(REAL_ZIP_PATH);
    const zipFile = new File([buf], 'health.zip', { type: 'application/zip' });
    const entries = await getZipEntries(zipFile);

    // Structural assertions only — never assert on real file names/values.
    expect(entries.length).toBeGreaterThan(0);
    for (const { name, entry } of entries) {
      const lower = name.toLowerCase();
      expect(lower.includes('__macosx')).toBe(false);
      expect(lower.includes('.ds_store')).toBe(false);
      expect(/\.(pdf|jpe?g|png)$/i.test(lower)).toBe(true);
      const blob = await entry.async('uint8array');
      expect(blob.length).toBeGreaterThan(0);
    }
  });
});
