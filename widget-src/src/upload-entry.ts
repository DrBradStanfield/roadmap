/**
 * Entry point for health-upload.js IIFE bundle.
 * Exposes window.HealthUpload with file processing functions.
 * No React, no UI — pure processing logic only.
 */
import { extractFromPdf, isPdf } from './lib/pdf-extract';
import { getZipEntries, isZip } from './lib/zip-extract';
import { resizeImage, isImage } from './lib/image-resize';
import { docxToText } from './lib/docx-extract';

export { extractFromPdf, isPdf, getZipEntries, isZip, resizeImage, isImage, docxToText };

const api = { extractFromPdf, isPdf, getZipEntries, isZip, resizeImage, isImage, docxToText };

/** What the main widget bundle reads from `window.HealthUpload` (UploadModal), typed from this bundle's own functions. */
export type HealthUploadAPI = typeof api;

declare global {
  interface Window { HealthUpload?: HealthUploadAPI }
}

// Expose on window for the main widget bundle to access
window.HealthUpload = api;
