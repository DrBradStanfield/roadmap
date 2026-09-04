/**
 * Client-side ZIP extraction using JSZip.
 * Bundled in health-upload.js (separate IIFE).
 */
import JSZip from 'jszip';
import { isImportableEntryName } from '@roadmap/health-core';

const MAX_FILES = 200;

/** ZIP entry enumeration — filters junk, dotfiles, unsupported extensions
 *  (the rule is health-core's, shared with the connector's import). */
export async function getZipEntries(file: File): Promise<Array<{ name: string; entry: JSZip.JSZipObject }>> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const entries: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir || !isImportableEntryName(relativePath)) return;
    entries.push({ name: relativePath, entry });
  });

  return entries.slice(0, MAX_FILES);
}

/** Returns true if file is a ZIP */
export function isZip(file: File): boolean {
  return file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip');
}
