/**
 * US-21 AC28 (Brad 2026-11-15): a share of the white or red cells is a test of
 * its own, never worked out from a count and never stored as one.
 *
 * `lab-catalog.ts` spreads these entries into LAB_CATALOG and re-exports
 * `labNameForUnit`. The two files import each other, so everything the catalogue
 * reads while it loads is a function declaration (hoisted, ready before either
 * body runs); nothing here reads the catalogue until a row is filed.
 */
import { canonicalLabValue, resolveLabCatalogEntry, type LabCatalogEntry } from './lab-catalog';
import type { ValidationRange } from './units';

/** The eight shares, each with the count it is a share of (`shareOf`). */
export function shareEntries(): LabCatalogEntry[] {
  return [
    { key: 'neutrophils_pct', label: 'Neutrophils (%)', group: 'haematology', unit: '%', aliases: ['neutrophils %', 'neutrophil %', 'neut %', 'neutrophils percent'], shareOf: 'neutrophils' },
    { key: 'lymphocytes_pct', label: 'Lymphocytes (%)', group: 'haematology', unit: '%', aliases: ['lymphocytes %', 'lymphocyte %', 'lymphs %', 'lymphocytes percent'], shareOf: 'lymphocytes' },
    { key: 'monocytes_pct', label: 'Monocytes (%)', group: 'haematology', unit: '%', aliases: ['monocytes %', 'monocyte %', 'monocytes percent'], shareOf: 'monocytes' },
    { key: 'eosinophils_pct', label: 'Eosinophils (%)', group: 'haematology', unit: '%', aliases: ['eosinophils %', 'eosinophil %', 'eos %', 'eosinophils percent'], shareOf: 'eosinophils' },
    { key: 'basophils_pct', label: 'Basophils (%)', group: 'haematology', unit: '%', aliases: ['basophils %', 'basophil %', 'baso %', 'basophils percent'], shareOf: 'basophils' },
    { key: 'immature_granulocytes_pct', label: 'Immature granulocytes (%)', group: 'haematology', unit: '%', aliases: ['immature granulocytes %', 'immature grans %'], shareOf: 'immature_granulocytes' },
    { key: 'reticulocytes_pct', label: 'Reticulocytes (%)', group: 'haematology', unit: '%', aliases: ['reticulocytes %', 'reticulocyte %', 'retic %'], shareOf: 'reticulocytes' },
    // NRBC per 100 white cells is the same number as NRBC in % of the white count.
    { key: 'nrbc_per_100_wbc', label: 'NRBC (per 100 WBC)', group: 'haematology', unit: '/100 WBC', aliases: ['nrbc per 100 wbc', 'nrbc %', 'nrbc/100 wbc'], unitAliases: ['%'], shareOf: 'nrbc' },
  ];
}

/**
 * Typing-mistake bounds (US-21 AC26 rules): a share of the cells is 0 to 100.
 * NRBC per 100 WBC is a ratio, not a share, since NRBC are not counted among
 * the white cells: reported values pass 100 (up to 327), so its ceiling is 1000.
 */
export function shareRanges(): Record<string, ValidationRange> {
  const ranges: Record<string, ValidationRange> = Object.fromEntries(shareEntries().map((e) => [e.key, { min: 0, max: 100 }]));
  return { ...ranges, nrbc_per_100_wbc: { min: 0, max: 1000 } };
}

/** Each count → the test that is its share: `neutrophils` → `neutrophils_pct`. */
const SHARE_OF_COUNT: ReadonlyMap<string, LabCatalogEntry> = new Map(shareEntries().map((e) => [e.shareOf!, e]));

/**
 * The name a lab row is filed under, given its printed unit: a name that
 * resolves to a count ("Neutrophils"), printed in a unit its share takes (%),
 * is that share's key (`neutrophils_pct`); any other name comes back as it came,
 * so a printed name's own factor (BUN) is kept. Every door that takes a printed
 * name and unit reads it first (the upload's extraction, the connector's import
 * and `file_results`, `appendLabValue`, `addLabValue`, `bulkAppendValues`,
 * `sameLabQuantity`), so a report that prints both lines files both, each in
 * its own slot.
 */
export function labNameForUnit(name: string, unit: string): string {
  const share = SHARE_OF_COUNT.get(resolveLabCatalogEntry(name)?.key ?? '');
  return share && canonicalLabValue(share, 0, unit) !== null ? share.key : name;
}
