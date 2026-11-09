import { describe, it, expect } from 'vitest';
import { buildDocumentRef, byNewestDocument, DOCUMENT_FOLDERS, extensionOf, sanitizeTitle } from './document-path';
import { DOCUMENT_TYPES } from './validation';
import { localDay } from './merge';

describe('byNewestDocument (US-14 AC8, US-73 AC12)', () => {
  const order = (docs: Array<{ id: string; documentDate?: string | null; createdAt?: string | null }>) => [...docs].sort(byNewestDocument).map((d) => d.id);

  it('on one date, the later filed first by instant, whatever the offset or precision', () => {
    expect(order([
      { id: 'utc-seconds', documentDate: '2026-09-14', createdAt: '2026-10-01T08:00:00Z' },
      // 09:00Z, written with a +13:00 offset: the latest instant though its text sorts first.
      { id: 'auckland', documentDate: '2026-09-14', createdAt: '2026-10-01T22:00:00+13:00' },
      { id: 'utc-millis', documentDate: '2026-09-14', createdAt: '2026-10-01T08:59:59.999Z' },
    ])).toEqual(['auckland', 'utc-millis', 'utc-seconds']);
  });

  it('an absent or unreadable filing stamp counts as the oldest, and two such tie', () => {
    expect(order([
      { id: 'none', documentDate: '2026-09-14' },
      { id: 'garbled', documentDate: '2026-09-14', createdAt: 'yesterday' },
      { id: 'stamped', documentDate: '2026-09-14', createdAt: '2026-10-01T08:00:00Z' },
    ])[0]).toBe('stamped');
    expect(byNewestDocument({ documentDate: null, createdAt: 'x' }, { documentDate: null })).toBe(0);
  });

  it('a legacy row with no date is undated, after every dated one', () => {
    expect(order([{ id: 'legacy' }, { id: 'old', documentDate: '2020-01-01' }, { id: 'new', documentDate: '2026-01-01' }]))
      .toEqual(['new', 'old', 'legacy']);
  });
});

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
  it('keeps non-ASCII — an em dash or a macron is a fine file name once the Dropbox header escapes it', () => {
    expect(sanitizeTitle('GP Consultation Letter — Dr A. Example')).toBe('GP Consultation Letter — Dr A. Example');
    expect(sanitizeTitle('Letter for Hēmi Māori')).toBe('Letter for Hēmi Māori');
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

  // US-14 AC2: the date comes from the model reading an uploaded file, so a
  // crafted PDF can make it a path. Only a real calendar day reaches the ref.
  it.each(['../../x', '2026-01-01/../../x', '..', '2026-02-30', '2026-1-1', '', null, undefined])(
    'US-14 AC2: a date that is not a calendar day (%s) falls back to today',
    (date) => {
      const ref = buildDocumentRef({
        type: 'clinic_letter',
        title: 'Letter',
        date: date as string,
        sourceFileName: 'letter.pdf',
        existingRefs: [],
      });
      expect(ref).toBe(`Clinic letters/${localDay(new Date())} Letter.pdf`);
      expect(ref.split('/')).toHaveLength(2);
    },
  );
});
