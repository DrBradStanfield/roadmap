// The review matrix model: upload and saved values as a metric × date grid (US-12, US-13).
import { type UnitSystem, type MetricType, UNIT_DEFS } from '@roadmap/health-core/units';
import { type ApiMeasurement, METRIC_LABELS, BLOOD_TEST_METRICS, VITAL_METRICS } from '@roadmap/health-core/mappings';
import { displayLabUnit, labSlotKey, resolveLabCatalogEntry } from '@roadmap/health-core/lab-catalog';
import { sameLabQuantity, slotState, type LabQuantity } from '@roadmap/health-core/record-edits';
import { UNDATED_PREVIOUS, type RefusedLabValue } from '@roadmap/health-core/lab-extraction';
import { withComparator, comparatorOf, type Comparator } from '@roadmap/health-core/lab-limits';
import type { ExtractedValue, AdditionalLabValue, ApiLabValue, DocumentResult } from './api-types';
import { labValueLabel } from '@roadmap/health-core/lab-series';
import { type CellUnit, cellNumber } from './blood-test-cell';
import { type FullDate, parseReportDate, UNDATED_DATE, dateSource, buildDatePrefix } from './review-dates';

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

/** Two stored values are the same value when only float noise from a unit
 *  conversion separates them. */
export function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

/** A lab reading's unit as the matrix shows it (display spelling only). */
function labUnitText(lab: { name: string; unit: string }): string {
  return displayLabUnit(lab.unit, resolveLabCatalogEntry(lab.name));
}

/** Lab-value name → row key: health-core's slot key, so a report's "Vitamin D"
 *  and the stored `vitamin_d` share one row, as in the connector (US-35 AC6).
 *  `|` is swapped out because the cellKey format is `${rowKey}|${dateKey}`, and
 *  an LLM-emitted name like "ALT | AST ratio" would otherwise collide. Prefixed
 *  so a lab row named like a core metric ("ldl", "systolic_bp": saved before
 *  US-12 AC11, or by a connector commit today) never shares a cell with it. */
export function normaliseLabName(name: string): string {
  return `lab:${labSlotKey(name).replace(/\|/g, '/')}`;
}

// ============================================================================
// Matrix model — review-time blood-test values rendered as a metric × date
// grid. Replaces the per-file row layout. Existing history acts as greyed-out
// context columns; new upload values are editable per cell. Documents render
// below the matrix in per-file cards (unchanged).
// ============================================================================

export type DateKey = string; // YYYY-MM-DD or YYYY-MM

export interface MatrixColumn {
  dateKey: DateKey;     // sort key, also rendered as the column header
  date: FullDate;       // mutable for new columns; sourced from history for existing
  isNew: boolean;       // false = history-only; true = at least one upload contributes
  sources: string[];    // upload date sources at this date (`dateSource`; empty for history-only columns)
  /** An undated previous column (US-12 AC14): its file, whose report day it
   *  must come before, and the month it printed, if any. Keyed by its file,
   *  picked or not, so it never merges with another column. */
  undated?: { fi: number; printedMonth?: string };
}

interface CoreRow {
  kind: 'core';
  metric: MetricType;
}

interface AdditionalRow {
  kind: 'additional';
  /** The lab's slot key (`normaliseLabName`), shared with the connector. Display uses any case from the data. */
  nameKey: string;
  /** Display name — preserves casing from the first source we see. */
  displayName: string;
  /** Stable unit from the first source we see. */
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
}

export type MatrixRow = CoreRow | AdditionalRow;

/** Editable matrix cell. Discriminated by `kind` so the save logic can
 *  resolve back to the right source array (r.values[vi] vs
 *  r.additionalValues[ai]) without a sign-encoding trick. */
/** The already-saved row an upload value collides with. Its presence IS the
 *  conflict: the slot already holds an active row with a DIFFERENT value
 *  (typically written by a connector). The cell edits like any other; it only
 *  saves when the user ticks "Replace". `id` is what the save sends as
 *  `correctsId`. */
export interface ExistingCell { id: string; display: string; valueSI?: number; lab?: LabQuantity; displayUnit?: string; comparator?: Comparator }

