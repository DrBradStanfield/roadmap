/**
 * US-21 phase 1 — pure grouping/series logic for surfacing stored
 * `labValues` (beyond the core 8 matrix) beneath the blood-test matrix.
 * Read-only: no editing, no unit conversion — values render as-reported
 * (see decisions in docs/user-stories.md § US-21).
 */
import { labSlotKey, resolveLabCatalogEntry, displayLabUnit, labValueLabel, type LabValueGroup, type LabSeriesPoint, type LabValueRow } from '@roadmap/health-core';

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
 *  `units` holds each distinct display unit, as the table shows them (US-21 AC3a).
 *  Series come back sorted by label; rows keep their loaded order. */
export function groupLabHistory<Row extends LabValueRow>(rows: Row[]): {
  keys: string[];
  series: Record<string, { label: string; rows: Row[]; units: string[] }>;
} {
  const series: Record<string, { label: string; rows: Row[]; units: string[] }> = {};
  for (const row of rows) {
    const key = labSlotKey(row.metricName);
    if (!series[key]) {
      series[key] = { label: labValueLabel(row.metricName), rows: [], units: [] };
    }
    series[key].rows.push(row);
    const unit = displayLabUnit(row.unit ?? '', resolveLabCatalogEntry(row.metricName)); // no unit: shown with none (US-65)
    series[key].units = [...new Set([...series[key].units, unit])];
  }
  const keys = Object.keys(series).sort((a, b) => series[a].label.localeCompare(series[b].label));
  return { keys, series };
}
