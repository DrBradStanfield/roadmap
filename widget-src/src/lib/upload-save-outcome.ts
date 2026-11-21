import type { LabUnitRefusal, MeasurementRefusal } from '@roadmap/health-core/record-edits';

/** One session's save outcome (US-12 AC6c). The saved counts add up across a
 *  retry, which finishes what the first Save began; the rest are the last
 *  attempt's. Documents count by content, else name: a retry may refile one. `unstored`: originals the cloud would not store; their details
 *  are saved (US-14 AC4, AC12). The refusals are lab rows in a unit the record
 *  does not know for that test, and core values it refused: each is named, as
 *  a dropped value must never be silent (US-21 phase 3, US-35 AC17). */
export interface SaveOutcome {
  values: number; labValues: number; documents: string[];
  skippedValues: number; skippedLabValues: number; unstored: number;
  refusedLabUnits: LabUnitRefusal[]; refusedMeasurements: MeasurementRefusal[];
  /** The lab rows each file's values wrote, by the file's identity (`fileKey`), every attempt's: a
   *  retry whose values are already saved still lists them on the file's archive row (US-14 AC10). */
  labRows: ReadonlyMap<string, string[]>;
}
export const NO_OUTCOME: SaveOutcome = { values: 0, labValues: 0, documents: [], skippedValues: 0, skippedLabValues: 0, unstored: 0, refusedLabUnits: [], refusedMeasurements: [], labRows: new Map() };

/** What earlier attempts saved. The last attempt's skips, errors and refusals
 *  belong to it: never beside a new error. */
export const savedSoFar = (o: SaveOutcome): SaveOutcome => ({ ...NO_OUTCOME, values: o.values, labValues: o.labValues, documents: o.documents, labRows: o.labRows });

/** Two attempts' lab rows, by file. */
export const joinRows = (a: ReadonlyMap<string, string[]>, b: ReadonlyMap<string, string[]>): ReadonlyMap<string, string[]> =>
  new Map([...new Set([...a.keys(), ...b.keys()])].map((f) => [f, [...new Set([...(a.get(f) ?? []), ...(b.get(f) ?? [])])]]));

/** One attempt added to the session: saved counts add up, documents by key
 *  once; skips, unstored and refusals are the attempt's own. */
export const withAttempt = (o: SaveOutcome, attempt: SaveOutcome): SaveOutcome => ({
  ...attempt,
  values: o.values + attempt.values,
  labValues: o.labValues + attempt.labValues,
  documents: [...new Set([...o.documents, ...attempt.documents])],
  labRows: joinRows(o.labRows, attempt.labRows),
});
