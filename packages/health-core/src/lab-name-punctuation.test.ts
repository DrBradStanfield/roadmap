// US-07 AC10 (Brad 2026-11-02, "Yes, all tests"): a catalogued test's name, however a
// report punctuates it, saves into that test's own slot, in its SI unit.
import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_LOOSE_NAMES, LAB_CATALOG, foldName, labSlotKey, resolveLabCatalogEntry } from './lab-catalog';
import { appendLabValue } from './record-edits';
import { createEmptyFile, type FileLabValue, type RoadmapFile } from './roadmap-file';
import { mergeFiles } from './merge';
import { migrateFile } from './migrate';

const NOW = '2026-11-02T09:00:00Z';
const empty = (): RoadmapFile => createEmptyFile({ deviceId: 'test-device', now: NOW });

function saved(file: RoadmapFile, metricName: string, value: number, unit: string, recordedAt = '2026-10-30') {
  const result = appendLabValue(file, { metricName, value, unit, recordedAt, now: NOW });
  if (!result.ok) throw new Error(`${metricName}: ${result.reason} ${result.message}`);
  return result;
}

describe('US-07 AC10: punctuated spellings of other catalogued tests', () => {
  it.each([
    ['Vitamin-D', 'vitamin_d'],
    ['Vitamin D (25-OH)', 'vitamin_d'],
    ['Vitamin D - 25 OH', 'vitamin_d'],
    ['Albumin/Creatinine Ratio', 'urine_acr'],
    ['Albumin:Creatinine ratio', 'urine_acr'],
    ['Free-T4', 'ft4'],
    ['T4 (Free)', 'ft4'],
    ['Free Thyroxine - FT4', 'ft4'],
    ['Ferritin, Serum', 'ferritin'],
    ['HS CRP', 'crp'],
    ['C-Reactive-Protein', 'crp'],
    ['Testosterone (Free)', 'free_testosterone'],
    ['Gamma-GT', 'ggt'],
  ])('"%s" is filed under %s', (printed, key) => {
    expect(resolveLabCatalogEntry(printed)?.key).toBe(key);
    expect(labSlotKey(printed)).toBe(key);
  });

  // The whole catalogue: each name with its spaces as hyphens, its last word in
  // brackets, a comma before its last word, or dots after a lone a/p+m, still
  // reaches the entry that name belongs to.
  it('every catalogue name, re-punctuated, reaches its own entry', () => {
    const variants = (n: string): string[] => {
      const words = foldName(n).split(' ');
      if (words.length < 2) return [`${n}-`, `(${n})`];
      const head = words.slice(0, -1).join(' '), last = words[words.length - 1];
      return [words.join('-'), `${head} (${last})`, `${head}, ${last}`, `${head} - ${last}`, words.join(' / ')];
    };
    const misses: string[] = [];
    for (const entry of LAB_CATALOG) {
      for (const name of [entry.key, entry.label, ...entry.aliases]) {
        const owner = resolveLabCatalogEntry(name)?.key;
        for (const v of variants(name)) {
          const got = resolveLabCatalogEntry(v)?.key;
          if (got !== owner) misses.push(`${v} -> ${got} (want ${owner})`);
        }
      }
    }
    expect(misses).toEqual([]);
    expect(AMBIGUOUS_LOOSE_NAMES).toEqual([]);
  });

  it('a punctuated name saves in the catalogue unit, converted from the printed one', () => {
    const { row } = saved(empty(), 'Vitamin-D', 30, 'ng/mL');
    expect(row).toMatchObject({ metricName: 'vitamin_d', unit: 'nmol/L' });
    expect(row.value).toBeCloseTo(74.88, 2);
  });

  it('a punctuated name and the plain one share one slot: the second save on that day is refused', () => {
    const first = saved(empty(), 'Vitamin D', 80, 'nmol/L');
    const again = appendLabValue(first.file, { metricName: 'Vitamin-D', value: 82, unit: 'nmol/L', recordedAt: '2026-10-30', now: NOW });
    expect(again).toMatchObject({ ok: false, reason: 'slot-occupied' });
  });

  it('two devices saving the same test under different punctuation merge into one active row', () => {
    const a = saved(empty(), 'Free-T4', 15, 'pmol/L').file;
    const b = saved(empty(), 'T4, Free', 16, 'pmol/L').file;
    const merged = mergeFiles(a, b, { now: NOW, deviceId: 'test-device' });
    const active = merged.labValues.filter((r: FileLabValue) => r.metricName === 'ft4' && r.status === 'active');
    expect(active).toHaveLength(1);
  });

  it('an unknown test keeps its own printed slot and unit', () => {
    const { row } = saved(empty(), 'Salivary Cortisol, Late-Night', 3.1, 'nmol/L');
    expect(row).toMatchObject({ metricName: 'salivary cortisol, late-night', unit: 'nmol/L', value: 3.1 });
  });

  it.each(['Cortisol \u2010 PM', 'Cortisol \u2011 PM', 'Cortisol \u2212 PM'])('"%s" (a PDF hyphen or minus) counts as a dash', (printed) => {
    expect(labSlotKey(printed)).toBe('cortisol_pm');
  });

  it('a row stored earlier as "Cortisol, A.M." in µg/dL loads as a converted cortisol_am row; the original is kept, flipped', () => {
    const raw = JSON.parse(JSON.stringify(empty()));
    raw.labValues = [{
      id: 'old-1', metricName: 'Cortisol, A.M.', value: 10, unit: 'µg/dL', recordedAt: '2026-06-01',
      createdAt: '2026-06-01T08:00:00Z', status: 'active', source: 'lab_import',
    }];
    const file = migrateFile(raw, { deviceId: 'test-device', now: NOW });
    const original = file.labValues.find((r) => r.id === 'old-1');
    const converted = file.labValues.find((r) => r.id === 'old-1#si');
    expect(original?.status).toBe('entered-in-error');
    expect(converted).toMatchObject({ status: 'active', unit: 'nmol/L', correctsId: 'old-1' });
    expect(converted?.value).toBeCloseTo(275.9, 1);
    expect(labSlotKey(converted!.metricName)).toBe('cortisol_am');
  });
});
