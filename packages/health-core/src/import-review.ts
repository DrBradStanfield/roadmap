/**
 * The import review's one rule (US-13 AC13), shared by the website and the
 * iPhone: which extracted values the person must look at, which save with no
 * row, which are not saved and why, and the words both screens show.
 * Pure, and in agreement with Save by construction: every refusal and every
 * slot is the write path's own (`bulkAppendValues`, run dry), and slot
 * precedence and sameness are `review-slots.ts`, which the website's matrix
 * shares. The assistant's refusal text is never read or changed here. No new
 * server or AI call. Design: docs/drafts/import-review-redesign.md.
 */
import { UNDATED_PREVIOUS, isUrineOrRatioUnit, type UnifiedExtractionResult } from './lab-extraction';
import { labTestLabel } from './lab-catalog';
import { bulkAppendValues, slotIndex, slotOfRow, type BulkAppendResult, type BulkRow } from './record-edits';
import { createCoreRow, isBloodTestKey } from './blood-tests';
import { isClinicalDay } from './measurement-history';
import { placeReadings, readingRank, type Quantity, type SlotPlace } from './review-slots';
import { METRIC_LABELS } from './mappings';
import { DOCUMENT_TYPES, type DocumentType } from './validation';
import { createEmptyFile, createLabValue, createMeasurement, type RoadmapFile } from './roadmap-file';
import type { Comparator } from './lab-limits';

/** One file as the review holds it, as Save would send it. */
export interface ImportFile {
  /** The extraction, with any number the person edited put in place. */
  result: Pick<UnifiedExtractionResult, 'classification'> & Partial<Pick<UnifiedExtractionResult, 'values' | 'additionalValues' | 'refusedValues' | 'unreadValues' | 'droppedValueCount' | 'document'>>;
  /** Each value's effective day by ref (`v<i>`, `a<i>`): after the person's
   *  choice for an undated column and any edited report date; null, or a day
   *  that is not a real calendar day, while it has none (`valueDays`). */
  days: Readonly<Record<string, string | null>>;
  /** The refs Save sends: ticked, not cleared. Each client keeps its own defaults. */
  sent: ReadonlySet<string>;
  /** Refs the person edited: never "already saved". */
  edited?: ReadonlySet<string>;
}

/** Each value's day: its own printed day, else `fileDay` (the report's, or
 *  the one picked); an undated previous column's is `undatedDay` (null until picked). */
export function valueDays(result: ImportFile['result'], fileDay: string | null, undatedDay: string | null = null): Record<string, string | null> {
  const day = (own?: string) => (own === undefined ? fileDay : own === UNDATED_PREVIOUS ? undatedDay : own);
  return Object.fromEntries([
    ...(result.values ?? []).map((v, i) => [`v${i}`, day(v.recordedAt)]),
    ...(result.additionalValues ?? []).map((v, i) => [`a${i}`, day(v.recordedAt)]),
  ]);
}

/** Why a value gets a row (D1). `outOfRange`: the write refuses its number
 *  (outside its input range, or half of an inverted blood pressure). */
export type UnsureReason = 'confidence' | 'question' | 'unitGuessed' | 'outOfRange' | 'conflict';
/** Why a value is not saved (D5). */
export type NotSavedReason = 'unit' | 'noUnit' | 'misread' | 'scale' | 'unreadable' | 'urine' | 'sameDay';

/**
 * One value's place in the review. `ref`: `v<i>` a core value, `a<i>` an
 * additional one, `r<i>` a refused row, `u<i>` an unread one. `label` is the
 * test's label, never a key; "" for an unread row that names no test. `sent`:
 * Save sends it.
 * - sure: Save writes it, no row needed.
 * - saved: the record already holds it, or an equal reading of this upload does.
 * - unsure: shown as a row, with every reason.
 * - notSaved: Save would not write it, with one reason.
 * - waiting: no day yet; it stays behind the file's date question.
 */
export type ClassifiedValue =
  | { file: number; ref: string; label: string; sent: boolean; group: 'sure' | 'saved' | 'waiting' }
  | { file: number; ref: string; label: string; sent: boolean; group: 'unsure'; reasons: UnsureReason[] }
  | { file: number; ref: string; label: string; sent: boolean; group: 'notSaved'; reason: NotSavedReason };

/** The website's history (active rows) as a record, for `classifyImportValues`:
 *  a blood test as a core row, a vital as a measurement, a lab as a lab row,
 *  comparators kept, as the store holds them. */
