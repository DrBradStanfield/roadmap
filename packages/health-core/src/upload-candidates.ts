/**
 * One candidate per offered value (web list PR 1b; US-13 AC5, AC12, AC26): the number Save would send for it, the person's
 * edit else the one read; a value holding typed text has none. Its fault comes from that candidate alone: the held text, or
 * a core value outside its range in the units table. One exception: a sent value the write refuses for a reason its own
 * number does not show (a blood pressure half of a pair the wrong way up, a lab filed as a core value out of its range)
 * carries the review's own refusal.
 *
 * A value is selected when ticked, its conflict not kept unless replacing (US-13 AC5), and it can be saved at all (no own
 * day still to come). It blocks Save when it holds typed text, or when it is a selected core value with a fault, sent or
 * not (a lab's refusal never blocks: it is not saved, and says so). The list
 * (upload-list.ts) and Save's blockers (upload-view.ts `saveBlockers`) both read this. Pure.
 */
import { isCoreRef, offeredValues, type ClassifiedValue, type OfferedValue } from './import-review';
import { cellRange } from './cell-unit';
import { rangeFault, type MetricType } from './units';
import { PRESSURE_ORDER } from './validation';
import type { TypedText } from './upload-choices';
import type { UploadState } from './upload-flow';
import { readFiles, type UploadReview } from './upload-review';

export type RowFault =
  | { kind: 'typed'; text: string }
  | { kind: 'range'; metric: MetricType; fault: 'above' | 'below' }
  | { kind: 'refused'; message: string };

export interface Candidate {
  /** The lab file's index in `review.labFiles`, its id, the value's ref and what the read offered. */
  file: number; fileId: string; ref: string; at: OfferedValue; v: ClassifiedValue;
  ticked: boolean; typed: TypedText | null; edit: number | undefined;
  /** What Save would send: the edit, else the read number (a core value in SI); null while the row holds typed text. */
  candidate: number | null;
  fault: RowFault | null; selected: boolean; blocks: boolean;
}

/** A conflict whose held value stays: a copy never replaces (Replace lives on the reading that holds the slot). */
const keptConflict = (review: UploadReview, v: ClassifiedValue) =>
  v.group === 'unsure' && v.reasons.includes('conflict') && (!!v.copy || !review.labFiles[v.file].replacing.includes(v.ref));

/** Never saved whatever is done to its number: its own printed day is still to come. */
const undatable = (v: ClassifiedValue) => v.group === 'notSaved' && (v.reason === 'futureDay' || v.reason === 'futureCoreDay');

function faultOf(at: OfferedValue, v: ClassifiedValue, typed: TypedText | null, candidate: number | null): RowFault | null {
  if (typed) return { kind: 'typed', text: typed.text };
  if (candidate === null) return null;
  const metric = at.kind === 'core' ? at.value.metric as MetricType : null;
  const range = metric && rangeFault(cellRange(metric, 'si'), candidate);
  if (metric && range) return { kind: 'range', metric, fault: range };
  // A sent value the write refuses for a reason its own number in the units table does not show: a blood pressure half
  // of a pair the wrong way up (US-02 AC8), or a lab the write files as a core value, out of that value's range.
  if (v.sent && !v.writes && v.group === 'unsure' && v.reasons.includes('outOfRange')) {
    return { kind: 'refused', message: v.refusal && 'measurement' in v.refusal ? v.refusal.measurement.message : PRESSURE_ORDER };
  }
  return null;
}

/** Every offered value of every read lab report, in picked order and then extraction order. */
export function candidates(review: UploadReview, s: UploadState): Candidate[] {
  const reads = new Map(readFiles(s).map((f) => [f.id, f.status]));
  const classified = new Map(review.classification.values.map((v) => [`${v.file}:${v.ref}`, v]));
  return review.labFiles.flatMap((lab, file) => {
    const st = reads.get(lab.fileId);
    if (!st) return [];
    return offeredValues(st.extraction).flatMap((at): Candidate[] => {
      const v = classified.get(`${file}:${at.ref}`);
      if (!v) return [];
      const typed = st.choices.typed?.[at.ref] ?? null;
      const edit = st.choices.edits[at.ref];
      const candidate = typed ? null : edit ?? (at.kind === 'core' ? at.value.valueSI : at.value.value);
      const ticked = lab.ticked.includes(at.ref);
      const fault = faultOf(at, v, typed, candidate);
      const selected = ticked && !keptConflict(review, v) && !undatable(v);
      // A lab's refusal never blocks Save (main's rule, US-13 AC5: a selected core value): it says why it is not saved.
      const blocks = !!typed || (selected && fault !== null && isCoreRef(at.ref));
      return [{ file, fileId: lab.fileId, ref: at.ref, at, v, ticked, typed, edit, candidate, fault, selected, blocks }];
    });
  });
}
