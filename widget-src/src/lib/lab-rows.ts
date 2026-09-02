/**
 * US-21 phase 1 — pure grouping/series logic for surfacing stored
 * `labValues` (beyond the core 8 matrix) beneath the blood-test matrix.
 * Read-only: no editing, no unit conversion — values render as-reported
 * (see decisions in docs/user-stories.md § US-21).
 */
import { LAB_GROUPS, labSlotKey, resolveLabCatalogEntry, displayLabUnit, type LabGroupId } from '@roadmap/health-core';
import { labValueLabel } from './lab-value-labels';
import type { ApiLabValue } from './api-types';

export type LabRowsGroupId = LabGroupId | 'other';
export type LabRowsIcon = 'kidney' | 'liver' | 'droplet' | 'thyroid' | 'hormones' | 'vitamins' | 'flame' | 'flask';

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
  /** Stable series identity — `labSlotKey`, the same key the merge slots on. */
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
    // Store the DISPLAY unit: catalogue-canonical when the reported spelling
    // means the same unit, typography-normalized otherwise. Relabeling only —
    // values are never converted; a truly different unit flags mixedUnits.
    series.points.push({ id: row.id, value: row.value, unit: displayLabUnit(row.unit, entry), recordedAt: row.recordedAt });
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

/** Column dates (yyyy-mm-dd, ascending) + per-series point lookup for
 *  rendering a group as a date-column matrix (US-21 AC1 — same layout as the
 *  core 8). Two same-day points in one series: the later recordedAt wins,
 *  mirroring the core matrix's last-write-wins upsert. */
export function labGroupMatrix(group: LabValueGroup): {
  dates: string[];
  points: Record<string, Record<string, LabSeriesPoint>>;
} {
  const dates = new Set<string>();
  const points: Record<string, Record<string, LabSeriesPoint>> = {};
  for (const s of group.series) {
    const byDate: Record<string, LabSeriesPoint> = {};
    for (const p of s.points) { // ascending, so a later same-day point overwrites
      const day = p.recordedAt.slice(0, 10);
      dates.add(day);
      byDate[day] = p;
    }
    points[s.seriesKey] = byDate;
  }
  return { dates: Array.from(dates).sort(), points };
}

/** Total value-points across all groups/series — the `lab_rows_viewed` count. */
export function countLabValuePoints(groups: LabValueGroup[]): number {
  return groups.reduce((sum, g) => sum + g.series.reduce((s2, ser) => s2 + ser.points.length, 0), 0);
}

/** One history series per lab SLOT (US-10) — "Vitamin D" and `vitamin_d` are
 *  one chart, not two — labelled from the catalogue when the test is known.
 *  Series come back sorted by label; rows keep their loaded order. */
export function groupLabHistory(rows: LabValueRow[]): {
  keys: string[];
  series: Record<string, { label: string; rows: LabValueRow[] }>;
} {
  const series: Record<string, { label: string; rows: LabValueRow[] }> = {};
  for (const row of rows) {
    const key = labSlotKey(row.metricName);
    if (!series[key]) {
      series[key] = { label: resolveLabCatalogEntry(row.metricName)?.label ?? labValueLabel(row.metricName), rows: [] };
    }
    series[key].rows.push(row);
  }
  const keys = Object.keys(series).sort((a, b) => series[a].label.localeCompare(series[b].label));
  return { keys, series };
}