export function recordFromHistory(
  measurements: ReadonlyArray<{ id: string; metricType: string; value: number; recordedAt: string; createdAt?: string; comparator?: Comparator }>,
  labValues: ReadonlyArray<{ id: string; metricName: string; value: number; unit: string; recordedAt: string; createdAt?: string; referenceLow?: number | null; referenceHigh?: number | null; comparator?: Comparator }>,
): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'review', now: '1970-01-01T00:00:00.000Z' });
  const createdAt = (r: { createdAt?: string; recordedAt: string }) => r.createdAt ?? r.recordedAt;
  const limit = (c?: Comparator) => (c ? { comparator: c } : null);
  return {
    ...file,
    measurements: measurements.filter((m) => !isBloodTestKey(m.metricType)).map((m) => createMeasurement({ id: m.id, metricType: m.metricType, value: m.value, recordedAt: m.recordedAt, createdAt: createdAt(m), ...limit(m.comparator) })),
    labValues: [
      ...measurements.filter((m) => isBloodTestKey(m.metricType)).map((m) => createCoreRow({ id: m.id, metric: m.metricType, value: m.value, recordedAt: m.recordedAt, createdAt: createdAt(m), ...limit(m.comparator) })),
      ...labValues.map((l) => createLabValue({ id: l.id, metricName: l.metricName, value: l.value, unit: l.unit, referenceLow: l.referenceLow ?? null, referenceHigh: l.referenceHigh ?? null, recordedAt: l.recordedAt, createdAt: createdAt(l), ...limit(l.comparator) })),
    ],
  };
}

/** The record's reading in each slot, as `placeReadings` compares it. */
function heldReadings(record: RoadmapFile): (slot: string) => Quantity | undefined {
  const index = slotIndex(record);
  return (slot) => {
    const row = index.get(slot);
    if (!row) return undefined;
    const limit = row.comparator ? { comparator: row.comparator } : null;
    return 'metricType' in row || row.core ? { valueSI: row.value, ...limit } : { lab: { name: row.metricName, value: row.value, unit: row.unit, ...limit } };
  };
}

/** A lab refusal in the person's words, from the write's own fault (never its text). */
const labReason = (r: BulkAppendResult['refused'][number]): NotSavedReason =>
  r.fault === 'implausible' || r.fault === 'ceiling' ? 'misread' : r.fault === 'scale' || r.fault === 'decimal' ? 'scale' : r.unit.trim() ? 'unit' : 'noUnit';

/** A day no value lands on: a probe for a value with no day reads only its refusals. */
const PROBE_DAY = '2000-01-01';

/**
 * Every value in each group (D1), in the order Save must send them (sent
 * values by rank, then file and value order; then the unsent; then refused
 * and unread rows). Each value is first written alone to an empty record,
 * dry, so its refusal and its slot are the write's own; then slots are placed
 * (`placeReadings`); then the sent values are written together to `record`,
 * dry, so a blood pressure the pair refuses is caught. Recompute it whenever
 * a day, a tick or an edit changes.
 */
