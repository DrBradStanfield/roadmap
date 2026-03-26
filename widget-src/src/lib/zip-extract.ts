/**
 * Client-side ZIP extraction using JSZip.
 * Bundled in health-upload.js (separate IIFE).
 */
import JSZip from 'jszip';
import type { PageContent } from './pdf-extract';

const MAX_FILES = 20;
const JUNK_PATTERNS = ['__macosx/', '.ds_store', 'thumbs.db'];
const SUPPORTED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];

export interface ExtractedFile {
  fileName: string;
  pages: PageContent[];
}

export interface ZipProgress {
  current: number;
  total: number;
  fileName: string;
}

/** ZIP entry enumeration — filters junk, dotfiles, unsupported extensions. */
export async function getZipEntries(file: File): Promise<Array<{ name: string; entry: JSZip.JSZipObject }>> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const entries: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const lower = relativePath.toLowerCase();
    if (JUNK_PATTERNS.some(p => lower.includes(p))) return;
    if (lower.startsWith('.')) return;
    const ext = '.' + lower.split('.').pop();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) return;
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
