/**
 * What a picked file is, by its mime type or name (US-12 AC13). Pure, so the
 * modal reads and counts by the same rule without loading the upload bundle.
 */
import { extensionOf } from '@roadmap/health-core';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Returns true if the file looks like a .docx */
export function isDocx(file: File): boolean {
  return file.type === DOCX_MIME || file.name.toLowerCase().endsWith('.docx');
}

/** The passive types an archived original may open as in a tab, by its ref's extension. */
const VIEWABLE_TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.heic': 'image/heic' };

/** The type to open an archived original as, or null to download it (US-14 AC3).
 *  A blob: URL opened in a tab runs with the page's origin, so the ref's
 *  extension must name a passive type and the stored bytes must carry that type
 *  or none (Dropbox and GitHub return untyped bytes). */
export function viewableType(fileRef: string, blobType: string): string | null {
  const type = VIEWABLE_TYPES[extensionOf(fileRef)];
  const stored = blobType.split(';')[0].trim().toLowerCase();
  return type && (stored === type || stored === '' || stored === 'application/octet-stream') ? type : null;
}

/** Returns true for a legacy Word .doc, which the upload cannot read. */
export function isLegacyDoc(file: File): boolean {
  return file.type === 'application/msword' || file.name.toLowerCase().endsWith('.doc');
}
