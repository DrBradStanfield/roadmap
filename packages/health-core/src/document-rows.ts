/**
 * The document row, built once for every writer: the website and the iPhone
 * app through `saveDocuments` (document-save.ts), and the connector's import
 * commit (mcp-tools.ts). This module holds no save and no I/O, so the
 * connector builds its rows without importing the blob-writing path.
 */
import { LAB_ARCHIVE_TITLE } from './document-path';
import type { FileDocument } from './roadmap-file';
import type { DocumentType } from './validation';

/**
 * Metadata flag stamped on synthesized blood-test archive entries. These exist
 * ONLY to persist the original lab PDF to the user's cloud — the extracted
 * VALUES surface in the Blood Test Results table, so the synthesized entry must
 * never appear in the Documents list. Real biopsy/histology pathology reports
 * carry markdown content + their own metadata and are NEVER flagged.
 */
export const LAB_ARCHIVE_FLAG = 'labArchive';

/** What a reviewed document says about itself, before it is a row. */
export interface DocumentFields {
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
}

/**
 * The hidden row that keeps a lab report's original in the user's cloud: the
 * extracted values live in the record, so this row carries no text. One shape
 * for the website, the iPhone app and the connector.
 */
export function labArchiveFields(sourceFileName: string | null, reportDate: string | null): DocumentFields {
  return {
    documentType: 'pathology_report',
    title: LAB_ARCHIVE_TITLE,
    documentDate: reportDate,
    contentMd: '',
    metadata: { [LAB_ARCHIVE_FLAG]: true },
    sourceFileName,
  };
}

/**
 * A new document row with no original stored yet (`fileRef: ''`). A save that
 * then stores the blob sets `fileRef` and `mimeType` on it; the connector never
 * stores one (US-35 AC8).
 */
export function documentRow(d: DocumentFields, row: Pick<FileDocument, 'id' | 'contentHash' | 'mimeType' | 'addedAt'>): FileDocument {
  return {
    id: row.id, title: d.title, type: d.documentType as DocumentType, date: d.documentDate,
    fileRef: '', contentHash: row.contentHash, mimeType: row.mimeType, extractedText: d.contentMd,
    addedAt: row.addedAt, metadata: d.metadata, sourceFileName: d.sourceFileName,
  };
}
