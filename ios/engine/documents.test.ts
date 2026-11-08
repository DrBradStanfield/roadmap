// US-73 AC12 (US-14 AC8): My health's Documents on the iPhone, as the web's
// HealthRecordsSection lists them: live rows only, never a lab report's archive
// row, scan results apart from letters and the rest. Through screenJson, the
// door the tab draws from.
import { describe, expect, it } from 'vitest';
import type { FileDocument } from '../../packages/health-core/src/roadmap-file';
import { screenJson } from './entry';
import { newRecord } from './my-data';

const NOW = '2026-10-21T08:00:00.000Z';

function doc(id: string, over: Partial<FileDocument> = {}): FileDocument {
  return {
    id, title: `Doc ${id}`, type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: '', mimeType: '',
    extractedText: `# ${id}`, addedAt: '2026-10-01T00:00:00.000Z', ...over,
  };
}

function shelf(documents: FileDocument[]) {
  const record = { ...newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland'), documents };
  return (JSON.parse(screenJson(JSON.stringify(record), NOW, 'phone', '{}')) as { myData: { documents: { scans: Array<Record<string, unknown>>; others: Array<Record<string, unknown>> } } }).myData.documents;
}

describe('My health documents (US-73 AC12)', () => {
  it('lists scan results apart from letters and other documents, each newest first, an undated one last', () => {
    const { scans, others } = shelf([
      doc('old-letter', { date: '2025-03-02' }),
      doc('scan', { type: 'scan_result', date: '2026-05-01' }),
      doc('undated', { type: 'discharge_summary', date: null }),
      doc('new-letter', { date: '2026-09-14' }),
      doc('older-scan', { type: 'scan_result', date: '2024-01-01' }),
    ]);
    expect(scans.map((d) => d.id)).toEqual(['scan', 'older-scan']);
    expect(others.map((d) => d.id)).toEqual(['new-letter', 'old-letter', 'undated']);
    expect(others[2]).toMatchObject({ day: null, typeLabel: 'Discharge Summary' });
  });

  it('leaves out deleted documents and lab-report archive rows, by the flag or the legacy signature', () => {
    const { scans, others } = shelf([
      doc('kept'),
      doc('deleted', { deleted: true }),
      doc('flagged', { type: 'pathology_report', title: 'Blood test results', fileRef: 'Lab results/x.pdf', metadata: { labArchive: true } }),
      doc('legacy', { type: 'pathology_report', title: 'Blood test results', extractedText: '' }),
      doc('pathology', { type: 'pathology_report', title: 'Histology', extractedText: 'Benign.' }),
    ]);
    expect(scans).toEqual([]);
    expect(others.map((d) => d.id)).toEqual(['kept', 'pathology']);
  });

  it('gives each row its title, label, day, markdown and file name, and names an original only when the cloud holds one', () => {
    const { others } = shelf([
      doc('with', { title: 'Cardiology follow-up', date: '2026-09-14', fileRef: 'Clinic letters/2026-09-14 Cardiology follow-up.pdf', mimeType: 'application/pdf', sourceFileName: 'Letter.pdf', extractedText: '# Letter' }),
      doc('without', { date: '2026-01-01' }),
    ]);
    expect(others[0]).toEqual({
      id: 'with', title: 'Cardiology follow-up', typeLabel: 'Clinic Letter', day: '2026-09-14', content: '# Letter', sourceFileName: 'Letter.pdf',
      original: { name: '2026-09-14 Cardiology follow-up.pdf', mimeType: 'application/pdf' },
    });
    expect(others[1]).toMatchObject({ original: null, sourceFileName: null });
  });

  it('an empty record lists none', () => {
    expect(shelf([])).toEqual({ scans: [], others: [] });
  });
});
