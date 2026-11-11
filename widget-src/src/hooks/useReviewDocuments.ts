import { useState, useMemo, useEffect, useRef } from 'react';
import type { DocumentType } from '@roadmap/health-core/validation';
import { isScreeningEligible } from '@roadmap/health-core/types';
import { pendingRowsFor } from '@roadmap/health-core/document-save';
import type { ApiDocument, UploadHistory } from '../lib/api-types';
import { unarchivedOriginals } from '../lib/archive-payloads';
import { type FullDate, columnDay, readDocumentDate } from '../lib/review-dates';
import type { FileResult, DocumentToSave } from '../lib/upload-pipeline';

/** Dedup on sourceFileName: stable across LLM re-extractions (titles drift,
 *  the source filename doesn't). The user can manually re-check the box if
 *  they want to save a same-filename second copy. */
function buildDocHistoryIndex(history: ApiDocument[]): Set<string> {
  const idx = new Set<string>();
  for (const d of history) {
    if (!d.sourceFileName) continue;
    idx.add(d.sourceFileName);
  }
  return idx;
}

function isDocDuplicate(sourceFileName: string | null, idx: Set<string>): boolean {
  if (!sourceFileName) return false;
  return idx.has(sourceFileName);
}

/** The names under which `after` holds a document `before` did not: filed
 *  since (US-12 AC6). A reload that filed nothing names none (US-12 AC6b). */
function newlyFiledNames(before: ApiDocument[], after: ApiDocument[]): Set<string> {
  const held = new Set(before.map(d => d.id));
  return new Set(after.flatMap(d => (d.sourceFileName && !held.has(d.id) ? [d.sourceFileName] : [])));
}

/** `checked` with every document filed under one of `filed` unticked. */
function uncheckFiled(checked: Record<number, boolean>, results: FileResult[], filed: Set<string>): Record<number, boolean> {
  const next = { ...checked };
  results.forEach((r, fi) => { if (r.document && filed.has(r.fileName)) next[fi] = false; });
  return next;
}

/** Order in which document type sections render: scans, then letters,
 *  then other admin docs. Exhaustive over DocumentType so a typo (or a
 *  new enum value added without ordering) is a compile error, not a
 *  silent fall-through to the bottom of the list. */
const DOC_TYPE_ORDER: Record<DocumentType, number> = {
  scan_result: 0,
  clinic_letter: 1,
  discharge_summary: 2,
  pathology_report: 3,
  vaccination_record: 4,
  other: 99,
};

/** The upload review's per-document state: which documents save, their
 *  titles, dates and screening updates, and the file sections' order. Each
 *  map is keyed by the file's index in `results`. */
