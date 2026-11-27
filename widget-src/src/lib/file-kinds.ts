/**
 * What a picked file is, by its mime type or name (US-12 AC13). Pure, so the
 * modal reads and counts by the same rule without loading the upload bundle.
 * Which archived original opens: health-core file-kinds.ts (US-14 AC14).
 */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A ZIP by its type or name. A .docx is a ZIP too, and some browsers say so: the upload checks isDocx first. */
export function isZip(file: File): boolean {
  return file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip');
}

/** Returns true if the file looks like a .docx */
export function isDocx(file: File): boolean {
  return file.type === DOCX_MIME || file.name.toLowerCase().endsWith('.docx');
}

/** Returns true for a legacy Word .doc, which the upload cannot read. */
export function isLegacyDoc(file: File): boolean {
  return file.type === 'application/msword' || file.name.toLowerCase().endsWith('.doc');
}
