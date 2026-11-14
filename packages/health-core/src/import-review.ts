/**
 * The import review's one rule (US-13 AC13), shared by the website and the
 * iPhone: which extracted values the person must look at, which save with no
 * row, which are not saved and why, and the words both screens show.
 * Pure: it reads only the extraction and the record's held slots, so no new
 * server or AI call. The assistant's refusal text (`labUnitRefusal`,
 * `RefusedLabValue.reason`) is never read or changed here: every reason comes
 * from structure (unit, fault, code). Design: docs/drafts/import-review-redesign.md.
 */
import { UNDATED_PREVIOUS, isUrineOrRatioUnit, type UnifiedExtractionResult } from './lab-extraction';
import { labTestLabel, resolveLabCatalogEntry } from './lab-catalog';
import { bloodTestKeyOf, coreStored, isCoreRow } from './blood-tests';
import { measurementValueFault, sameLabQuantity, slotIndex, slotKey, toStoredLab, type LabQuantity } from './record-edits';
import { METRIC_LABELS } from './mappings';
import { DOCUMENT_TYPES, type DocumentType } from './validation';
import type { RoadmapFile } from './roadmap-file';

/** One file as the review holds it: its extraction, and the day its values
 *  without a day of their own are filed on (the report's, or the one picked);
 *  null while none is set, which leaves those values unslotted. */
export interface ImportFile {
  result: Pick<UnifiedExtractionResult, 'classification'> & Partial<Pick<UnifiedExtractionResult, 'values' | 'additionalValues' | 'refusedValues' | 'unreadValues' | 'droppedValueCount' | 'document'>>;
  day: string | null;
}

/** What the record holds in a slot: a core or vital value in its stored (SI)
 *  number, or a lab row as stored. */
export type HeldValue = { valueSI: number } | { lab: LabQuantity };

/** Why a value gets a row (D1). */
export type UnsureReason = 'confidence' | 'question' | 'unitGuessed' | 'outOfRange' | 'conflict';
/** Why a value is not saved (D5). */
export type NotSavedReason = 'unit' | 'noUnit' | 'misread' | 'scale' | 'unreadable' | 'urine' | 'sameDay';

/**
 * One value's place in the review. `ref` is the value's place in its file:
 * `v<i>` a core value, `a<i>` an additional one (as the iPhone's save names
 * them), `r<i>` a refused row, `u<i>` an unread one. `label` is the test's
 * label, never a key; "" for an unread row that names no test.
 * - sure: saves on Save with no row.
 * - saved: the record already holds this value for that test and day.
 * - unsure: shown as a row, with every reason.
 * - notSaved: Save will not write it, with one reason.
 */
export type ClassifiedValue =
  | { file: number; ref: string; label: string; group: 'sure' | 'saved' }
  | { file: number; ref: string; label: string; group: 'unsure'; reasons: UnsureReason[] }
  | { file: number; ref: string; label: string; group: 'notSaved'; reason: NotSavedReason };

/** Two stored numbers are the same value (float noise from a conversion is not a conflict). */
const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));

/** The record's active rows by slot (`slotKey`), as a review compares against them. */
export function heldSlotsFromFile(file: RoadmapFile): ReadonlyMap<string, HeldValue> {
  const held = new Map<string, HeldValue>();
  for (const [slot, row] of slotIndex(file)) {
    held.set(slot, 'metricType' in row || isCoreRow(row) ? { valueSI: row.value }
      : { lab: { name: row.metricName, value: row.value, unit: row.unit, ...(row.comparator ? { comparator: row.comparator } : null) } });
  }
  return held;
}

/** The website's history (active rows) by slot: vitals and core values by
 *  metric, labs by name, as `heldSlotsFromFile`. */
export function heldSlots(
  measurements: ReadonlyArray<{ metricType: string; value: number; recordedAt: string }>,
  labValues: ReadonlyArray<{ metricName: string; value: number; unit: string; recordedAt: string }>,
): ReadonlyMap<string, HeldValue> {
  const held = new Map<string, HeldValue>();
  for (const m of measurements) held.set(slotKey('measurement', m.metricType, m.recordedAt), { valueSI: m.value });
  for (const l of labValues) held.set(slotKey('lab', l.metricName, l.recordedAt), { lab: { name: l.metricName, value: l.value, unit: l.unit } });
  return held;
}

/** A refused unit, by what was printed. */
const unitReason = (unit: string): NotSavedReason => (unit.trim() ? 'unit' : 'noUnit');

/**
 * Every value of every file, in file order, each in one group (D1). A value
 * is not saved first (a refused unit or number, or a second reading of a test
 * on a day this upload already filled: the first one wins, as the save's own
 * slot rule does), then saved (the record holds the same value), then unsure
 * (any reason), else sure. A value with no known day is never slotted.
 */
