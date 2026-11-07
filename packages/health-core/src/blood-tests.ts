/**
 * Every blood test lives in `labValues` (US-66). The nine tests the plan reads
 * are core rows there: `core: true`, the core key as `metricName`, the
 * `CORE_BLOOD_UNITS` unit. `measurements` keeps the vitals.
 *
 * Records written before this held core tests in `measurements`. `migrateFile`
 * moves them on every read (`moveBloodMeasurements`, a pure field rename) and
 * folds old lab rows named like a core test into core values
 * (`foldLegacyCoreRows`). Readers take core values from `bloodTestRows` only.
 * Design: docs/drafts/one-blood-test-table.md §3 to §8.
 */
import { CORE_SUFFIX, isBloodTestKey, isCoreRow, isFoldRow, labRowSlot, v2FormOf } from './core-rows';
import { resolveCoreMetricName } from './lab-extraction';
import { dayOf, rowIsNewer } from './merge';
import { measurementValueFault } from './record-edits';
import { CORE_BLOOD_UNITS, createLabValue, type FileLabValue, type FileMeasurement, type RoadmapFile } from './roadmap-file';
import { reportedToCanonical, type MetricType } from './units';

export { isBloodTestKey, isCoreRow, labRowSlot };

/** Brad 2026-11-02: an old row named "creatinine" may be urine (US-12 AC11), so it is not folded. */
export const FOLD_CREATININE = false;

/** The core blood test a printed name is, or null. Never a vital: weight, waist, BP and height are not blood tests. */
export function bloodTestKeyOf(name: string): MetricType | null {
  const metric = resolveCoreMetricName(name);
  return isBloodTestKey(metric) ? metric : null;
}

/**
 * A printed number, unit and range as a core row stores them: converted by
 * `UNIT_DEFS` (same-scale spellings and Lp(a)'s average factor included), the
 * bounds alike, a null bound kept null. Null when the unit does not convert.
 * The range check is the caller's: it reads the value only.
 */
export function coreStored(
  metric: MetricType, value: number, unit: string, referenceLow?: number | null, referenceHigh?: number | null,
): Pick<FileLabValue, 'value' | 'unit' | 'referenceLow' | 'referenceHigh'> | null {
  const si = (n: number) => reportedToCanonical(metric, n, unit)?.valueSI;
  const valueSI = si(value);
  if (valueSI === undefined) return null;
  const bound = (n: number | null | undefined) => (n == null ? null : si(n) ?? null);
  return { value: valueSI, unit: CORE_BLOOD_UNITS[metric], referenceLow: bound(referenceLow), referenceHigh: bound(referenceHigh) };
}

/** A core row, with the standard defaults `createLabValue` fills in. */
export function createCoreRow(
  fields: Pick<FileLabValue, 'id' | 'value' | 'recordedAt' | 'createdAt'> & { metric: string }
    & Partial<Pick<FileLabValue, 'referenceLow' | 'referenceHigh' | 'source' | 'status' | 'correctsId' | 'comparator'>>,
): FileLabValue {
  const { metric, ...rest } = fields;
  return { ...createLabValue({ ...rest, metricName: metric, unit: CORE_BLOOD_UNITS[metric] }), core: true };
}

/** A field the move would write: a measurement that already has one is left where it is (US-66 AC2). */
const LAB_FIELDS = ['metricName', 'unit', 'referenceLow', 'referenceHigh', 'core'];

function movable(row: FileMeasurement): boolean {
  return isBloodTestKey(row.metricType) && !LAB_FIELDS.some((field) => field in row);
}

/**
 * US-66 AC2: every measurement with a blood-test `metricType` becomes a core
 * lab row. A pure field rename: every other field, `externalId: null`
 * included, is kept verbatim, so `v2FormOf` gives back the old bytes. The
 * move reads only `metricType`, so an unreadable row (US-65) moves too. A row
 * that already carries a lab field stays, hidden as unreadable. Idempotent;
 * with nothing to move it returns the arrays it was given.
 */
export function moveBloodMeasurements(
  measurements: FileMeasurement[], labValues: FileLabValue[],
): { measurements: FileMeasurement[]; labValues: FileLabValue[] } {
  if (!measurements.some(movable)) return { measurements, labValues };
  const moved = measurements.filter(movable).map(({ metricType, ...rest }): FileLabValue => ({
    ...rest, metricName: metricType, unit: CORE_BLOOD_UNITS[metricType], referenceLow: null, referenceHigh: null, core: true,
  }));
  return { measurements: measurements.filter((row) => !movable(row)), labValues: [...labValues, ...moved] };
}

/** The fold an old core-named row gets, or null when it stays an extra row (US-66 AC5). */
function foldOf(row: FileLabValue): FileLabValue | null {
  if (row.status !== 'active' || row.core === true || typeof row.metricName !== 'string'
    || typeof row.value !== 'number' || typeof row.unit !== 'string') return null;
  const bounds = [row.referenceLow, row.referenceHigh];
  if (!bounds.every((n) => n == null || (typeof n === 'number' && Number.isFinite(n)))) return null;
  const metric = bloodTestKeyOf(row.metricName);
  if (!metric || (metric === 'creatinine' && !FOLD_CREATININE)) return null;
  const stored = coreStored(metric, row.value, row.unit, row.referenceLow, row.referenceHigh);
  if (!stored || measurementValueFault(metric, stored.value)) return null;
  return { ...row, ...stored, id: `${row.id}${CORE_SUFFIX}`, metricName: metric, core: true, status: 'active', correctsId: row.id };
}

