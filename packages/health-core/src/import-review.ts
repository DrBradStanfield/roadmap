/**
 * The import review's one rule (US-13 AC13), shared by the website and the
 * iPhone: which extracted values the person must look at, which save with no
 * row, which are not saved and why, and the words both screens show.
 * In agreement with Save by construction: the review classifies the very rows
 * Save would submit (`importRow`, the one builder both clients save with),
 * by each row's own outcome in one dry run of `bulkAppendValues`; slot
 * precedence is `review-slots.ts`, which the website's matrix shares. Pure.
 * The assistant's refusal text is never read or changed here. No new server
 * or AI call. Design: docs/drafts/import-review-redesign.md.
 */
import { UNDATED_PREVIOUS, isUrineOrRatioUnit, type UnifiedExtractionResult } from './lab-extraction';
import { labTestLabel } from './lab-catalog';
import { bulkAppendValues, slotIndex, slotKey, type BulkAppendResult, type BulkRow, type LabUnitRefusal, type MeasurementRefusal } from './record-edits';
import { bulkRowTarget } from './bulk-row-target';
import { coreStored, createCoreRow, isBloodTestKey } from './blood-tests';
import { isClinicalDay } from './measurement-history';
import { placeReadings, readingRank, sameReading, type Quantity } from './review-slots';
import { METRIC_LABELS } from './mappings';
import { DOCUMENT_TYPES, type DocumentType } from './validation';
import { createEmptyFile, createLabValue, createMeasurement, type RoadmapFile } from './roadmap-file';
import type { Comparator } from './lab-limits';
import type { MetricType } from './units';

