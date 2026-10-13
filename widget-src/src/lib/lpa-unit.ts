// The unit Lp(a)'s field shows and reads typed numbers in (US-05 AC2): one of
// nmol/L, mg/dL and mg/L, as the user last chose it. The record keeps the
// choice (`profile.lpaUnit`), so it follows the user across devices.

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { LPA_UNITS, type LpaUnit, type UnitSystem } from '@roadmap/health-core';
import { getLpaUnit, setLpaUnit } from './roadmap-data';
import { trackProductEvent } from './server-api';
import { safeGetItem } from './storage';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';

const isLpaUnit = (unit: unknown): unit is LpaUnit => (LPA_UNITS as readonly unknown[]).includes(unit);

/**
 * The field's unit. `saved` is the record's choice, unchecked (a hand edit
 * can hold anything). With none, `legacy` is the old build's two-way toggle
 * on this device, read but never rewritten: there 'conventional' was mg/L.
 * With neither, US units give mg/dL and any other nmol/L.
 */
export function effectiveLpaUnit(saved: unknown, legacy: unknown, unitSystem: UnitSystem): LpaUnit {
  if (isLpaUnit(saved)) return saved;
  if (legacy === 'conventional') return 'mg/L';
  if (legacy === 'si') return 'nmol/L';
  return unitSystem === 'conventional' ? 'mg/dL' : 'nmol/L';
}

/** The old build's toggle for the Lp(a) field, in HealthTool's per-field overrides. */
function legacyToggle(): unknown {
  try {
    return JSON.parse(safeGetItem('health_roadmap_unit_overrides') ?? '{}')?.lpa;
  } catch {
    return undefined;
  }
}

const listeners = new Set<() => void>();
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener(REMOTE_CHANGED_EVENT, onChange); // another device's choice, merged in
  return () => {
    listeners.delete(onChange);
    window.removeEventListener(REMOTE_CHANGED_EVENT, onChange);
  };
}

/** Write a choice to the record and show it in every Lp(a) field on the page. */
function chooseLpaUnit(unit: LpaUnit, from: LpaUnit): void {
  if (unit !== from) trackProductEvent('lpa_unit_selected', { unit, from }); // the labels, never a value
  setLpaUnit(unit);
  for (const onChange of listeners) onChange();
}

/** Lp(a)'s field unit, and how to choose another. */
export function useLpaUnit(unitSystem: UnitSystem): [LpaUnit, (unit: LpaUnit) => void] {
  const saved = useSyncExternalStore(subscribe, getLpaUnit);
  // HealthTool clears the old toggles when the unit system changes, and only then.
  const legacy = useMemo(legacyToggle, [unitSystem]);
  const unit = effectiveLpaUnit(saved, legacy, unitSystem);
  return [unit, useCallback((next: LpaUnit) => chooseLpaUnit(next, unit), [unit])];
}