export type EditableMatrixCell =
  | { state: 'editable'; kind: 'core'; fi: number; vi: number; initialDisplay: string; confidence: 'high' | 'medium' | 'low'; question?: string; printed?: string; valueSI: number; displayUnit: string; existing?: ExistingCell; comparator?: Comparator }
  | { state: 'editable'; kind: 'additional'; fi: number; ai: number; initialDisplay: string; valueSI: number; displayUnit: string; lab: LabQuantity; referenceLow?: number | null; referenceHigh?: number | null; existing?: ExistingCell; comparator?: Comparator };

/** What a cell's review state (typed text, touched, Replace) is keyed by: its
 *  value's place in the extraction, never its column. A picked date re-keys
 *  the column, and an edit or a clear made before the pick must survive it. */
export function editId(cell: EditableMatrixCell): string {
  return cell.kind === 'core' ? valueId(cell.fi, 'core', cell.vi) : valueId(cell.fi, 'additional', cell.ai);
}
function valueId(fi: number, kind: 'core' | 'additional', i: number): string {
  return `${fi}:${kind === 'core' ? 'v' : 'a'}${i}`;
}

/** A Replace tick holds for one saved row only: a date moved onto another
 *  saved row's slot starts unticked. */
export function replaceKey(cell: EditableMatrixCell, existing: ExistingCell): string {
  return `${editId(cell)}>${existing.id}`;
}

/** A reading a review hides because another holds its (test, day): named, never its value. */
interface HiddenReading { label: string; day: DateKey }
/** `comparator`: a core reading printed as a limit; a lab's rides on its `lab` (US-12 AC20). */
type Quantity = { valueSI?: number; lab?: LabQuantity; comparator?: Comparator };

/** A core cell as rendered: its text in the row's unit and the value it saves. */
/** `comparator`: an untouched limit's, shown before its bound; an edited cell is exact (US-12 AC20). */
export interface CoreCellView { text: string; valueSI?: number; error: string | null; comparator?: Comparator }

export type MatrixCell =
  | { state: 'empty' }
  /** What a collision compares: `valueSI` for a core metric (the stored value), `lab` for an additional lab,
   *  shown in `displayUnit`. */
  | { state: 'context'; id: string; displayValue: string; valueSI?: number; lab?: LabQuantity; displayUnit?: string; comparator?: Comparator }
  | EditableMatrixCell;

/** Build the matrix view. A saved row owns its cell: an upload value that
 *  MATCHES it is already recorded (stays context), one that DIFFERS becomes a
 *  `conflict` the user can accept as a correction. */
