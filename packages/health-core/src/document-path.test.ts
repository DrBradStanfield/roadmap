import { describe, it, expect } from 'vitest';
import { buildDocumentRef, DOCUMENT_FOLDERS, extensionOf, sanitizeTitle } from './document-path';
import { DOCUMENT_TYPES } from './validation';

describe('DOCUMENT_FOLDERS', () => {
  it('maps every DocumentType to a folder', () => {
    for (const t of DOCUMENT_TYPES) expect(DOCUMENT_FOLDERS[t]).toBeTruthy();
  });

  it("Brad's three named folders + catch-all", () => {
    expect(DOCUMENT_FOLDERS.pathology_report).toBe('Lab results');
    expect(DOCUMENT_FOLDERS.scan_result).toBe('Scans');
    expect(DOCUMENT_FOLDERS.clinic_letter).toBe('Clinic letters');
    expect(DOCUMENT_FOLDERS.discharge_summary).toBe('Clinic letters');
    expect(DOCUMENT_FOLDERS.vaccination_record).toBe('Other documents');
    expect(DOCUMENT_FOLDERS.other).toBe('Other documents');
  });
});

describe('sanitizeTitle', () => {
  it('strips path separators and forbidden characters', () => {
    expect(sanitizeTitle('Lipids: fasting / "final"?')).toBe('Lipids fasting final');
  });
  it('keeps hyphens (Chest X-ray survives)', () => {
    expect(sanitizeTitle('Chest X-ray')).toBe('Chest X-ray');
  });
  it('trims trailing dots (Windows) and collapses whitespace', () => {
    expect(sanitizeTitle('  CT   head ... ')).toBe('CT head');
  });
  it('falls back when nothing survives', () => {
    expect(sanitizeTitle('///???')).toBe('Document');
  });
});

describe('extensionOf', () => {
  it('lowercases and keeps short extensions', () => {
    expect(extensionOf('Scan.PDF')).toBe('.pdf');
    expect(extensionOf('photo.JPEG')).toBe('.jpeg');
  });
  it('handles missing/odd names', () => {
    expect(extensionOf(null)).toBe('');
    expect(extensionOf('no-extension')).toBe('');
  });
});

describe('buildDocumentRef', () => {
  it('builds folder/date-first names — chronological in every cloud UI', () => {
    expect(
      buildDocumentRef({
        type: 'pathology_report',
        title: 'Lipid panel',
        date: '2024-05-10',
        sourceFileName: 'results.pdf',
        existingRefs: [],
      }),
    ).toBe('Lab results/2024-05-10 Lipid panel.pdf');
  });

  it('suffixes collisions instead of overwriting (case-insensitive)', () => {
    const existing = ['Scans/2025-01-22 Chest X-ray.jpg', 'scans/2025-01-22 chest x-ray (2).jpg'];
    expect(
      buildDocumentRef({
        type: 'scan_result',
        title: 'Chest X-ray',
        date: '2025-01-22',
        sourceFileName: 'IMG_001.JPG',
        existingRefs: existing,
      }),
    ).toBe('Scans/2025-01-22 Chest X-ray (3).jpg');
  });

  it('caps absurdly long titles without losing the extension', () => {
    const ref = buildDocumentRef({
      type: 'clinic_letter',
      title: 'A'.repeat(300),
      date: '2026-06-10',
      sourceFileName: 'letter.pdf',
      existingRefs: [],
    });
    expect(ref.endsWith('.pdf')).toBe(true);
    expect(ref.split('/')[1].length).toBeLessThanOrEqual(80);
  });
});
