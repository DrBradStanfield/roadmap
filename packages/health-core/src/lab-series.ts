/**
 * US-21 phase 1 — pure grouping/series logic for surfacing stored
 * `labValues` (beyond the core 8 matrix): the web's tables and phone rows,
 * and the iPhone's My data rows (US-25 AC17). Moved here unchanged from the
 * widget (lab-rows.ts, lab-value-labels.ts, blood-test-cell.ts) so both apps
 * group, name and print a lab test one way.
 * Read-only: no editing, no unit conversion — values render as-reported
 * (see decisions in docs/user-stories.md § US-21).
 */
import { LAB_GROUPS, LAB_PLAUSIBLE_RANGES, labSlotKey, labUnitRefusalNote, labUnitTaken, resolveLabCatalogEntry, displayLabUnit, type CountFault, type LabGroup, type LabGroupId } from './lab-catalog';
import { trendWindow } from './recent-trend';
import { rowTarget } from './row-target';
import { comparatorOf, limitText, type Comparator } from './lab-limits';
import { compareReadings } from './measurement-history';

/** A lab test's name for display: its catalogue label, else the snake_case name title-cased. */
export function labValueLabel(metricName: string): string {
  return resolveLabCatalogEntry(metricName)?.label
    ?? metricName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * What a person reads when the record refused a lab value's unit: the unit a
 * catalogued test is stored in, or, for a unit it does take, that the number was
 * refused, and a note on what to look for instead, where there is one (US-21 AC15). Never the store's
 * message, which is the copy an assistant reads.
 */
export function labUnitRefusalLine(key: string, unit: string, fault?: CountFault, bound?: 'above' | 'below'): string {
  const entry = resolveLabCatalogEntry(key);
  const implausible = fault === 'implausible' ? labPlausibleNote(key, bound) : undefined;
  if (entry && implausible) return `${entry.label}: ${implausible}`;
  const note = labUnitRefusalNote(entry, unit, fault);
  if (fault === 'scale') return `${labValueLabel(key)}: ${note}.`;
  if (fault === 'ceiling') return `${note}.`;
  const takes = entry ? ` This test takes ${entry.unit}.` : '';
  const lead = labUnitTaken(entry, unit)
    ? `${labValueLabel(key)}: the number was not saved.`
    : !unit.trim()
      ? `${labValueLabel(key)}: no unit was printed, so it was not saved.${takes}`
      : `${labValueLabel(key)}: unit not recognised (${unit}). It was not saved.${takes}`;
  return note ? `${lead} ${note}.` : lead;
}

/** Why an uploaded value past its plausible range was refused (US-21 AC26), after its test's label:
 *  the end it passed, never the number. Undefined for a test without that bound. */
export function labPlausibleNote(key: string, bound?: 'above' | 'below'): string | undefined {
  const entry = resolveLabCatalogEntry(key);
  const range = entry && bound ? LAB_PLAUSIBLE_RANGES[entry.key] : undefined;
  if (!entry || !range) return undefined;
  return `a value ${bound} ${labNumberText(bound === 'above' ? range.max : range.min)} ${entry.unit} is almost certainly a misread number or unit, so it was not saved. Check the report.`;
}

/** Why a lab test's history draws no line: its reports used more than one unit (US-21 AC3a).
 *  `units` in the order met, oldest report first; an empty one reads "no unit". */
export function mixedUnitsNote(units: string[]): string {
  return `Units vary between reports (${units.map((u) => u || 'no unit').join(', ')}), so this test is not charted.`;
}

/** A lab value as the matrix shows it: up to two decimals, no trailing zeros;
 *  below 0.1, two significant figures, so a suppressed TSH of 0.004 never
 *  prints "0" (US-21 AC25). */
export function formatLabValue(v: number): string {
  const size = Math.abs(v);
  if (size >= 0.1 || size === 0 || !Number.isFinite(size)) return String(Math.round(v * 100) / 100);
  // toFixed throws past 100 digits, and a reader takes any finite number, so
  // an absurdly small one prints in exponent form rather than blank the table (US-65).
  if (size < 1e-20) return String(Number(v.toPrecision(2)));
  // toFixed, not String: String(4e-7) prints exponent notation.
  return v.toFixed(1 - Math.floor(Math.log10(size))).replace(/0+$/, '');
}

/** A number as the matrix prints it, thousands separated ("2,500"), for a refusal's words (US-21 AC26). */
export function labNumberText(v: number): string {
  return Number(formatLabValue(v)).toLocaleString('en-US', { maximumFractionDigits: 20 });
}

/** A saved lab value as shown: a limit with its symbol and its bound as
 *  printed ("< 0.005"), else `formatLabValue` (US-12 AC20, US-21 AC25). */
export function savedLabText(v: number, comparator?: Comparator): string {
  return comparator ? limitText(v, 0, comparator) : formatLabValue(v);
}

export type LabRowsGroupId = LabGroupId | 'other';
export type LabRowsIcon = LabGroup['icon'];

/** Widget-side pseudo-group for names the catalogue doesn't (yet) know. */
const OTHER_GROUP: { id: 'other'; label: string; icon: LabRowsIcon } = {
  id: 'other',
  label: 'Other tests',
  icon: 'flask',
};

export interface LabSeriesPoint {
  id: string;
  value: number;
  unit: string;
  recordedAt: string;
  /** The write time, which breaks a tie in `recordedAt` (US-07 AC4). */
  createdAt?: string;
  /** Printed as a limit: `value` is its bound (US-12 AC20). */
  comparator?: Comparator;
}

export interface LabSeries {
  /** Stable series identity — `labSlotKey`, the same key the merge slots on. */
  seriesKey: string;
  label: string;
  /** Display unit for the group's UnitChip — the most recent point's unit.
   *  A catalogued test is STORED in the catalogue's SI unit (US-21 phase 3),
   *  so its points agree; a test the catalogue does not know keeps the unit it
   *  was reported in, and older rows predate the conversion — check
   *  `mixedUnits` before treating this as every point's unit. */
  unit: string;
  mixedUnits: boolean;
  /** Ascending by `compareReadings`: day, then time, createdAt, id (oldest first, newest last/right). */
  points: LabSeriesPoint[];
}

export interface LabValueGroup {
  id: LabRowsGroupId;
  label: string;
  icon: LabRowsIcon;
  series: LabSeries[];
}

/** A stored lab value as the grouping reads it. The widget's rows come
 *  pre-filtered to active (RoadmapStore.loadLabValues() applies activeOnly()),
 *  so `status` is optional; a less-filtered source still drops the rest. */
export type LabValueRow = { id: string; metricName: string; value: number; unit: string; recordedAt: string; createdAt?: string; status?: string; comparator?: unknown };

/** Group + series-ify stored lab values for read-only display. Entered-in-
 *  error rows are excluded; series are sorted oldest→newest; a series
 *  spanning more than one distinct unit is flagged `mixedUnits`. */
export function groupLabValues(rows: LabValueRow[]): LabValueGroup[] {
  const seriesByGroup = new Map<LabRowsGroupId, Map<string, { label: string; points: LabSeriesPoint[] }>>();

  for (const row of rows) {
    if (row.status && row.status !== 'active') continue;
    const entry = resolveLabCatalogEntry(row.metricName);
    const groupId: LabRowsGroupId = entry ? entry.group : 'other';
    const seriesKey = labSlotKey(row.metricName);
    const label = entry ? entry.label : labValueLabel(row.metricName);

    let groupMap = seriesByGroup.get(groupId);
    if (!groupMap) { groupMap = new Map(); seriesByGroup.set(groupId, groupMap); }
    let series = groupMap.get(seriesKey);
    if (!series) { series = { label, points: [] }; groupMap.set(seriesKey, series); }
    // Store the DISPLAY unit: catalogue-canonical when the stored spelling
    // means the same unit, typography-normalized otherwise. Relabeling only —
    // nothing is converted here (catalogued tests are converted once, on the
    // write); a unit that still differs flags mixedUnits.
    // A row with no unit is one readers accept (readable-rows.ts), from another build:
    // it shows with no unit rather than throwing, so one row never blanks the screen.
    series.points.push({ id: row.id, value: row.value, unit: displayLabUnit(row.unit ?? '', entry), recordedAt: row.recordedAt, ...(row.createdAt ? { createdAt: row.createdAt } : {}), ...comparatorOf(row) });
  }

  const groupDefs: Array<{ id: LabRowsGroupId; label: string; icon: LabRowsIcon }> = [...LAB_GROUPS, OTHER_GROUP];

  const result: LabValueGroup[] = [];
  for (const def of groupDefs) {
    const groupMap = seriesByGroup.get(def.id);
    if (!groupMap || groupMap.size === 0) continue;
    const series: LabSeries[] = Array.from(groupMap.entries()).map(([seriesKey, s]) => {
      const points = [...s.points].sort(compareReadings);
      const units = new Set(points.map(p => p.unit));
      return {
        seriesKey,
        label: s.label,
        unit: points[points.length - 1].unit,
        mixedUnits: units.size > 1,
        points,
      };
    });
    series.sort((a, b) => a.label.localeCompare(b.label));
    result.push({ id: def.id, label: def.label, icon: def.icon, series });
  }
  return result;
}

/** A lab test's row, as the web's phone rows and the iPhone's My data draw it (US-62 AC8). */
export interface LabSeriesRow {
  seriesKey: string;
  label: string;
  unit: string;
  latest: { id: string; value: string; day: string };
  /** The value before the latest, as reported; null with one value, or in a series of more than one unit. */
  previous: string | null;
  /** The newest value's printed range, "Ref 30–400"; null when none was printed. */
  target: string | null;
  /** The recent values (`trendWindow`), oldest first; none in a series of more than one unit. */
  trend: number[];
  /** Which trend points were printed as a limit (US-12 AC20); absent with no trend. */
  trendLimits?: boolean[];
}

/** Every lab test series as a row, in `groupLabValues`'s order. A series in more
 *  than one unit draws no trend and no previous value: one line or one bracket
 *  would compare unlike numbers (US-21 AC3a). A value printed as a limit reads
 *  with its symbol, "< 5" (US-12 AC20); `exactOnly` leaves limits out of the
 *  trend before its window is taken, as the iPhone's core rows do, where the
 *  web flags them instead (`trendLimits`, drawn hollow). Never graded. */
export function labSeriesRows(rows: (LabValueRow & { referenceLow?: number | null; referenceHigh?: number | null })[], now = new Date(), exactOnly = false): LabSeriesRow[] {
  const byId = new Map(rows.map(v => [v.id, v]));
  const recent = trendWindow(now);
  const trendOf = (points: LabSeriesPoint[]) => {
    const shown = recent(exactOnly ? points.filter(p => !p.comparator) : points, p => p.recordedAt.slice(0, 10));
    return { trend: shown.map(p => p.value), trendLimits: shown.map(p => !!p.comparator) };
  };
  return groupLabValues(rows).flatMap(g => g.series).map(s => {
    const latest = s.points.at(-1)!;
    const previous = s.points.at(-2);
    const printed = byId.get(latest.id);
    const sameUnit = !s.mixedUnits;
    return {
      seriesKey: s.seriesKey,
      label: s.label,
      unit: s.unit,
      latest: { id: latest.id, value: savedLabText(latest.value, latest.comparator), day: latest.recordedAt.slice(0, 10) },
      previous: previous && sameUnit ? savedLabText(previous.value, previous.comparator) : null,
      target: rowTarget({ referenceLow: printed?.referenceLow, referenceHigh: printed?.referenceHigh }, 'si', null, null)?.bare ?? null,
      ...(sameUnit ? trendOf(s.points) : { trend: [] }),
    };
  });
}
