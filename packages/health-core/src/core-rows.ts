/**
 * The core-row primitives the merge needs (US-66), kept apart from
 * `blood-tests.ts` so `merge.ts` imports nothing heavier than the record's
 * shape and the lab catalogue: the name resolver and the range check would
 * close an import cycle through `validation.ts`.
 */
import { labSlotKey } from './lab-catalog';
import { baseIdOf } from './merge';
import { CORE_BLOOD_UNITS, type FileLabValue } from './roadmap-file';
import type { MetricType } from './units';

/** The suffix of a fold row's id: the printed row's id plus this, the same on every device (US-66 AC5). */
export const CORE_SUFFIX = '#core';

/** Whether a key is one of the nine core blood tests. Own keys only: `__proto__` is not a test. */
export function isBloodTestKey(key: unknown): key is MetricType {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(CORE_BLOOD_UNITS, key);
}

/** A core value: flagged by a core write path, and named by its core key (US-66 AC1). */
export function isCoreRow(row: { core?: unknown; metricName?: unknown }): boolean {
  return row.core === true && isBloodTestKey(row.metricName);
}

/** A row `migrateFile` added to correct a printed row into a core value (US-66 AC5). */
export function isFoldRow(row: FileLabValue): boolean {
  return isCoreRow(row) && baseIdOf(row.id).endsWith(CORE_SUFFIX);
}

/** A lab row's slot, without its day: `core:<key>` for a core value, else `lab:` and the catalogue key. The two never meet (US-66 AC1). */
export function labRowSlot(row: Pick<FileLabValue, 'metricName'> & { core?: unknown }): string {
  return isCoreRow(row) ? `core:${row.metricName}` : `lab:${labSlotKey(row.metricName)}`;
}

/**
 * A moved row as it was before the move, for the content hash (US-66 AC2):
 * an old `#dup-` id, its base-id winner and every `correctsId` that points at
 * them stay as they were. Any other row comes back as it is.
 */
export function v2FormOf(row: object): object {
  const r = row as Record<string, unknown>;
  if (!isCoreRow(r) || 'metricType' in r || r.unit !== CORE_BLOOD_UNITS[r.metricName as string]
    || r.referenceLow !== null || r.referenceHigh !== null) return row;
  const { metricName, unit: _unit, referenceLow: _low, referenceHigh: _high, core: _core, ...rest } = r;
  return { ...rest, metricType: metricName };
}

