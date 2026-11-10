import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { HealthInputs } from '@roadmap/health-core/types';
import type { UnitSystem } from '@roadmap/health-core/units';
import { PREFILL_FIELDS, hasUnsavedProfileEdits } from '@roadmap/health-core/mappings';
import { birthRefusedMessage } from '@roadmap/health-core/validation';
import { getBackendKind, getShownErase, saveChangedMeasurements } from '../lib/roadmap-data';
import { localHealthWritesStopped, patchMirror } from '../lib/storage';
import { useDebouncedSave } from '../lib/useDebouncedSave';

/** The profile fields a save carries: height, sex, the birth date and the unit system. */
const PROFILE_FIELDS: ReadonlyArray<keyof HealthInputs> = [...PREFILL_FIELDS, 'unitSystem'];

/**
 * The profile's save: height, sex, birth month and year, and the unit system
 * (US-02 AC5, US-34 AC4, US-54 AC5b).
 *
 * The form's profile is in one of four states against the record:
 * - clean: the form holds what the record holds (`saved`, the last values the
 *   record took);
 * - waiting: an edit is on the 500 ms timer, with the erase it was made
 *   against (an erase or a closing tab cancels or flushes it);
 * - saving: the write is on its way;
 * - kept: the store refused a value (out of range, US-02 AC5, or a birth
 *   pair, US-54 AC5b). It stays unsaved; an out-of-range value stays in the
 *   form with its error. A refused birth pair goes back to the record's
 *   (unless typed over since) and says why in `birthRefused` until the next
 *   birth edit.
 *
 * A remote change that arrived while the form was dirty is held by the relay
 * and released (`onClean`) once the form is clean (US-34 AC4): after a save
 * that left no out-of-range value in the form (a refused birth pair goes
 * back, so it counts as clean), or when nothing was left to save. Not while
 * an out-of-range value is still in the form (the re-read would replace it
 * and its error), nor while an edit made during the save's await is unsaved.
 */
export interface ProfileSave {
  /** Save any unsaved profile field now. True if saved or nothing to save; false if refused. */
  flushProfile: (erase?: string) => Promise<boolean>;
  /** The waiting save: run it now (a closing tab) or drop it (an erase). */
  profileTimer: { flush: () => void; cancel: () => void };
  /** The record's profile as last read or saved. */
  markSaved: (inputs: Partial<HealthInputs>) => void;
  /** The form holds a profile edit the record does not (US-34 AC4). */
  profileDirty: () => boolean;
  birthRefused: string | null;
  clearBirthRefused: () => void;
}

export function useProfileSave(args: {
  inputs: Partial<HealthInputs>;
  inputsRef: MutableRefObject<Partial<HealthInputs>>;
  setInputs: Dispatch<SetStateAction<Partial<HealthInputs>>>;
  loaded: boolean;
  /** The form is clean: a held remote change may apply (the relay's `saved`). */
  onClean: () => void;
  writeRefused: (erase?: string) => void;
  /** The units machine (useUnits' `record`): this tab's unsaved switch, and the save that wrote one. */
  units: { pending: () => UnitSystem | undefined; saved: (system: unknown) => void };
}): ProfileSave {
  const { inputs, inputsRef, setInputs, loaded, onClean, writeRefused, units } = args;
  const saved = useRef<Partial<HealthInputs>>({});
  const [birthRefused, setBirthRefused] = useState<string | null>(null);

  // A fresh function each render: the timer runs the one from the render that scheduled it.
  async function flushProfile(erase?: string): Promise<boolean> {
    if (getBackendKind() === 'local' && localHealthWritesStopped()) return true;
    const current: Partial<HealthInputs> = {};
    const previous: Partial<HealthInputs> = {};
    // This tab's unit switch is written even when the copy saved holds it: switched,
    // the other device writing the same, then switched back, the held change would
    // otherwise apply the other device's units over this later choice (US-34 AC7a).
    const switched = units.pending() !== undefined;
    for (const field of PROFILE_FIELDS) {
      if (inputs[field] !== undefined) (current as any)[field] = inputs[field];
      if (saved.current[field] !== undefined && !(switched && field === 'unitSystem')) (previous as any)[field] = saved.current[field];
    }

    const hasChanges = switched || PROFILE_FIELDS.some(f => inputs[f] !== saved.current[f]);
    // Clean (a refused value cleared or put back): a held remote change applies now (N1).
    if (!hasChanges) { onClean(); return true; }

    const result = await saveChangedMeasurements(current, previous, erase);
    if (!result.ok) {
      writeRefused(erase);
      return false;
    }
    if (getBackendKind() === 'local' && localHealthWritesStopped()) return true;
    const refused = result.birthRefused;
    // A value out of range was refused (US-02 AC5): it stays in the form, unsaved, its error shown.
    const kept = new Set(Object.keys(result.refused ?? {}) as Array<keyof HealthInputs>);
    if (refused) { kept.add('birthYear'); kept.add('birthMonth'); }
    for (const field of PROFILE_FIELDS) {
      if (!kept.has(field)) (saved.current as any)[field] = inputs[field];
    }
    units.saved(inputs.unitSystem); // before onClean: a held change then finds the switch saved
    if (refused) {
      // US-54 AC5b: the form shows the record's pair again, unless typed over
      // since, so it is clean and a remote change still applies (US-34 AC4).
      const record = saved.current;
      setInputs(prev => (prev.birthYear === inputs.birthYear && prev.birthMonth === inputs.birthMonth
        ? { ...prev, birthYear: record.birthYear, birthMonth: record.birthMonth }
        : prev));
      setBirthRefused(birthRefusedMessage(refused.birthYear, refused.birthMonth));
    }
    // The chat copy holds the saved profile beside the saved values it
    // already has (US-15 AC10).
    patchMirror({ profile: { ...saved.current } });
    // Clean again: release a held remote change (see the header).
    if (!result.refused && !PROFILE_FIELDS.some(f => inputsRef.current[f] !== inputs[f])) onClean();
    return true;
  }

  const profileTimer = useDebouncedSave(500);
  useEffect(() => {
    if (!loaded) return;
    const erase = getShownErase(); // as the edit was made, not as the timer fires
    profileTimer.schedule(() => { void flushProfile(erase); });
    return () => profileTimer.cancel();
  }, [inputs, loaded, profileTimer]);

  const markSaved = useCallback((record: Partial<HealthInputs>) => { saved.current = { ...record }; }, []);
  const profileDirty = useCallback(() => hasUnsavedProfileEdits(inputsRef.current, saved.current), [inputsRef]);
  const clearBirthRefused = useCallback(() => setBirthRefused(null), []);

  return { flushProfile, profileTimer, markSaved, profileDirty, birthRefused, clearBirthRefused };
}
