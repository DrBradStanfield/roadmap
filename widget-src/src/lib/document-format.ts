export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  scan_result: 'Scan Result',
  clinic_letter: 'Clinic Letter',
  discharge_summary: 'Discharge Summary',
  pathology_report: 'Pathology Report',
  vaccination_record: 'Vaccination Record',
  other: 'Document',
};

/** Format a YYYY-MM-DD date string for display. */
export function formatDocumentDate(dateStr: string | null): string {
  if (!dateStr) return 'Date unknown';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
