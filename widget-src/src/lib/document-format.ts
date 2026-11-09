/** Format a YYYY-MM-DD date string for display. */
export function formatDocumentDate(dateStr: string | null): string {
  if (!dateStr) return 'Date unknown';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
