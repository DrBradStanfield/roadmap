// The unit system the page shows (US-05): the saved preference, else one
// detected from the browser, and each field's own unit where the person
// switched it (kept on this device). A record's saved unit system wins at load
// and on a re-read, held while a field has the focus (useHeldUnits).
// `startUnitOf(field)`: this device's unit for a field as the page started,
// before the record's applied: a matrix draft cell kept with no unit was typed in it.
import { useCallback, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { HealthInputs } from '@roadmap/health-core/types';
import { FIELD_METRIC_MAP } from '@roadmap/health-core/mappings';
import { detectUnitSystem, type MetricType, type UnitSystem } from '@roadmap/health-core/units';
import { getJson, loadUnitPreference, safeRemoveItem, safeSetItem, saveUnitPreference } from '../lib/storage';
import { useHeldUnits } from './useHeldUnits';

/** This device's per-field unit toggles (lib/lpa-unit.ts reads its old Lp(a) entry). */
const UNIT_OVERRIDES_KEY = 'health_roadmap_unit_overrides';

/** This device's per-field unit toggles: the entries whose unit is 'si' or
 *  'conventional'. A stored value that is not a plain object reads as none,
 *  so a hand edit or an old build's junk never breaks the page (US-05 AC6). */
function loadUnitOverrides(): Record<string, UnitSystem> {
  const stored = getJson<unknown>(UNIT_OVERRIDES_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([, us]) => us === 'si' || us === 'conventional'));
}

export function useUnits(setInputs: Dispatch<SetStateAction<Partial<HealthInputs>>>, rootRef: RefObject<HTMLElement | null>) {
  // Unit system: load saved preference or auto-detect
  const [start] = useState(() => ({ system: loadUnitPreference() ?? detectUnitSystem(), overrides: loadUnitOverrides() }));
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(start.system);
  const startUnitOf = useCallback((field: string) => start.overrides[field] ?? start.system, [start]);

  // Per-field unit overrides (persisted to localStorage)
  const [unitOverrides, setUnitOverrides] = useState(start.overrides);

  // Toggle a single field's unit override
  const handleToggleFieldUnit = useCallback((field: string) => {
    setUnitOverrides(prev => {
      const current = prev[field] ?? unitSystem;
      const toggled = current === 'si' ? 'conventional' : 'si';
      const next = { ...prev };
      if (toggled === unitSystem) {
        delete next[field];
      } else {
        next[field] = toggled;
      }
      safeSetItem(UNIT_OVERRIDES_KEY, JSON.stringify(next));
      return next;
    });
  }, [unitSystem]);

  // Handle unit system change — save to localStorage and to inputs (for cloud sync)
  const handleUnitSystemChange = useCallback((system: UnitSystem) => {
    setUnitSystem(system);
    saveUnitPreference(system);
    setInputs(prev => ({ ...prev, unitSystem: system }));
    // Clear per-field overrides when global unit changes
    setUnitOverrides({});
    safeRemoveItem(UNIT_OVERRIDES_KEY);
  }, []);

  // Convert field-keyed overrides to MetricType-keyed for health-core + ResultsPanel.
  // Lp(a) has its own three-unit control (US-05 AC2): an old build's two-way
  // toggle for it is read there alone, and drives no other display.
  const metricUnitOverrides = useMemo(() => {
    const m: Partial<Record<MetricType, UnitSystem>> = {};
    for (const [field, fieldUs] of Object.entries(unitOverrides)) {
      const metric = FIELD_METRIC_MAP[field];
      if (metric && metric !== 'lpa') m[metric] = fieldUs;
    }
    return Object.keys(m).length > 0 ? m : undefined;
  }, [unitOverrides]);

  /** The record's own unit system, read at load or a re-read, wins over this device's. */
  const applySavedUnitSystem = useCallback((unitPref: unknown) => {
    if (unitPref === 'si' || unitPref === 'conventional') {
      setUnitSystem(unitPref);
      saveUnitPreference(unitPref);
    }
  }, []);
  // Shown at load; offered by a re-read, and held while a field has the focus (hooks/useHeldUnits).
  const { showUnits, offerUnits } = useHeldUnits(applySavedUnitSystem, unitSystem, rootRef);

  return { unitSystem, unitOverrides, startUnitOf, metricUnitOverrides, handleToggleFieldUnit, handleUnitSystemChange, showUnits, offerUnits };
}
