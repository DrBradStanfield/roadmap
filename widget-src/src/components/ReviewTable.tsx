import { useState, useMemo, useEffect, useCallback, useRef, memo } from 'react';
import type { LpaUnit, UnitSystem, MetricType, MeasurementSource, ApiMeasurement, DocumentType } from '@roadmap/health-core';
import {
  UNIT_DEFS,
  healthInputSchema,
  METRIC_LABELS,
  METRIC_TO_FIELD,
  parseLocalisedNumber,
  BLOOD_TEST_METRICS,
  VITAL_METRICS,
  hasUnitChoice,
  isScreeningEligible,
  displayLabUnit,
  labSlotKey,
  resolveLabCatalogEntry,
  canonicalLabRow,
  sameLabQuantity,
  slotState,
  validDay,
  isCalendarDay,
  UNDATED_PREVIOUS,
  type LabQuantity,
} from '@roadmap/health-core';
import { getCurrentDateValue } from './DatePicker';
import type { ExtractedValue, AdditionalLabValue, ApiDocument, ApiLabValue, DocumentResult, UploadHistory } from '../lib/api-types';
import { labValueLabel } from '../lib/lab-value-labels';
import { unarchivedOriginals } from '../lib/archive-payloads';
import { useMatrixScrollSync } from '../lib/useMatrixScrollSync';
import { type CellUnit, type Grading, cellHint, cellLabel, cellText, cellToSI, validateTypedValue } from '../lib/blood-test-cell';
import { useLpaUnit } from '../lib/lpa-unit';
import { NumericInputCell } from './NumericInputCell';
import { DraftDateCell } from './DraftDateCell';
import { LpaUnitControl } from './LpaUnitControl';
import { UnitChip } from './UnitChip';
import { MONTHS_SHORT } from '../lib/constants';

export interface FileResult {
  fileName: string;
  reportDate: string | null;
  values: ExtractedValue[];
  additionalValues: AdditionalLabValue[];
  error?: string;
  /** Present for non-lab documents (scan results, clinic letters, etc.) */
  document?: DocumentResult;
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
}
export interface ReviewedLabValue {
  name: string; value: number; unit: string;
  referenceLow?: number | null; referenceHigh?: number | null;
  recordedAt: string; correctsId?: string;
}

interface ReviewTableProps {
  results: FileResult[];
  history: UploadHistory;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, UnitSystem>>;
  onToggleFieldUnit?: (field: string) => void;
  /** The plan's age, which sets screening eligibility (US-06 AC5). Unset with no plan or no valid birth year. */
  age?: number;
  /** With the age, sets screening eligibility. */
  sex?: 'male' | 'female';
  /** Whom the hints and status colours grade for; null for a known minor,
   *  as in the blood-test matrix (US-07 AC6). */
  grading: Grading;
  onSave: (payload: {
    values: ReviewedValue[];
    documents: DocumentToSave[];
    labValues: ReviewedLabValue[];
  }) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
}

/** Full date state: day/month/year. Day is null when the LLM didn't extract one. */
interface FullDate {
  day: string | null; // "01"-"31" or null
  month: string;      // "1"-"12"
  year: string;       // "2024"
  /** An undated previous column the user has not dated yet (US-12 AC14):
   *  month and year are empty. */
  undated?: true;
}

/** A printed date as review state. A day is kept only if it exists in its
 *  month; a date with no real month (null, "June 2024", "2024-13") shows this
 *  month with no day (US-13 AC8). */
function parseReportDate(dateStr: string | null): FullDate {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ]|$)/.exec(dateStr ?? '');
  if (!m || !isCalendarDay(`${m[1]}-${m[2]}-01`)) {
    const now = getCurrentDateValue();
    return { day: null, month: now.month, year: now.year };
  }
  return { day: m[3] && isCalendarDay(`${m[1]}-${m[2]}-${m[3]}`) ? m[3] : null, month: m[2], year: m[1] };
}

/** The date of an undated previous column until the user picks one: no
 *  month, so it never shares a column with the report's or any month's (US-12 AC14). */
const UNDATED_DATE: FullDate = { day: null, month: '', year: '', undated: true };

/** "Jun" for "6" or "06". */
function monthLabel(month: string): string {
  return MONTHS_SHORT.find(m => m.value === month.padStart(2, '0'))?.label ?? month;
}

/** "5 Jan 2019" for 2019-01-05, "Jun 2025" for 2025-06; null for anything
 *  else (an undated column's key, `undated:<file>`, is no date). */
function longDate(day: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(day);
  return m && `${m[3] ? `${Number(m[3])} ` : ''}${monthLabel(m[2])} ${m[1]}`;
}

/** A column's date when it is a calendar day that has happened, else null:
 *  only then is it set, and Save allowed (US-13 AC8). */
function columnDay(date: FullDate): string | null {
  return date.day ? validDay(fullDateToIso(date), { now: new Date().toISOString() }) : null;
}

function getDaysInMonth(month: string, year: string): number {
  return new Date(parseInt(year), parseInt(month), 0).getDate();
}

/** Build YYYY-MM-DD or YYYY-MM-01 ISO string from FullDate state. */
function buildRecordedAt(date: FullDate): string {
  return `${fullDateToIso(date)}T00:00:00.000Z`;
}

