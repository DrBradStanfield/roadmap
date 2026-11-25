import type { HealthInputs } from '@roadmap/health-core/types';
import { screeningsToInputs, type ApiMeasurement, type ApiMedication, type ApiScreening } from '@roadmap/health-core/mappings';
import { labEgfrOf } from '@roadmap/health-core/plan';
import { planPsa } from '@roadmap/health-core/measurement-history';
import type { ApiLabValue } from './api-types';
import { loadAllHistorySync, loadLabValuesSync, loadLatestMeasurementsSync } from './roadmap-data';
import { loadFromLocalStorage, saveToLocalStorage } from './storage';

/** The saved values the chat mirror is made from (US-15 AC10). */
export interface MirrorSources {
  /** The saved profile. */
  profile: Partial<HealthInputs>;
  /** The newest saved row per metric. */
  latest: ApiMeasurement[];
  medications: ApiMedication[];
  screenings: ApiScreening[];
  /** The record's lab rows, for the lab eGFR (US-07 AC7). */
  labRows: readonly ApiLabValue[];
  /** Every measurement on record, for the PSA flag (US-06 AC21 item 6). */
  history: readonly ApiMeasurement[];
}

/** Nothing on record: a new visitor, or another device erased it (US-11). */
export const NO_RECORD: MirrorSources = { profile: {}, latest: [], medications: [], screenings: [], labRows: [], history: [] };

/** The whole mirror, from saved values. Its derived fields, the lab eGFR and the
 *  newest usable PSA with its `raisedBefore`, are worked out here and nowhere
 *  else, so no writer leaves one behind its sources (US-34 AC11). */
export function mirrorOf(saved: MirrorSources, now: Date) {
  return {
    inputs: saved.profile,
    previousMeasurements: saved.latest,
    medications: saved.medications,
    screenings: saved.screenings,
    labEgfr: labEgfrOf(saved.labRows),
    psa: planPsa(saved.history, now, screeningsToInputs(saved.screenings)) ?? null,
  };
}

/** The one writer of the chat mirror. A source the caller leaves out is taken as
 *  it stands now: the profile and the lists from the mirror (the page's saved
 *  ones, which a held change does not reach, US-34 AC9, AC10), the measurements
 *  and lab rows from the store (none before it opens). Every derived field is
 *  worked out again. */
export function writeMirror(saved: Partial<MirrorSources>): void {
  const cached = loadFromLocalStorage();
  const m = mirrorOf({
    profile: saved.profile ?? cached?.inputs ?? {},
    medications: saved.medications ?? cached?.medications ?? [],
    screenings: saved.screenings ?? cached?.screenings ?? [],
    latest: saved.latest ?? loadLatestMeasurementsSync()?.previousMeasurements ?? [],
    labRows: saved.labRows ?? loadLabValuesSync() ?? [],
    history: saved.history ?? loadAllHistorySync(),
  }, new Date());
  saveToLocalStorage(m.inputs, m.previousMeasurements, m.medications, m.screenings, undefined, m.labEgfr, m.psa);
}
