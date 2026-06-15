import { describe, it, expect } from 'vitest';
import {
  isLabArchiveDocument,
  synthesizeLabArchiveEntries,
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
