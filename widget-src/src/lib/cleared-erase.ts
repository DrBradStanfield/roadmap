/**
 * The erase this browser's off-file health data (drafts, kept answers, stored
 * originals) was last cleared for, kept across loads (RecordHost.clearedErase,
 * US-11 AC6). One key; its value is `{ lineage, erase }` and nothing else: the
 * store id it was cleared on ('local' is the device record) and the erase
 * identity, the erase's epoch and time. Read and written only while that store
 * owns the off-file data (ownsOffFileData, the one owner rule). Log-off removes
 * it (standalone/connect.ts logOff).
 */
import { readErase } from '@roadmap/health-core/erase-identity';
import { ownsOffFileData, safeGetItem, safeSetItem } from './storage';

export const CLEARED_ERASE_KEY = 'health_roadmap_cleared_erase';

/** The erase kept for `storeId`; null unless it owns the off-file data, the
 *  kept one is its own, and the erase reads. */
export function clearedEraseFor(storeId: string): string | null {
  if (!ownsOffFileData(storeId)) return null;
  try {
    const kept = JSON.parse(safeGetItem(CLEARED_ERASE_KEY) ?? 'null') as { lineage?: unknown; erase?: unknown } | null;
    return kept?.lineage === storeId && typeof kept.erase === 'string' && readErase(kept.erase) ? kept.erase : null;
  } catch {
    return null;
  }
}

/** Keep `erase` as cleared for on `storeId`, only while it owns the off-file data. */
export function noteClearedFor(storeId: string, erase: string): void {
  if (ownsOffFileData(storeId)) safeSetItem(CLEARED_ERASE_KEY, JSON.stringify({ lineage: storeId, erase }));
}
