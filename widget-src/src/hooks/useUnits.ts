// The unit system the page shows (US-05): the saved preference, else one
// detected from the browser, and each field's own unit where the person
// switched it (kept on this device). The record's unit system wins at load
// and on a re-read, held while a field has the focus. The mode lives in one
// state (hooks/units-machine.ts); this hook sends its events and runs its effects.
// `startUnitOf(field)`: this device's unit for a field as the page started,
// before the record's applied: a matrix draft cell kept with no unit was typed in it.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { HealthInputs } from '@roadmap/health-core/types';
import { FIELD_METRIC_MAP } from '@roadmap/health-core/mappings';
import { detectUnitSystem, type MetricType, type UnitSystem } from '@roadmap/health-core/units';
import { getJson, loadUnitPreference, safeRemoveItem, safeSetItem, saveUnitPreference } from '../lib/storage';
import { heldUnits, opposite, pendingUnits, seenUnits, transition, type Units, type UnitsEvent } from './units-machine';

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

const systemOf = (value: unknown): UnitSystem | undefined => (value === 'si' || value === 'conventional' ? value : undefined);
/** This tab's switch, as the matrix hears it: re-read the cells typed by hand in `from` (lib/useBloodDraftUnits). */
export type UnitSwitchListener = (from: UnitSystem, to: UnitSystem) => void;

export function useUnits(setInputs: Dispatch<SetStateAction<Partial<HealthInputs>>>, rootRef: RefObject<HTMLElement | null>) {
  // Unit system: load saved preference or auto-detect
  const [start] = useState(() => ({ system: loadUnitPreference() ?? detectUnitSystem(), overrides: loadUnitOverrides() }));
  const startUnitOf = useCallback((field: string) => start.overrides[field] ?? start.system, [start]);
  const [units, setUnits] = useState<Units>({ mode: 'following', shown: start.system });
  // The machine's own copy, read by listeners between renders.
  const machine = useRef(units);

  // Per-field unit overrides (persisted to localStorage).
  const [unitOverrides, setUnitOverrides] = useState(start.overrides);
  const [switchListeners] = useState(() => new Set<UnitSwitchListener>());

  /** A field in the tool has the focus: an input, select or textarea. Measured as each event is sent. */
  const typing = useCallback(() => {
    const active = document.activeElement;
    return !!active && !!rootRef.current?.contains(active) && active.matches('input, select, textarea');
  }, [rootRef]);

  const dispatch = useCallback((event: UnitsEvent) => {
    const { state, effects } = transition(machine.current, event);
    if (state !== machine.current) { machine.current = state; setUnits(state); }
    for (const effect of effects) {
      if (effect.type === 'apply') saveUnitPreference(effect.system);
      else if (effect.type === 'leaveNextFrame') requestAnimationFrame(() => dispatch({ type: 'left', typing: typing() }));
      else {
        const { from, to } = effect;
        for (const listener of switchListeners) listener(from, to);
        saveUnitPreference(to);
        setInputs(prev => ({ ...prev, unitSystem: to }));
        setUnitOverrides({});
        safeRemoveItem(UNIT_OVERRIDES_KEY);
      }
    }
  }, [typing, setInputs, switchListeners]);

  // A field's own unit control: the other unit from the one the person saw (a press holds that).
  // Returns the turn, for the matrix's re-read of the cells typed by hand. A unit that equals the
  // system shown follows the system again (US-05 AC2), except while the record's units are held:
  // they apply a frame later, and the chip's unit is kept through them (US-34 AC7a, Q4).
  const handleToggleFieldUnit = useCallback((field: string) => {
    const state = machine.current;
    const from = unitOverrides[field] ?? seenUnits(state);
    const to = opposite(from);
    const next = { ...unitOverrides, [field]: to };
    if (to === state.shown && !heldUnits(state)) delete next[field];
    setUnitOverrides(next);
    safeSetItem(UNIT_OVERRIDES_KEY, JSON.stringify(next));
    return { from, to };
  }, [unitOverrides]);

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

  // The tool's unit controls (`data-unit-control`; "all" is the Units or Height pill).
  // The click is heard as it bubbles to the document, after the control's own
  // handler: a row's chip reads what the person saw while the press still holds it.
  // The focus leaving a field is read a frame later: during focusout it is on the
  // body even when it is going to another field. Nothing here cancels a default.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const control = (target: EventTarget | null) => (target instanceof Element && root.contains(target) ? target.closest('[data-unit-control]') : null);
    const cancel = () => dispatch({ type: 'cancelled', typing: typing() });
    const onPointerDown = (e: PointerEvent) => { if (control(e.target)) dispatch({ type: 'pointed' }); else cancel(); };
    const onFocusIn = (e: FocusEvent) => { if (!control(e.target)) cancel(); };
    const onClick = (e: MouseEvent) => {
      const pressed = control(e.target);
      if (pressed) dispatch({ type: 'clicked', control: pressed.getAttribute('data-unit-control') === 'all' ? 'all' : 'row' });
      else cancel();
    };
    const onFocusOut = () => requestAnimationFrame(() => dispatch({ type: 'left', typing: typing() }));
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointercancel', cancel, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('click', onClick);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointercancel', cancel, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('click', onClick);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [rootRef, dispatch, typing]);

  // H9: a focused field that unmounts sends no focusout. While units are held,
  // the field with the focus is watched, and its unmounting is a leave. Live only while holding.
  const holding = units.mode === 'holding';
  useEffect(() => {
    const root = rootRef.current;
    if (!holding || !root) return;
    let field = document.activeElement;
    const onFocusIn = (e: FocusEvent) => { field = e.target as Element; };
    const observer = new MutationObserver(() => { if (field && !field.isConnected) dispatch({ type: 'left', typing: typing() }); });
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('focusin', onFocusIn);
    return () => { observer.disconnect(); root.removeEventListener('focusin', onFocusIn); };
  }, [holding, rootRef, dispatch, typing]);

  /** This tab's switch, for the matrix's typed cells. Returns the unsubscribe. */
  const onSwitch = useCallback((listener: UnitSwitchListener) => {
    switchListeners.add(listener);
    return () => { switchListeners.delete(listener); };
  }, [switchListeners]);

  /** What the record's read and save tell the units (useRecordApply, useProfileSave, HealthTool's erase). */
  const record = useMemo(() => ({
    shown: (system: unknown) => dispatch({ type: 'shown', system: systemOf(system) }),
    offered: (system: unknown) => dispatch({ type: 'offered', system: systemOf(system), typing: typing() }),
    saved: (system: unknown) => dispatch({ type: 'saved', system: systemOf(system) }),
    erased: () => dispatch({ type: 'erased' }),
    /** This tab's switch the profile save has yet to write: it holds another writer's change (H2). */
    pending: () => pendingUnits(machine.current),
  }), [dispatch, typing]);

  return { unitSystem: units.shown, unitOverrides, startUnitOf, metricUnitOverrides, handleToggleFieldUnit, onSwitch, record };
}