export function classifyImportValues(files: readonly ImportFile[], held: ReadonlyMap<string, HeldValue>): ClassifiedValue[] {
  const out: ClassifiedValue[] = [];
  const filled = new Set<string>();
  /** The slot's verdict, once the value is otherwise saveable. */
  const placed = (slot: string | null, same: (h: HeldValue) => boolean): 'sameDay' | 'saved' | 'conflict' | null => {
    if (!slot) return null;
    if (filled.has(slot)) return 'sameDay';
    filled.add(slot);
    const h = held.get(slot);
    return !h ? null : same(h) ? 'saved' : 'conflict';
  };
  const dayOf = (own: string | undefined, fileDay: string | null) => (own === undefined ? fileDay : own === UNDATED_PREVIOUS ? null : own);
  const finish = (file: number, ref: string, label: string, reasons: UnsureReason[], slot: ReturnType<typeof placed>): ClassifiedValue => {
    if (slot === 'sameDay') return { file, ref, label, group: 'notSaved', reason: 'sameDay' };
    if (slot === 'saved') return { file, ref, label, group: 'saved' };
    const all = slot === 'conflict' ? [...reasons, 'conflict' as const] : reasons;
    return all.length ? { file, ref, label, group: 'unsure', reasons: all } : { file, ref, label, group: 'sure' };
  };

  files.forEach(({ result, day }, file) => {
    if (result.classification !== 'lab_report') return;
    (result.values ?? []).forEach((v, i) => {
      const ref = `v${i}`;
      const label = METRIC_LABELS[v.metric] ?? labTestLabel(v.metric);
      const reasons: UnsureReason[] = [];
      if (v.confidence !== 'high') reasons.push('confidence');
      if (v.question) reasons.push('question');
      if (v.unitGuessed) reasons.push('unitGuessed');
      // A hidden value outside the input range would block Save unseen (US-13 AC5).
      if (measurementValueFault(v.metric, v.valueSI)) reasons.push('outOfRange');
      const d = dayOf(v.recordedAt, day);
      const slot = placed(d ? slotKey('measurement', v.metric, d) : null, (h) => 'valueSI' in h && sameNumber(h.valueSI, v.valueSI));
      out.push(finish(file, ref, label, reasons, slot));
    });
    (result.additionalValues ?? []).forEach((v, i) => {
      const ref = `a${i}`;
      const label = labTestLabel(v.name);
      // The save's own split (bulkAppendValues): a core name is that core value, an imported creatinine never.
      const named = bloodTestKeyOf(v.name);
      const asLab = !named || named === 'creatinine';
      let slotKeyed: string | null = null;
      let same: (h: HeldValue) => boolean;
      const d = dayOf(v.recordedAt, day);
      if (asLab) {
        const stored = toStoredLab(resolveLabCatalogEntry(v.name), v.value, v.unit, v.referenceLow, v.referenceHigh);
        if ('ok' in stored) {
          const fault = stored.fault;
          const reason: NotSavedReason = fault === 'implausible' || fault === 'ceiling' ? 'misread'
            : fault === 'scale' || fault === 'decimal' ? 'scale' : unitReason(v.unit);
          out.push({ file, ref, label, group: 'notSaved', reason });
          return;
        }
        const offered: LabQuantity = { name: v.name, value: v.value, unit: v.unit };
        same = (h) => 'lab' in h && sameLabQuantity(h.lab, offered);
        if (d) slotKeyed = slotKey('lab', v.name, d);
      } else {
        const core = coreStored(named, v.value, v.unit, v.referenceLow, v.referenceHigh);
        if (!core) { out.push({ file, ref, label, group: 'notSaved', reason: unitReason(v.unit) }); return; }
        // Not a review cell's input, so a value out of range is refused at the save, not blocking it.
        if (measurementValueFault(named, core.value)) { out.push({ file, ref, label, group: 'notSaved', reason: 'misread' }); return; }
        same = (h) => 'valueSI' in h && sameNumber(h.valueSI, core.value);
        if (d) slotKeyed = slotKey('measurement', named, d);
      }
      const reasons: UnsureReason[] = [];
      if (v.confidence && v.confidence !== 'high') reasons.push('confidence');
      if (v.question) reasons.push('question');
      out.push(finish(file, ref, label, reasons, placed(slotKeyed, same)));
    });
    (result.refusedValues ?? []).forEach((v, i) => {
      const reason: NotSavedReason = !v.unit.trim() ? 'noUnit' : v.metric === 'creatinine' && isUrineOrRatioUnit(v.unit) ? 'urine' : 'unit';
      out.push({ file, ref: `r${i}`, label: METRIC_LABELS[v.metric] ?? labTestLabel(v.metric), group: 'notSaved', reason });
    });
    const unread = result.unreadValues ?? [];
    unread.forEach((v, i) => out.push({ file, ref: `u${i}`, label: v.name ? labTestLabel(v.name) : '', group: 'notSaved', reason: 'unreadable' }));
    // Dropped rows the server named no test for (US-12 AC19), counted after the named ones.
    const unnamed = Math.max(0, (result.droppedValueCount ?? 0) - unread.length);
    for (let i = 0; i < unnamed; i++) out.push({ file, ref: `u${unread.length + i}`, label: '', group: 'notSaved', reason: 'unreadable' });
  });
  return out;
}

