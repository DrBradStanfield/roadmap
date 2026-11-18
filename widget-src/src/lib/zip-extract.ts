/**
 * Client-side ZIP listing using JSZip.
 * Bundled in health-upload.js (separate IIFE).
 */
import JSZip from 'jszip';
import { fileNameLine } from '@roadmap/health-core/lab-extraction';
import { UPLOAD_LIMITS, zipMemberVerdict } from '@roadmap/health-core/upload-rules';

/** One member to read: its cleaned path, its entry (inflated only when read, US-12 AC1), and its
 *  size from the ZIP's directory. JSZip keeps that size on `_data`, which its types leave private;
 *  `bytes` is absent when it gives none, and the read checks the size once inflated. */
export interface ZipEntry { name: string; entry: JSZip.JSZipObject; bytes?: number }
type Listed = JSZip.JSZipObject & { _data?: { uncompressedSize?: unknown } };

/** ZIP entry enumeration — filters junk, dotfiles, unsupported extensions
 *  (the rule is health-core's zipMemberVerdict, the connector's isImportableEntryName). */
export async function getZipEntries(file: File): Promise<ZipEntry[]> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const entries: ZipEntry[] = [];
  zip.forEach((relativePath, entry) => {
    // The cleaned name, as the connector's unzip uses: one member, one decision.
    const name = fileNameLine(relativePath);
    if (entry.dir || zipMemberVerdict(name, 'web') !== 'keep') return;
    const size = (entry as Listed)._data?.uncompressedSize;
    entries.push({ name, entry, ...(typeof size === 'number' ? { bytes: size } : null) });
  });

  return entries.slice(0, UPLOAD_LIMITS.web.zipMembers);
}
