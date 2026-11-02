/**
 * US-65 (Brad 2026-11-01): what this build can read in a record. A row or a
 * profile field it cannot read STAYS IN THE FILE, where every build, older
 * ones included, merges, erases and corrects it as before. Only readers skip
 * it: screens, the plan, prefill and the agent read tools take
 * `readableView(file).file`; writers and the merge take the record itself.
 *
 * Unreadable means a reader would crash on it or could not interpret it: a
 * metric or medication key this build does not know, or a wrong type on a
 * field a reader uses. A missing optional field, a missing `status` (read as
 * active), a `source: null` or a `metadata: null` stays readable, as it was.
 * Hand-written checks, not Zod: this runs over every row on every read.
 */
import { BLOOD_TEST_METRICS } from './mappings';
import { MEDICATION_KEYS, METRIC_TYPES } from './validation';
import { LPA_UNITS, UNIT_SYSTEMS } from './units';
import { ALCOHOL_ANSWERS, isSex } from './types';
import type { RoadmapFile } from './roadmap-file';

type Row = Record<string, unknown>;

/** A blood test left in `measurements` is one the move could not rename (US-66 AC2): unreadable. */
const METRICS: ReadonlySet<unknown> = new Set(METRIC_TYPES.filter((metric) => !BLOOD_TEST_METRICS.includes(metric)));
const MEDICATIONS: ReadonlySet<unknown> = new Set(MEDICATION_KEYS);
const isNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Absent, null, or of the type readers expect. */
const opt = (test: (v: unknown) => boolean) => (v: unknown) => v === undefined || v === null || test(v);
const optString = opt((v) => typeof v === 'string');
const optNumber = opt(isNumber);
const oneOf = (words: readonly unknown[]) => opt((v) => words.includes(v));
const strings = (r: Row, fields: readonly string[]) => fields.every((field) => optString(r[field]));

const medication = (r: Row) => MEDICATIONS.has(r.medicationKey) && strings(r, ['drugName', 'doseUnit', 'changeType', 'updatedAt'])
  && optNumber(r.doseValue);
const supplement = (r: Row) => typeof r.supplementKey === 'string'
  && strings(r, ['supplementName', 'doseUnit', 'status', 'startedAt', 'changeType', 'updatedAt']) && optNumber(r.doseValue);

/** The arrays readers skip rows in, and each one's test. Migrate already
 *  guarantees an object with a string id, and a clinical day where one is due. */
const ROWS = {
  measurements: (r: Row) => METRICS.has(r.metricType) && isNumber(r.value)
    && strings(r, ['status', 'createdAt', 'source', 'correctsId', 'externalId']),
  labValues: (r: Row) => typeof r.metricName === 'string' && isNumber(r.value) && optNumber(r.referenceLow) && optNumber(r.referenceHigh)
    && strings(r, ['unit', 'status', 'createdAt', 'source', 'correctsId']),
  medications: medication,
  medicationHistory: medication,
  supplements: supplement,
  supplementHistory: supplement,
  // Every field a reader renders: a number or an object in any of them reached React as a child.
  documents: (r: Row) => strings(r, ['title', 'type', 'date', 'fileRef', 'contentHash', 'mimeType', 'extractedText', 'addedAt', 'sourceFileName'])
    && opt(isObject)(r.metadata) && opt((v) => typeof v === 'boolean')(r.deleted),
} as const;

export type RowArray = keyof typeof ROWS;
const ROW_ARRAYS = Object.keys(ROWS) as RowArray[];

/** The profile fields readers use, and each one's test. */
const PROFILE: Record<string, (v: unknown) => boolean> = {
  sex: opt(isSex),
  birthYear: optNumber,
  birthMonth: optNumber,
  heightCm: optNumber,
  unitSystem: oneOf(UNIT_SYSTEMS),
  unitOverrides: opt(isObject),
  lpaUnit: oneOf(LPA_UNITS),
  reportEmailCaptured: opt((v) => typeof v === 'boolean'),
  alcohol: oneOf(ALCOHOL_ANSWERS),
};
const PROFILE_FIELDS = Object.keys(PROFILE);

/** Whether a reader can read this row of this array (US-65). */
export function isReadableRow(key: RowArray, row: unknown): boolean {
  return isObject(row) && ROWS[key](row as Row);
}

/** Whether a reader would show this row at all: a corrected or deleted one it would
 *  not, so it never keeps the line alive (US-65 AC4). */
function shown(row: Row): boolean {
  return row.status !== 'entered-in-error' && row.deleted !== true;
}

export interface ReadableView {
  /** The record as readers see it: unreadable rows left out, unreadable profile fields absent. */
  file: RoadmapFile;
  /** How many unreadable rows a reader would have shown, plus unreadable profile fields. */
  count: number;
}

/** The view, with what it was computed from: an edit that pushes a row in place
 *  (the web's document commit does) changes a length, and the view is made again. */
interface Cached { lengths: number[]; profile: unknown; view: ReadableView }
const views = new WeakMap<RoadmapFile, Cached>();

/** The readers' view of a record. The record itself, with no copy, when every
 *  entry in it is readable. A view's own view is itself, with the same count, so
 *  a reader handed the view still knows what was left out. */
export function readableView(file: RoadmapFile): ReadableView {
  const lengths = ROW_ARRAYS.map((key) => file[key].length);
  const seen = views.get(file);
  if (seen && seen.profile === file.profile && seen.lengths.every((n, i) => n === lengths[i])) return seen.view;

  const profile = file.profile as unknown as Row;
  const badFields = PROFILE_FIELDS.filter((field) => !PROFILE[field](profile[field]));
  const badArrays = ROW_ARRAYS.filter((key) => !(file[key] as unknown as Row[]).every((row) => ROWS[key](row)));
  let view: ReadableView = { file, count: 0 };
  if (badFields.length > 0 || badArrays.length > 0) {
    let count = badFields.length;
    const out: Record<string, unknown> = { ...file };
    for (const key of badArrays) {
      const rows = file[key] as unknown as Row[];
      out[key] = rows.filter((row) => {
        if (ROWS[key](row)) return true;
        if (shown(row)) count++;
        return false;
      });
    }
    if (badFields.length > 0) out.profile = Object.fromEntries(Object.entries(profile).filter(([field]) => !badFields.includes(field)));
    view = { file: out as unknown as RoadmapFile, count };
    views.set(view.file, { lengths: ROW_ARRAYS.map((key) => view.file[key].length), profile: view.file.profile, view });
  }
  views.set(file, { lengths, profile: file.profile, view });
  return view;
}

/** The one line that tells the person, web and iPhone alike (US-65 AC4). */
export function unreadableNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 entry in your record could not be read, so it is kept unchanged and not shown.'
    : `${count} entries in your record could not be read, so they are kept unchanged and not shown.`;
}
