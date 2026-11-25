/**
 * Entry point for health-upload.js IIFE bundle.
 * Exposes window.HealthUpload with file processing functions.
 * No React, no UI — pure processing logic only.
 */
import { extractFromPdf, isPdf } from './lib/pdf-extract';
import { getZipEntries } from './lib/zip-extract';
import { resizeImage, isImage } from './lib/image-resize';
import { docxToText } from './lib/docx-extract';
// The shared upload Save and its review (health-core), here so only a page that uploads loads them (mount 3a).
import { uploadSave } from '@roadmap/health-core/upload-save';
import { uploadReview } from '@roadmap/health-core/upload-review';

export { extractFromPdf, isPdf, getZipEntries, resizeImage, isImage, docxToText, uploadSave, uploadReview };

const api = { extractFromPdf, isPdf, getZipEntries, resizeImage, isImage, docxToText, uploadSave, uploadReview };

/** What the main widget bundle reads from `window.HealthUpload` (UploadModal), typed from this bundle's own functions. */
export type HealthUploadAPI = typeof api;

declare global {
  interface Window { HealthUpload?: HealthUploadAPI }
}

// Expose on window for the main widget bundle to access
window.HealthUpload = api;
