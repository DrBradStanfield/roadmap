// Test fixtures for the import review's tests (US-13 AC13). Not shipped: only tests import it.
import { valueDays, type ImportFile } from './import-review';
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

/** A lab report file, every value sent unless `unsent` names it. */
export function lab(result: Partial<ImportFile['result']>, opts: { day?: string | null; undatedDay?: string | null; unsent?: string[] } = {}): ImportFile {
  const full = { classification: 'lab_report', ...result };
  const days = valueDays(full, opts.day === undefined ? DAY : opts.day, opts.undatedDay ?? null);
  return { result: full, days, sent: new Set(Object.keys(days).filter((ref) => !opts.unsent?.includes(ref))) };
}

/** A record holding these rows, written by the real write path. */
type RowInput = BulkRow extends infer R ? R extends BulkRow ? Omit<R, 'source' | 'recordedAt'> & { recordedAt?: string } : never : never;
export function recordWith(rows: RowInput[]): RoadmapFile {
  return bulkAppendValues(EMPTY, rows.map((r) => ({ recordedAt: DAY, source: 'manual', ...r }) as BulkRow), NOW).file;
}
