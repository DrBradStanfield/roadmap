/**
 * US-21 phase 1 — pure grouping/series logic for surfacing stored
 * `labValues` (beyond the core 8 matrix) beneath the blood-test matrix.
 * Read-only: no editing, no unit conversion — values render as-reported
 * (see decisions in docs/user-stories.md § US-21).
 */
import { LAB_GROUPS, resolveLabCatalogEntry, type LabGroupId } from '@roadmap/health-core';
import type { ApiLabValue } from './api-types';

export type LabRowsGroupId = LabGroupId | 'other';
export type LabRowsIcon = 'kidney' | 'liver' | 'thyroid' | 'hormones' | 'vitamins' | 'flame' | 'flask';

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
}

export interface LabSeries {
  /** Stable series identity: catalogue key when resolved, else the
   *  normalized reported name. */
  seriesKey: string;
  label: string;
  /** Display unit for the group's UnitChip — the most recent point's unit.
   *  Phase 1 shows values as-reported (no conversion), so check
   *  `mixedUnits` before treating this as every point's unit. */
  unit: string;
  mixedUnits: boolean;
  /** Ascending by recordedAt (oldest first, newest last/right). */
  points: LabSeriesPoint[];
}

export interface LabValueGroup {
  id: LabRowsGroupId;
  label: string;
  icon: LabRowsIcon;
  series: LabSeries[];
}

/** ApiLabValue as loaded by the widget already comes pre-filtered to active
 *  rows (RoadmapStore.loadLabValues() applies activeOnly()), so `status`
 *  isn't on the type. Accept it optionally anyway so this stays correct if
 *  ever fed a less-filtered source. */
type LabValueRow = ApiLabValue & { status?: string };

/** Resolve a reported metric name to a catalogue entry, tolerant of the
 *  underscore/space variance the LLM extractor produces (e.g. "free_t4"
 *  vs the catalogue alias "free t4"). Never match on raw text otherwise —
 *  always through the catalogue's key/label/alias lookup. */
function resolveEntry(reportedName: string) {
  return resolveLabCatalogEntry(reportedName) ?? resolveLabCatalogEntry(reportedName.replace(/_/g, ' '));
}

function titleCase(name: string): string {
  return name
    .trim()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Group + series-ify stored lab values for read-only display. Entered-in-
 *  error rows are excluded; series are sorted oldest→newest; a series
 *  spanning more than one distinct unit is flagged `mixedUnits`. */
export function groupLabValues(rows: LabValueRow[]): LabValueGroup[] {
  const seriesByGroup = new Map<LabRowsGroupId, Map<string, { label: string; points: LabSeriesPoint[] }>>();

  for (const row of rows) {
    if (row.status && row.status !== 'active') continue;
    const entry = resolveEntry(row.metricName);
    const groupId: LabRowsGroupId = entry ? entry.group : 'other';
    const seriesKey = entry ? entry.key : row.metricName.trim().toLowerCase().replace(/\s+/g, '_');
    const label = entry ? entry.label : titleCase(row.metricName);

    let groupMap = seriesByGroup.get(groupId);
    if (!groupMap) { groupMap = new Map(); seriesByGroup.set(groupId, groupMap); }
    let series = groupMap.get(seriesKey);
    if (!series) { series = { label, points: [] }; groupMap.set(seriesKey, series); }
    series.points.push({ id: row.id, value: row.value, unit: row.unit, recordedAt: row.recordedAt });
  }

  const groupDefs: Array<{ id: LabRowsGroupId; label: string; icon: LabRowsIcon }> = [...LAB_GROUPS, OTHER_GROUP];

  const result: LabValueGroup[] = [];
  for (const def of groupDefs) {
    const groupMap = seriesByGroup.get(def.id);
    if (!groupMap || groupMap.size === 0) continue;
    const series: LabSeries[] = Array.from(groupMap.entries()).map(([seriesKey, s]) => {
      const points = [...s.points].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
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

/** Total value-points across all groups/series — the `lab_rows_viewed` count. */
export function countLabValuePoints(groups: LabValueGroup[]): number {
  return groups.reduce((sum, g) => sum + g.series.reduce((s2, ser) => s2 + ser.points.length, 0), 0);
}
