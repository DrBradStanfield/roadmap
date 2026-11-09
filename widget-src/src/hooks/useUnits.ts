// The unit system the page shows (US-05): the saved preference, else one
// detected from the browser, and each field's own unit where the person
// switched it (kept on this device). A record's saved unit system wins at load.
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { HealthInputs } from '@roadmap/health-core/types';
import { FIELD_METRIC_MAP } from '@roadmap/health-core/mappings';
import { detectUnitSystem, type MetricType, type UnitSystem } from '@roadmap/health-core/units';
import { getJson, loadUnitPreference, safeRemoveItem, safeSetItem, saveUnitPreference } from '../lib/storage';

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

export function useUnits(setInputs: Dispatch<SetStateAction<Partial<HealthInputs>>>) {
  // Unit system: load saved preference or auto-detect
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() => loadUnitPreference() ?? detectUnitSystem());

  // Per-field unit overrides (persisted to localStorage)
  const [unitOverrides, setUnitOverrides] = useState(loadUnitOverrides);

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

  /** The record's own unit system, read at load, wins over this device's. */
  const applySavedUnitSystem = useCallback((unitPref: unknown) => {
    if (unitPref === 'si' || unitPref === 'conventional') {
      setUnitSystem(unitPref);
      saveUnitPreference(unitPref);
    }
  }, []);

  return { unitSystem, unitOverrides, metricUnitOverrides, handleToggleFieldUnit, handleUnitSystemChange, applySavedUnitSystem };
}
