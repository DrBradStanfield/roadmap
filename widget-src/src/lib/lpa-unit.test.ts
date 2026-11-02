// @vitest-environment jsdom
// US-05 AC2: which unit Lp(a)'s field opens in. US-05 AC3: which saved Lp(a)
// rows the page asks about.
import { describe, it, expect, beforeEach } from 'vitest';
import type { ApiMeasurement, MeasurementSource, UnitSystem } from '@roadmap/health-core';
import { effectiveLpaUnit, keepLpaAsIs, lpaRowsToCheck } from './lpa-unit';
import { LPA_CHECK_KEPT_KEY, stopLocalHealthWrites } from './storage';

describe('US-05 AC2 — the unit Lp(a)’s field opens in', () => {
  it('with nothing chosen: mg/dL in US units, nmol/L in any other', () => {
    expect(effectiveLpaUnit(undefined, undefined, 'conventional')).toBe('mg/dL');
    expect(effectiveLpaUnit(undefined, undefined, 'si')).toBe('nmol/L');
  });

  it('the unit chosen in the record wins over the default and the old toggle', () => {
    expect(effectiveLpaUnit('mg/L', undefined, 'conventional')).toBe('mg/L');
    expect(effectiveLpaUnit('nmol/L', 'conventional', 'si')).toBe('nmol/L');
  });

  it('legacy: the old build’s toggle set to conventional was its mg/L; set to SI, nmol/L', () => {
    expect(effectiveLpaUnit(undefined, 'conventional', 'si')).toBe('mg/L');
    expect(effectiveLpaUnit(undefined, 'si', 'conventional')).toBe('nmol/L');
  });

  it('a value the record cannot mean (a hand edit) reads as nothing chosen', () => {
    expect(effectiveLpaUnit('mmol/L', undefined, 'conventional')).toBe('mg/dL');
    expect(effectiveLpaUnit(42, 'banana', 'si')).toBe('nmol/L');
  });
});

// US-05 AC3: from the release of 25daf668 (its GitHub Pages release went out
// at 2026-09-07T03:53:45Z, before the Shopify Deploy run) until the fix went
// live, the US-units field was labelled mg/L and read at 0.24 nmol/L per mg/L,
// so a US lab's mg/dL number typed there is stored 10x low. Each such row is
// asked about.
describe('US-05 AC3 — the Lp(a) rows the page asks about', () => {
  const LEGACY_KEY = 'health_roadmap_unit_overrides';
  beforeEach(() => localStorage.clear());
  const lpa = (over: Partial<ApiMeasurement> = {}): ApiMeasurement => ({
    id: 'r1', metricType: 'lpa', value: 37.44, recordedAt: '2026-09-18T00:00:00.000Z',
    createdAt: '2026-09-20T04:00:00.000Z', source: 'manual', status: 'active', ...over,
  });
  const asked = (row: ApiMeasurement, unitSystem: UnitSystem = 'conventional') =>
    lpaRowsToCheck([row], unitSystem).map((c) => c.row.id);

  it('a value typed into the US field in those weeks: asked, with the number typed (37.44 stored was 156)', () => {
    expect(lpaRowsToCheck([lpa()], 'conventional')).toEqual([{ row: lpa(), typed: 156 }]);
  });

  it('the number typed is rebuilt to 2 places, float noise gone, never rounded to a whole number', () => {
    expect(lpaRowsToCheck([lpa({ value: 10.92 })], 'conventional')[0].typed).toBe(45.5);
    expect(lpaRowsToCheck([lpa({ value: 2.9616 })], 'conventional')[0].typed).toBe(12.34);
  });

  it('each typed path is asked about; an import or a device feed is not', () => {
    for (const source of ['manual', 'manual_correction', 'lab_import_edited'] as MeasurementSource[]) {
      expect(asked(lpa({ source })), source).toEqual(['r1']);
    }
    for (const source of ['lab_import', 'apple_health', 'fitbit', undefined]) {
      expect(asked(lpa({ source: source as MeasurementSource })), String(source)).toEqual([]);
    }
  });

  it('the window: from the first release of 25daf668 (GitHub Pages, 2026-09-07T03:53:45Z), up to but not including the fix\'s release', () => {
    expect(asked(lpa({ createdAt: '2026-09-07T03:52:00.000Z' }))).toEqual([]); // the commit, not yet live
    expect(asked(lpa({ createdAt: '2026-09-07T03:53:44.999Z' }))).toEqual([]);
    expect(asked(lpa({ createdAt: '2026-09-07T03:53:45.000Z' }))).toEqual(['r1']);
    expect(asked(lpa({ createdAt: '2026-09-07T03:59:28.000Z' }))).toEqual(['r1']); // the Shopify Deploy run
    expect(asked(lpa({ createdAt: '2026-10-13T02:29:59.999Z' }))).toEqual(['r1']);
    expect(asked(lpa({ createdAt: '2026-10-13T02:30:00.000Z' }))).toEqual([]);
    expect(asked(lpa({ createdAt: '2026-10-20T00:00:00.000Z' }))).toEqual([]);
  });

  it('only US units, where the field showed the default US label, mg/L: a US user is asked, an SI user is not', () => {
    expect(asked(lpa(), 'conventional')).toEqual(['r1']);
    expect(asked(lpa(), 'si')).toEqual([]);
  });

  // Adversary R6. An old 'conventional' toggle was a deliberate choice of
  // the old mg/L: that user typed real mg/L numbers, stored right. An old
  // 'si' toggle is still asked: the user may have typed into the default mg/L
  // field before toggling, and the number-and-unit answers keep a row stored
  // right safe.
  it('an old mg/L toggle (conventional) excludes; an old SI toggle on a US page is still asked', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ lpa: 'conventional' }));
    expect(asked(lpa(), 'si')).toEqual([]);
    expect(asked(lpa(), 'conventional')).toEqual([]);
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ lpa: 'si' }));
    expect(asked(lpa(), 'conventional')).toEqual(['r1']);
    expect(asked(lpa(), 'si')).toEqual([]);
  });

  it('only an active Lp(a) row: an entered-in-error row, or another test, is not asked about', () => {
    expect(asked(lpa({ status: 'entered-in-error' }))).toEqual([]);
    expect(asked(lpa({ metricType: 'apob' }))).toEqual([]);
  });

  it('a row kept as it is, on this device, is not asked about again; the others still are', () => {
    keepLpaAsIs('r1');
    expect(lpaRowsToCheck([lpa(), lpa({ id: 'r2' })], 'conventional').map((c) => c.row.id)).toEqual(['r2']);
  });

  it('US-04 AC5: a row kept while the browser refuses the store is still kept on this page, so a move is not left waiting', () => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
    try {
      keepLpaAsIs('r3');
    } finally {
      Storage.prototype.setItem = setItem;
    }
    expect(localStorage.length).toBe(0);
    expect(lpaRowsToCheck([lpa({ id: 'r3' }), lpa({ id: 'r4' })], 'conventional').map((c) => c.row.id)).toEqual(['r4']);
  });

  it("US-09 AC2e: after another tab's log-off, a row kept as saved is kept on this page only, so a move is not left waiting", () => {
    stopLocalHealthWrites(); // last in this file: the latch lasts for the module's life
    keepLpaAsIs('r5');
    expect(localStorage.getItem(LPA_CHECK_KEPT_KEY)).toBeNull();
    expect(lpaRowsToCheck([lpa({ id: 'r5' }), lpa({ id: 'r6' })], 'conventional').map((c) => c.row.id)).toEqual(['r6']);
  });
});
