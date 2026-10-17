/**
 * Entry point for health-upload.js IIFE bundle.
 * Exposes window.HealthUpload with file processing functions.
 * No React, no UI — pure processing logic only.
 */
import { extractFromPdf, isPdf } from './lib/pdf-extract';
import { getZipEntries, isZip } from './lib/zip-extract';
import { resizeImage, isImage } from './lib/image-resize';
import { docxToText, isDocx, isLegacyDoc } from './lib/docx-extract';

export { extractFromPdf, isPdf, getZipEntries, isZip, resizeImage, isImage, docxToText, isDocx, isLegacyDoc };

// Expose on window for the main widget bundle to access
(window as any).HealthUpload = {
  extractFromPdf,
  isPdf,
  getZipEntries,
  isZip,
  resizeImage,
  isImage,
  docxToText,
  isDocx,
  isLegacyDoc,
};