export function classifyImportValues(files: readonly ImportFile[], record: RoadmapFile, now: string): ClassifiedValue[] {
  const empty = createEmptyFile({ deviceId: 'review', now });
  type Candidate = { file: number; ref: string; label: string; sent: boolean; edited: boolean; rank: 0 | 1 | 2; day: string | null; row: BulkRow; quantity: Quantity; reasons: UnsureReason[]; core: boolean };
  const candidates: Candidate[] = [];
  const limit = (c?: Comparator) => (c ? { comparator: c } : null);
  files.forEach(({ result, days, sent, edited }, file) => {
    if (result.classification !== 'lab_report') return;
    const at = (ref: string) => (isClinicalDay(days[ref]) ? days[ref]!.slice(0, 10) : null);
    (result.values ?? []).forEach((v, i) => {
      const ref = `v${i}`;
      const reasons: UnsureReason[] = [];
      if (v.confidence !== 'high') reasons.push('confidence');
      if (v.question) reasons.push('question');
      if (v.unitGuessed) reasons.push('unitGuessed');
      const day = at(ref);
      candidates.push({
        file, ref, label: METRIC_LABELS[v.metric] ?? labTestLabel(v.metric), sent: sent.has(ref), edited: !!edited?.has(ref),
        rank: readingRank(v.recordedAt, UNDATED_PREVIOUS), day, reasons, core: true,
        row: { kind: 'measurement', metricType: v.metric, value: v.valueSI, recordedAt: day ?? PROBE_DAY, source: 'lab_import', ...limit(v.comparator) },
        quantity: { valueSI: v.valueSI, ...limit(v.comparator) },
      });
    });
    (result.additionalValues ?? []).forEach((v, i) => {
      const ref = `a${i}`;
      const reasons: UnsureReason[] = [];
      if (v.confidence && v.confidence !== 'high') reasons.push('confidence');
      if (v.question) reasons.push('question');
      const day = at(ref);
      candidates.push({
        file, ref, label: labTestLabel(v.name), sent: sent.has(ref), edited: !!edited?.has(ref),
        rank: readingRank(v.recordedAt, UNDATED_PREVIOUS), day, reasons, core: false,
        row: { kind: 'lab', metricName: v.name, value: v.value, unit: v.unit, referenceLow: v.referenceLow ?? null, referenceHigh: v.referenceHigh ?? null, recordedAt: day ?? PROBE_DAY, source: 'lab_import', ...limit(v.comparator) },
        quantity: { lab: { name: v.name, value: v.value, unit: v.unit, ...limit(v.comparator) } },
      });
    });
  });

  // 1) Each value alone, dry, on an empty record: the write's own refusal and slot.
  //    A lab the write files as a core value (an HbA1c printed as a lab row) compares as one.
  const probes = candidates.map((c) => {
    const probe = bulkAppendValues(empty, [c.row], now);
    const written = probe.saved[0];
    const asCore = written && !('metricType' in written) && written.core;
    const quantity: Quantity = asCore ? { valueSI: written.value, ...limit(written.comparator) } : c.quantity;
    return { refused: probe.refused[0], rangeRefused: probe.measurementRefusals.length > 0, slot: written ? slotOfRow(written) : null, quantity };
  });
  const outcome = new Map<Candidate, ClassifiedValue>();
  const base = (c: Candidate) => ({ file: c.file, ref: c.ref, label: c.label, sent: c.sent });
  const placeable: number[] = [];
  candidates.forEach((c, i) => {
    const p = probes[i];
    if (p.refused) outcome.set(c, { ...base(c), group: 'notSaved', reason: labReason(p.refused) });
    else if (p.rangeRefused && !c.core) outcome.set(c, { ...base(c), group: 'notSaved', reason: 'misread' });
    else if (!c.day) outcome.set(c, { ...base(c), group: 'waiting' });
    else placeable.push(i);
  });

  // 2) Slots, by the review's precedence (US-12 AC12, AC14; US-13 AC3).
  const places = placeReadings(placeable.map((i) => ({
    slot: probes[i].slot!, rank: candidates[i].rank, quantity: probes[i].quantity, edited: candidates[i].edited, sent: candidates[i].sent,
  })), heldReadings(record));
  const placeOf = new Map<Candidate, SlotPlace>(placeable.map((i, k) => [candidates[i], places[k]]));

  // 3) What Save writes, together and dry, on the record: a range or pair refusal.
  const writes = placeable.map((i) => candidates[i]).filter((c) => c.sent && (placeOf.get(c) === 'free' || placeOf.get(c) === 'conflict'))
    .sort((a, b) => a.rank - b.rank);
  const batch = bulkAppendValues(record, writes.map((c) => c.row), now);
  const refusedInBatch = new Set(batch.measurementRefusals.map((r) => writes[r.index]));

  for (const i of placeable) {
    const c = candidates[i];
    const place = placeOf.get(c)!;
    const reasons: UnsureReason[] = [...c.reasons];
    if (probes[i].rangeRefused || refusedInBatch.has(c)) reasons.push('outOfRange');
    if (place === 'conflict') reasons.push('conflict');
    outcome.set(c, place === 'saved' || place === 'duplicate' ? { ...base(c), group: 'saved' }
      : place === 'hidden' ? { ...base(c), group: 'notSaved', reason: 'sameDay' }
        : reasons.length ? { ...base(c), group: 'unsure', reasons } : { ...base(c), group: 'sure' });
  }

  const sendOrder = candidates.map((c, i) => i).sort((i, j) =>
    Number(!candidates[i].sent) - Number(!candidates[j].sent) || (candidates[i].sent ? candidates[i].rank - candidates[j].rank : 0) || i - j);
  const out: ClassifiedValue[] = sendOrder.map((i) => outcome.get(candidates[i])!);
  files.forEach(({ result }, file) => {
    if (result.classification !== 'lab_report') return;
    (result.refusedValues ?? []).forEach((v, i) => {
      const reason: NotSavedReason = !v.unit.trim() ? 'noUnit' : v.metric === 'creatinine' && isUrineOrRatioUnit(v.unit) ? 'urine' : 'unit';
      out.push({ file, ref: `r${i}`, label: METRIC_LABELS[v.metric] ?? labTestLabel(v.metric), sent: false, group: 'notSaved', reason });
    });
    const unread = result.unreadValues ?? [];
    unread.forEach((v, i) => out.push({ file, ref: `u${i}`, label: v.name ? labTestLabel(v.name) : '', sent: false, group: 'notSaved', reason: 'unreadable' }));
    // Dropped rows the server named no test for (US-12 AC19), counted after the named ones.
    const unnamed = Math.max(0, (result.droppedValueCount ?? 0) - unread.length);
    for (let i = 0; i < unnamed; i++) out.push({ file, ref: `u${unread.length + i}`, label: '', sent: false, group: 'notSaved', reason: 'unreadable' });
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
export function importSummary(files: ReadonlyArray<Pick<ImportFile, 'result'>>): ImportSummary {
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
  // One value is "Check this value" (owner's ruling, 2026-11-15).
  checkTitle: (k: number) => (k === 1 ? 'Check this value' : `Check these ${plural(k, 'value')}`),
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