/** YYYY-MM-DD, defaulting day to 01 when absent. */
function fullDateToIso(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  const day = (date.day ?? '01').padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

/** Inverse of fullDateToIso. Returns null on malformed input. */
function parseIsoToFullDate(iso: string): FullDate | null {
  const [year, month, day] = iso.split('-');
  if (!year || !month || !day) return null;
  return { year, month, day };
}

/** What sets a value's date, and keys the date state: its file's report date,
 *  or its own printed day from a dated previous-results column (US-12 AC12),
 *  so editing one column's date never moves the other. */
function dateSource(fi: number, recordedAt?: string): string {
  return recordedAt ? `${fi}@${recordedAt}` : String(fi);
}

/** Build the most precise date prefix for duplicate matching. */
function buildDatePrefix(date: FullDate): string {
  const month = date.month.padStart(2, '0');
  if (date.day) {
    return `${date.year}-${month}-${date.day.padStart(2, '0')}`;
  }
  return `${date.year}-${month}`;
}

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

/** Two stored values are the same value when only float noise from a unit
 *  conversion separates them. */
function sameValue(a: number, b: number): boolean {
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
function normaliseLabName(name: string): string {
  return `lab:${labSlotKey(name).replace(/\|/g, '/')}`;
}

// ============================================================================
// Matrix model — review-time blood-test values rendered as a metric × date
// grid. Replaces the per-file row layout. Existing history acts as greyed-out
// context columns; new upload values are editable per cell. Documents render
// below the matrix in per-file cards (unchanged).
// ============================================================================

type DateKey = string; // YYYY-MM-DD or YYYY-MM

interface MatrixColumn {
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

type MatrixRow = CoreRow | AdditionalRow;

/** Editable matrix cell. Discriminated by `kind` so the save logic can
 *  resolve back to the right source array (r.values[vi] vs
 *  r.additionalValues[ai]) without a sign-encoding trick. */
/** The already-saved row an upload value collides with. Its presence IS the
 *  conflict: the slot already holds an active row with a DIFFERENT value
 *  (typically written by a connector). The cell edits like any other; it only
 *  saves when the user ticks "Replace". `id` is what the save sends as
 *  `correctsId`. */
interface ExistingCell { id: string; display: string; valueSI?: number; lab?: LabQuantity; displayUnit?: string }

type EditableMatrixCell =
  | { state: 'editable'; kind: 'core'; fi: number; vi: number; initialDisplay: string; confidence: 'high' | 'medium' | 'low'; question?: string; valueSI: number; displayUnit: string; existing?: ExistingCell }
  | { state: 'editable'; kind: 'additional'; fi: number; ai: number; initialDisplay: string; valueSI: number; displayUnit: string; lab: LabQuantity; referenceLow?: number | null; referenceHigh?: number | null; existing?: ExistingCell };

/** What a cell's review state (typed text, touched, Replace) is keyed by: its
 *  value's place in the extraction, never its column. A picked date re-keys
 *  the column, and an edit or a clear made before the pick must survive it. */
function editId(cell: EditableMatrixCell): string {
  return cell.kind === 'core' ? valueId(cell.fi, 'core', cell.vi) : valueId(cell.fi, 'additional', cell.ai);
}
function valueId(fi: number, kind: 'core' | 'additional', i: number): string {
  return `${fi}:${kind === 'core' ? 'v' : 'a'}${i}`;
}

/** A Replace tick holds for one saved row only: a date moved onto another
 *  saved row's slot starts unticked. */
function replaceKey(cell: EditableMatrixCell, existing: ExistingCell): string {
  return `${editId(cell)}>${existing.id}`;
}

/** A reading a review hides because another holds its (test, day): named, never its value. */
interface HiddenReading { label: string; day: DateKey }
type Quantity = { valueSI?: number; lab?: LabQuantity };

/** A core cell as rendered: its text in the row's unit and the value it saves. */
interface CoreCellView { text: string; valueSI?: number; error: string | null }

type MatrixCell =
  | { state: 'empty' }
  /** What a collision compares: `valueSI` for a core metric (the stored value), `lab` for an additional lab,
   *  shown in `displayUnit`. */
  | { state: 'context'; id: string; displayValue: string; valueSI?: number; lab?: LabQuantity; displayUnit?: string }
  | EditableMatrixCell;

/** Build the matrix view. A saved row owns its cell: an upload value that
 *  MATCHES it is already recorded (stays context), one that DIFFERS becomes a
 *  `conflict` the user can accept as a correction. Exported for tests. */
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
    a.valueSI !== undefined && b.valueSI !== undefined ? sameValue(a.valueSI, b.valueSI)
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
      ? cellText(metric, m.value, displayFor(metric))
      : String(m.value);
    cells.set(`${metric}|${dateKey}`, { state: 'context', id: m.id, displayValue: display, valueSI: m.value });
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
      state: 'context', id: lv.id, displayValue: String(lv.value),
      lab: { name: lv.metricName, value: lv.value, unit: lv.unit },
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
    return prev && { id: prev.id, display: prev.displayValue, valueSI: prev.valueSI, lab: prev.lab, displayUnit: prev.displayUnit };
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
        ? cellText(metric, v.valueSI, displayFor(metric))
        : String(v.displayValue);
      const existing = place(slot, cellKey, rank, initialDisplay, { valueSI: v.valueSI }, !!touched?.has(valueId(fi, 'core', vi)), METRIC_LABELS[metric] || metric);
      if (existing === null) return;
      cells.set(cellKey, {
        state: 'editable', kind: 'core', fi, vi,
        initialDisplay,
        confidence: v.confidence,
        question: v.question,
        valueSI: v.valueSI,
        displayUnit: v.displayUnit,
        existing,
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
      const lab = { name: av.name, value: av.value, unit: av.unit };
      const existing = place(slot, cellKey, rank, String(av.value), { lab }, !!touched?.has(valueId(fi, 'additional', ai)), labValueLabel(av.name));
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

/** What a screen reader names the row: the metric key, or the lab row's own name (never its `lab:` key). */
function rowName(row: MatrixRow): string {
  return row.kind === 'core' ? row.metric : row.displayName;
}

/** Cell key for the matrix model (used by both the cells Map and the
 *  per-cell edit state). */
function matrixCellKey(rowKey: string, dateKey: DateKey): string {
  return `${rowKey}|${dateKey}`;
}

/** Row's stable key for cell lookups. */
function matrixRowKey(row: MatrixRow): string {
  return row.kind === 'core' ? row.metric : row.nameKey;
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

export function ReviewTable({
  results,
  history,
  unitSystem,
  metricUnitOverrides,
  onToggleFieldUnit,
  age: userAge,
  sex,
  grading,
  onSave,
  onCancel,
  isSaving,
  error,
}: ReviewTableProps) {
  const docHistoryIndex = useMemo(() => buildDocHistoryIndex(history.documents), [history.documents]);
  // Lp(a) has its own three units, kept in the record, as in the blood-test
  // matrix (US-05 AC2); a two-way override for it drives nothing.
  const [lpaUnit, chooseLpaUnit] = useLpaUnit(unitSystem);
  const units = useMemo<Partial<Record<MetricType, CellUnit>>>(() => ({ ...metricUnitOverrides, lpa: lpaUnit }), [metricUnitOverrides, lpaUnit]);

  // Full date state (day/month/year) per file, and, once edited, per printed
  // day of a dated previous-results column (`dateSource`, US-12 AC12).
  const [fileDates, setFileDates] = useState<Record<string, FullDate>>(() => {
    const dates: Record<string, FullDate> = {};
    results.forEach((r, i) => { dates[i] = parseReportDate(r.reportDate); });
    return dates;
  });

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
  // itself, so a retry cannot file it twice. The user can still re-tick it.
  useEffect(() => {
    setDocChecked(prev => {
      const next = { ...prev };
      results.forEach((r, fi) => { if (r.document && isDocDuplicate(r.fileName, docHistoryIndex)) next[fi] = false; });
      return next;
    });
  }, [docHistoryIndex, results]);

  // Per-document: editable title
  const [docTitles, setDocTitles] = useState<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    results.forEach((r, fi) => { if (r.document) map[fi] = r.document.title; });
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

  // The matrix model is the source of truth for what's rendered + what's
  // saveable. Cells in `context` state come from history (greyed, no edit);
  // `editable` cells come from this upload. Save selection = an editable
  // cell whose `editedDisplayValues` entry is non-empty (clear-to-skip).
  // Per-cell edit metadata. Membership = "user touched this cell" (drives
  // the touched-stays-on-toggle behaviour below). `display` is the row's
  // display unit at the moment of edit, read at save time so a unit toggle
  // *after* typing doesn't misconvert the typed value into the wrong SI.
  const touchedRef = useRef<Map<string, { display?: CellUnit }>>(new Map());
  // How many values are touched: rebuilds the matrix when a value is first
  // edited, so a slot's winner and loser are judged as edited (`place`).
  const [touchedCount, setTouchedCount] = useState(0);
  const matrix = useMemo(
    () => buildMatrixModel(results, fileDates, history.measurements, history.labValues, unitSystem, units, touchedRef.current),
    [results, fileDates, history.measurements, history.labValues, unitSystem, units, touchedCount],
  );
  /** One line naming the hidden readings by test and day, never a value (US-12 AC14). */
  const hiddenNotice = useMemo(() => {
    const n = matrix.hiddenReadings.length;
    if (n === 0) return null;
    const byDay = new Map<string, Set<string>>();
    for (const { label, day } of matrix.hiddenReadings) byDay.set(day, (byDay.get(day) ?? new Set()).add(label));
    const names = [...byDay.values()].reduce((count, labels) => count + labels.size, 0);
    const where = (day: string) => { const date = longDate(day); return date ? `on ${date}` : 'in the undated previous column'; };
    const groups = [...byDay].map(([day, labels]) => `${[...labels].join(', ')} ${where(day)}`).join('; ');
    return `${n} reading${n === 1 ? '' : 's'} not saved: ${groups} already ${names === 1 ? 'has' : 'have'} another reading.`;
  }, [matrix]);

  // Initial display values are derived from the matrix (not from raw results)
  // so the unit-system switch re-formats them and dedup-collapsed cells
  // (LLM value silently dropped where history wins) don't appear here.
  const initialDisplayValues = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const cell of matrix.cells.values()) {
      if (cell.state === 'editable') map[editId(cell)] = cell.initialDisplay;
    }
    return map;
  }, [matrix]);

  const [editedDisplayValues, setEditedDisplayValues] = useState<Record<string, string>>(
    () => ({ ...initialDisplayValues }),
  );
  // Conflict cells only: "Replace the saved value with this one". Default
  // off — the record already holds a value, so replacing is the user's call.
  const [replaceChecked, setReplaceChecked] = useState<Record<string, boolean>>({});
  const toggleReplace = useCallback((key: string, on: boolean) => {
    setReplaceChecked(prev => ({ ...prev, [key]: on }));
  }, []);

  const updateEditedDisplayValue = useCallback((id: string, value: string, display?: CellUnit) => {
    const existing = touchedRef.current.get(id);
    if (!existing) setTouchedCount(n => n + 1);
    touchedRef.current.set(id, { display: display ?? existing?.display });
    setEditedDisplayValues(prev => ({ ...prev, [id]: value }));
  }, []);

  // Reformat on unit-system switch + pick up newly-editable cells when a
  // date change reshapes the matrix. User-touched cells keep their text;
  // untouched cells get re-seeded from the (re-formatted) initial; untouched
  // cells that vanished from the model drop out.
  useEffect(() => {
    setEditedDisplayValues(prev => {
      const next: Record<string, string> = {};
      const touched = touchedRef.current;
      for (const id of Object.keys(initialDisplayValues)) {
        next[id] = touched.has(id) && prev[id] !== undefined ? prev[id] : initialDisplayValues[id];
      }
      // A touched value that is not editable just now (its day holds it as
      // saved, or a primary reading took the slot) keeps its text for when
      // the day moves on: an edit is never dropped by a date pick.
      for (const id of touched.keys()) if (!(id in next) && prev[id] !== undefined) next[id] = prev[id];
      return next;
    });
  }, [initialDisplayValues]);

  const metricOf = (cell: EditableMatrixCell) =>
    cell.kind === 'core' ? results[cell.fi]?.values[cell.vi]?.metric as MetricType | undefined : undefined;
  const extractedError = (cell: EditableMatrixCell): string | null => {
    const metric = metricOf(cell);
    if (!metric || !UNIT_DEFS[metric]) return null;
    const parsed = healthInputSchema.shape[METRIC_TO_FIELD[metric] as keyof typeof healthInputSchema.shape].safeParse(cell.valueSI);
    return parsed.success ? null : parsed.error.issues[0].message;
  };
  // Equal rendered text preserves valid extraction precision. An explicit
  // correction of an invalid extraction must instead use the typed quantity.
  const isEditedText = (cell: EditableMatrixCell, editedStr: string) => {
    const typedIn = touchedRef.current.get(editId(cell))?.display;
    const metric = metricOf(cell);
    return (touchedRef.current.has(editId(cell)) && extractedError(cell) !== null)
      || editedStr !== (typedIn && metric && UNIT_DEFS[metric] ? cellText(metric, cell.valueSI, typedIn) : cell.initialDisplay);
  };

  /** The value a cell saves (SI for a core metric): the extracted one while
   *  untouched, which re-deriving from its rounded display would move (Lp(a)
   *  124.9 nmol/L shows "50.0" mg/dL → 125); once edited, the typed number in the
   *  unit it was typed in, so a toggle after typing never misconverts it. */
  const savedValue = (cell: EditableMatrixCell, editedStr: string): number | undefined => {
    const parsed = parseLocalisedNumber(editedStr);
    if (parsed === undefined) return undefined;
    if (!isEditedText(cell, editedStr)) return cell.valueSI;
    const metric = metricOf(cell);
    if (!metric || !UNIT_DEFS[metric]) return parsed;
    return cellToSI(metric, parsed, touchedRef.current.get(editId(cell))?.display ?? units[metric] ?? unitSystem);
  };

  // Validate the quantity we save, not a rounded rendering after a unit switch.
  const cellError = (cell: EditableMatrixCell, text: string): string | null => {
    const metric = metricOf(cell);
    if (!text || !metric || !UNIT_DEFS[metric]) return null;
    if (isEditedText(cell, text)) {
      return validateTypedValue(metric, text, touchedRef.current.get(editId(cell))?.display ?? units[metric] ?? unitSystem).error;
    }
    return extractedError(cell);
  };

  /** Is a ticked replacement the value already saved? A lab compares quantity, in its printed unit (US-35 AC6). */
  const replacesNothing = (cell: EditableMatrixCell, existing: ExistingCell, value: number, editedStr: string): boolean =>
    existing.valueSI !== undefined ? sameValue(value, existing.valueSI)
      : existing.lab && cell.kind === 'additional' ? sameLabQuantity(existing.lab, { ...cell.lab, value })
        : editedStr === existing.display;

  /** Walks the matrix cells, returns the editable ones with a non-empty
   *  edited display value — the cells that will save. Shared by both the
   *  summary counts and handleSave so they stay in sync. */

  const collectSaveableCells = () => {
    interface CellPayload {
      dateKey: DateKey;
      cell: EditableMatrixCell;
      value: number;
      isEdited: boolean;
    }
    const out: CellPayload[] = [];
    let hasInvalid = false;
    for (const [cellKey, cell] of matrix.cells) {
      if (cell.state !== 'editable') continue;
      // A conflicting cell saves only when the user asserts the replacement.
      if (cell.existing && !replaceChecked[replaceKey(cell, cell.existing)]) continue;
      const editedStr = (editedDisplayValues[editId(cell)] ?? cell.initialDisplay).trim();
      if (!editedStr) continue;
      if (cellError(cell, editedStr)) {
        hasInvalid = true;
        continue;
      }
      const value = savedValue(cell, editedStr);
      if (value === undefined) continue;
      // A "replacement" that matches what is already saved would append a
      // correction row that corrects nothing. The slot is already right.
      if (cell.existing && replacesNothing(cell, cell.existing, value, editedStr)) continue;
      // dateKey is the suffix after the LAST `|` — robust against the
      // (rare) chance the rowKey itself contains a separator.
      const dateKey = cellKey.slice(cellKey.lastIndexOf('|') + 1);
      out.push({ dateKey, cell, value, isEdited: isEditedText(cell, editedStr) });
    }
    return { cells: out, hasInvalid };
  };

  const { cells: saveableCells, hasInvalid } = useMemo(collectSaveableCells, [matrix, editedDisplayValues, replaceChecked]);
  /** Cells whose value as now typed is the saved row's: already saved, so no
   *  Replace is offered and nothing saves (an edit judged by its edited value). */
  const heldEqual = useMemo(() => {
    const ids = new Set<string>();
    for (const cell of matrix.cells.values()) {
      if (cell.state !== 'editable' || !cell.existing) continue;
      const text = (editedDisplayValues[editId(cell)] ?? cell.initialDisplay).trim();
      const value = savedValue(cell, text);
      if (value !== undefined && replacesNothing(cell, cell.existing, value, text)) ids.add(editId(cell));
    }
    return ids;
  }, [matrix, editedDisplayValues]);
  // A Replace box gone because the edit now equals the saved row loses its
  // tick, so it never comes back ticked.
  useEffect(() => {
    const gone = [...matrix.cells.values()].flatMap(c => (c.state === 'editable' && c.existing && heldEqual.has(editId(c)) ? [replaceKey(c, c.existing)] : []));
    if (gone.some(k => replaceChecked[k])) setReplaceChecked(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => !gone.includes(k))));
  }, [heldEqual]);
  // What each core cell shows, and the value its colour grades: the value it
  // saves (US-13 AC4), in the row's unit. Typed text is kept verbatim in the
  // unit it was typed in, so a unit toggle shows the same quantity in the new
  // unit and edits nothing (as a typed weight is kept, US-05).
  const coreCellViews = useMemo(() => {
    const views = new Map<string, CoreCellView>();
    for (const cell of matrix.cells.values()) {
      if (cell.state !== 'editable') continue;
      const metric = metricOf(cell);
      if (!metric) continue;
      const text = (editedDisplayValues[editId(cell)] ?? cell.initialDisplay).trim();
      const valueSI = savedValue(cell, text);
      const shownIn = units[metric] ?? unitSystem;
      const typedIn = touchedRef.current.get(editId(cell))?.display ?? shownIn;
      views.set(editId(cell), {
        valueSI,
        error: cellError(cell, text),
        text: !isEditedText(cell, text) ? cell.initialDisplay
          : typedIn === shownIn || valueSI === undefined || !UNIT_DEFS[metric] ? text
          : cellText(metric, valueSI, shownIn),
      });
    }
    return views;
  }, [matrix, editedDisplayValues]);
  const selectedCount = useMemo(() => saveableCells.filter(c => c.cell.kind === 'core').length, [saveableCells]);
  const selectedAdditionalCount = useMemo(() => saveableCells.filter(c => c.cell.kind === 'additional').length, [saveableCells]);
  const totalEditableCells = useMemo(() => {
    let n = 0;
    for (const cell of matrix.cells.values()) if (cell.state === 'editable') n++;
    return n;
  }, [matrix]);
  const selectedDocCount = useMemo(() => Object.values(docChecked).filter(Boolean).length, [docChecked]);
  // Original lab PDFs remain retryable after saved values become context.
  // Connector metadata-only letters also carry archive-only work (US-35 AC8).
  const archiveCount = useMemo(() => {
    const selectedDocs = new Set(results.filter((r, fi) => r.document && docChecked[fi]).map((r) => r.fileName));
    return unarchivedOriginals(results, history.documents, selectedDocs).length;
  }, [results, history.documents, docChecked]);
  const nothingSelected = selectedCount === 0 && selectedAdditionalCount === 0 && selectedDocCount === 0;

  /** The new columns Save may write on: a calendar day that has happened
   *  (US-13 AC8), and for an undated previous column one before its report's
   *  own day when that is known, so a stray "today" never dates it (US-12 AC14). */
  const datedColumns = useMemo(() => new Set(matrix.columns.filter(col => {
    const day = columnDay(col.date);
    const report = col.undated && columnDay(fileDates[col.undated.fi]);
    return day && (!report || day < report);
  }).map(col => col.dateKey)), [matrix.columns, fileDates]);

  /** What an undated column's header asks for while it has no day: a day in
   *  its printed month, before its file's report day when that is known, even
   *  when the file shows no report column (US-12 AC14). */
  const pickHints = useMemo(() => new Map(matrix.columns.flatMap(col => {
    if (!col.undated) return [];
    const { printedMonth: month } = col.undated;
    const report = columnDay(fileDates[col.undated.fi]);
    const inMonth = month ? ` in ${longDate(month)}` : '';
    const before = report ? ` before ${longDate(report)}` : '';
    return [[col.dateKey, `Pick a day${inMonth}${before}`] as const];
  })), [matrix.columns, fileDates]);

  /** A column with no date isn't saveable. Existing-history columns always
   *  have a YYYY-MM-DD date; a new (upload) column that will write a cell
   *  needs to be in `datedColumns`, so dedup against history matches exactly (a month-only
   *  upload would silently synthesise day=01) and no misread or future date
   *  is ever written: rows are append-only (US-13 AC8). A column whose cells
   *  are all cleared writes nothing and needs no date. */
  const allDatesSet = useMemo(() => {
    const writing = new Set(saveableCells.map(c => c.dateKey));
    return matrix.columns.every(col => !col.isNew || !writing.has(col.dateKey) || datedColumns.has(col.dateKey));
  }, [matrix.columns, saveableCells, datedColumns]);

  /** Column-level date editing: propagate to every contributing date source so
   *  the matrix stays consistent. New-column dates only — existing-history
   *  columns are read-only (correction goes through the live timeline). */
  const handleColumnDateChange = (col: MatrixColumn, update: Partial<FullDate>) => {
    if (!col.isNew) return;
    setFileDates(prev => {
      // An undated column's day comes before its report's: a later pick (a
      // stray "today") is refused, never written (US-12 AC14).
      const report = col.undated && columnDay(prev[col.undated.fi]);
      if (report && update.day && fullDateToIso({ ...col.date, ...update }) >= report) return prev;
      const next = { ...prev };
      for (const source of col.sources) {
        const merged: FullDate = { ...(prev[source] ?? col.date), ...update, undated: undefined };
        if (merged.day) {
          const maxDay = getDaysInMonth(merged.month, merged.year);
          if (parseInt(merged.day) > maxDay) merged.day = String(maxDay);
        }
        next[source] = merged;
      }
      return next;
    });
  };

  const handleSave = () => {
    if (hasInvalid || !allDatesSet) return;
    // Collect core lab values
    const selected: ReviewedValue[] = [];
    const selectedLabValues: ReviewedLabValue[] = [];

    // O(1) column lookup so save doesn't go quadratic on big uploads.
    const columnsByKey = new Map(matrix.columns.map(col => [col.dateKey, col]));
    // One row per (test, day). buildMatrixModel already shows one reading per
    // slot, in this same rank (US-12 AC12, AC14); this is the backstop.
    const rank = (cell: EditableMatrixCell) => {
      const day = (cell.kind === 'core' ? results[cell.fi]?.values[cell.vi] : results[cell.fi]?.additionalValues[cell.ai])?.recordedAt;
      return !day ? 0 : day === UNDATED_PREVIOUS ? 2 : 1;
    };
    const slots = new Set<string>();

    for (const c of [...saveableCells].sort((a, b) => rank(a.cell) - rank(b.cell))) {
      const col = columnsByKey.get(c.dateKey);
      if (!col) continue;
      const recordedAt = buildRecordedAt(col.date);
      const cell = c.cell;
      const slot = `${cell.kind === 'core' ? metricOf(cell) : normaliseLabName(results[cell.fi]?.additionalValues[cell.ai]?.name ?? '')}|${recordedAt}`;
      if (slots.has(slot)) continue;
      slots.add(slot);
      if (cell.kind === 'core') {
        const metric = metricOf(cell);
        if (!metric) continue;
        selected.push({
          metric,
          valueSI: c.value,
          recordedAt,
          source: c.isEdited ? 'lab_import_edited' : undefined,
          correctsId: cell.existing?.id,
        });
      } else {
        const av = results[cell.fi]?.additionalValues[cell.ai];
        if (!av) continue;
        selectedLabValues.push({
          name: av.name,
          value: c.value,
          unit: av.unit,
          referenceLow: av.referenceLow,
          referenceHigh: av.referenceHigh,
          recordedAt,
          correctsId: cell.existing?.id,
        });
      }
    }

    // Collect documents
    const documents: DocumentToSave[] = [];
    results.forEach((r, fi) => {
      if (!r.document || !docChecked[fi]) return;
      const date = fileDates[fi];
      const dateStr = date.year && date.month ? fullDateToIso(date) : null;

      const screeningType = r.document.metadata?.screeningType as string | undefined;
      const screeningKey = screeningType ? `${screeningType}_last_date` : undefined;

      documents.push({
        documentType: r.document.classification,
        title: docTitles[fi] || r.document.title,
        documentDate: dateStr,
        contentMd: r.document.contentMarkdown,
        metadata: r.document.metadata,
        sourceFileName: r.fileName,
        screeningUpdate: screeningKey && screeningChecked[fi] && dateStr
          ? { key: screeningKey, date: dateStr }
          : undefined,
        file: r.file,
      });
    });

    onSave({ values: selected, documents, labValues: selectedLabValues });
  };

  return (
    <div className="review-table">
      <div className="review-summary">
        {nothingSelected && archiveCount > 0 ? (
          `Save will archive the original PDF${archiveCount !== 1 ? 's' : ''}. No extracted values or documents are selected.`
        ) : (
          <>
            {selectedCount > 0 && `${selectedCount} value${selectedCount !== 1 ? 's' : ''}`}
            {selectedCount > 0 && selectedAdditionalCount > 0 && ' + '}
            {selectedAdditionalCount > 0 && `${selectedAdditionalCount} additional`}
            {(selectedCount > 0 || selectedAdditionalCount > 0) && selectedDocCount > 0 && ' + '}
            {selectedDocCount > 0 && `${selectedDocCount} document${selectedDocCount !== 1 ? 's' : ''}`}
            {nothingSelected && 'No items selected'}
            {' '}from {results.length} file{results.length !== 1 ? 's' : ''} · {totalEditableCells} extracted
          </>
        )}
      </div>

      {(matrix.coreRows.length > 0 || matrix.additionalRows.length > 0) && (
        <ReviewMatrix
          matrix={matrix}
          unitSystem={unitSystem}
          metricUnitOverrides={units}
          onToggleFieldUnit={onToggleFieldUnit}
          onChooseLpaUnit={chooseLpaUnit}
          grading={grading}
          editedDisplayValues={editedDisplayValues}
          coreCellViews={coreCellViews}
          onCellChange={updateEditedDisplayValue}
          onColumnDateChange={handleColumnDateChange}
          datedColumns={datedColumns}
          pickHints={pickHints}
          replaceChecked={replaceChecked}
          heldEqual={heldEqual}
          onReplaceToggle={toggleReplace}
        />
      )}

      {sortedResults.map(({ r, fi }) => {
        // After the matrix, the per-file section only renders for:
        //   - documents (scan results, clinic letters, …)
        //   - error rows (file failed to parse)
        //   - value-only files with NOTHING shown by the matrix (rare, e.g.
        //     LLM returned `values:[]` and `additionalValues:[]` — show
        //     "No values found" so the upload doesn't appear ignored).
        const hasNothingForMatrix = !r.error && !r.document && r.values.length === 0 && r.additionalValues.length === 0;
        if (!r.error && !r.document && !hasNothingForMatrix) return null;

        const date = fileDates[fi];
        const isDocDup = r.document ? isDocDuplicate(r.fileName, docHistoryIndex) : false;

        return (
          <div key={fi} className="review-file-section">
            <div className="review-file-header">
              <span className="review-file-name">{r.fileName}</span>
            </div>

            {r.error ? (
              <p className="review-file-error">Could not read this file: {r.error}</p>
            ) : r.document ? (
              <div className="review-document-card">
                <div className="review-document-header">
                  <label className="review-row-check">
                    <input
                      type="checkbox"
                      checked={docChecked[fi] ?? false}
                      onChange={(e) => setDocChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                  </label>
                  <span className={`review-doc-type-badge review-doc-type--${r.document.classification}`}>
                    {r.document.classification.replace(/_/g, ' ')}
                  </span>
                  {isDocDup && <span className="review-row-dup">Already saved</span>}
                </div>

                <div className="review-document-title">
                  <input
                    type="text"
                    value={docTitles[fi] || ''}
                    onChange={(e) => setDocTitles(prev => ({ ...prev, [fi]: e.target.value }))}
                    className="review-title-input"
                    placeholder="Document title"
                  />
                </div>

                <div className="review-file-date">
                  <span>Date:</span>
                  <DraftDateCell
                    date={fullDateToIso(date)}
                    needsDay={!date.day}
                    ariaLabel="Document date"
                    onChange={picked => {
                      const parsed = parseIsoToFullDate(picked);
                      if (parsed) setFileDates(prev => ({ ...prev, [fi]: parsed }));
                    }}
                  />
                </div>

                <div className="review-document-preview">
                  {r.document.contentMarkdown.slice(0, 300)}
                  {r.document.contentMarkdown.length > 300 && '...'}
                </div>

                {!!r.document.metadata?.screeningType && isScreeningEligible(String(r.document.metadata.screeningType), userAge, sex) && (
                  <label className="review-screening-update">
                    <input
                      type="checkbox"
                      checked={screeningChecked[fi] ?? false}
                      onChange={(e) => setScreeningChecked(prev => ({ ...prev, [fi]: e.target.checked }))}
                    />
                    <span>
                      Update <strong>{String(r.document.metadata.screeningType)}</strong> screening date
                      {r.document.documentDate ? ` to ${r.document.documentDate}` : ''}
                    </span>
                  </label>
                )}
              </div>
            ) : (
              <p className="review-no-values">No blood test values or document found in this file</p>
            )}
          </div>
        );
      })}

      {!allDatesSet && (
        <p className="review-date-hint">Pick a past day for every new column before saving, and for previous results a day before the report's — keeps the saved date precise.</p>
      )}

      {hiddenNotice && <p className="review-date-hint" role="status">{hiddenNotice}</p>}

      {hasInvalid && <p role="status">Correct or clear the values with errors before saving.</p>}
      {error && <p className="upload-error">{error}</p>}

      <div className="review-actions">
        <button
          className="btn-primary review-save-btn"
          onClick={handleSave}
          disabled={hasInvalid || (nothingSelected && archiveCount === 0) || !allDatesSet || isSaving}
        >
          {isSaving ? 'Saving...' : `Save ${[
            selectedCount > 0 && `${selectedCount} Value${selectedCount !== 1 ? 's' : ''}`,
            selectedAdditionalCount > 0 && `${selectedAdditionalCount} Additional`,
            selectedDocCount > 0 && `${selectedDocCount} Document${selectedDocCount !== 1 ? 's' : ''}`,
            archiveCount > 0 && `${archiveCount} Original${archiveCount !== 1 ? 's' : ''}`,
          ].filter(Boolean).join(' + ')}`}
        </button>
        <button className="review-cancel-btn" onClick={onCancel} disabled={isSaving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// ReviewMatrix — the metric × date grid. Uses the same .bt-* CSS as the live
// BloodTestTimeline so visual treatment stays consistent. Existing-history
// cells render greyed-out; new (LLM-extracted) cells render an editable input.
// ============================================================================

interface ReviewMatrixProps {
  matrix: ReturnType<typeof buildMatrixModel>;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, CellUnit>>;
  onToggleFieldUnit?: (field: string) => void;
  onChooseLpaUnit: (unit: LpaUnit) => void;
  grading: Grading;
  editedDisplayValues: Record<string, string>;
  coreCellViews: ReadonlyMap<string, CoreCellView>;
  onCellChange: (id: string, value: string, display?: CellUnit) => void;
  onColumnDateChange: (col: MatrixColumn, update: Partial<FullDate>) => void;
  datedColumns: ReadonlySet<DateKey>;
  pickHints: ReadonlyMap<DateKey, string>;
  replaceChecked: Record<string, boolean>;
  heldEqual: ReadonlySet<string>;
  onReplaceToggle: (key: string, on: boolean) => void;
}

function ReviewMatrix({
  matrix, unitSystem, metricUnitOverrides, onToggleFieldUnit, onChooseLpaUnit, grading,
  editedDisplayValues, coreCellViews, onCellChange, onColumnDateChange, datedColumns, pickHints, replaceChecked, heldEqual, onReplaceToggle,
}: ReviewMatrixProps) {
  const scrollSync = useMatrixScrollSync(matrix.columns.length);

  return (
    <div className="bt-timeline review-matrix">
      <div className="bt-timeline-body">
        <div className="bt-row bt-header-row">
          <div className="bt-cell-name bt-cell-header">METRIC</div>
          <div ref={scrollSync.registerHeader} onScroll={scrollSync.onScroll} className="bt-cell-strip">
            <div className="bt-strip-inner">
              {matrix.columns.map(col => (
                <MatrixColumnHeader key={col.dateKey} col={col} set={datedColumns.has(col.dateKey)} hint={pickHints.get(col.dateKey)} onDateChange={onColumnDateChange} />
              ))}
              <div className="bt-strip-spacer"/>
            </div>
          </div>
        </div>

        {matrix.coreRows.map((row, rowIdx) => (
          <MatrixRowView
            key={row.metric}
            row={row}
            rowIdx={rowIdx}
            columns={matrix.columns}
            cells={matrix.cells}
            unitSystem={unitSystem}
            metricUnitOverrides={metricUnitOverrides}
            onToggleFieldUnit={onToggleFieldUnit}
            onChooseLpaUnit={onChooseLpaUnit}
            grading={grading}
            scrollSync={scrollSync}
            editedDisplayValues={editedDisplayValues}
            coreCellViews={coreCellViews}
            onCellChange={onCellChange}
            replaceChecked={replaceChecked}
          heldEqual={heldEqual}
            onReplaceToggle={onReplaceToggle}
          />
        ))}

        {matrix.additionalRows.length > 0 && (
          <>
            <div className="bt-section-divider">Additional Lab Values</div>
            {matrix.additionalRows.map((row, i) => (
              <MatrixRowView
                key={row.nameKey}
                row={row}
                rowIdx={matrix.coreRows.length + i}
                columns={matrix.columns}
                cells={matrix.cells}
                unitSystem={unitSystem}
                metricUnitOverrides={metricUnitOverrides}
                onToggleFieldUnit={onToggleFieldUnit}
                onChooseLpaUnit={onChooseLpaUnit}
                grading={grading}
                scrollSync={scrollSync}
                editedDisplayValues={editedDisplayValues}
                coreCellViews={coreCellViews}
                onCellChange={onCellChange}
                replaceChecked={replaceChecked}
          heldEqual={heldEqual}
                onReplaceToggle={onReplaceToggle}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** Column header — shows the date. New (upload) columns render an editable
 *  date picker so the user can fix LLM-misread dates; existing-history
 *  columns are read-only (correction goes through the live timeline). */
function MatrixColumnHeader({ col, set, hint, onDateChange }: { col: MatrixColumn; set: boolean; hint?: string; onDateChange: (col: MatrixColumn, update: Partial<FullDate>) => void }) {
  if (!col.isNew) {
    return (
      <div className="bt-cell-value bt-cell-context bt-cell-date">
        <span className="bt-value-num num">{formatColumnDate(col.date)}</span>
      </div>
    );
  }
  const onChange = (picked: string) => {
    const parsed = parseIsoToFullDate(picked);
    if (parsed) onDateChange(col, parsed);
  };
  // A column with no past day yet (US-13 AC8) opens an empty picker; an
  // undated previous column (US-12 AC14) names its limits (`pickHints`).
  return (
    <DraftDateCell
      date={col.date.undated ? '' : fullDateToIso(col.date)}
      needsDay={!set}
      placeholder={hint}
      ariaLabel={col.undated ? 'Choose the date of the previous results' : 'Choose column date'}
      onChange={onChange}
    />
  );
}

function formatColumnDate(date: FullDate): string {
  const yy = date.year.slice(-2);
  return date.day ? `${date.day} ${monthLabel(date.month)} '${yy}` : `${monthLabel(date.month)} '${yy}`;
}

interface MatrixRowViewProps {
  row: MatrixRow;
  rowIdx: number;
  columns: MatrixColumn[];
  cells: Map<string, MatrixCell>;
  unitSystem: UnitSystem;
  metricUnitOverrides?: Partial<Record<MetricType, CellUnit>>;
  onToggleFieldUnit?: (field: string) => void;
  onChooseLpaUnit: (unit: LpaUnit) => void;
  grading: Grading;
  scrollSync: ReturnType<typeof useMatrixScrollSync>;
  editedDisplayValues: Record<string, string>;
  coreCellViews: ReadonlyMap<string, CoreCellView>;
  onCellChange: (id: string, value: string, display?: CellUnit) => void;
  replaceChecked: Record<string, boolean>;
  heldEqual: ReadonlySet<string>;
  onReplaceToggle: (key: string, on: boolean) => void;
}

function MatrixRowView({
  row, rowIdx, columns, cells, unitSystem, metricUnitOverrides, onToggleFieldUnit, onChooseLpaUnit,
  grading, scrollSync, editedDisplayValues, coreCellViews, onCellChange, replaceChecked, heldEqual, onReplaceToggle,
}: MatrixRowViewProps) {
  const rowKey = matrixRowKey(row);
  const rowDisplay = row.kind === 'core' ? (metricUnitOverrides?.[row.metric] ?? unitSystem) : unitSystem;
  const { label, unitLabel, refLabel } = describeRow(row, rowDisplay, grading);
  // A fixed unit (mmHg, PSA's ng/mL) gets a static chip, not a toggle that does nothing.
  const toggleUnit = row.kind === 'core' && onToggleFieldUnit && hasUnitChoice(row.metric)
    ? () => onToggleFieldUnit(METRIC_TO_FIELD[row.metric])
    : undefined;

  return (
    <div className="bt-row">
      <div className="bt-cell-name">
        <div className="bt-name-label">{label}</div>
        {row.kind === 'core' && row.metric === 'lpa'
          ? <LpaUnitControl unit={rowDisplay as LpaUnit} onChange={onChooseLpaUnit}/>
          : unitLabel && <UnitChip label={unitLabel} onToggle={toggleUnit}/>}
        {refLabel && <div className="bt-ref-label">{refLabel}</div>}
      </div>
      <div ref={el => scrollSync.registerRow(rowIdx, el)} onScroll={scrollSync.onScroll} className="bt-cell-strip">
        <div className="bt-strip-inner">
          {columns.map(col => {
            const cell = cells.get(matrixCellKey(rowKey, col.dateKey)) ?? { state: 'empty' as const };
            const id = cell.state === 'editable' ? editId(cell) : '';
            return (
              <MatrixCellView
                key={col.dateKey}
                cell={cell}
                row={row}
                unitSystem={rowDisplay}
                grading={grading}
                editedValue={coreCellViews.get(id)?.text ?? editedDisplayValues[id] ?? ''}
                valueSI={coreCellViews.get(id)?.valueSI}
                validationError={coreCellViews.get(id)?.error}
                onCellChange={onCellChange}
                replace={cell.state === 'editable' && !!cell.existing && !!replaceChecked[replaceKey(cell, cell.existing)]}
                alreadySaved={heldEqual.has(id)}
                onReplaceToggle={onReplaceToggle}
              />
            );
          })}
          <div className="bt-strip-spacer"/>
        </div>
      </div>
    </div>
  );
}

/** Row label + unit chip + reference range. Core rows pull from UNIT_DEFS /
 *  METRIC_LABELS / getDisplayLabel; additional rows use the LLM-extracted
 *  unit and (if present) a reference range. Caller passes the resolved
 *  display unit (already honours per-metric overrides). */
function describeRow(row: MatrixRow, display: CellUnit, grading: Grading): { label: string; unitLabel: string | null; refLabel: string | null } {
  if (row.kind === 'core') {
    const label = METRIC_LABELS[row.metric] || row.metric;
    const unitLabel = UNIT_DEFS[row.metric] ? cellLabel(row.metric, display) : null;
    // Same reference-range hint InputPanel + BloodTestTimeline show so
    // users have the same context when reviewing as when reading the
    // live timeline, and withheld from a known minor there too (US-07 AC6).
    const refLabel = cellHint(row.metric, display, grading);
    return { label, unitLabel, refLabel };
  }
  const refLabel = (row.referenceLow != null || row.referenceHigh != null)
    ? `Ref: ${row.referenceLow ?? '–'}–${row.referenceHigh ?? '–'}`
    : null;
  return { label: row.displayName, unitLabel: row.unit, refLabel };
}

interface MatrixCellViewProps {
  cell: MatrixCell;
  row: MatrixRow;
  unitSystem: CellUnit;
  grading: Grading;
  editedValue: string;
  /** The value a core cell saves, which its colour grades (US-13 AC4). */
  valueSI?: number;
  validationError?: string | null;
  /** Keyed by `editId`. */
  onCellChange: (id: string, value: string, display?: CellUnit) => void;
  replace: boolean;
  /** The value as now typed is the saved row's: no Replace is offered. */
  alreadySaved: boolean;
  /** Keyed by `replaceKey`. */
  onReplaceToggle: (key: string, on: boolean) => void;
}

const MatrixCellView = memo(function MatrixCellView({
  cell, row, unitSystem, grading, editedValue, valueSI, validationError, onCellChange, replace, alreadySaved, onReplaceToggle,
}: MatrixCellViewProps) {
  if (cell.state === 'empty') {
    // NBSP keeps :empty from matching — the theme has a global
    // `div:empty { display: none }` (specificity beats .bt-cell-empty).
    return <div className="bt-cell-value bt-cell-empty">{' '}</div>;
  }
  // Rows merge by slot key (US-35 AC6), so one lab row can hold readings in
  // different units: a cell whose unit is not its row's says its own.
  const showUnit = (unit?: string): unit is string => row.kind === 'additional' && !!unit && unit !== row.unit;
  const unitNote = (unit?: string) => showUnit(unit) && <span className="bt-cell-unit">{unit}</span>;
  const withUnitText = (text: string, unit?: string) => (showUnit(unit) ? `${text} ${unit}` : text);
  if (cell.state === 'context') {
    return (
      <div className="bt-cell-value bt-cell-context" title="Already saved at this date">
        <span className="bt-value-num num">{cell.displayValue}</span>
        {unitNote(cell.displayUnit)}
      </div>
    );
  }
  const isCore = cell.kind === 'core';
  // Stamp the row's display unit so a toggle-after-typing doesn't
  // misconvert the typed value at save time.
  const handleChange = (v: string) => onCellChange(editId(cell), v, isCore ? unitSystem : undefined);
  // A guessed unit (medium) and a doubtful read (low) both ask to be checked (US-21 AC18).
  const lowConfClass = isCore && cell.confidence !== 'high' ? ' bt-cell-low-confidence' : '';
  let storedText: string | null = null;
  if (cell.kind === 'additional') {
    // What Save stores for a catalogued test printed in another unit: the write's
    // own canonicalLabRow on the number as it now reads, so a row the write
    // refuses (a count off its range's scale) previews nothing (US-21 AC18).
    const entry = resolveLabCatalogEntry(cell.lab.name);
    const typed = entry ? parseLocalisedNumber(editedValue) : undefined;
    const row = entry && typed !== undefined
      ? canonicalLabRow(entry, { value: typed, unit: cell.lab.unit, referenceLow: cell.referenceLow, referenceHigh: cell.referenceHigh })
      : null;
    if (row && row.factor !== 1) storedText = `${row.stored.value} ${row.stored.unit}`;
  }

  const input = isCore ? (
    <NumericInputCell
      metric={matrixRowKey(row) as MetricType}
      display={unitSystem}
      grading={grading}
      value={editedValue}
      valueSI={valueSI}
      validationResult={validationError}
      onChange={handleChange}
      wrapperClass={`bt-cell-input bt-cell-review${lowConfClass}`}
      note={cell.question && <span className="bt-cell-question">{cell.question}</span>}
    />
  ) : (
    <NumericInputCell
      value={editedValue}
      onChange={handleChange}
      wrapperClass="bt-cell-input bt-cell-review"
      ariaLabel={withUnitText(`${rowName(row)} value`, cell.displayUnit) + (storedText ? `, saved as ${storedText}` : '')}
      note={<>{unitNote(cell.displayUnit)}{storedText && <span className="bt-cell-si">→ {storedText}</span>}</>}
    />
  );

  if (!cell.existing) return input;
  const oldText = withUnitText(cell.existing.display, cell.existing.displayUnit);
  const newText = withUnitText(editedValue || 'the uploaded value', cell.displayUnit);
  // A screen reader hears both units whenever they differ, even when the saved one is the row's.
  const unitsDiffer = !isCore && !!cell.existing.displayUnit && cell.existing.displayUnit !== cell.displayUnit;
  const heardOld = unitsDiffer ? `${cell.existing.display} ${cell.existing.displayUnit}` : oldText;
  const heardNew = unitsDiffer ? `${editedValue || 'the uploaded value'} ${cell.displayUnit}` : newText;

  // Slot already holds a different saved value. Show it, show the file's, and
  // let the user assert the replacement. Layout lives in styles.css.
  return (
    <div className="bt-cell-conflict">
      <span className="bt-value-num num bt-cell-conflict-old">{oldText}</span>
      {input}
      {!alreadySaved && <label className="bt-cell-conflict-replace">
        <input
          type="checkbox"
          checked={replace}
          onChange={(e) => onReplaceToggle(replaceKey(cell, cell.existing!), e.target.checked)}
          aria-label={`Replace the saved ${rowName(row)} value ${heardOld} with ${heardNew}`}
        />
        <span aria-hidden="true">Replace</span>
      </label>}
    </div>
  );
});
