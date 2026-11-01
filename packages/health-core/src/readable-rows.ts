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
import { MEDICATION_KEYS, METRIC_TYPES } from './validation';
import { LPA_UNITS } from './units';
import { ALCOHOL_ANSWERS } from './types';
import type { RoadmapFile } from './roadmap-file';

type Row = Record<string, unknown>;

const METRICS: ReadonlySet<unknown> = new Set(METRIC_TYPES);
const MEDICATIONS: ReadonlySet<unknown> = new Set(MEDICATION_KEYS);
const isNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
/** Absent, null, or of the type readers expect. */
const opt = (test: (v: unknown) => boolean) => (v: unknown) => v === undefined || v === null || test(v);
const optString = opt((v) => typeof v === 'string');
const optNumber = opt(isNumber);

const medication = (r: Row) => MEDICATIONS.has(r.medicationKey) && optString(r.drugName) && optNumber(r.doseValue) && optString(r.doseUnit);
const supplement = (r: Row) => typeof r.supplementKey === 'string' && optString(r.supplementName) && optNumber(r.doseValue) && optString(r.doseUnit) && optString(r.status);

/** The arrays readers skip rows in, and each one's test. Migrate already
 *  guarantees an object with a string id, and a clinical day where one is due. */
const ROWS = {
  measurements: (r: Row) => METRICS.has(r.metricType) && isNumber(r.value) && optString(r.status) && optString(r.createdAt),
  labValues: (r: Row) => typeof r.metricName === 'string' && isNumber(r.value) && optString(r.unit)
    && optNumber(r.referenceLow) && optNumber(r.referenceHigh) && optString(r.status) && optString(r.createdAt),
  medications: medication,
  medicationHistory: medication,
  supplements: supplement,
  supplementHistory: supplement,
  documents: (r: Row) => optString(r.title) && optString(r.extractedText) && optString(r.date),
} as const;

const oneOf = (words: readonly unknown[]) => opt((v) => words.includes(v));

/** The profile fields readers use, and each one's test. */
const PROFILE: Record<string, (v: unknown) => boolean> = {
  sex: oneOf(['male', 'female']),
  birthYear: optNumber,
  birthMonth: optNumber,
  heightCm: optNumber,
  unitSystem: oneOf(['si', 'conventional']),
  unitOverrides: opt((v) => typeof v === 'object' && !Array.isArray(v)),
  lpaUnit: oneOf(LPA_UNITS),
  reportEmailCaptured: opt((v) => typeof v === 'boolean'),
  alcohol: oneOf(ALCOHOL_ANSWERS),
};

export interface ReadableView {
  /** The record as readers see it: unreadable rows left out, unreadable profile fields absent. */
  file: RoadmapFile;
  /** How many rows and profile fields were left out. */
  count: number;
}

const views = new WeakMap<RoadmapFile, ReadableView>();

/** The readers' view of a record, computed once per record object. The record
 *  itself when everything in it is readable. A view's own view is itself, with
 *  the same count, so a reader handed the view still knows what was left out. */
export function readableView(file: RoadmapFile): ReadableView {
  const seen = views.get(file);
  if (seen) return seen;
  let count = 0;
  const out: Record<string, unknown> = { ...file };
  for (const [key, readable] of Object.entries(ROWS)) {
    const rows = file[key as keyof typeof ROWS] as unknown as Row[];
    const kept = rows.filter((row) => readable(row));
    if (kept.length !== rows.length) [count, out[key]] = [count + rows.length - kept.length, kept];
  }
  const profile = file.profile as unknown as Row;
  const bad = Object.keys(PROFILE).filter((field) => !PROFILE[field](profile[field]));
  if (bad.length > 0) {
    count += bad.length;
    out.profile = Object.fromEntries(Object.entries(profile).filter(([field]) => !bad.includes(field)));
  }
  const view = { file: count === 0 ? file : (out as unknown as RoadmapFile), count };
  views.set(file, view);
  views.set(view.file, view);
  return view;
}

/** The one line that tells the person, web and iPhone alike (US-65 AC4). */
export function unreadableNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 entry in your record could not be read, so it is kept unchanged and not shown.'
    : `${count} entries in your record could not be read, so they are kept unchanged and not shown.`;
}
