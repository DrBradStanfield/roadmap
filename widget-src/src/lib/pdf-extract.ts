/**
 * Client-side PDF text/image extraction using pdfjs-dist.
 * Bundled in health-upload.js (separate IIFE), NOT in main widget.
 */
import * as pdfjsLib from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';

// Inline the pdf.js worker as a blob URL so it works from any CDN origin.
// The ?raw import inlines the worker source at build time.
const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

const MAX_PAGES = 20;
const TEXT_THRESHOLD = 50; // chars per page to consider "text-based"

export interface PageContent {
  type: 'text' | 'image';
  content: string;
  mimeType?: string;
}

/**
 * Extract content from a PDF file. Returns an array of page content blocks.
 * Text-based pages → text content (cheaper LLM call).
 * Scanned/image pages → JPEG base64 (vision LLM call).
 */
export async function extractFromPdf(file: File): Promise<PageContent[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageCount = Math.min(pdf.numPages, MAX_PAGES);
  const pages: PageContent[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);

    // Try text extraction first
    const textContent = await page.getTextContent();
    const text = (textContent.items as Array<{ str?: string }>)
      .map(item => item.str || '')
      .join(' ')
      .trim();

    if (text.length > TEXT_THRESHOLD) {
      pages.push({ type: 'text', content: `[Page ${i}/${pdf.numPages}]\n${text}` });
    } else {
      // Scanned page — render to canvas → JPEG
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      const base64 = dataUrl.split(',')[1];
      // Release GPU-backed pixel buffer immediately
      canvas.width = 0;
      canvas.height = 0;
      pages.push({ type: 'image', content: base64, mimeType: 'image/jpeg' });
    }

    page.cleanup();
  }

  return pages;
}

/** Returns true if the file looks like a PDF */
export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}