export function buildMatrixModel(
  results: FileResult[],
  fileDates: Record<string, FullDate>,
  measurementHistory: ApiMeasurement[],
  labValueHistory: ApiLabValue[],
  unitSystem: UnitSystem,
  metricUnitOverrides?: Partial<Record<MetricType, CellUnit>>,
  /** Values the user edited (`editId`): never hidden as already saved. Their
   *  cell stays editable against the saved row, judged by the edited text. */
  touched?: { has(id: string): boolean },
): { columns: MatrixColumn[]; coreRows: CoreRow[]; additionalRows: AdditionalRow[]; cells: Map<string, MatrixCell>; hiddenReadings: HiddenReading[] } {
  const cells = new Map<string, MatrixCell>();
  const columnsByKey = new Map<DateKey, MatrixColumn>();
  const coreMetricsSeen = new Set<MetricType>();
  const additionalByKey = new Map<string, AdditionalRow>();

  /** Resolved display unit for a core metric, honouring per-metric override. */
  const displayFor = (metric: MetricType): CellUnit => metricUnitOverrides?.[metric] ?? unitSystem;

  /** Two readings are the same quantity. A core metric compares stored
   *  values: its rounded display can hide a real difference (Lp(a) 124.9 and
   *  125 nmol/L both read "50.0" mg/dL, either side of the Elevated line,
   *  US-13 AC3). An additional lab compares quantities: the record holds it in
   *  SI, the report prints its own unit, so health-core's `sameLabQuantity`
   *  converts both, as the connector does (US-35 AC6). */
  const sameQuantity = (a: Quantity, b: Quantity, display?: string, shown?: string) =>
    a.valueSI !== undefined && b.valueSI !== undefined ? sameValue(a.valueSI, b.valueSI) && a.comparator === b.comparator
      : a.lab && b.lab ? sameLabQuantity(a.lab, b.lab)
        : display !== undefined && shown !== undefined && slotState(shown, display) === 'held_equal';

  const addColumn = (dateKey: DateKey, date: FullDate, source: string | null) => {
    let col = columnsByKey.get(dateKey);
    if (!col) {
      col = { dateKey, date, isNew: source !== null, sources: [] };
      columnsByKey.set(dateKey, col);
    }
    if (source !== null) {
      col.isNew = true;
      if (!col.sources.includes(source)) col.sources.push(source);
    }
    return col;
  };

  /** A value's date: its own printed day when it has one (US-12 AC12), else
   *  its file's. The date state holds only what the user picked; a printed day
   *  nobody edited is read from the value itself. */
  type Dated = { recordedAt?: string; printedMonth?: string };
  const valueDate = (fi: number, { recordedAt }: Dated): FullDate | undefined =>
    recordedAt ? fileDates[dateSource(fi, recordedAt)] ?? (recordedAt === UNDATED_PREVIOUS ? UNDATED_DATE : parseReportDate(recordedAt)) : fileDates[fi];
  /** The column a value sits in. An undated previous column is keyed by its
   *  file, picked or not, so it never merges with another (US-12 AC14). */
  const valueDateKey = (fi: number, v: Dated): DateKey | null => {
    const date = valueDate(fi, v);
    return !date ? null : v.recordedAt === UNDATED_PREVIOUS ? `undated:${fi}` : buildDatePrefix(date);
  };
  /** The day a value's slot is on: its column's, or an undated column's picked
   *  day (null until picked). Held rows and primary readings are met here. */
  const slotDateKey = (fi: number, v: Dated): DateKey | null => {
    const date = valueDate(fi, v);
    return !date || date.undated ? null : buildDatePrefix(date);
  };

  // 1) Seed columns + cells from existing history (greyed context). A blood
  //    test seeds its own column. A saved BP seeds only a date this upload
  //    brings, so it conflicts like any held slot (US-13 AC3) without every
  //    vitals date becoming a column.
  //    An upload brings a column only for a date one of its values carries:
  //    document-only files (scans, letters) keep their own card below the
  //    matrix, off the date axis. One rule for the seeding and the overlay.
  const bloodTestSet = new Set<string>(BLOOD_TEST_METRICS);
  const vitalSet = new Set<string>(VITAL_METRICS);
  const uploadDates = new Set(results.flatMap((r, fi) => [...r.values, ...r.additionalValues].map(v => slotDateKey(fi, v))));
  for (const m of measurementHistory) {
    const dateKey = m.recordedAt.slice(0, 10);
    const metric = m.metricType as MetricType;
    const blood = bloodTestSet.has(metric);
    if (!blood && !(vitalSet.has(metric) && uploadDates.has(dateKey))) continue;
    if (blood) {
      addColumn(dateKey, parseReportDate(dateKey), null);
      coreMetricsSeen.add(metric);
    }
    const display = UNIT_DEFS[metric]
      ? cellNumber(metric, m.value, displayFor(metric), m.comparator)
      : String(m.value);
    cells.set(`${metric}|${dateKey}`, { state: 'context', id: m.id, displayValue: withComparator(display, m.comparator), valueSI: m.value, ...comparatorOf(m) });
  }
  for (const lv of labValueHistory) {
    const dateKey = lv.recordedAt.slice(0, 10);
    addColumn(dateKey, parseReportDate(dateKey), null);
    const nameKey = normaliseLabName(lv.metricName);
    if (!additionalByKey.has(nameKey)) {
      additionalByKey.set(nameKey, {
        kind: 'additional',
        nameKey,
        displayName: labValueLabel(lv.metricName), // the catalogue label, as the matrix shows it
        // Same display-only unit-spelling normalization as the lab-rows
        // matrix ("umol/L" → "µmol/L", ratio ≡ L/L) — these are stored rows,
        // already in the catalogue's SI unit when the test is catalogued.
        unit: labUnitText({ name: lv.metricName, unit: lv.unit }),
        referenceLow: lv.referenceLow,
        referenceHigh: lv.referenceHigh,
      });
    }
    cells.set(`${nameKey}|${dateKey}`, {
      state: 'context', id: lv.id, displayValue: withComparator(String(lv.value), lv.comparator),
      lab: { name: lv.metricName, value: lv.value, unit: lv.unit, ...comparatorOf(lv) },
      displayUnit: labUnitText({ name: lv.metricName, unit: lv.unit }),
    });
  }

  // 2) Overlay upload values, one reading per (test, day), in the save's own
  //    rank: a report's own reading claims its slot first, then a dated
  //    previous column's, then an undated one's (on its picked day), then
  //    file order (US-12 AC12, AC14). A later reading of a claimed slot is
  //    hidden, as AC12 hides it, and listed in `hiddenReadings` (`place`), so
  //    it is never dropped silently. On a held slot: an equal value is
  //    already recorded (context), a differing one a conflict the user
  //    resolves in the table (US-32).
  const claims = new Map<string, { rank: number; quantity: Quantity; edited: boolean; heldEqual: boolean }>();
  /** The saved rows, by slot, before any upload cell takes one. */
  const savedRows = new Map(cells);
  const hiddenReadings: HiddenReading[] = [];
  const rankOf = (recordedAt?: string) => (!recordedAt ? 0 : recordedAt === UNDATED_PREVIOUS ? 2 : 1);
  /**
   * Where one reading lands: an ExistingCell (a conflict with the saved row)
   * or undefined (a free slot) to place an editable cell, null for none.
   * A reading equal to the saved row, and not edited, is already recorded:
   * context, shown in its own column too (an undated one's, US-13 AC3), and
   * never counted. Within one rank a winner that only matched the saved row
   * does not block a differing reading, which becomes the conflict (US-13
   * AC3). Otherwise a claimed slot hides the later reading, counted when it
   * differs from the winner or either side was edited (US-12 AC14).
   */
  const place = (slot: string, cellKey: string, rank: number, display: string, quantity: Quantity, edited: boolean, label: string): ExistingCell | undefined | null => {
    const held = savedRows.get(slot);
    const prev = held?.state === 'context' ? held : undefined;
    const equalHeld = !edited && !!prev && sameQuantity(quantity, prev, display, prev.displayValue);
    const winner = claims.get(slot);
    const blocked = !!winner && !(winner.rank === rank && winner.heldEqual);
    if (!blocked) claims.set(slot, { rank, quantity, edited, heldEqual: equalHeld });
    if (equalHeld) {
      // Never over a conflict another reading of this test already put in
      // the same column (a test printed twice in one undated column).
      if (slot !== cellKey && cells.get(cellKey)?.state !== 'editable') cells.set(cellKey, prev!);
      return null;
    }
    if (blocked) {
      if (edited || winner!.edited || !sameQuantity(quantity, winner!.quantity)) hiddenReadings.push({ label, day: slot.slice(slot.lastIndexOf('|') + 1) });
      return null;
    }
    return prev && { id: prev.id, display: prev.displayValue, valueSI: prev.valueSI, lab: prev.lab, displayUnit: prev.displayUnit, ...comparatorOf(prev) };
  };
  for (const rank of [0, 1, 2]) results.forEach((r, fi) => {
    /** The column a value lands in: its own date's (US-12 AC12) or its file's. */
    const columnFor = (v: Dated): DateKey | null => {
      const dateKey = valueDateKey(fi, v);
      if (!dateKey) return null;
      const col = addColumn(dateKey, valueDate(fi, v)!, dateSource(fi, v.recordedAt));
      if (v.recordedAt === UNDATED_PREVIOUS) col.undated ??= { fi, printedMonth: v.printedMonth };
      return dateKey;
    };
    /** Where a value meets a held row or a primary reading: its slot's day. */
    const slotFor = (rowKey: string, v: Dated, dateKey: DateKey) => `${rowKey}|${slotDateKey(fi, v) ?? dateKey}`;

    r.values.forEach((v, vi) => {
      if (rankOf(v.recordedAt) !== rank) return;
      const dateKey = columnFor(v);
      if (!dateKey) return;
      const metric = v.metric as MetricType;
      coreMetricsSeen.add(metric);
      const cellKey = `${metric}|${dateKey}`;
      const slot = slotFor(metric, v, dateKey);
      const initialDisplay = UNIT_DEFS[metric]
        ? cellNumber(metric, v.valueSI, displayFor(metric), v.comparator)
        : String(v.displayValue);
      const existing = place(slot, cellKey, rank, withComparator(initialDisplay, v.comparator), { valueSI: v.valueSI, ...comparatorOf(v) }, !!touched?.has(valueId(fi, 'core', vi)), METRIC_LABELS[metric] || metric);
      if (existing === null) return;
      cells.set(cellKey, {
        state: 'editable', kind: 'core', fi, vi,
        initialDisplay,
        confidence: v.confidence,
        question: v.question,
        // What the report printed, when the cell shows something else: a
        // converted number, or a guessed unit (US-13 AC11). By number: "1.10" is "1.1".
        printed: v.unitGuessed || Number(initialDisplay) !== v.displayValue
          ? `Printed: ${v.displayValue} ${v.displayUnit || '(no unit)'}` : undefined,
        valueSI: v.valueSI,
        displayUnit: v.displayUnit,
        existing,
        ...comparatorOf(v),
      });
    });

    r.additionalValues.forEach((av, ai) => {
      if (rankOf(av.recordedAt) !== rank) return;
      const dateKey = columnFor(av);
      if (!dateKey) return;
      const nameKey = normaliseLabName(av.name);
      if (!additionalByKey.has(nameKey)) {
        additionalByKey.set(nameKey, {
          kind: 'additional',
          nameKey,
          displayName: labValueLabel(av.name),
          // Display-only spelling normalization. The review shows the report
          // as PRINTED, and the save path passes av.unit on unchanged — the
          // conversion to SI happens once, at the write (US-21 phase 3).
          unit: labUnitText(av),
          referenceLow: av.referenceLow ?? null,
          referenceHigh: av.referenceHigh ?? null,
        });
      }
      const cellKey = `${nameKey}|${dateKey}`;
      const slot = slotFor(nameKey, av, dateKey);
      const lab = { name: av.name, value: av.value, unit: av.unit, ...comparatorOf(av) };
      const existing = place(slot, cellKey, rank, withComparator(String(av.value), av.comparator), { lab }, !!touched?.has(valueId(fi, 'additional', ai)), labValueLabel(av.name));
      if (existing === null) return;
      cells.set(cellKey, {
        state: 'editable',
        kind: 'additional',
        fi, ai,
        initialDisplay: String(av.value),
        valueSI: av.value,
        displayUnit: labUnitText(av),
        lab,
        referenceLow: av.referenceLow,
        referenceHigh: av.referenceHigh,
        existing,
        ...comparatorOf(av),
      });
    });
  });

  // 3) Sort. Columns chronological asc (oldest left, newest right).
  //    Core rows in the canonical BLOOD_TEST_METRICS order so the matrix
  //    reads the same as the live timeline, then any vitals the report
  //    printed (BP; extraction never returns weight or waist): save takes
  //    every cell, so every cell needs a row (US-12 AC11). Additional rows alphabetic.
  //    An undated previous column comes first: it is older than its report.
  const columns = Array.from(columnsByKey.values())
    .sort((a, b) => Number(!a.date.undated) - Number(!b.date.undated)
      || (a.date.undated ? '' : buildDatePrefix(a.date)).localeCompare(b.date.undated ? '' : buildDatePrefix(b.date))
      || a.dateKey.localeCompare(b.dateKey));
  const coreRows: CoreRow[] = [...BLOOD_TEST_METRICS, ...VITAL_METRICS]
    .filter(m => coreMetricsSeen.has(m as MetricType))
    .map(m => ({ kind: 'core' as const, metric: m as MetricType }));
  const additionalRows = Array.from(additionalByKey.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );

  return { columns, coreRows, additionalRows, cells, hiddenReadings };
}

/** What a screen reader names the row: the label it shows, or the lab row's own name (never its `lab:` key). */
export function rowName(row: MatrixRow): string {
  return row.kind === 'core' ? METRIC_LABELS[row.metric] || row.metric : row.displayName;
}

/** Cell key for the matrix model (used by both the cells Map and the
 *  per-cell edit state). */
export function matrixCellKey(rowKey: string, dateKey: DateKey): string {
  return `${rowKey}|${dateKey}`;
}

/** Row's stable key for cell lookups. */
export function matrixRowKey(row: MatrixRow): string {
  return row.kind === 'core' ? row.metric : row.nameKey;
}

