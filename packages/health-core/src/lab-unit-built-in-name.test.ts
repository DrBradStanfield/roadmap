// US-21 AC7a: a lab unit named like a built-in object property ("constructor", "__proto__") is a
// spelling the catalogue does not know, so it is refused as "bogus" is, and a stored row in it is
// left as it is. Before, it found the property instead of a factor and stored NaN. Synthetic values.
import { describe, expect, it } from 'vitest';
import { canonicalLabRow, canonicalLabValue, resolveLabCatalogEntry } from './lab-catalog';
import { addLabValue, appendLabValue, bulkAppendValues, correctValue } from './record-edits';
import { migrateFile } from './migrate';
import { createEmptyFile, type FileLabValue, type RoadmapFile } from './roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const DAY = '2026-10-01T00:00:00.000Z';
const urate = resolveLabCatalogEntry('urate')!; // stored in mmol/L, takes µmol/L and mg/dL by a factor
const row = (unit: string, value: number): FileLabValue => ({
  id: 'u1', metricName: 'urate', value, unit, referenceLow: null, referenceHigh: null, recordedAt: DAY, createdAt: NOW,
  source: 'lab_import', status: 'active', correctsId: null,
});
const record = (labValues: FileLabValue[] = []): RoadmapFile => ({ ...createEmptyFile({ deviceId: 'd', now: NOW }), labValues });

// The unit is lower-cased before the lookup, so of the built-in names only these two reach it.
// "toString" and "bogus" are controls: refused before this change and after it.
describe.each(['constructor', 'Constructor', '__proto__', 'toString', 'bogus'])('US-21 AC7a: urate in the unit "%s"', (unit) => {
  it('has no stored value in the catalogue', () => {
    expect.soft(canonicalLabValue(urate, 380, unit)).toBeNull();
    expect.soft(canonicalLabRow(urate, { value: 380, unit, referenceLow: 200, referenceHigh: 420 })).toBeNull();
  });

  it('is refused by addLabValue, appendLabValue, bulkAppendValues and correctValue, and nothing is saved', () => {
    // soft: each door is checked on its own
    expect.soft(addLabValue(record(), { metricName: 'Urate', unit, value: 380, day: '2026-10-01' }, NOW)).toMatchObject({ ok: false, reason: 'unknown-unit' });
    expect.soft(appendLabValue(record(), { metricName: 'Urate', unit, value: 380, now: NOW })).toMatchObject({ ok: false, reason: 'unknown-unit' });
    const bulk = bulkAppendValues(record(), [{ kind: 'lab', metricName: 'Urate', value: 380, unit, recordedAt: DAY, source: 'lab_import' }], NOW);
    expect.soft([bulk.saved, bulk.file.labValues, bulk.refused.map((r) => r.unit)]).toEqual([[], [], [unit]]);
    expect.soft(correctValue(record([row('mmol/L', 0.38)]), { id: 'u1', newValue: 380, unit, now: NOW })).toMatchObject({ ok: false, reason: 'unknown-unit' });
  });

  it('a stored row in that unit is left as it is at load, not corrected', () => {
    const stored = row(unit, 380);
    expect(migrateFile(JSON.parse(JSON.stringify(record([stored]))), { deviceId: 'd', now: NOW }).labValues).toEqual([stored]);
  });
});

describe('US-21 AC7a: the spellings urate takes still convert', () => {
  it('µmol/L and mg/dL convert into mmol/L, and ferritin, which has no conversions, refuses mg/dL', () => {
    expect(canonicalLabValue(urate, 380, 'µmol/L')).toEqual({ value: 0.38, unit: 'mmol/L', factor: 0.001 });
    expect(canonicalLabValue(urate, 6.4, 'mg/dL')).toEqual({ value: 0.380672, unit: 'mmol/L', factor: 0.05948 });
    expect(canonicalLabValue(urate, 0.38, 'mmol/L')).toEqual({ value: 0.38, unit: 'mmol/L', factor: 1 });
    expect(canonicalLabValue(resolveLabCatalogEntry('ferritin')!, 90, 'mg/dL')).toBeNull();
  });
});