export function useReviewDocuments(results: FileResult[], history: UploadHistory, userAge: number | undefined, sex: 'male' | 'female' | undefined) {
  const docHistoryIndex = useMemo(() => buildDocHistoryIndex(history.documents), [history.documents]);

  // Render order: value-only files first, then document-bearing files
  // grouped by type (scans → letters → other) and within type by date desc.
  // Errored files go last. Each entry keeps its original index so all the
  // per-row state (`checked`, `fileDates`, …) keys stay stable.
  const sortedResults = useMemo(() =>
    results.map((r, fi) => ({ r, fi })).sort((a, b) => {
      const aErr = a.r.error ? 2 : 0;
      const bErr = b.r.error ? 2 : 0;
      if (aErr !== bErr) return aErr - bErr;
      const aDoc = a.r.document ? DOC_TYPE_ORDER[a.r.document.classification] : -1;
      const bDoc = b.r.document ? DOC_TYPE_ORDER[b.r.document.classification] : -1;
      if (aDoc !== bDoc) return aDoc - bDoc;
      const aDate = a.r.document?.documentDate ?? '';
      const bDate = b.r.document?.documentDate ?? '';
      return bDate.localeCompare(aDate);
    }),
    [results],
  );

  // Default: checked for new docs, unchecked for already-saved ones.
  const [docChecked, setDocChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => {
      if (!r.document) return;
      map[fi] = !isDocDuplicate(r.fileName, docHistoryIndex);
    });
    return map;
  });
  // A document the record now holds (a partial save reloaded history) unchecks
  // itself, so a retry cannot file it twice. The user can still re-tick it,
  // and a reload that filed nothing under its name keeps that tick (US-12 AC6b).
  const shownDocuments = useRef(history.documents);
  useEffect(() => {
    const filed = newlyFiledNames(shownDocuments.current, history.documents);
    shownDocuments.current = history.documents;
    setDocChecked(prev => uncheckFiled(prev, results, filed));
  }, [history.documents, results]);

  // A document whose bytes metadata-only shown-document rows hold (a failed
  // upload, or the connector's) replaces them, so its card starts from the
  // newest: the user sees the earlier title and date, a missing date included,
  // and can change them (US-14 AC4).
  const [heldRows] = useState(() => results.map(r => (r.document ? pendingRowsFor(history.documents, r.contentHash, false)[0] : undefined)));
  // A document's date is its own, never the blood-test column's: the day it
  // saves, null until known or picked. A month alone still dates its
  // screening update until the user picks a day or clears it (US-13 AC6).
  const [documentDates, setDocumentDates] = useState<Record<number, { day: string | null; month: string | null }>>(() =>
    Object.fromEntries(results.map((r, fi) => [fi, readDocumentDate(heldRows[fi] ? heldRows[fi].documentDate : r.document?.documentDate)])));
  const screeningDateFor = (fi: number) => documentDates[fi]?.day ?? documentDates[fi]?.month ?? null;

  // Per-document: editable title
  const [docTitles, setDocTitles] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    results.forEach((r, fi) => { if (r.document) map[fi] = heldRows[fi]?.title ?? r.document.title; });
    return map;
  });

  // Per-document: whether to update screening date (when screeningType is present AND user is old enough).
  // No age (no plan) starts unticked: eligibility is unknown (US-06 AC5). The user can still tick it.
  const [screeningChecked, setScreeningChecked] = useState<Record<number, boolean>>(() => {
    const map: Record<number, boolean> = {};
    results.forEach((r, fi) => {
      const st = r.document?.metadata?.screeningType as string | undefined;
      if (st && userAge !== undefined && isScreeningEligible(st, userAge, sex)) {
        map[fi] = true;
      }
    });
    return map;
  });

  const selectedDocCount = useMemo(() => Object.values(docChecked).filter(Boolean).length, [docChecked]);
  // Original lab PDFs remain retryable after saved values become context.
  // Connector metadata-only letters also carry archive-only work (US-35 AC8).
  const archiveCount = useMemo(() => {
    const selectedDocs = new Set(results.filter((r, fi) => r.document && docChecked[fi]).map((r) => r.fileName));
    return unarchivedOriginals(results, history.documents, selectedDocs).length;
  }, [results, history.documents, docChecked]);

  /** Save's document half. Every result as reviewed: the report date is the
   *  column's past day or unknown, never the extracted string (US-13 AC8).
   *  Then the ticked documents, each with its screening update. */
  const documentsToSave = (fileDates: Record<string, FullDate>) => {
    const reviewed: FileResult[] = results.map((r, fi) => ({
      ...r,
      reportDate: columnDay(fileDates[fi]),
      ...(r.document ? { document: { ...r.document, title: docTitles[fi] || r.document.title, documentDate: documentDates[fi]?.day ?? null } } : {}),
    }));
    const documents: DocumentToSave[] = [];
    reviewed.forEach(({ document: doc, fileName, file }, fi) => {
      if (!doc || !docChecked[fi]) return;
      const screeningType = doc.metadata?.screeningType as string | undefined;
      const screeningDate = screeningDateFor(fi);
      documents.push({
        documentType: doc.classification,
        title: doc.title,
        documentDate: doc.documentDate,
        contentMd: doc.contentMarkdown,
        metadata: doc.metadata,
        sourceFileName: fileName,
        screeningUpdate: screeningType && screeningChecked[fi] && screeningDate
          ? { key: `${screeningType}_last_date`, date: screeningDate }
          : undefined,
        file,
      });
    });
    return { reviewed, documents };
  };

  return {
    sortedResults,
    isSaved: (r: FileResult) => isDocDuplicate(r.fileName, docHistoryIndex),
    docChecked, setDocChecked,
    documentDates, setDocumentDates, screeningDateFor,
    docTitles, setDocTitles,
    screeningChecked, setScreeningChecked,
    selectedDocCount, archiveCount,
    documentsToSave,
  };
}

export type ReviewDocuments = ReturnType<typeof useReviewDocuments>;
