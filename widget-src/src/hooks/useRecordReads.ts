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
 *  `raisedBefore` worked out here from the full record (US-06 AC21 item 6).
 *  `shown` is asked as the mirror is written, after the lab read (US-34 AC9, AC10). */
export async function mirrorRecord(result: LatestMeasurementsResult, shown?: ShownCopy): Promise<void> {
  const labEgfr = labEgfrOf(await loadLabValues() ?? []);
  const copy = shown?.();
  if (copy === null) return;
  const { inputs, medications, screenings } = copy ?? result;
  saveToLocalStorage(inputs, result.previousMeasurements, medications, screenings, undefined,
    labEgfr, planPsa(loadAllHistorySync(), new Date(), screeningsToInputs(screenings)));
}

/** What a read writes beside its values, decided as it writes: undefined, the record read; the page's profile and
 *  lists while they differ from it (a held change, US-34 AC9, AC10); null, nothing (a read the page does not show). */
export type ShownCopy = () => Pick<LatestMeasurementsResult, 'inputs' | 'medications' | 'screenings'> | null | undefined;

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

  /** Re-read every value the page shows. Hands back what it read. `shown`: see mirrorRecord. */
  const reloadValues = useCallback(async (shown?: ShownCopy) => {
    const result = await loadLatestMeasurements();
    if (shown?.() === null) return result; // a read the page does not show: nothing replaced or written (H16)
    if (result) {
      setPreviousMeasurements(result.previousMeasurements);
      await mirrorRecord(result, shown);
    }
    await Promise.all([refreshLabValues(), loadHistory()]);
    return result;
  }, [refreshLabValues, loadHistory, setPreviousMeasurements]);

  return { reloadValues, refreshLabValues, loadHistory };
}
