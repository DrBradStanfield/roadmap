/**
 * Client-side ZIP extraction using JSZip.
 * Bundled in health-upload.js (separate IIFE).
 */
import JSZip from 'jszip';
import { fileNameLine, IMPORT_LIMITS, isImportableEntryName } from '@roadmap/health-core';

/** ZIP entry enumeration — filters junk, dotfiles, unsupported extensions
 *  (the rule is health-core's, shared with the connector's import). */
export async function getZipEntries(file: File): Promise<Array<{ name: string; entry: JSZip.JSZipObject }>> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const entries: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  zip.forEach((relativePath, entry) => {
    // The cleaned name, as the connector's unzip uses: one member, one decision.
    const name = fileNameLine(relativePath);
    if (entry.dir || !isImportableEntryName(name)) return;
    entries.push({ name, entry });
  });

  return entries.slice(0, IMPORT_LIMITS.websiteFiles);
}

/** Returns true if file is a ZIP */
export function isZip(file: File): boolean {
  return file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip');
}
