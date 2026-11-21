/**
 * The upload review's Save (US-12 AC6), unchanged in what it writes: the values first, then the
 * documents, so a lab report's archive row lists the rows its values wrote (US-14 AC10). The
 * shared upload state (health-core upload-flow.ts) holds the mode; this writes one attempt and
 * says what it saved, or why the review stays open.
 */
import type { DocumentPayload, ExistingDoc } from '@roadmap/health-core/document-save';
import { labRowsByFile } from '@roadmap/health-core/document-rows';
import { bulkSaveMeasurements, bulkSaveDocuments, bulkSaveLabValues, getEraseIdentity, getShownErase } from './roadmap-data';
import { countRefusedSpellings } from './refused-spellings';
import type { BulkLabValuesResult, BulkSaveResult } from './api-types';
import type { ReviewDecisions } from './upload-pipeline';
import { synthesizeLabArchiveEntries, connectorDocumentEntries } from './archive-payloads';
import { toStoreInputs } from './to-store-inputs';
import { Sentry } from './sentry';
import { recordFailure, WritesStoppedError } from './error-diagnostics';
import { joinRows, type SaveOutcome } from './upload-save-outcome';
import { isScreeningDateKey } from '@roadmap/health-core/upload-screening';

export interface SaveContext {
  /** The lab rows earlier attempts of this review wrote. */
  earlierRows: ReadonlyMap<string, string[]>;
  /** The page's re-read; a partial save waits for it before a retry (US-12 AC6c). */
  complete: () => void | Promise<void>;
  /** `erase`: the erase the page showed as the save began (US-16 AC2a). */
  screening?: (screeningKey: string, value: string, erase: string) => void;
  /** The record's documents as the review read them, for the connector's metadata-only letters. */
  existing: ReadonlyArray<ExistingDoc>;
}

/** One Save attempt: `attempt` is what it wrote (absent when it threw before writing); `message`,
 *  present when something failed, keeps the review open with its words for a retry. */
export async function saveReview(d: ReviewDecisions, { earlierRows, complete, screening, existing }: SaveContext): Promise<{ attempt?: SaveOutcome; message?: string }> {
  const { values: selectedValues, documents, labValues, reviewed, labRefusals = [] } = d;
  const erase = getShownErase(); // the record this save was asked for
  try {
    const { measurements, labValues: labValuePayloads } = toStoreInputs({ values: selectedValues, labValues });

    // Each branch settles before the session becomes dismissible. One
    // rejected write must not release another archive that is still saving.
    // A throw is a programming error, not a store result: report it (tag
    // only — no payload, names or values) and keep the review for a retry.
    // A log-off refusal keeps the review too, unreported (US-09 AC2c, A19).
    let threw = false;
    const failed = <T,>(branch: string, fallback: T) => (err: unknown) => {
      threw = true;
      if (!(err instanceof WritesStoppedError)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch } });
      return fallback;
    };
    // The values first, then the documents: a lab report's archive row lists
    // the rows its values wrote (US-14 AC10), this attempt's and an earlier
    // one's, whose values a retry skips as already saved. A failed branch
    // stops neither other, as when they ran side by side.
    const savedValues: BulkSaveResult = measurements.length > 0 ? await bulkSaveMeasurements(measurements).catch(failed('measurements', { saved: [], skippedDuplicates: 0, errorCount: measurements.length, refused: [] })) : { saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] };
    const savedLabValues: BulkLabValuesResult = labValuePayloads.length > 0 ? await bulkSaveLabValues(labValuePayloads).catch(failed('labValues', { saved: [], skippedDuplicates: 0, errorCount: labValuePayloads.length, refused: [] })) : { saved: [], skippedDuplicates: 0, errorCount: 0, refused: [] };
    const labRows = labRowsByFile(
      [...(savedValues.labRows ?? measurements.map(() => null)), ...(savedLabValues.labRows ?? labValuePayloads.map(() => null))],
      [...selectedValues.map(v => v.file), ...labValues.map(v => v.file)],
    );
    // Blobs travel INSIDE the payload (attached at processing time, and only
    // when the backend can archive them) — no name-keyed re-join here.
    const docPayloads: DocumentPayload<Blob>[] = documents.map(doc => ({
      documentType: doc.documentType,
      title: doc.title,
      documentDate: doc.documentDate,
      contentMd: doc.contentMd,
      metadata: doc.metadata,
      sourceFileName: doc.sourceFileName,
      file: doc.file,
      contentHash: doc.contentHash,
    }));
    // By each file's identity: a letter and a lab report can share a name.
    const covered = new Set(documents.flatMap(doc => (doc.fileKey ? [doc.fileKey] : [])));
    docPayloads.push(...synthesizeLabArchiveEntries(reviewed, covered, joinRows(earlierRows, labRows)));
    // A letter the connector filed metadata-only: unselected here, still archived
    // (US-35 AC8), with the title and date the review shows (US-13 AC6).
    docPayloads.push(...connectorDocumentEntries(reviewed, existing, covered));
    const savedDocs = docPayloads.length > 0 ? await bulkSaveDocuments(docPayloads).catch(failed('documents', { saved: [], errorCount: docPayloads.length, unstored: 0 })) : { saved: [], errorCount: 0, unstored: 0 };

    const saveErrors = savedValues.errorCount + savedLabValues.errorCount + savedDocs.errorCount;
    const attempt: SaveOutcome = {
      values: savedValues.saved.length,
      labValues: savedLabValues.saved.length,
      documents: [...new Set(savedDocs.saved.map(doc => doc.contentHash ?? doc.sourceFileName ?? doc.id))],
      skippedValues: savedValues.skippedDuplicates, skippedLabValues: savedLabValues.skippedDuplicates,
      unstored: savedDocs.unstored ?? 0,
      refusedLabUnits: savedLabValues.refused, refusedMeasurements: savedValues.refused,
      labRows,
    };
    // A save error keeps the review open for retry (US-12 AC6). Skipped
    // values and refusals are settled outcomes, reported on the done screen;
    // a skip does not establish that the reviewed value is already saved.
    const totalSaved = savedValues.saved.length + savedDocs.saved.length + savedLabValues.saved.length;

    // Update screening dates for documents with screening mappings, unless
    // the record was erased while the save ran: the date belongs to it.
    for (const doc of getEraseIdentity() === erase ? documents : []) {
      if (doc.screeningUpdate && screening && isScreeningDateKey(doc.screeningUpdate.key)) screening(doc.screeningUpdate.key, doc.screeningUpdate.date, erase);
    }

    // A re-read that fails, at once or later, is only reported: what saved stays saved.
    const reportReread = (err: unknown) => { if (!(err instanceof WritesStoppedError)) Sentry.captureException(recordFailure(err, 'Upload save failed'), { tags: { area: 'upload-save', branch: 'reread' } }); };
    const reread = () => { try { return Promise.resolve(complete()).catch(reportReread); } catch (err) { reportReread(err); return Promise.resolve(); } };
    if (!threw && saveErrors === 0) {
      // The labs the review did not send, counted as refused spellings, as the store would (US-21 AC15).
      countRefusedSpellings(labRefusals);
      void reread();
      return { attempt };
    }
    // Stay in review: a second Save retries idempotently (values dedup on
    // skippedDuplicates, documents on contentHash). Save stays busy until the
    // page has read back what saved, so the retry does not send it again; a failed re-read is only reported.
    if (totalSaved > 0) await reread();
    return { attempt, message: threw ? 'Some items could not be saved. Please try again.' : 'Failed to save. Please try again.' };
  } catch {
    return { message: 'Failed to save. Please try again.' };
  }
}
