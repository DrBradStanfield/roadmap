// Value saves and corrections: the answer shapes RoadmapStore's writers hand back, the
// row view they share and the profile write (moved from roadmap-store.ts, US-64).
import type { MoveRejection } from '@roadmap/health-core/record-edits';
import type { RecordSession } from '@roadmap/health-core/record-session';
import { birthInFuture, type MeasurementSource, inputRangeFault } from '@roadmap/health-core/validation';
import { stampProfile } from '@roadmap/health-core/state-edits';
import { PREFILL_FIELDS, type ApiMeasurement } from '@roadmap/health-core/mappings';
import type { RoadmapProfile, FileLabValue, FileMeasurement } from '@roadmap/health-core/roadmap-file';
import type { HealthInputs } from '@roadmap/health-core/types';
import type { Comparator } from '@roadmap/health-core/lab-limits';
import { readableView } from '@roadmap/health-core/readable-rows';

/** How a correction ended. `changed`: the value named is not there any
 *  more, or another row has replaced it (another device, a connector).
 *  `invalid`: the record does not take that number (outside the metric's
 *  range). `refused`: a lab value past its plausible range, in the engine's
 *  words, which the page shows as the iPhone and MCP do (US-21 AC26).
 *  `error`: no record is open. */
export type CorrectStatus = 'ok' | 'changed' | 'invalid' | 'error' | { refused: string };
/** How a blood test move ended (US-04 AC5), as a correction does. `changed`:
 *  the test on that day is not what the page showed. `invalid` carries the
 *  record's refusal, for the page to say. */
export type MoveOutcome = { status: Exclude<Extract<CorrectStatus, string>, 'invalid'> } | { status: 'invalid'; refusal: MoveRejection };
/** A birth month in the future that a save refused (US-54 AC5b): the pair judged. */
export interface BirthRefusal { birthYear: number; birthMonth: number | undefined }
/** A profile save: refused by the erase, or saved with any birth month it refused. */
/** A profile value outside its range, by field, with why (US-02 AC5): never written. */
export type ProfileRangeRefusal = Partial<Record<keyof HealthInputs, string>>;
/** `added`: the rows the save inserted as new, never a correction or a refused number (US-07 AC11's usage signal). */
export type ProfileSave = { ok: false } | { ok: true; birthRefused: BirthRefusal | null; added: ApiMeasurement[]; refused?: ProfileRangeRefusal };
/** One reviewed upload row. `correctsId` is set only when the reviewer ticked
 *  "Replace" on a slot another writer (a connector, another device) already
 *  holds — it turns the write into a FHIR correction instead of a skip. */
/** `comparator`: a result printed as a limit, saved as printed (US-12 AC20). */
export interface BulkMeasurementInput {
  metricType: string; value: number; recordedAt: string; source: MeasurementSource; correctsId?: string; comparator?: Comparator;
}

/** A saved row as the screens read a value: a core lab row under its key as
 *  `metricType`, as a measurement reads (US-66 AC7). Vitals pass as they are. */
export function valueView(row: FileMeasurement | FileLabValue): ApiMeasurement {
  if (!('metricName' in row)) return row as ApiMeasurement;
  const { metricName, unit: _unit, referenceLow: _low, referenceHigh: _high, core: _core, ...rest } = row;
  return { ...rest, metricType: metricName } as ApiMeasurement;
}

/** RoadmapStore.applyProfileChanges, which forwards here with its session. */
export function applyProfileChanges(session: RecordSession, current: Partial<HealthInputs>, previous: Partial<HealthInputs>, erase?: string, outOfRange: ProfileRangeRefusal = {}): BirthRefusal | null {
    const changes: Record<string, unknown> = {};
    for (const field of [...PREFILL_FIELDS, 'unitSystem'] as const) {
      // A cleared form field is absent from current, but is still a write.
      // Keep its key as null so the field stamp carries the clear (US-10 AC9).
      if (current[field] !== previous[field]) changes[field] = current[field] ?? null;
      // US-02 AC5: a value outside its range never reaches the file, whatever
      // the caller ("19" on the way to 190, left or not); the rest still write.
      const fault = inputRangeFault(field, changes[field]);
      if (fault) { delete changes[field]; outOfRange[field] = fault; }
    }
    // US-54 AC5b: a birth month after this one writes neither changed half, as
    // update_profile refuses it; a year alone is judged with January. Judged as
    // typed and as it would be stored, over a half another device changed.
    const future = (p: { birthYear?: number | null; birthMonth?: number | null }): BirthRefusal | null =>
      p.birthYear != null && birthInFuture(p.birthYear, p.birthMonth ?? 1, new Date())
        ? { birthYear: p.birthYear, birthMonth: p.birthMonth ?? undefined }
        : null;
    const refused = 'birthYear' in changes || 'birthMonth' in changes
      ? future(current) ?? future({ ...readableView(session.file).file.profile, ...changes })
      : null;
    if (refused) { delete changes.birthYear; delete changes.birthMonth; }
    if (Object.keys(changes).length === 0) return refused;
    // Only the fields changed take a new stamp (US-10 AC6). And an edit, which
    // schedules a save, as every other mutation is: a profile-only edit (sex,
    // height, birth date — no measurement changed with it) once scheduled no
    // save at all, so it sat in memory until the next unrelated edit carried it up.
    session.edit((file) => stampProfile(file, changes as Partial<RoadmapProfile>, new Date().toISOString()), erase);
    return refused;
}