const slotOn = (row: FileLabValue) => `${labRowSlot(row)}@${dayOf(row.recordedAt)}`;

/**
 * US-66 AC5 (Brad D1): every active lab row whose name is a core test, whose
 * unit converts and whose converted value is in range, is corrected into a
 * core value: `<id>#core` appended with `correctsId`, the printed row flipped.
 * A real core value beats a fold, so a fold on a day that already holds one is
 * born `entered-in-error`; between folds for one day the newer `createdAt`,
 * then id, stays active. Idempotent; with nothing to fold it returns `rows`.
 */
export function foldLegacyCoreRows(rows: FileLabValue[]): FileLabValue[] {
  const ids = new Set(rows.map((row) => row.id));
  const folds = new Map<FileLabValue, FileLabValue>();
  for (const row of rows) {
    const fold = foldOf(row);
    if (fold && !ids.has(fold.id)) folds.set(row, fold);
  }
  if (folds.size === 0) return rows;
  const held = new Set(rows.filter((row) => row.status === 'active' && isCoreRow(row)).map(slotOn));
  const winners = new Map<string, FileLabValue>();
  for (const fold of folds.values()) {
    const slot = slotOn(fold);
    const winner = winners.get(slot);
    if (!held.has(slot) && (!winner || rowIsNewer(fold, winner))) winners.set(slot, fold);
  }
  return rows.flatMap((row) => {
    const fold = folds.get(row);
    if (!fold) return [row];
    const status = winners.get(slotOn(fold)) === fold ? 'active' : 'entered-in-error';
    return [{ ...row, status: 'entered-in-error' }, { ...fold, status }];
  });
}

/** A row with no status reads as active (US-65 AC1), as `latestActivePerMetric` reads it. */
export const isActive = (row: { status?: string }) => row.status === undefined || row.status === 'active';

/**
 * The core values every reader counts (US-66 AC7): active core rows in their
 * core unit, shaped as measurements for `latestActivePerMetric` and
 * `measurementsToInputs`. Any other row counts nowhere.
 */
export function bloodTestRows(file: Pick<RoadmapFile, 'labValues'>): Array<FileLabValue & { metricType: string }> {
  return file.labValues
    .filter((row) => isActive(row) && isCoreRow(row) && row.unit === CORE_BLOOD_UNITS[row.metricName])
    .map((row) => ({ ...row, metricType: row.metricName }));
}

/** The active vitals, plus the core values as measurements: what the plan and reminders read (US-66 AC7). */
export function currentValueRows(file: Pick<RoadmapFile, 'measurements' | 'labValues'>): Array<FileMeasurement | (FileLabValue & { metricType: string })> {
  // A blood row the move refused is unreadable (US-66 AC2) and counts nowhere. One it
  // would move still counts, so a caller holding an unmigrated record reads what migrate gives.
  const stuck = (m: FileMeasurement) => isBloodTestKey(m.metricType) && !movable(m);
  return [...file.measurements.filter((m) => isActive(m) && !stuck(m)), ...bloodTestRows(file)];
}

/**
 * The exact inverse of the move (US-66 AC14): every core row in the moved
 * shape, a fold excepted, back in `measurements`. Shipped tested and unused,
 * the emergency path if a fix forward is impossible.
 */
export function toOldShape(file: RoadmapFile): RoadmapFile {
  const back = (row: FileLabValue) => !isFoldRow(row) && v2FormOf(row) !== row;
  return {
    ...file,
    measurements: [...file.measurements, ...file.labValues.filter(back).map((row) => v2FormOf(row) as FileMeasurement)],
    labValues: file.labValues.filter((row) => !back(row)),
  };
}

/** The usage counts (US-66 AC13), each capped; never a name or a value. */
const REPORT_CAP = 1000;

/**
 * What a migration did to one record, for `blood_tests_unified` (US-66 AC13):
 * `before` the stored bytes as read, `after` the migrated record.
 * `keptApart` counts old core-named rows that could not fold.
 */
export function bloodTableReport(
  before: Pick<RoadmapFile, 'measurements' | 'labValues'>, after: Pick<RoadmapFile, 'labValues'>,
): { moved: number; folded: number; keptApart: number } {
  const cap = (n: number) => Math.min(n, REPORT_CAP);
  const afterIds = new Set(after.labValues.map((row) => row.id));
  const beforeIds = new Set(before.labValues.map((row) => row.id));
  return {
    moved: cap(before.measurements.filter((row) => isBloodTestKey(row.metricType) && afterIds.has(row.id)).length),
    folded: cap(after.labValues.filter((row) => isFoldRow(row) && !beforeIds.has(row.id)).length),
    keptApart: cap(after.labValues.filter((row) => row.status === 'active' && row.core !== true
      && typeof row.metricName === 'string' && bloodTestKeyOf(row.metricName)).length),
  };
}
