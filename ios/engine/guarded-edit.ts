// One edit, guarded, on any target (I-1; I-2 step 4): the checks every write the app asks for
// passes, in one place, whichever record it lands on. The cloud session is the one target today
// (cloud.ts); the phone's file joins it as a door later (phoneEdit, I-1), held to the same
// refusal table (cloud.test.ts). The write rule itself stays applyEdit (my-data.ts): a target adds
// guards, never row logic.
import { isCoreRow } from '../../packages/health-core/src/blood-tests';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { applyEdit, type Edit, type EditOutcome } from './my-data';
import { lpaUnitOf, readUnitChoices, unitsOf } from './unit-choices';

export type Refusal = Extract<EditOutcome, { ok: false }>;

export function refuse(reason: string, message: string): Refusal {
  return { ok: false, reason, message };
}

/** What the screen showed when the edit began: the record's units, Lp(a)'s unit when the sheet
 *  showed one, and the per-test units as JSON (UnitChoices, US-25 AC17e). */
export interface Shown {
  units: string;
  lpaUnit?: string;
  choicesJson?: string;
}

/** Where a guarded edit lands. */
export interface EditTarget {
  /** The record as the target holds it now. */
  readonly file: RoadmapFile;
  /** The refusal when this is no longer the record the screen showed (an erase since), else null. */
  stale(): Refusal | null;
  /** Takes `next`; the refusal when it cannot, and then nothing changed. */
  commit(next: RoadmapFile): Refusal | null;
  /** What an accepted edit's answer carries beside `ok`: the record as now held, and its erase. */
  answer(): { record: string; erase?: string };
}

/** Only edits whose number is read in the user's units can be misread after a
 *  unit change: a value, a correction, a height. */
export function dependsOnUnits(edit: Edit, file: RoadmapFile): boolean {
  // A lab value's correction is in the unit its row is stored in, whatever the record's units (review R7);
  // a core blood test's is read in the record's units, like a vital's, though it is a lab row (US-66 AC6).
  if (edit.kind === 'correct') {
    return file.measurements.some((row) => row.id === edit.id) || file.labValues.some((row) => row.id === edit.id && isCoreRow(row));
  }
  return edit.kind === 'add' || (edit.kind === 'profile' && edit.height !== undefined);
}

/** A value or correction of Lp(a), read in Lp(a)'s own unit, which the record holds (US-05 AC2). */
function dependsOnLpaUnit(edit: Edit, file: RoadmapFile): boolean {
  if (edit.kind === 'add') return edit.metric === 'lpa';
  // Lp(a) is a core lab row (US-66 AC9).
  return edit.kind === 'correct' && file.labValues.some((row) => row.id === edit.id && isCoreRow(row) && row.metricName === 'lpa');
}

/** `edit` on `target`, read in the units the screen showed, or the first guard that refuses it. */
export function guardedEdit(target: EditTarget, edit: Edit, shown: Shown, nowIso: string) {
  const file = target.file;
  // A number is read in the units the screen showed. If another device has
  // changed the units since, the same number would be stored in the wrong ones.
  if (dependsOnUnits(edit, file) && shown.units !== unitsOf(file)) {
    return refuse('units-changed', 'Your units changed on another device, so this was not saved. Close this and enter the value again.');
  }
  // Lp(a)'s unit is the record's too (US-05 AC2): a number typed in the old one is never
  // saved in the new one.
  if (shown.lpaUnit !== undefined && dependsOnLpaUnit(edit, file) && shown.lpaUnit !== lpaUnitOf(file)) {
    return refuse('units-changed', 'Your Lp(a) unit changed on another device, so this was not saved. Close this and enter the value again.');
  }
  const stale = target.stale();
  if (stale) return stale;
  // Read in the per-test units the sheet showed (AC17e), as the phone's own file is.
  const outcome = applyEdit(file, edit, nowIso, readUnitChoices(shown.choicesJson));
  if (!outcome.ok) return outcome;
  // An edit that changed nothing (an Apple Health batch already taken in) saves nothing.
  // Any other goes to the target: only then is it taken.
  if (outcome.file !== file) {
    const refusal = target.commit(outcome.file);
    if (refusal) return refusal;
  }
  const { file: _edited, ok, ...extra } = outcome;
  return { ok, ...target.answer(), ...extra };
}
