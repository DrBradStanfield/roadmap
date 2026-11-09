// The upload pipeline: what a file read becomes (FileResult), what the review hands back to save, and the pure steps between.
import { resolveLabValues, type RefusedLabValue } from '@roadmap/health-core/lab-extraction';
import { UNIT_DEFS, reportedToCanonical } from '@roadmap/health-core/units';
import { comparatorOf, type Comparator } from '@roadmap/health-core/lab-limits';
import { bloodTestKeyOf } from '@roadmap/health-core/blood-tests';
import type { MeasurementSource } from '@roadmap/health-core/validation';
import type { ExtractedValue, AdditionalLabValue, DocumentResult } from './api-types';

export interface FileResult {
  fileName: string;
  reportDate: string | null;
  values: ExtractedValue[];
  additionalValues: AdditionalLabValue[];
  error?: string;
  /** Present for non-lab documents (scan results, clinic letters, etc.) */
  document?: DocumentResult;
  /** Values the extractor refused rather than guessed, listed under "Not saved" (US-12 AC15). */
  refusedValues?: RefusedLabValue[];
  /** The original uploaded bytes — saved into the user's cloud archive (v2). */
  file?: Blob;
  /** 'sha256-<hex>' of `file` — matched against the record's document rows. */
  contentHash?: string;
}

/** Document to be saved, assembled from review state */
export interface DocumentToSave {
  documentType: string;
  title: string;
  documentDate: string | null;
  contentMd: string;
  metadata: Record<string, unknown>;
  sourceFileName: string | null;
  /** If this maps to a screening type, the key to update (e.g. "colorectal_last_date") */
  screeningUpdate?: { key: string; date: string };
  /** The original bytes, carried inside the payload (no name-keyed re-join). */
  file?: Blob;
}

/** A reviewed row on its way to the store. `correctsId` is set when the user
 *  ticked "Replace" on a slot an earlier writer already holds — the store
 *  turns it into a FHIR correction. */
export interface ReviewedValue {
  metric: string; valueSI: number; recordedAt: string; source?: MeasurementSource; correctsId?: string;
  /** Printed as a limit and saved as printed (US-12 AC20); an edited cell is an exact value. */
  comparator?: Comparator;
}
export interface ReviewedLabValue {
  name: string; value: number; unit: string;
  referenceLow?: number | null; referenceHigh?: number | null;
  recordedAt: string; correctsId?: string;
  comparator?: Comparator;
}

/**
 * Brad D5 (US-66 AC6): an extra value named like a core test, creatinine
 * excepted (US-12 AC11), is offered as that core value. The extractor moves
 * one into a free slot; one it left is offered here. In a unit the test takes
 * it joins the core row, where a held day shows the conflict (US-13 AC3) and
 * a second reading of a day is listed as hidden (US-12 AC14). In any other
 * unit it is listed as not saved, with why (US-12 AC19).
 */
export function offerCoreExtras(result: Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'>): Pick<FileResult, 'values' | 'additionalValues' | 'refusedValues'> {
  const values = [...result.values];
  const additionalValues: FileResult['additionalValues'] = [];
  const refusedValues = [...(result.refusedValues ?? [])];
  for (const v of result.additionalValues ?? []) {
    const metric = bloodTestKeyOf(v.name);
    if (!metric || metric === 'creatinine') { additionalValues.push(v); continue; }
    const day = { ...(v.recordedAt ? { recordedAt: v.recordedAt } : null), ...(v.printedMonth ? { printedMonth: v.printedMonth } : null) };
    if (reportedToCanonical(metric, v.value, v.unit)) {
      values.push(...resolveLabValues([{ metric, value: v.value, unit: v.unit, confidence: v.confidence ?? 'high', question: v.question, printedName: v.printedName, ...day, ...comparatorOf(v) }]));
    } else {
      const { si, conventional } = UNIT_DEFS[metric].label;
      refusedValues.push({ metric, value: v.value, unit: v.unit, reason: `This test is measured in ${si === conventional ? si : `${si} or ${conventional}`}.`, ...day });
    }
  }
  return { values, additionalValues, ...(refusedValues.length ? { refusedValues } : null) };
}
