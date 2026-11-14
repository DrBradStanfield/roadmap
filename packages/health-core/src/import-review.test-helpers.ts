// Test fixtures for the import review's tests (US-13 AC13). Not shipped: only tests import it.
import { importRow, valueDays, type ImportFile } from './import-review';
import type { AdditionalLabValue, ExtractedValue } from './lab-extraction';
import { bulkAppendValues, type BulkRow } from './record-edits';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

export const DAY = '2026-11-01';
export const NOW = '2026-11-02T00:00:00.000Z';
export const EMPTY: RoadmapFile = createEmptyFile({ deviceId: 'test', now: NOW });

export const core = (over: Partial<ExtractedValue> = {}): ExtractedValue => ({
  metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', ...over,
});
export const extra = (over: Partial<AdditionalLabValue> = {}): AdditionalLabValue => ({ name: 'Ferritin', value: 80, unit: 'µg/L', ...over });

/** A lab report file whose every dated value Save sends, built by `importRow`,
 *  unless `unsent` names it; `replaces` selects Replace (a `correctsId`). */
export function lab(result: Partial<ImportFile['result']>, opts: { day?: string | null; undatedDay?: string | null; unsent?: string[]; replaces?: Record<string, string> } = {}): ImportFile {
  const full = { classification: 'lab_report', ...result };
  const days = valueDays(full, opts.day === undefined ? DAY : opts.day, opts.undatedDay ?? null);
  const rows: Record<string, BulkRow> = {};
  for (const [ref, day] of Object.entries(days)) {
    if (!day || opts.unsent?.includes(ref)) continue;
    rows[ref] = importRow(full, ref, day, { correctsId: opts.replaces?.[ref] })!;
  }
  return { result: full, rows, days };
}

type RowInput = BulkRow extends infer R ? R extends BulkRow ? Omit<R, 'source' | 'recordedAt'> & { recordedAt?: string } : never : never;
/** A record holding these rows, written by the real write path. */
export function recordWith(rows: RowInput[]): RoadmapFile {
  return bulkAppendValues(EMPTY, rows.map((r) => ({ recordedAt: DAY, source: 'manual', ...r }) as BulkRow), NOW).file;
}