/** One file as the review holds it. */
export interface ImportFile {
  result: Pick<UnifiedExtractionResult, 'classification'> & Partial<Pick<UnifiedExtractionResult, 'values' | 'additionalValues' | 'refusedValues' | 'unreadValues' | 'droppedValueCount' | 'document'>>;
  /** The rows Save would submit now, by ref (`v<i>`, `a<i>`), each built by
   *  `importRow`: a selected Replace carries `correctsId`, an edit its number.
   *  A ref with no row is not sent (unticked or cleared). */
  rows: Readonly<Record<string, BulkRow>>;
  /** Each value's effective day by ref, for the values not sent: after the
   *  person's choice for an undated column and any edited report date; null
   *  while it has none (`valueDays`). */
  days: Readonly<Record<string, string | null>>;
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

/**
 * The row Save submits for one extracted value: the one builder the iPhone's
 * save, the website's save and this review all use. `day` is the value's
 * effective day; `correctsId` a selected Replace of that row; `edited` the
 * number the person typed (a core value in SI, a lab in `unit`, or its own),
 * saved as `lab_import_edited` and exact (an edited limit is a number,
 * US-12 AC20). Null for a ref the extraction does not hold.
 */
export function importRow(result: ImportFile['result'], ref: string, day: string, opts: { correctsId?: string; edited?: { value: number; unit?: string } } = {}): BulkRow | null {
  const i = Number(ref.slice(1));
  const { correctsId, edited } = opts;
  const common = { recordedAt: day, source: edited ? 'lab_import_edited' as const : 'lab_import' as const, ...(correctsId ? { correctsId } : null) };
  if (ref[0] === 'v') {
    const v = result.values?.[i];
    if (!v || !Number.isInteger(i)) return null;
    return { kind: 'measurement', metricType: v.metric, value: edited ? edited.value : v.valueSI, ...common, ...(!edited && v.comparator ? { comparator: v.comparator } : null) };
  }
  const a = ref[0] === 'a' ? result.additionalValues?.[i] : undefined;
  if (!a || !Number.isInteger(i)) return null;
  return {
    kind: 'lab', metricName: a.name, value: edited ? edited.value : a.value, unit: edited?.unit ?? a.unit,
    referenceLow: a.referenceLow ?? null, referenceHigh: a.referenceHigh ?? null, ...common, ...(!edited && a.comparator ? { comparator: a.comparator } : null),
  };
}

/** Why a value gets a row (D1). `outOfRange`: the write refuses its number
 *  (outside its input range, or half of a blood pressure the wrong way up). */
export type UnsureReason = 'confidence' | 'question' | 'unitGuessed' | 'outOfRange' | 'conflict';
/** Why a value is not saved (D5). */
export type NotSavedReason = 'unit' | 'noUnit' | 'misread' | 'scale' | 'unreadable' | 'urine' | 'sameDay';

/**
 * One value's place in the review. `ref`: `v<i>` a core value, `a<i>` an
 * additional one, `r<i>` a refused row, `u<i>` an unread one. `label` is the
 * test's label, never a key; "" for an unread row that names no test.
 * `sent`: the client gave a row for it. `writes`: Save writes it.
 * - sure: Save writes it, no row needed.
 * - saved: the record already holds it, or (`duplicate`) an equal reading of
 *   this upload holds its slot: one copy saves, so the client counts it nowhere.
 * - unsure: shown as a row, with every reason; `refusal` the write's own when
 *   it refuses the number (out of range, or a blood pressure the wrong way up).
 * - notSaved: Save would not write it, with one reason; `refusal` the write's
 *   own for a lab it refuses (its key and unit, for the refused-spelling count).
 * - waiting: no day yet; it stays behind the file's date question.
 */
export type ClassifiedValue =
  | { file: number; ref: string; label: string; sent: boolean; writes: boolean; group: 'sure' | 'saved' | 'waiting'; duplicate?: true }
  | { file: number; ref: string; label: string; sent: boolean; writes: boolean; group: 'unsure'; reasons: UnsureReason[]; refusal?: MeasurementRefusal }
  | { file: number; ref: string; label: string; sent: boolean; writes: boolean; group: 'notSaved'; reason: NotSavedReason; refusal?: LabUnitRefusal };

/** The review: every value's group, and the rows Save submits (the ones it
 *  writes, in order). Submitting `rows` writes each one and refuses none. */
export interface ImportClassification { values: ClassifiedValue[]; rows: BulkRow[] }

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

/** A row's slot, from its metric and day as the write keys it, and what it
 *  compares as: a lab the write files as a core value compares as one. */
function slotOf(row: BulkRow): { slot: string; quantity: Quantity } {
  const target = bulkRowTarget(row);
  const limit = row.comparator ? { comparator: row.comparator } : null;
  const slot = slotKey(target.slot, target.metric, row.recordedAt);
  if (row.kind === 'measurement') return { slot, quantity: { valueSI: row.value, ...limit } };
  const asCore = !target.asLab ? coreStored(target.named as MetricType, row.value, row.unit)?.value : undefined;
  return { slot, quantity: asCore !== undefined ? { valueSI: asCore, ...limit } : { lab: { name: row.metricName, value: row.value, unit: row.unit, ...limit } } };
}

/** A lab refusal in the person's words, from the write's own fault (never its text). */
const labReason = (r: BulkAppendResult['refused'][number]): NotSavedReason =>
  r.fault === 'implausible' || r.fault === 'ceiling' ? 'misread' : r.fault === 'scale' || r.fault === 'decimal' ? 'scale' : r.unit.trim() ? 'unit' : 'noUnit';

/** The write refuses this row even on an empty record (its unit, its count,
 *  its range): it takes no (test, day) slot. The review's groups and the
 *  website's matrix place readings by this one rule. */
export function refusedAlone(row: BulkRow, now: string): boolean {
  return bulkAppendValues(createEmptyFile({ deviceId: 'review', now }), [row], now).outcomes[0] === 'refused';
}

/** A day no value lands on: a value with no day is written there alone, on an
 *  empty record, only to read its refusal. */
const PROBE_DAY = '2000-01-01';

type Info = { file: number; ref: string; label: string; reasons: UnsureReason[]; rank: 0 | 1 | 2 };
type Group = ClassifiedValue extends infer V ? V extends ClassifiedValue ? Omit<V, 'file' | 'ref' | 'label' | 'sent'> : never : never;

/**
 * Each row's group from its own outcome in one dry run (D1): written is sure,
 * or unsure with its signals; skipped is saved when the record holds an equal
 * value, else a conflict; refused is a core range or pair refusal (unsure,
 * shown) or a lab refusal (not saved, with its reason).
 */
function groupsOf(rows: Array<{ row: BulkRow; reasons: UnsureReason[] }>, record: RoadmapFile, now: string): Group[] {
  const run = bulkAppendValues(record, rows.map((r) => r.row), now);
  const held = heldReadings(record);
  const rangeRefused = new Map(run.measurementRefusals.map((r) => [r.index, r]));
  let lab = 0;
  return rows.map(({ row, reasons }, k): Group => {
    const { slot, quantity } = slotOf(row);
    const holder = held(slot);
    const differs = !!holder && (row.source === 'lab_import_edited' || !sameReading(quantity, holder));
    const all = (more: UnsureReason[]): Group => {
      const list = [...reasons, ...more, ...(differs || row.correctsId ? ['conflict' as const] : [])];
      return list.length ? { group: 'unsure', reasons: [...new Set(list)], writes: false } : { group: 'sure', writes: false };
    };
    const outcome = run.outcomes[k];
    if (outcome === 'written') return { ...all([]), writes: true };
    if (outcome === 'skipped') return holder && !differs && !row.correctsId ? { group: 'saved', writes: false } : all(['conflict']);
    const refusal = rangeRefused.get(k);
    if (refusal) { const g = all(['outOfRange']); return g.group === 'unsure' ? { ...g, refusal } : g; }
    const refused = run.refused[lab++];
    return { group: 'notSaved', reason: labReason(refused), writes: false, refusal: refused };
  });
}

/**
 * Every value in each group (D1), from the rows Save would submit now: one
 * dry run of `bulkAppendValues` on the record, each row's group from its own
 * outcome. Readings of one test on one day are placed first (`placeReadings`):
 * a loser that differs is not saved (`sameDay`); one equal to its winner takes
 * the winner's outcome ("saved" once the winner is written or held). A value
 * not sent is written alone, dry, to show what ticking it would do; with no
 * day it waits. Values come in Save's order (the run's, then the rest), then
 * refused and unread rows. Recompute it whenever a day, a tick, an edit or a
 * Replace changes.
 */
export function classifyImportValues(files: readonly ImportFile[], record: RoadmapFile, now: string): ImportClassification {
  const empty = createEmptyFile({ deviceId: 'review', now });
  const sent: Array<Info & { row: BulkRow }> = [];
  const unsent: Array<Info & { day: string | null }> = [];
  files.forEach(({ result, rows, days }, file) => {
    if (result.classification !== 'lab_report') return;
    const add = (ref: string, label: string, reasons: UnsureReason[], recordedAt?: string) => {
      const info: Info = { file, ref, label, reasons, rank: readingRank(recordedAt, UNDATED_PREVIOUS) };
      const row = rows[ref];
      if (row && isClinicalDay(row.recordedAt)) sent.push({ ...info, row });
      else unsent.push({ ...info, day: isClinicalDay(days[ref]) ? days[ref]!.slice(0, 10) : null });
    };
    (result.values ?? []).forEach((v, i) => add(`v${i}`, METRIC_LABELS[v.metric] ?? labTestLabel(v.metric), [
      ...(v.confidence !== 'high' ? ['confidence' as const] : []), ...(v.question ? ['question' as const] : []), ...(v.unitGuessed ? ['unitGuessed' as const] : []),
    ], v.recordedAt));
    (result.additionalValues ?? []).forEach((v, i) => add(`a${i}`, labTestLabel(v.name), [
      ...(v.confidence && v.confidence !== 'high' ? ['confidence' as const] : []), ...(v.question ? ['question' as const] : []),
    ], v.recordedAt));
  });

  // 1) One reading per (test, day), by the review's precedence (US-12 AC12, AC14; US-13 AC3).
  //    A row the write refuses on its own (its unit, its range) takes no slot:
  //    it goes to the run as it is, and a valid reading of that day still lands.
  const placed = sent.map((_, i) => i).filter((i) => !refusedAlone(sent[i].row, now));
  const placements = placeReadings(placed.map((i) => ({ ...slotOf(sent[i].row), rank: sent[i].rank, edited: sent[i].row.source === 'lab_import_edited', sent: true })), heldReadings(record));
  const places = new Map(placed.map((i, k) => [i, { place: placements[k].place, winner: placements[k].winner === undefined ? undefined : placed[placements[k].winner!] }]));
  const loses = (i: number) => places.get(i)?.place === 'duplicate' || places.get(i)?.place === 'hidden';
  const batch = sent.map((_, i) => i).filter((i) => !loses(i)).sort((i, j) => sent[i].rank - sent[j].rank || i - j);

  // 2) One dry run of what Save submits; each row's group is its own outcome.
  const groups = new Map<number, Group>(groupsOf(batch.map((i) => sent[i]), record, now).map((g, k) => [batch[k], g]));
  const label = (s: Info, sentHere: boolean) => ({ file: s.file, ref: s.ref, label: s.label, sent: sentHere });
  const values: ClassifiedValue[] = batch.map((i) => ({ ...label(sent[i], true), ...groups.get(i)! }) as ClassifiedValue);
  sent.forEach((s, i) => {
    if (!loses(i)) return;
    const { place, winner } = places.get(i)!;
    const won = groups.get(winner!)!;
    const inherited: Group = place === 'hidden' ? { group: 'notSaved', reason: 'sameDay', writes: false }
      : won.writes || won.group === 'saved' ? { group: 'saved', writes: false, duplicate: true } : { ...won, writes: false };
    values.push({ ...label(s, true), ...inherited } as ClassifiedValue);
  });

  // 3) A value not sent: what ticking it alone would do; with no day, only its refusal.
  for (const u of unsent) {
    const file = files[u.file];
    const row = importRow(file.result, u.ref, u.day ?? PROBE_DAY)!;
    const [g] = groupsOf([{ row, reasons: [...u.reasons] }], u.day ? record : empty, now);
    const shown: Group = u.day || g.group === 'notSaved' || (g.group === 'unsure' && g.reasons.includes('outOfRange')) ? { ...g, writes: false } : { group: 'waiting', writes: false };
    values.push({ ...label(u, false), ...shown } as ClassifiedValue);
  }

  files.forEach(({ result }, file) => {
    if (result.classification !== 'lab_report') return;
    const notSaved = (ref: string, name: string, reason: NotSavedReason): ClassifiedValue => ({ file, ref, label: name, sent: false, writes: false, group: 'notSaved', reason });
    (result.refusedValues ?? []).forEach((v, i) => values.push(notSaved(`r${i}`, METRIC_LABELS[v.metric] ?? labTestLabel(v.metric),
      !v.unit.trim() ? 'noUnit' : v.metric === 'creatinine' && isUrineOrRatioUnit(v.unit) ? 'urine' : 'unit')));
    const unread = result.unreadValues ?? [];
    unread.forEach((v, i) => values.push(notSaved(`u${i}`, v.name ? labTestLabel(v.name) : '', 'unreadable')));
    // Dropped rows the server named no test for (US-12 AC19), counted after the named ones.
    const unnamed = Math.max(0, (result.droppedValueCount ?? 0) - unread.length);
    for (let i = 0; i < unnamed; i++) values.push(notSaved(`u${unread.length + i}`, '', 'unreadable'));
  });
  return { values, rows: batch.filter((i) => groups.get(i)!.writes).map((i) => sent[i].row) };
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
    if (result.classification === 'lab_report') values += (result.values?.length ?? 0) + (result.additionalValues?.length ?? 0);
    // A document counts by its kind, values or not: a clinic letter that prints an LDL is still a letter.
    if (result.document && result.document.classification !== 'lab_report') {
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
