/**
 * Client-side ZIP extraction using JSZip.
 * Bundled in health-upload.js (separate IIFE).
 */
import JSZip from 'jszip';
import { extractFromPdf, isPdf, type PageContent } from './pdf-extract';
import { resizeImage } from './image-resize';

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

/**
 * Process a ZIP file: extract supported files, convert each to PageContent[].
 * Files are processed sequentially to manage memory.
 */
export async function processZip(
  file: File,
  onProgress?: (progress: ZipProgress) => void,
  abortSignal?: AbortSignal,
): Promise<ExtractedFile[]> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Filter to supported files, skip junk
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

  const filesToProcess = entries.slice(0, MAX_FILES);
  const results: ExtractedFile[] = [];

  for (let i = 0; i < filesToProcess.length; i++) {
    if (abortSignal?.aborted) break;

    const { name, entry } = filesToProcess[i];
    onProgress?.({ current: i + 1, total: filesToProcess.length, fileName: name });

    try {
      const blob = await entry.async('blob');
      const fileObj = new File([blob], name.split('/').pop() || name);

      let pages: PageContent[];
      if (isPdf(fileObj)) {
        pages = await extractFromPdf(fileObj);
      } else {
        // Image file
        const base64 = await resizeImage(fileObj, 1500);
        pages = [{ type: 'image', content: base64, mimeType: 'image/jpeg' }];
      }

      results.push({ fileName: name, pages });
    } catch (error) {
      console.warn(`Failed to process ${name}:`, error);
    }
  }

  return results;
}

/** Returns true if file is a ZIP */
export function isZip(file: File): boolean {
  return file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed' ||
    file.name.toLowerCase().endsWith('.zip');
}