/** What the review found, for its first line (D4, D7). `documents` by kind, in `DOCUMENT_TYPES` order. */
export interface ImportSummary {
  values: number;
  documents: Array<{ kind: DocumentType; count: number }>;
  files: number;
}

/** The values read as numbers from lab reports, and the documents by kind. A
 *  refused or unread row is not "found": it is counted under "Not saved". */
export function importSummary(files: readonly ImportFile[]): ImportSummary {
  let values = 0;
  const kinds = new Map<DocumentType, number>();
  for (const { result } of files) {
    if (result.classification === 'lab_report') {
      values += (result.values?.length ?? 0) + (result.additionalValues?.length ?? 0);
    } else if (result.document) {
      const kind = (DOCUMENT_TYPES as readonly string[]).includes(result.document.classification) ? result.document.classification as DocumentType : 'other';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }
  return { values, documents: DOCUMENT_TYPES.filter((k) => kinds.has(k)).map((kind) => ({ kind, count: kinds.get(kind)! })), files: files.length };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Each kind's words, one and many (string 2). */
const KIND_WORDS: Record<DocumentType, [string, string]> = {
  scan_result: ['scan result', 'scan results'],
  clinic_letter: ['clinic letter', 'clinic letters'],
  discharge_summary: ['discharge summary', 'discharge summaries'],
  pathology_report: ['pathology report', 'pathology reports'],
  vaccination_record: ['vaccination record', 'vaccination records'],
  other: ['other document', 'other documents'],
};

/** The summary line (strings 1 to 3): "Found 12 blood test values and 1 clinic letter in 3 files". */
export function importSummaryText({ values, documents, files }: ImportSummary): string {
  const parts = [
    ...(values > 0 ? [plural(values, 'blood test value')] : []),
    ...documents.map(({ kind, count }) => plural(count, ...KIND_WORDS[kind])),
  ];
  if (parts.length === 0) return 'No blood test values or documents found.';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Found ${list}${files > 1 ? ` in ${files} files` : ''}`;
}

/** Each not-saved reason in the person's words (strings 17 to 23), after the tests' labels and a colon. */
export const NOT_SAVED_TEXT: Record<NotSavedReason, string> = {
  unit: 'this unit is not one we know for this test',
  noUnit: 'no unit was printed',
  misread: 'the number looks misread. Check the report',
  scale: 'the number and its range are on different scales',
  unreadable: 'could not be read',
  urine: 'this unit is usually a urine result',
  sameDay: 'another reading of this test is on the same day',
};

/** "Not saved" as the review shows it (D5): the count for its line, one line
 *  per reason naming each test once, and the unread rows that name no test. */
export function notSavedGroups(values: readonly ClassifiedValue[]): { total: number; lines: Array<{ reason: NotSavedReason; labels: string[]; text: string }>; other: string | null } {
  const notSaved = values.filter((v): v is Extract<ClassifiedValue, { group: 'notSaved' }> => v.group === 'notSaved');
  const byReason = new Map<NotSavedReason, string[]>();
  for (const v of notSaved) {
    if (!v.label) continue;
    const labels = byReason.get(v.reason) ?? [];
    if (!labels.includes(v.label)) byReason.set(v.reason, [...labels, v.label]);
  }
  const lines = [...byReason].map(([reason, labels]) => ({ reason, labels, text: `${labels.join(', ')}: ${NOT_SAVED_TEXT[reason]}` }));
  const unnamed = notSaved.filter((v) => !v.label).length;
  const other = unnamed > 0 ? `${unnamed} ${lines.length ? 'other ' : ''}${unnamed === 1 ? 'value' : 'values'} could not be read` : null;
  return { total: notSaved.length, lines, other };
}

/** The review's other words (strings 4 to 14), one copy for both screens. */
export const IMPORT_REVIEW_TEXT = {
  checkTitle: (k: number) => `Check these ${plural(k, 'value')}`,
  checkFooter: 'We were not sure about these. Check each against the report.',
  conflictKept: 'Your record already has a different value for this day. It stays as it is.',
  willSave: (n: number) => `${plural(n, 'value')} will be saved`,
  showAll: (n: number) => `Show all ${n}`,
  hide: 'Hide',
  alreadySaved: (n: number) => `${n} already in your record`,
  save: (n: number) => `Save ${plural(n, 'value')}`,
  notSavedTitle: (n: number) => `${plural(n, 'value')} not saved`,
  notSavedFooter: 'To add one, use + Add a blood test after saving.',
} as const;
