// The unit Lp(a)'s field shows and reads typed numbers in (US-05 AC2): one of
// nmol/L, mg/dL and mg/L, as the user last chose it. The record keeps the
// choice (`profile.lpaUnit`), so it follows the user across devices.

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { isLpaUnit, recordLpaUnit, type ApiMeasurement, type LpaUnit, type UnitSystem } from '@roadmap/health-core';
import { getLpaUnit, setLpaUnit } from './roadmap-data';
import { trackProductEvent } from './server-api';
import { getJson, LPA_CHECK_KEPT_KEY, safeGetItem, setJson } from './storage';
import { REMOTE_CHANGED_EVENT } from '../storage/roadmap-store';

/**
 * The field's unit. `saved` is the record's choice, unchecked (a hand edit
 * can hold anything). With none, `legacy` is the old build's two-way toggle
 * on this device, read but never rewritten: there 'conventional' was mg/L.
 * With neither, US units give mg/dL and any other nmol/L.
 */
export function effectiveLpaUnit(saved: unknown, legacy: unknown, unitSystem: UnitSystem): LpaUnit {
  if (!isLpaUnit(saved) && legacy === 'conventional') return 'mg/L';
  if (!isLpaUnit(saved) && legacy === 'si') return 'nmol/L';
  return recordLpaUnit(saved, unitSystem);
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

// --- The Lp(a) check (US-05 AC3) ---
// From the release of 25daf668 until faf3053c went live, the US-units field
// was labelled mg/L and read at 0.24 nmol/L per mg/L, so a US lab's mg/dL
// number typed there is stored 10x low. No migration: the page asks about
// each such row.
// Start: 25daf668 (commit 03:52:52Z) went out first on GitHub Pages (Actions
// run 34081135907, released 2026-09-07T03:53:45Z), then on Shopify (Deploy
// run 34081483149, head 098815a7, ran 03:59:28Z to 04:07:03Z). A Shopify tab
// still on the old factor in that overlap, up to about 13 minutes, plus any
// tab left open, stored typed x 2.4, which reads 10x high here, so its
// buttons fall out of range or match no report: safe.
// End: faf3053c went out on Pages at 2026-10-13T02:03:48Z, and on Shopify by
// a manual release, health-roadmap-835 (prod) and health-roadmap-edu-101
// (edu), logged in the release session at 2026-10-13T02:29:15Z.
// A tab opened before the fix's release and kept open after it still ran the
// old field; a row it wrote is not asked about.
const MISLABELLED_FROM = Date.parse('2026-09-07T03:53:45Z');
const LPA_FIX_LIVE = '2026-10-13T02:30:00Z';
const OLD_NMOL_PER_MG_L = 0.24;
// The connector, the CLI and a chat prefill write these too, and stored their
// rows right; the question's number-and-unit answers keep those rows safe.
const TYPED_SOURCES: readonly unknown[] = ['manual', 'manual_correction', 'lab_import_edited'];

const keptIds = (): unknown[] => {
  const kept = getJson<unknown>(LPA_CHECK_KEPT_KEY);
  return Array.isArray(kept) ? kept : [];
};

/** The row asked about, and the number the user would have typed into the
 *  mg/L field: the stored value over 0.24, to 2 places, float noise gone
 *  (37.44 stored was 156; 10.92 was 45.5). */
export interface LpaCheck { row: ApiMeasurement; typed: number }

/** The active Lp(a) rows written by a typed path while the field was labelled
 *  mg/L, on a device in US units, where mg/L was the default. Not a device
 *  whose old toggle chose mg/L ('conventional'): that user typed real mg/L.
 *  One toggled to SI is asked: it may have typed into the default mg/L field
 *  first. Less any kept as saved on this device. */
export function lpaRowsToCheck(rows: ApiMeasurement[], unitSystem: UnitSystem): LpaCheck[] {
  if (unitSystem !== 'conventional' || legacyToggle() === 'conventional') return [];
  const kept = keptIds();
  return rows
    .filter(r => {
      const created = Date.parse(r.createdAt);
      return r.metricType === 'lpa' && r.status === 'active' && TYPED_SOURCES.includes(r.source)
        && created >= MISLABELLED_FROM && created < Date.parse(LPA_FIX_LIVE) && !kept.includes(r.id);
    })
    .map(row => ({ row, typed: Number((row.value / OLD_NMOL_PER_MG_L).toFixed(2)) }));
}

/** The report matches neither number, or its correction would save what is stored: keep the row as saved, and never ask about it again on this device. */
export function keepLpaAsIs(id: string): void {
  setJson(LPA_CHECK_KEPT_KEY, [...keptIds(), id]);
}
