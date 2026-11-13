import { useCallback, useRef } from 'react';
import { labEgfrOf } from '@roadmap/health-core/plan';
import { planPsa } from '@roadmap/health-core/measurement-history';
import { screeningsToInputs } from '@roadmap/health-core/mappings';
import type { LatestMeasurementsResult } from '../lib/api-types';
import { loadAllHistory, loadAllHistorySync, loadLabValues, loadLatestMeasurements } from '../lib/roadmap-data';
import { loadFromLocalStorage, patchMirror, saveToLocalStorage } from '../lib/storage';
import type { useRecordState } from './useRecordState';

type RecordSetters = Pick<ReturnType<typeof useRecordState>, 'setPreviousMeasurements' | 'setHistory' | 'setLabValueHistory'>;

/** The chat mirror (US-15 AC10): the record as read, for the storefront chat
 *  embed and the bubble, with the lab eGFR and the newest usable PSA, its
 *  `raisedBefore` worked out here from the full record (US-06 AC21 item 6). */
export async function mirrorRecord(result: LatestMeasurementsResult): Promise<void> {
  saveToLocalStorage(result.inputs, result.previousMeasurements, result.medications, result.screenings, undefined,
    labEgfrOf(await loadLabValues() ?? []), planPsa(loadAllHistorySync(), new Date(), screeningsToInputs(result.screenings)));
}

/**
 * The page's reads of the record (US-21, US-34, US-15 AC10): the values the
 * plan shows, every measurement for both matrices, and the lab rows. Each
 * read replaces the screen's copy (hooks/useRecordState) and keeps the chat
 * mirror in step. Every save and correction ends in `reloadValues`, so
 * nothing reads a patched copy that could disagree with the record.
 */
export function useRecordReads({ setPreviousMeasurements, setHistory, setLabValueHistory }: RecordSetters) {
  // A generation count: an older lab read that answers after a newer one is dropped.
  const labReads = useRef(0);
  /** The lab rows (US-21). A failed read keeps the rows shown. */
  const refreshLabValues = useCallback(() => {
    const read = ++labReads.current;
    return loadLabValues().then(rows => {
      if (rows && read === labReads.current) {
        setLabValueHistory(rows);
        // A lab eGFR added by hand reaches the other chats too (US-07 AC7).
        const labEgfr = labEgfrOf(rows);
        const cached = loadFromLocalStorage();
        if (cached && JSON.stringify(cached.labEgfr) !== JSON.stringify(labEgfr)) patchMirror({ labEgfr });
      }
    }).catch(() => {});
  }, [setLabValueHistory]);

  /** Every measurement, for both matrices. */
  const loadHistory = useCallback(() => loadAllHistory().then(setHistory), [setHistory]);

  /** Re-read every value the page shows. Hands back what it read. */
  const reloadValues = useCallback(async () => {
    const result = await loadLatestMeasurements();
    if (result) {
      setPreviousMeasurements(result.previousMeasurements);
      await mirrorRecord(result);
    }
    await Promise.all([refreshLabValues(), loadHistory()]);
    return result;
  }, [refreshLabValues, loadHistory, setPreviousMeasurements]);

  return { reloadValues, refreshLabValues, loadHistory };
}
