/**
 * RoadmapFile → the `Api*` shapes the mappings layer converts into HealthInputs.
 *
 * The record file stores the profile and the screenings singleton in its own
 * camelCase shapes; `measurementsToInputs` and `screeningsToInputs` speak the
 * `Api*` shapes the v1 endpoints returned. These three adapters bridge the two,
 * and they live here — not in the browser store that used to own them — because
 * the CLI plan generator (tools/get-plan.ts, US-30) has to derive inputs from
 * the same file the widget does, and a second copy of this bridge is a second
 * answer to "what is my current value".
 */
import type { ApiProfile, ApiScreening } from './mappings';
import type { FileScreenings, RoadmapProfile } from './roadmap-file';
import type { ScreeningInputs } from './types';
import { encodeSex, encodeUnitSystem } from './types';
import { SCREENING_KEYS } from './validation';

/** A screening key as stored (`colorectal_last_date`) → its ScreeningInputs field. */
export function screeningFieldName(key: string): keyof ScreeningInputs {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof ScreeningInputs;
}

/** The file's profile as an ApiProfile. Names are never stored in the file. */
export function fileProfileToApi(p: RoadmapProfile): ApiProfile {
  return {
    sex: p.sex ? encodeSex(p.sex) : null,
    birthYear: p.birthYear ?? null,
    birthMonth: p.birthMonth ?? null,
    unitSystem: p.unitSystem ? encodeUnitSystem(p.unitSystem) : null,
    firstName: null,
    lastName: null,
    height: p.heightCm ?? null,
  };
}

/** The screenings singleton as keyed rows; unset and blank fields are omitted. */
export function fileScreeningRows(s: FileScreenings): ApiScreening[] {
  const rows: ApiScreening[] = [];
  for (const key of SCREENING_KEYS) {
    const v = (s as unknown as Record<string, unknown>)[screeningFieldName(key)];
    if (v !== undefined && v !== null && v !== '') {
      rows.push({ id: key, screeningKey: key, value: String(v), updatedAt: s.updatedAt });
    }
  }
  return rows;
}
