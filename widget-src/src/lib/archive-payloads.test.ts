import { describe, it, expect } from 'vitest';
import {
  isLabArchiveDocument,
  synthesizeLabArchiveEntries,
  connectorOriginals,
  connectorDocumentEntries,
  LAB_ARCHIVE_FLAG,
} from './archive-payloads';
import type { FileResult } from '../components/ReviewTable';

const blob = () => new Blob(['x'], { type: 'application/pdf' });

function result(over: Partial<FileResult>): FileResult {
  return {
    fileName: 'lipids.pdf',
    reportDate: '2025-01-10',
    values: [{ metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high' }],
    additionalValues: [],
    ...over,
  } as FileResult;
}

describe('synthesizeLabArchiveEntries', () => {
  it('flags synthesized blood-test entries with labArchive metadata', () => {
    const out = synthesizeLabArchiveEntries([result({ file: blob() })], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].documentType).toBe('pathology_report');
    expect(out[0].title).toBe('Blood test results');
    expect(out[0].metadata[LAB_ARCHIVE_FLAG]).toBe(true);
    // The original blob is still carried through → persisted to the user's cloud.
    expect(out[0].file).toBeInstanceOf(Blob);
  });

  it('skips files with no values, errors, no blob, or already covered', () => {
    expect(synthesizeLabArchiveEntries([result({ file: blob(), values: [], additionalValues: [] })], new Set())).toHaveLength(0);
    expect(synthesizeLabArchiveEntries([result({ file: blob(), error: 'boom' })], new Set())).toHaveLength(0);
    expect(synthesizeLabArchiveEntries([result({})], new Set())).toHaveLength(0); // no file
    expect(synthesizeLabArchiveEntries([result({ file: blob() })], new Set(['lipids.pdf']))).toHaveLength(0);
  });
});

describe('isLabArchiveDocument', () => {
  it('hides synthesized blood-test archive entries (explicit flag)', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Blood test results',
      contentMd: '',
      metadata: { [LAB_ARCHIVE_FLAG]: true },
    })).toBe(true);
  });

  it('hides legacy synthesized entries via content signature (no flag)', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Blood test results',
      contentMd: '',
      metadata: {},
    })).toBe(true);
  });

  it('keeps real pathology reports (biopsy/histology with content)', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Breast Core Biopsy — Histology',
      contentMd: '## Histology\n\nInvasive ductal carcinoma...',
      metadata: { specimenType: 'core biopsy', result: 'malignant' },
    })).toBe(false);
  });

  it('keeps clinic letters, discharge summaries, scans, vaccination records', () => {
    for (const documentType of ['clinic_letter', 'discharge_summary', 'scan_result', 'vaccination_record', 'other']) {
      expect(isLabArchiveDocument({
        documentType,
        title: 'Blood test results', // even with a colliding title, non-pathology types stay
        contentMd: '',
        metadata: {},
      })).toBe(false);
    }
  });

  it('does not hide a pathology report whose title happens to match but has content', () => {
    expect(isLabArchiveDocument({
      documentType: 'pathology_report',
      title: 'Blood test results',
      contentMd: '## Bone marrow biopsy',
      metadata: {},
    })).toBe(false);
  });
});

// US-13 AC1 / US-35 AC8 — the connector's metadata-only row (hash, no fileRef)
// is what a website upload of the same bytes archives behind.
describe('connectorOriginals', () => {
  const doc = (over: Partial<{ contentHash: string | null; fileRef: string | null }>) =>
    ({ contentHash: 'sha256-a', fileRef: null, ...over });

  it('counts a value-bearing file whose hash matches a row without a fileRef', () => {
    expect(connectorOriginals([result({ file: blob(), contentHash: 'sha256-a' })], [doc({})], new Set()).length).toBe(1);
  });

  it('ignores an archived row, a different hash, and files the archive step would skip', () => {
    expect(connectorOriginals([result({ file: blob(), contentHash: 'sha256-a' })], [doc({ fileRef: 'Lab results/a.pdf' })], new Set()).length).toBe(0);
    expect(connectorOriginals([result({ file: blob(), contentHash: 'sha256-b' })], [doc({})], new Set()).length).toBe(0);
    expect(connectorOriginals([result({ contentHash: 'sha256-a' })], [doc({})], new Set()).length).toBe(0); // no blob (device-only)
    expect(connectorOriginals([result({ file: blob(), contentHash: 'sha256-a', values: [] })], [doc({})], new Set()).length).toBe(0);
  });

  it('counts an unselected document (any type) whose hash matches a row without a fileRef, not one already selected', () => {
    const letter = result({ fileName: 'letter.pdf', values: [], file: blob(), contentHash: 'sha256-a', document: LETTER });
    expect(connectorOriginals([letter], [doc({})], new Set()).length).toBe(1);
    expect(connectorOriginals([letter], [doc({})], new Set(['letter.pdf'])).length).toBe(0);
    expect(connectorOriginals([letter], [doc({ fileRef: 'Letters/a.pdf' })], new Set()).length).toBe(0);
  });
});

const LETTER = { classification: 'clinic_letter' as const, title: 'Cardiology follow-up', documentDate: '2024-06-10', contentMarkdown: '# Letter', metadata: { clinic: 'x' } };

describe('connectorDocumentEntries', () => {
  const pending = [{ contentHash: 'sha256-a', fileRef: null }];
  const letter = result({ fileName: 'letter.pdf', values: [], file: blob(), contentHash: 'sha256-a', document: LETTER });

  it('files an unselected connector-held letter with its reviewed content and bytes', () => {
    const out = connectorDocumentEntries([letter], pending, new Set());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ documentType: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2024-06-10', contentMd: '# Letter', metadata: { clinic: 'x' }, sourceFileName: 'letter.pdf' });
    expect(out[0].file).toBeInstanceOf(Blob);
  });

  it('skips a selected letter (saved as a document already), a lab file, and a letter the record holds no hash for', () => {
    expect(connectorDocumentEntries([letter], pending, new Set(['letter.pdf']))).toHaveLength(0);
    expect(connectorDocumentEntries([result({ file: blob(), contentHash: 'sha256-a' })], pending, new Set())).toHaveLength(0);
    expect(connectorDocumentEntries([letter], [], new Set())).toHaveLength(0);
  });
});
