/**
 * Document file paths — the organised-archive scheme (Brad's design, 2026-06-10).
 *
 * Raw uploads live in the USER's own cloud, next to the JSON record, sorted
 * into human folders by the AI's classification and named date-first so every
 * cloud UI lists them chronologically:
 *
 *   Lab results/2024-05-10 Lipid panel.pdf
 *   Scans/2025-01-22 Chest X-ray.jpg
 *
 * The returned path IS the FileDocument.fileRef — adapters map it to storage
 * (Dropbox/GitHub/WebDAV use it verbatim; Drive maps each top folder to a real
 * subfolder of 'Health Plan by Dr Brad').
 */
import type { DocumentType } from './validation';

/** AI classification → human folder. Few folders, deliberately. */
export const DOCUMENT_FOLDERS: Record<DocumentType, string> = {
  pathology_report: 'Lab results',
  scan_result: 'Scans',
  clinic_letter: 'Clinic letters',
  discharge_summary: 'Clinic letters',
  vaccination_record: 'Other documents',
  other: 'Other documents',
};

/** Longest file name we'll generate (excluding folder), extension included. */
const MAX_NAME_LENGTH = 80;

/**
 * Make a title safe as a file name on every backend: strip path separators
 * and characters Windows/Drive/Dropbox reject, collapse whitespace, trim
 * trailing dots (Windows). Falls back to 'Document' when nothing survives.
 */
export function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim();
  return cleaned || 'Document';
}

/** Lowercased extension (with dot) from a source file name, '' if none. */
export function extensionOf(sourceFileName: string | null | undefined): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(sourceFileName ?? '');
  return match ? `.${match[1].toLowerCase()}` : '';
}

/**
 * Build the fileRef for an upload: `<folder>/<YYYY-MM-DD> <title><ext>`.
 *
 * - `date`: the DOCUMENT's own date (AI-extracted, user-corrected in review);
 *   pass the upload date as fallback when the document has none.
 * - `existingRefs`: the refs already in the user's file — name collisions get
 *   a " (2)" / " (3)" suffix so nothing is ever overwritten.
 */
export function buildDocumentRef(opts: {
  type: DocumentType;
  title: string;
  date: string; // YYYY-MM-DD
  sourceFileName?: string | null;
  existingRefs: Iterable<string>;
}): string {
  const folder = DOCUMENT_FOLDERS[opts.type] ?? 'Other documents';
  const ext = extensionOf(opts.sourceFileName);
  let base = `${opts.date} ${sanitizeTitle(opts.title)}`;
  if (base.length + ext.length > MAX_NAME_LENGTH) {
    base = base.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd();
  }

  const taken = new Set<string>();
  for (const ref of opts.existingRefs) taken.add(ref.toLowerCase());

  let candidate = `${folder}/${base}${ext}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${folder}/${base} (${n})${ext}`;
  }
  return candidate;
}
