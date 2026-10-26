import { describe, it, expect } from 'vitest';
import { acceptedLabUnits, canonicalLabRow, displayLabUnit, canonicalLabValue, LAB_CATALOG, labCountFault, LAB_CONVERSIONS, LAB_GROUPS, labUnitRefusal, labUnitRefusalNote, labUnitTaken, resolveLabCatalogEntry, normalizeLabUnit, labSlotKey } from './lab-catalog';
import { resolveCoreMetricName } from './lab-extraction';

// US-21 · Additional blood tests — catalogue integrity (phase-1 scaffold).
describe('lab catalogue integrity (US-21)', () => {
  it('keys are unique and snake_case', () => {
    const keys = LAB_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+$/);
  });

  it('every entry belongs to a defined group', () => {
    const groups = new Set(LAB_GROUPS.map((g) => g.id));
    for (const e of LAB_CATALOG) expect(groups.has(e.group)).toBe(true);
  });

  it('no name (key, label, or alias) resolves to two different entries', () => {
    const owner = new Map<string, string>();
    for (const e of LAB_CATALOG) {
      // Within one entry, key/label/alias may coincide — dedupe before checking.
      const names = new Set([e.key, e.label.toLowerCase(), ...e.aliases]);
      for (const name of names) {
        expect(name).toBe(name.toLowerCase());
        expect(owner.get(name) ?? e.key).toBe(e.key);
        owner.set(name, e.key);
      }
    }
  });

  it('resolves aliases case-insensitively to the right entry', () => {
    expect(resolveLabCatalogEntry('Gamma GT')?.key).toBe('ggt');
    expect(resolveLabCatalogEntry('hs-CRP')?.key).toBe('crp');
    expect(resolveLabCatalogEntry('  Na+ ')?.key).toBe('sodium');
    expect(resolveLabCatalogEntry('Free T4')?.key).toBe('ft4');
    expect(resolveLabCatalogEntry('not a real test')).toBeUndefined();
  });

  it('resolves underscore-vs-space LLM extractor variance (free_t4 -> ft4)', () => {
    expect(resolveLabCatalogEntry('free_t4')?.key).toBe('ft4');
    expect(resolveLabCatalogEntry('vitamin_d')?.key).toBe('vitamin_d');
    // Whitespace runs and mixed separators fold the same way labSlotKey's
    // uncatalogued fallback folds them, so both paths agree on one slot.
    expect(resolveLabCatalogEntry('vitamin  d')?.key).toBe('vitamin_d');
    expect(resolveLabCatalogEntry('vitamin_ d')?.key).toBe('vitamin_d');
    expect(resolveLabCatalogEntry('Vitamin\tD')?.key).toBe('vitamin_d');
  });

  it('every group has at least one entry', () => {
    for (const g of LAB_GROUPS) {
      expect(LAB_CATALOG.some((e) => e.group === g.id)).toBe(true);
    }
  });
});

// US-21 units fix (found live by Brad 2026-08-14): common FBC/chemistry tests
// were uncatalogued (16-row "Other tests" dump) and unit spellings rendered
// raw ("umol/L", "x 10e9/L", ratio-vs-L/L false mixed-units flag).
describe('US-21 units fix: haematology coverage', () => {
  it('catalogues the common full-blood-count tests under haematology', () => {
    for (const [name, key] of [
      ['Haemoglobin', 'haemoglobin'], ['hb', 'haemoglobin'], ['hgb', 'haemoglobin'],
      ['Hematocrit', 'haematocrit'], ['hct', 'haematocrit'],
      ['WBC', 'wbc'], ['white cell count', 'wbc'],
      ['RBC', 'rbc'], ['red blood cell count', 'rbc'],
      ['platelet count', 'platelets'], ['plt', 'platelets'],
      ['Neutrophils', 'neutrophils'], ['Lymphocytes', 'lymphocytes'],
      ['Monocytes', 'monocytes'], ['Eosinophils', 'eosinophils'], ['Basophils', 'basophils'],
      ['MCV', 'mcv'], ['MCH', 'mch'], ['MCHC', 'mchc'], ['RDW', 'rdw'],
    ] as const) {
      const entry = resolveLabCatalogEntry(name);
      expect(entry?.key, name).toBe(key);
      expect(entry?.group, name).toBe('haematology');
    }
  });

  it('catalogues eGFR under renal and globulin under liver', () => {
    expect(resolveLabCatalogEntry('eGFR')?.group).toBe('renal');
    expect(resolveLabCatalogEntry('estimated gfr')?.key).toBe('egfr');
    expect(resolveLabCatalogEntry('Globulin')?.group).toBe('liver');
  });

  it('haematocrit is canonically L/L and accepts the "ratio" unit spelling', () => {
    const hct = resolveLabCatalogEntry('haematocrit')!;
    expect(hct.unit).toBe('L/L');
    expect(hct.unitAliases).toContain('ratio');
  });
});

describe('US-21 units fix: normalizeLabUnit (spelling only — NEVER value conversion)', () => {
  it('maps ASCII micro prefix to µ', () => {
    expect(normalizeLabUnit('umol/L')).toBe('µmol/L');
    expect(normalizeLabUnit('ug/L')).toBe('µg/L');
  });

  it('renders lab count-unit spellings with real superscripts', () => {
    expect(normalizeLabUnit('x 10e9/L')).toBe('×10⁹/L');
    expect(normalizeLabUnit('x 10e12/L')).toBe('×10¹²/L');
    expect(normalizeLabUnit('10^9/L')).toBe('×10⁹/L');
    expect(normalizeLabUnit('x10*9/L')).toBe('×10⁹/L');
  });

  it('uppercases the litre and fixes m2/m^2 in eGFR units', () => {
    expect(normalizeLabUnit('g/l')).toBe('g/L');
    expect(normalizeLabUnit('mL/min/1.73m2')).toBe('mL/min/1.73m²');
    expect(normalizeLabUnit('mL/min/1.73m^2')).toBe('mL/min/1.73m²');
  });

  it('maps Greek small mu to the micro sign (LLM extraction emits either)', () => {
    expect(normalizeLabUnit('μmol/L')).toBe('µmol/L');
  });

  it('resolves the extraction prompt’s standardized hs_crp spelling', () => {
    expect(resolveLabCatalogEntry('hs_crp')?.key).toBe('crp');
  });

  it('leaves already-canonical and unknown units untouched', () => {
    expect(normalizeLabUnit('mmol/L')).toBe('mmol/L');
    expect(normalizeLabUnit('µmol/L')).toBe('µmol/L');
    expect(normalizeLabUnit('U/L')).toBe('U/L');
    expect(normalizeLabUnit('mIU/L')).toBe('mIU/L');
    expect(normalizeLabUnit('ratio')).toBe('ratio');
    expect(normalizeLabUnit('pg')).toBe('pg');
    expect(normalizeLabUnit('%')).toBe('%');
    expect(normalizeLabUnit('')).toBe('');
  });
});

// US-31 AC5 / US-10 — every written spelling of a catalogued test resolves.
// The spaced and Title-cased forms of a snake_case key ("Vitamin D" for
// `vitamin_d`) are what an assistant and a person actually type.
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Every spelling this entry owns: key, spaced key, Title-cased spaced key,
 *  label, and each alias in both spaced and underscored form. */
const formsOf = (e: (typeof LAB_CATALOG)[number]) => {
  const spacedKey = e.key.replace(/_/g, ' ');
  return new Set([
    e.key,
    spacedKey,
    titleCase(spacedKey),
    e.label,
    ...e.aliases.flatMap((a) => [a, a.replace(/ /g, '_')]),
  ]);
};

describe('every catalogue spelling resolves (US-31 AC5)', () => {
  it.each(LAB_CATALOG)('$key resolves from key, spaced key, label and aliases', (entry) => {
    for (const form of formsOf(entry)) {
      expect(resolveLabCatalogEntry(form)?.key, form).toBe(entry.key);
      expect(labSlotKey(form), form).toBe(entry.key);
    }
  });

  it('no spelling — spaced or underscored — is claimed by two entries', () => {
    const owner = new Map<string, string>();
    for (const e of LAB_CATALOG) {
      for (const form of formsOf(e)) {
        const f = form.toLowerCase();
        expect(owner.get(f) ?? e.key, f).toBe(e.key);
        owner.set(f, e.key);
      }
    }
  });

  it('slots an uncatalogued name on its folded spelling, spaces and underscores alike', () => {
    expect(labSlotKey('  Some Novel Assay ')).toBe('some novel assay');
    expect(labSlotKey('some_novel_assay')).toBe('some novel assay');
  });
});

// ---------------------------------------------------------------------------
// US-21 phase 3 — every catalogued lab value is STORED in SI canonical units.
// ---------------------------------------------------------------------------
// Until now a lab row kept the unit its lab printed, so one test could hold a
// mg/dL row and a mmol/L row in the same series. The catalogue now carries the
// factor from every spelling it accepts to its canonical unit, and refuses a
// spelling it does not know rather than guessing the scale from the number.
describe('US-21 phase 3 — canonical SI conversion', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;

  it('US-21 phase 3 — every declared conversion row converts, and its canonical spelling is the identity', () => {
    for (const row of LAB_CONVERSIONS) {
      const entry = entryOf(row.reportedNames?.[0] ?? row.key);
      expect(row.canonical).toBe(entry.unit);
      const converted = canonicalLabValue(entry, 2, row.spelling);
      expect(converted, `${row.key} ${row.spelling}`).not.toBeNull();
      expect(converted!.unit).toBe(entry.unit);
      expect(converted!.factor).toBe(row.factor);
      expect(converted!.value).toBeCloseTo(2 * row.factor, 9);
      // Already canonical: the same number back, and converting twice is the
      // same as converting once (idempotent at load — migrate.ts leans on it).
      const again = canonicalLabValue(entry, converted!.value, entry.unit)!;
      expect(again.factor).toBe(1);
      expect(again.value).toBe(converted!.value);
    }
  });

  it('US-21 phase 3 — mg/dL reaches urea only under a nitrogen name: BUN converts, a bare "urea" is refused', () => {
    // The resolver hands back the entry the PRINTED NAME earns: "BUN" carries
    // the nitrogen factor, and mg/dL under the bare molecule name is ambiguous
    // (US nitrogen vs molecule), so it is refused rather than guessed.
    expect(canonicalLabValue(entryOf('BUN'), 14, 'mg/dL')!.value).toBeCloseTo(14 * 0.357, 6);
    expect(canonicalLabValue(entryOf('blood urea nitrogen'), 14, 'mg/dL')!.factor).toBe(0.357);
    expect(canonicalLabValue(entryOf('urea'), 14, 'mg/dL')).toBeNull();
    // Both names are one slot, and both take the canonical unit.
    expect(labSlotKey('BUN')).toBe('urea');
    expect(canonicalLabValue(entryOf('urea'), 5, 'mmol/L')!.factor).toBe(1);
  });

  it('US-21 phase 3 — prolactin in ng/mL is refused: the factor is assay-dependent', () => {
    expect(canonicalLabValue(entryOf('prolactin'), 12, 'ng/mL')).toBeNull();
    expect(canonicalLabValue(entryOf('prolactin'), 260, 'mIU/L')!.factor).toBe(1);
    // µIU/mL is the same number as mIU/L — a notation, not a conversion.
    expect(canonicalLabValue(entryOf('prolactin'), 260, 'µIU/mL')).toMatchObject({ value: 260, unit: 'mIU/L', factor: 1 });
  });

  it('US-21 phase 3 — the other spellings real reports print: UK urate, a US "urea nitrogen", LabCorp eGFR', () => {
    // A UK lab prints urate in µmol/L: a thousandth of the canonical mmol/L.
    expect(canonicalLabValue(entryOf('urate'), 380, 'µmol/L')).toMatchObject({ value: 0.38, unit: 'mmol/L' });
    expect(canonicalLabValue(entryOf('urate'), 380, 'umol/L')!.value).toBe(0.38);
    // "Urea Nitrogen" without the "Blood" is the same nitrogen, same slot, same factor.
    expect(labSlotKey('Urea Nitrogen')).toBe('urea');
    expect(canonicalLabValue(entryOf('urea nitrogen'), 18, 'mg/dL')!.factor).toBe(0.357);
    // LabCorp leaves the body-surface area off the eGFR unit.
    expect(canonicalLabValue(entryOf('eGFR'), 92, 'mL/min/1.73')).toMatchObject({ value: 92, unit: 'mL/min/1.73m²', factor: 1 });
  });

  it('US-21 phase 3 — normalizeLabUnit folds mcg to µg and uL to µL', () => {
    expect(normalizeLabUnit('mcg/dL')).toBe('µg/dL');
    expect(normalizeLabUnit('mcg/L')).toBe('µg/L');
    expect(normalizeLabUnit('K/uL')).toBe('K/µL');
    expect(normalizeLabUnit('x10e3/ul')).toBe('×10³/µL');
    expect(canonicalLabValue(entryOf('iron'), 100, 'mcg/dL')!.value).toBeCloseTo(17.9, 6);
  });

  it('US-21 phase 3 — the count spellings a haematology analyser prints are the same number', () => {
    for (const spelling of ['×10³/µL', 'K/uL', 'x10e3/uL', 'G/L', 'thou/uL', 'thousand/uL']) {
      expect(canonicalLabValue(entryOf('wbc'), 6.2, spelling), spelling).toMatchObject({ value: 6.2, unit: '×10⁹/L', factor: 1 });
    }
    for (const spelling of ['×10⁶/µL', 'M/uL', 'T/L', 'million/uL']) {
      expect(canonicalLabValue(entryOf('rbc'), 4.8, spelling), spelling).toMatchObject({ value: 4.8, unit: '×10¹²/L', factor: 1 });
    }
    expect(canonicalLabValue(entryOf('haematocrit'), 45, '%')!.value).toBe(0.45);
  });

  it('US-21 phase 3 — a spelling the catalogue does not know for that test is refused, never guessed', () => {
    expect(canonicalLabValue(entryOf('ferritin'), 210, 'pmol/L')).toBeNull();
    expect(canonicalLabValue(entryOf('tsh'), 1.8, 'ng/dL')).toBeNull();
    expect(canonicalLabValue(entryOf('ferritin'), 210, '')).toBeNull();
    // The refusal names the canonical unit and every spelling it does accept.
    const accepted = acceptedLabUnits(entryOf('ferritin'));
    expect(accepted[0]).toBe('µg/L');
    expect(accepted).toContain('ng/ml');
  });

  it('US-21 phase 3 — float noise from a factor never reaches the record', () => {
    // 0.1 * 3.671 is 0.3671000000000000… in binary; the stored number is not.
    expect(canonicalLabValue(entryOf('estradiol'), 0.1, 'pg/mL')!.value).toBe(0.3671);
    expect(canonicalLabValue(entryOf('vitamin_d'), 32, 'ng/mL')!.value).toBe(79.872);
  });
});

// ---------------------------------------------------------------------------
// US-21 AC14 — three spellings of one unit, folded for every test.
// ---------------------------------------------------------------------------
// product-health W40 `lab_unit_refused`: 10 of 25 refused key+unit pairs were
// spellings of units the catalogue already takes. "gm/dL" is g/dL, "Unit" or
// "Units" is U (a bracketed "Unit(s)" is not folded), and a cubic millimetre ("cmm", "cu mm", "cu.mm", "c.mm") is a µL. A fold is
// spelling only: it lands on a spelling the catalogue already accepts or
// refuses, so no factor changes and no conversion is new.
describe('US-21 AC14 — normalizeLabUnit folds gm/dL, Unit or Units, and cmm', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;

  it('US-21 AC14 — folds each spelling, any case, as a whole token', () => {
    expect(normalizeLabUnit('gm/dL')).toBe('g/dL');
    expect(normalizeLabUnit('gm/dl')).toBe('g/dl');
    expect(normalizeLabUnit('GM/DL')).toBe('g/DL');
    expect(normalizeLabUnit('Gm/dL')).toBe('g/dL');
    expect(normalizeLabUnit('Units/L')).toBe('U/L');
    expect(normalizeLabUnit('units/l')).toBe('U/L');
    expect(normalizeLabUnit('UNITS/L')).toBe('U/L');
    expect(normalizeLabUnit('Unit/L')).toBe('U/L');
    expect(normalizeLabUnit('10^3/cmm')).toBe('×10³/µL');
    expect(normalizeLabUnit('10^6/cmm')).toBe('×10⁶/µL');
    expect(normalizeLabUnit('10^3/CMM')).toBe('×10³/µL');
    expect(normalizeLabUnit('10^3/cu mm')).toBe('×10³/µL');
    expect(normalizeLabUnit('10^3/cu.mm')).toBe('×10³/µL');
    expect(normalizeLabUnit('10^3/c.mm')).toBe('×10³/µL');
    expect(normalizeLabUnit('x10e3/Cu.Mm')).toBe('×10³/µL');
  });

  it('US-21 AC14 — every W40 refused pair now resolves through the write path, on the existing factor', () => {
    // The path every write door takes (toStoredLab → canonicalLabRow), with a
    // range, so the bounds move by the same factor as the value (AC8).
    const stored = (name: string, value: number, unit: string, lo: number, hi: number) =>
      canonicalLabRow(entryOf(name), { value, unit, referenceLow: lo, referenceHigh: hi });
    // g/dL → g/L is the existing ×10 (a decilitre is a tenth of a litre).
    expect(entryOf('Hemoglobin').key).toBe('haemoglobin');
    expect(stored('Hemoglobin', 14.2, 'gm/dL', 13.5, 17.5)).toEqual({ stored: { value: 142, unit: 'g/L', referenceLow: 135, referenceHigh: 175 }, factor: 10 });
    expect(stored('albumin', 4.2, 'gm/dL', 3.5, 5)).toEqual({ stored: { value: 42, unit: 'g/L', referenceLow: 35, referenceHigh: 50 }, factor: 10 });
    expect(entryOf('Total Protein').key).toBe('total_protein');
    expect(stored('Total Protein', 7.1, 'gm/dL', 6, 8.3)).toEqual({ stored: { value: 71, unit: 'g/L', referenceLow: 60, referenceHigh: 83 }, factor: 10 });
    expect(stored('MCHC', 33.5, 'gm/dL', 32, 36)).toEqual({ stored: { value: 335, unit: 'g/L', referenceLow: 320, referenceHigh: 360 }, factor: 10 });
    // Units/L is U/L: the enzymes' canonical unit, factor 1.
    for (const name of ['ALT', 'AST', 'ALP']) {
      expect(stored(name, 25, 'Units/L', 7, 56), name).toEqual({ stored: { value: 25, unit: 'U/L', referenceLow: 7, referenceHigh: 56 }, factor: 1 });
    }
    // 10^3/cmm is ×10³/µL is ×10⁹/L; 10^6/cmm is ×10⁶/µL is ×10¹²/L. Factor 1.
    expect(stored('WBC', 6.2, '10^3/cmm', 4, 11)).toEqual({ stored: { value: 6.2, unit: '×10⁹/L', referenceLow: 4, referenceHigh: 11 }, factor: 1 });
    expect(stored('Platelets', 250, '10^3/cmm', 150, 400)).toEqual({ stored: { value: 250, unit: '×10⁹/L', referenceLow: 150, referenceHigh: 400 }, factor: 1 });
    expect(stored('RBC', 4.8, '10^6/cmm', 4.5, 5.9)).toEqual({ stored: { value: 4.8, unit: '×10¹²/L', referenceLow: 4.5, referenceHigh: 5.9 }, factor: 1 });
    for (const spelling of ['10^3/cu mm', '10^3/cu.mm', '10^3/c.mm']) {
      expect(canonicalLabValue(entryOf('wbc'), 6.2, spelling), spelling).toMatchObject({ value: 6.2, unit: '×10⁹/L', factor: 1 });
    }
  });

  it('US-21 AC14 — a folded spelling gets exactly the answer its canonical spelling gets, on every test', () => {
    // The whole of AC14 in one sweep: no factor changes, and a test that
    // refused the canonical spelling still refuses the folded one.
    const pairs: Array<[string, string]> = [
      ['gm/dL', 'g/dL'], ['GM/DL', 'g/dL'],
      ['Units/L', 'U/L'], ['Unit/L', 'U/L'],
      ['10^3/cmm', '×10³/µL'], ['10^6/cmm', '×10⁶/µL'], ['10^3/cu mm', '×10³/µL'],
      ['10^3/cu.mm', '×10³/µL'], ['10^3/c.mm', '×10³/µL'], ['cells/cmm', 'cells/µL'],
    ];
    for (const entry of LAB_CATALOG) {
      for (const [folded, canonical] of pairs) {
        expect(canonicalLabValue(entry, 7, folded), `${entry.key} ${folded}`).toEqual(canonicalLabValue(entry, 7, canonical));
      }
    }
    // Spot checks that refusal survives the fold.
    expect(canonicalLabValue(entryOf('tsh'), 1.8, 'Units/L')).toBeNull();
    expect(canonicalLabValue(entryOf('ferritin'), 210, 'gm/dL')).toBeNull();
    expect(canonicalLabValue(entryOf('mcv'), 90, '10^3/cmm')).toBeNull();
  });

  it('US-21 AC14 — the spellings Brad has not ruled on stay refused', () => {
    // cells/µL was on this list until AC15 ruled on it (its own block below).
    expect(canonicalLabValue(entryOf('lymphocytes'), 30, '%')).toBeNull();
    expect(normalizeLabUnit('mInt-unit(s)/mL')).toBe('mInt-unit(s)/mL');
    expect(canonicalLabValue(entryOf('tsh'), 1.8, 'mInt-unit(s)/mL')).toBeNull();
    expect(canonicalLabValue(entryOf('tsh'), 1.8, 'mInt-units/mL')).toBeNull();
    expect(canonicalLabValue(entryOf('ft4'), 2.1, 'T7 index')).toBeNull();
    expect(canonicalLabValue(entryOf('prolactin'), 12, 'ng/mL')).toBeNull();
    expect(canonicalLabValue(entryOf('urea'), 14, 'mg/dL')).toBeNull();
  });

  it('US-21 AC14 — the folds touch nothing but whole tokens', () => {
    for (const unit of [
      'mU/L', 'IU/L', 'µU/mL', 'mIU/L', 'µIU/mL', 'µmol/L', 'g/dL', 'g/L', 'mmol/L', 'U/L', 'mg/mmol', 'mg/g',
      'mm/hr', 'fL', 'pg', '%', 'mg/dL', 'pg/mL', 'ng/dL', 'kU/L', 'mInt-unit(s)/mL', 'µUnits/mL',
      'milliunits/L', 'kUnits/L', 'gm%', 'mgm/dL', 'gm/L', 'GM/L', 'mg/gm', 'gm/dL%', 'Unit(s)/L', 'mmol/mol', 'mL/min/1.73m²', 'cells/µL', 'lakhs/µL',
      // US-21 AC16: mm3 and mm³ fold only as a whole token.
      'xmm3/L', 'mm3s/L', 'cmm3', 'mm³x', '10mm3', 'mm33', 'mmm3', 'mm²',
    ]) {
      expect(normalizeLabUnit(unit), unit).toBe(unit);
    }
    expect(normalizeLabUnit('umol/L')).toBe('µmol/L');
    expect(normalizeLabUnit('uU/mL')).toBe('µU/mL');
  });

  it('US-21 AC14 — the gm fold is held to gm/dL: a bare gm/L and mg/gm are refused exactly as before', () => {
    // g/L on a count test is G/L, giga per litre; gm is only ever grams, so a
    // gm/L count must never land there.
    for (const name of ['wbc', 'platelets', 'neutrophils']) {
      expect(canonicalLabValue(entryOf(name), 6.2, 'gm/L'), name).toBeNull();
      expect(canonicalLabRow(entryOf(name), { value: 6.2, unit: 'GM/L', referenceLow: 4, referenceHigh: 11 }), name).toBeNull();
    }
    // A grams test does not take gm/L either: only the one spelling folds.
    expect(canonicalLabValue(entryOf('albumin'), 42, 'gm/L')).toBeNull();
    // mg/gm is not mg/g: urine ACR refuses it, as it did before AC14.
    expect(canonicalLabValue(entryOf('urine_acr'), 7, 'mg/gm')).toBeNull();
    expect(canonicalLabValue(entryOf('urine_acr'), 7, 'mg/g')!.factor).toBe(0.113);
  });

  it('US-21 AC14 — no spelling the catalogue accepts contains a folded token, so nothing accepted before changes', () => {
    // The folds run last in normalizeLabUnit, so they can change only an
    // output that holds a gm/dL, Unit, Units, cmm or (AC16) mm3/mm³ token. Every accepted spelling is
    // a fixed point, so no input that matched one before matches differently.
    for (const entry of LAB_CATALOG) {
      for (const spelling of [entry.unit, ...LAB_CONVERSIONS.filter((c) => c.key === entry.key).map((c) => c.spelling)]) {
        expect(normalizeLabUnit(spelling).toLowerCase(), `${entry.key} ${spelling}`).toBe(spelling.toLowerCase());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// US-21 AC15 — three more of W40's refused spellings.
// ---------------------------------------------------------------------------
// A count printed per microlitre converts at ×0.001 to ×10⁹/L (a microlitre is
// 10⁻⁶ L), but only as a whole number: cells are counted, so a decimal means
// the lab printed thousands under the wrong label. "cumm" folds to µL like
// cmm. A differential in % stays refused, and its refusal says the record
// keeps the absolute count.
describe('US-21 AC15 — cells/µL, cumm, and a differential in %', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;
  const COUNTED = ['wbc', 'neutrophils', 'lymphocytes', 'monocytes', 'eosinophils', 'basophils', 'platelets'];
  const DIFFERENTIALS = ['neutrophils', 'lymphocytes', 'monocytes', 'eosinophils', 'basophils'];

  it('US-21 AC15 — cumm folds to µL like cmm, only as a whole token', () => {
    expect(normalizeLabUnit('10^3/cumm')).toBe('×10³/µL');
    expect(normalizeLabUnit('10^6/cumm')).toBe('×10⁶/µL');
    expect(normalizeLabUnit('10^3/CUMM')).toBe('×10³/µL');
    expect(normalizeLabUnit('/cumm')).toBe('/µL');
    expect(normalizeLabUnit('cells/cumm')).toBe('cells/µL');
    expect(normalizeLabUnit('lakhs/cumm')).toBe('lakhs/µL');
    // Not inside another word.
    for (const unit of ['cummulative', 'xcumm/L', 'cumms/L', 'mg/cummx']) expect(normalizeLabUnit(unit), unit).toBe(unit);
    // Every way a report spells cells per microlitre lands on one spelling.
    for (const unit of ['cells/uL', 'cells/µL', 'cells/μL', 'cells/cmm', 'cells/cumm', 'cells/cu mm', 'Cells/uL']) {
      expect(normalizeLabUnit(unit).toLowerCase(), unit).toBe('cells/µl');
    }
  });

  it('US-21 AC15 — a whole count per µL converts at ×0.001 to ×10⁹/L, for the white cells, the differentials and platelets', () => {
    for (const key of COUNTED) {
      expect(entryOf(key).key).toBe(key);
      for (const spelling of ['cells/µL', 'cells/uL', 'cells/cmm', 'cells/cumm']) {
        expect(canonicalLabValue(entryOf(key), 2400, spelling), `${key} ${spelling}`).toEqual({ value: 2.4, unit: '×10⁹/L', factor: 0.001 });
      }
      expect(LAB_CONVERSIONS.filter((c) => c.key === key && c.spelling === 'cells/µl').map((c) => c.factor)).toEqual([0.001]);
    }
    // The range moves by the same factor as the value (AC8).
    expect(canonicalLabRow(entryOf('Neutrophils'), { value: 2400, unit: 'cells/uL', referenceLow: 1500, referenceHigh: 8000 }))
      .toEqual({ stored: { value: 2.4, unit: '×10⁹/L', referenceLow: 1.5, referenceHigh: 8 }, factor: 0.001 });
    expect(canonicalLabRow(entryOf('Platelet count'), { value: 250000, unit: 'cells/µL', referenceLow: 150000, referenceHigh: 400000 }))
      .toEqual({ stored: { value: 250, unit: '×10⁹/L', referenceLow: 150, referenceHigh: 400 }, factor: 0.001 });
    // No binary noise: 4100 × 0.001 is 4.1, not 4.1000000000000005.
    expect(canonicalLabValue(entryOf('wbc'), 4100, 'cells/cumm')!.value).toBe(4.1);
    expect(canonicalLabValue(entryOf('lymphocytes'), 1700, 'cells/µL')!.value).toBe(1.7);
    // Zero is a whole number: no basophils counted is a result.
    expect(canonicalLabValue(entryOf('basophils'), 0, 'cells/µL')).toEqual({ value: 0, unit: '×10⁹/L', factor: 0.001 });
  });

  it('US-21 AC15 — a count per µL that is not a whole number is refused, never rescaled', () => {
    for (const key of COUNTED) {
      expect(canonicalLabValue(entryOf(key), 2.4, 'cells/µL'), key).toBeNull();
      expect(canonicalLabRow(entryOf(key), { value: 2.4, unit: 'cells/uL', referenceLow: 1.5, referenceHigh: 8 }), key).toBeNull();
    }
    expect(canonicalLabValue(entryOf('platelets'), 250.5, 'cells/cumm')).toBeNull();
    // The refusal says why, from the spelling alone — no value in the text.
    const message = labUnitRefusal(entryOf('neutrophils'), 'cells/uL');
    expect(message).toContain('whole number');
    expect(message).toContain('thousands per µL (×10³/µL)');
    expect(message).not.toMatch(/\d\.\d/);
    expect(labUnitRefusalNote(entryOf('neutrophils'), 'cells/cmm')).toContain('whole number');
  });

  it('US-21 AC15 — under cells/µL a reference bound that is not a whole number refuses the row too', () => {
    // A range printed in thousands under a per-µL label would land ×0.001 too
    // small, and the result beside it would read as high when it never was.
    const row = (referenceLow: number | null, referenceHigh: number | null) =>
      canonicalLabRow(entryOf('neutrophils'), { value: 2400, unit: 'cells/uL', referenceLow, referenceHigh });
    expect(row(1500, 8000)).toEqual({ stored: { value: 2.4, unit: '×10⁹/L', referenceLow: 1.5, referenceHigh: 8 }, factor: 0.001 });
    expect(row(1.5, 8)).toBeNull();
    expect(row(1500, 8.5)).toBeNull();
    expect(row(1.5, null)).toBeNull();
    // Zero and an absent bound are fine.
    expect(canonicalLabRow(entryOf('basophils'), { value: 0, unit: 'cells/µL', referenceLow: 0, referenceHigh: 200 }))
      .toEqual({ stored: { value: 0, unit: '×10⁹/L', referenceLow: 0, referenceHigh: 0.2 }, factor: 0.001 });
    expect(row(null, null)).toEqual({ stored: { value: 2.4, unit: '×10⁹/L', referenceLow: null, referenceHigh: null }, factor: 0.001 });
    // The refusal names the range as well as the result.
    expect(labUnitRefusal(entryOf('neutrophils'), 'cells/uL')).toContain('printed range');
    // A decimal bound on any other spelling is untouched by the guard.
    expect(canonicalLabRow(entryOf('wbc'), { value: 6.2, unit: '×10³/µL', referenceLow: 4.5, referenceHigh: 11 })).not.toBeNull();
  });

  it('US-21 AC15 — under cells/µL with both bounds printed, a value a hundredfold off its own range refuses the row', () => {
    const row = (name: string, value: number, referenceLow: number | null, referenceHigh: number | null) =>
      canonicalLabRow(entryOf(name), { value, unit: 'cells/µL', referenceLow, referenceHigh });
    // A ×10³/µL range under a per-µL value, and a ×10³/µL value under a per-µL range.
    expect(row('platelets', 250000, 150, 400)).toBeNull();
    expect(row('platelets', 250, 150000, 450000)).toBeNull();
    // Real extremes pass: a check of the row against itself, not a clinical threshold.
    expect(row('wbc', 200000, 4000, 11000)).toEqual({ stored: { value: 200, unit: '×10⁹/L', referenceLow: 4, referenceHigh: 11 }, factor: 0.001 });
    expect(row('wbc', 100, 4000, 11000)).toEqual({ stored: { value: 0.1, unit: '×10⁹/L', referenceLow: 4, referenceHigh: 11 }, factor: 0.001 });
    // A low bound of 0 sets no lower limit.
    expect(row('basophils', 0, 0, 200)).toEqual({ stored: { value: 0, unit: '×10⁹/L', referenceLow: 0, referenceHigh: 0.2 }, factor: 0.001 });
    // One bound only: no magnitude check.
    expect(row('platelets', 250000, 150, null)).not.toBeNull();
    expect(row('platelets', 250000, null, 400)).not.toBeNull();
    // The limits themselves pass: exactly a hundredth of low and a hundred times high.
    expect(row('wbc', 40, 4000, 11000)).not.toBeNull();
    expect(row('wbc', 1100000, 4000, 11000)).not.toBeNull();
    expect(row('wbc', 39, 4000, 11000)).toBeNull();
    expect(row('wbc', 1100001, 4000, 11000)).toBeNull();
    // Other spellings are untouched by it.
    expect(canonicalLabRow(entryOf('platelets'), { value: 250000, unit: '×10³/µL', referenceLow: 150, referenceHigh: 400 })).not.toBeNull();
    // A unit the test takes, refused for its number, is named as such for the website's summary.
    expect(labUnitTaken(entryOf('platelets'), 'cells/cumm')).toBe(true);
    expect(labUnitTaken(entryOf('lymphocytes'), '%')).toBe(false);
    expect(labUnitTaken(undefined, 'cells/µL')).toBe(false);
  });

  // US-21 AC15 (2026-10-04 amendment): 0 reads the same on any scale, and the
  // low side guards WBC and platelets only, since real differential counts sit
  // near zero (an eosinophil count of 0, severe neutropenia).
  it('US-21 AC15 — 0 always passes, and the low-side check is for WBC and platelets only', () => {
    const row = (name: string, value: number, referenceLow: number, referenceHigh: number) =>
      canonicalLabRow(entryOf(name), { value, unit: 'cells/µL', referenceLow, referenceHigh });
    expect(row('eosinophils', 0, 15, 500)).toEqual({ stored: { value: 0, unit: '×10⁹/L', referenceLow: 0.015, referenceHigh: 0.5 }, factor: 0.001 });
    expect(row('wbc', 0, 4000, 11000)).not.toBeNull();
    expect(row('platelets', 0, 150000, 450000)).not.toBeNull();
    expect(row('neutrophils', 14, 1500, 7800)).toEqual({ stored: { value: 0.014, unit: '×10⁹/L', referenceLow: 1.5, referenceHigh: 7.8 }, factor: 0.001 });
    for (const key of DIFFERENTIALS) expect(row(key, 1, 1500, 7800), key).not.toBeNull();
    // The high side still guards every differential.
    for (const key of DIFFERENTIALS) expect(row(key, 780001, 1500, 7800), key).toBeNull();
    expect(row('platelets', 250, 150000, 450000)).toBeNull();
    expect(row('platelets', 250000, 150, 400)).toBeNull();
    expect(row('wbc', 100, 4000, 11000)).not.toBeNull();
    expect(row('wbc', 200000, 4000, 11000)).not.toBeNull();
  });

  it('US-21 AC15 — a refusal for the number says which: a decimal, or a value and range on different scales', () => {
    expect(labCountFault(entryOf('neutrophils'), { value: 2.4, unit: 'cells/uL' })).toBe('decimal');
    expect(labCountFault(entryOf('neutrophils'), { value: 2400, unit: 'cells/uL', referenceLow: 1.5, referenceHigh: 8 })).toBe('decimal');
    expect(labCountFault(entryOf('platelets'), { value: 250000, unit: 'cells/cumm', referenceLow: 150, referenceHigh: 400 })).toBe('scale');
    expect(labCountFault(entryOf('platelets'), { value: 250000, unit: 'cells/µL', referenceLow: 150000, referenceHigh: 400000 })).toBeNull();
    expect(labCountFault(entryOf('platelets'), { value: 2.5, unit: '×10³/µL', referenceLow: 150, referenceHigh: 400 })).toBeNull();

    const scale = labUnitRefusal(entryOf('platelets'), 'cells/µL', 'scale');
    expect(scale).toBe('Platelets in "cells/µL": the value and its printed range are on different scales, so the row was not stored. Ask the person to check the report; do not re-send it in another unit on your own');
    expect(labUnitRefusalNote(entryOf('platelets'), 'cells/µL', 'scale')).toBe('the value and its printed range are on different scales, so the row was not stored');
    // The assistant's copy of either asks the person; it never re-sends on its own.
    const decimal = labUnitRefusal(entryOf('platelets'), 'cells/µL', 'decimal');
    expect(decimal).toContain('whole numbers');
    expect(decimal).toContain('ask the person whether the report means thousands per µL (×10³/µL); do not re-send it in another unit on your own');
    expect(decimal).not.toContain('different scales');
    // The person's copy keeps its hint to look for the ×10³/µL line.
    expect(labUnitRefusalNote(entryOf('platelets'), 'cells/µL', 'decimal')).toContain('check whether the report means thousands per µL (×10³/µL)');
    expect(labUnitRefusalNote(entryOf('platelets'), 'cells/µL', 'decimal')).not.toContain('re-send');
    for (const message of [scale, decimal]) {
      expect(message).not.toContain('—');
      expect(message).not.toMatch(/\d{3}/);
    }
  });

  it('US-21 AC15 — RBC and the other blood-count tests do not take cells/µL', () => {
    for (const key of ['rbc', 'mcv', 'mch', 'mchc', 'rdw', 'haematocrit', 'haemoglobin']) {
      expect(canonicalLabValue(entryOf(key), 4800000, 'cells/µL'), key).toBeNull();
      expect(labUnitRefusalNote(entryOf(key), 'cells/µL'), key).toBeUndefined();
    }
  });

  it('US-21 AC15 — a differential in % stays refused, and its refusal points at the absolute count', () => {
    for (const key of DIFFERENTIALS) {
      expect(canonicalLabValue(entryOf(key), 60, '%'), key).toBeNull();
      const message = labUnitRefusal(entryOf(key), '%');
      expect(message, key).toContain('absolute count');
      expect(message, key).toContain('×10⁹/L or cells/µL');
      expect(message, key).toContain('not "%"');
      expect(message, key).toContain('Do not work the count out from the percentage');
      expect(labUnitRefusalNote(entryOf(key), '%'), key).not.toContain('Do not work');
    }
    // Only the differentials carry it: a % WBC or platelet count is not a thing a report prints.
    expect(labUnitRefusalNote(entryOf('wbc'), '%')).toBeUndefined();
    expect(labUnitRefusalNote(entryOf('platelets'), '%')).toBeUndefined();
    // Haematocrit in % is a real conversion and still converts.
    expect(canonicalLabValue(entryOf('haematocrit'), 45, '%')!.value).toBe(0.45);
    // Any other refused spelling keeps the plain message, with no note.
    expect(labUnitRefusalNote(entryOf('ferritin'), 'pmol/L')).toBeUndefined();
    expect(labUnitRefusal(entryOf('ferritin'), 'pmol/L')).toBe('Ferritin is stored in µg/L; this record takes µg/L, ng/ml, not "pmol/L"');
  });

  it('US-21 AC15 — the spellings still refused stay refused', () => {
    expect(canonicalLabValue(entryOf('platelets'), 2.5, 'lakhs/cumm')).toBeNull();
    expect(canonicalLabValue(entryOf('tsh'), 1.8, 'mInt-unit(s)/mL')).toBeNull();
    expect(canonicalLabValue(entryOf('tsh'), 1.8, 'mInt-units/mL')).toBeNull();
    expect(canonicalLabValue(entryOf('ft4'), 2.1, 'T7 index')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// US-21 AC16 — a cubic millimetre written mm3 or mm³ is a µL.
// ---------------------------------------------------------------------------
// product-health W41 `lab_unit_refused`: one upload printed platelets and WBC
// in `10^3/mm³` and RBC in `10^6/mm³` (superscript ³), and all three were
// refused. 1 mm³ is 1 µL, so mm3 and mm³ fold to µL as cmm does (AC14), but
// only as a whole-token denominator after a slash: a bare mm³ is a volume.
// A fold is spelling only: no factor changes.
describe('US-21 AC16 — mm3 and mm³ fold to µL', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;
  const PER_THOUSAND = ['wbc', 'platelets', 'neutrophils', 'lymphocytes', 'monocytes', 'eosinophils', 'basophils'];

  it('US-21 AC16 — folds mm3 and mm³, any case, only as a denominator after a slash', () => {
    expect(normalizeLabUnit('10^3/mm³')).toBe('×10³/µL');
    expect(normalizeLabUnit('10^3/mm3')).toBe('×10³/µL');
    expect(normalizeLabUnit('10^6/mm³')).toBe('×10⁶/µL');
    expect(normalizeLabUnit('10^6/mm3')).toBe('×10⁶/µL');
    expect(normalizeLabUnit('10^3/MM3')).toBe('×10³/µL');
    expect(normalizeLabUnit('x10e3/mm³')).toBe('×10³/µL');
    expect(normalizeLabUnit('cells/mm³')).toBe('cells/µL');
    expect(normalizeLabUnit('cells/mm3')).toBe('cells/µL');
    // The existing µL aliases over mm3: K, thou, thousand reach ×10⁹/L; M, million reach ×10¹²/L.
    for (const unit of ['K/mm3', 'k/mm³', 'thou/mm3', 'thousand/mm³']) {
      expect(canonicalLabValue(entryOf('wbc'), 6.2, unit), unit).toEqual({ value: 6.2, unit: '×10⁹/L', factor: 1 });
    }
    for (const unit of ['M/mm3', 'm/mm³', 'million/mm3']) {
      expect(canonicalLabValue(entryOf('rbc'), 4.8, unit), unit).toEqual({ value: 4.8, unit: '×10¹²/L', factor: 1 });
    }
  });

  it('US-21 AC16 — a bare mm³ is a volume, never folded', () => {
    // A plaque volume of 18.8 mm³ is a volume, not a denominator.
    for (const unit of ['mm³', 'mm3', 'MM3', 'cells per mm3', 'per mm³']) {
      expect(normalizeLabUnit(unit), unit).toBe(unit);
    }
    expect(normalizeLabUnit('mm3 ')).toBe('mm3');
    // An uncatalogued test reported in mm³ still displays mm³.
    expect(resolveLabCatalogEntry('plaque volume')).toBeUndefined();
    expect(displayLabUnit('mm³', resolveLabCatalogEntry('plaque volume'))).toBe('mm³');
    expect(displayLabUnit('mm3')).toBe('mm3');
  });

  it('US-21 AC16 — 10^3/mm³ reaches WBC, platelets and the differentials at ×1 to ×10⁹/L', () => {
    for (const key of PER_THOUSAND) {
      for (const spelling of ['10^3/mm³', '10^3/mm3']) {
        expect(canonicalLabValue(entryOf(key), 6.2, spelling), `${key} ${spelling}`).toEqual({ value: 6.2, unit: '×10⁹/L', factor: 1 });
      }
    }
    expect(canonicalLabRow(entryOf('Platelets'), { value: 250, unit: '10^3/mm³', referenceLow: 150, referenceHigh: 400 }))
      .toEqual({ stored: { value: 250, unit: '×10⁹/L', referenceLow: 150, referenceHigh: 400 }, factor: 1 });
    expect(canonicalLabRow(entryOf('WBC'), { value: 6.2, unit: '10^3/mm³', referenceLow: 4, referenceHigh: 11 }))
      .toEqual({ stored: { value: 6.2, unit: '×10⁹/L', referenceLow: 4, referenceHigh: 11 }, factor: 1 });
  });

  it('US-21 AC16 — 10^6/mm³ reaches RBC at ×1 to ×10¹²/L', () => {
    for (const spelling of ['10^6/mm³', '10^6/mm3']) {
      expect(canonicalLabValue(entryOf('rbc'), 4.8, spelling), spelling).toEqual({ value: 4.8, unit: '×10¹²/L', factor: 1 });
    }
    expect(canonicalLabRow(entryOf('RBC'), { value: 4.8, unit: '10^6/mm³', referenceLow: 4.5, referenceHigh: 5.9 }))
      .toEqual({ stored: { value: 4.8, unit: '×10¹²/L', referenceLow: 4.5, referenceHigh: 5.9 }, factor: 1 });
  });

  it('US-21 AC16 — cells/mm³ takes the cells/µL path: a whole number at ×0.001, a decimal refused', () => {
    for (const key of PER_THOUSAND) {
      for (const spelling of ['cells/mm³', 'cells/mm3']) {
        expect(canonicalLabValue(entryOf(key), 2400, spelling), `${key} ${spelling}`).toEqual({ value: 2.4, unit: '×10⁹/L', factor: 0.001 });
        expect(canonicalLabValue(entryOf(key), 2.4, spelling), `${key} ${spelling}`).toBeNull();
      }
    }
    // The magnitude guard and the refusal's wording come with it.
    expect(labCountFault(entryOf('platelets'), { value: 250000, unit: 'cells/mm³', referenceLow: 150, referenceHigh: 400 })).toBe('scale');
    expect(labUnitRefusalNote(entryOf('neutrophils'), 'cells/mm³')).toContain('whole number');
    expect(canonicalLabValue(entryOf('rbc'), 4800000, 'cells/mm³')).toBeNull();
  });

  it('US-21 AC16 — a folded spelling gets exactly the answer its µL spelling gets, on every test', () => {
    const pairs: Array<[string, string]> = [
      ['10^3/mm³', '×10³/µL'], ['10^3/mm3', '×10³/µL'], ['10^6/mm³', '×10⁶/µL'], ['10^6/mm3', '×10⁶/µL'],
      ['cells/mm³', 'cells/µL'], ['cells/mm3', 'cells/µL'],
    ];
    for (const entry of LAB_CATALOG) {
      for (const [folded, canonical] of pairs) {
        expect(canonicalLabValue(entry, 7, folded), `${entry.key} ${folded}`).toEqual(canonicalLabValue(entry, 7, canonical));
      }
    }
    expect(canonicalLabValue(entryOf('mcv'), 90, '10^3/mm³')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// US-21 AC22 — a power of ten in brackets or superscript, and mcL, are the
// spellings the catalogue already takes.
// ---------------------------------------------------------------------------
// product-health W43 `lab_unit_refused`: from 2026-10-20, 27 blood counts from
// 4 visitors were refused with no unit on the row, so the spelling failed both
// the catalogue and the counter's unit check. "x10(3)/uL" (a bracketed
// exponent) is the shape that does: the counter takes no digit outside a known
// construction. A fold is spelling only: no factor changes, and a test that
// refused the folded-to spelling still refuses it.
describe('US-21 AC22 — bracketed and superscript powers of ten, and mcL, fold', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;

  it('US-21 AC22 — folds each spelling to the one the catalogue takes', () => {
    const folds: Array<[string, string]> = [
      ['x10(3)/uL', '×10³/µL'], ['X10(3)/UL', '×10³/µL'], ['x10(9)/L', '×10⁹/L'], ['x 10(9)/L', '×10⁹/L'],
      ['10(9)/L', '×10⁹/L'], ['x10(12)/L', '×10¹²/L'], ['x10(6)/uL', '×10⁶/µL'], ['10(3)/uL', '×10³/µL'],
      ['10^(9)/L', '×10⁹/L'], ['x10^(3)/uL', '×10³/µL'], ['x10*(3)/uL', '×10³/µL'],
      ['x10³/µL', '×10³/µL'], ['× 10³/µL', '×10³/µL'], ['10³/µL', '×10³/µL'], ['x10⁹/L', '×10⁹/L'], ['x10¹²/L', '×10¹²/L'],
      ['x10(3)/mcL', '×10³/µL'], ['x10E3/mcL', '×10³/µL'], ['10*3/mcL', '×10³/µL'], ['K/mcL', 'K/µL'],
      ['Thousand/mcL', 'Thousand/µL'], ['cells/mcL', 'cells/µL'], ['x10(6)/mcL', '×10⁶/µL'], ['M/MCL', 'M/µL'],
    ];
    for (const [printed, folded] of folds) expect(normalizeLabUnit(printed), printed).toBe(folded);
  });

  it('US-21 AC22 — a folded spelling gets exactly the answer its folded-to spelling gets, on every test', () => {
    const pairs: Array<[string, string]> = [
      ['x10(3)/uL', '×10³/µL'], ['x10(9)/L', '×10⁹/L'], ['x10(12)/L', '×10¹²/L'], ['x10(6)/uL', '×10⁶/µL'],
      ['10^(9)/L', '×10⁹/L'], ['x10³/µL', '×10³/µL'], ['10³/µL', '×10³/µL'], ['x10(3)/mcL', '×10³/µL'],
      ['K/mcL', 'K/µL'], ['cells/mcL', 'cells/µL'],
    ];
    for (const entry of LAB_CATALOG) {
      for (const [printed, folded] of pairs) {
        expect(canonicalLabValue(entry, 7, printed), `${entry.key} ${printed}`).toEqual(canonicalLabValue(entry, 7, folded));
      }
    }
  });

  it('US-21 AC22 — the W43 blood counts save through the write path, on the existing factor', () => {
    const stored = (name: string, value: number, unit: string, lo: number, hi: number) =>
      canonicalLabRow(entryOf(name), { value, unit, referenceLow: lo, referenceHigh: hi });
    for (const name of ['WBC', 'Neutrophils', 'Lymphocytes', 'Monocytes', 'Eosinophils', 'Basophils', 'Immature granulocytes']) {
      expect(stored(name, 0.5, 'x10(3)/uL', 0.1, 1), name).toEqual({ stored: { value: 0.5, unit: '×10⁹/L', referenceLow: 0.1, referenceHigh: 1 }, factor: 1 });
    }
    expect(stored('Platelets', 250, 'x10(3)/mcL', 150, 400)).toEqual({ stored: { value: 250, unit: '×10⁹/L', referenceLow: 150, referenceHigh: 400 }, factor: 1 });
    expect(stored('RBC', 4.8, 'x10(6)/uL', 4.5, 5.9)).toEqual({ stored: { value: 4.8, unit: '×10¹²/L', referenceLow: 4.5, referenceHigh: 5.9 }, factor: 1 });
    expect(stored('WBC', 6.2, 'x10(9)/L', 4, 11)).toEqual({ stored: { value: 6.2, unit: '×10⁹/L', referenceLow: 4, referenceHigh: 11 }, factor: 1 });
    // cells/mcL is cells/µL: AC15's ×0.001 and its whole-number guard.
    expect(canonicalLabValue(entryOf('wbc'), 6200, 'cells/mcL')).toEqual({ value: 6.2, unit: '×10⁹/L', factor: 0.001 });
    expect(canonicalLabValue(entryOf('wbc'), 6.2, 'cells/mcL')).toBeNull();
    expect(labUnitTaken(entryOf('lymphocytes'), 'x10(3)/uL')).toBe(true);
  });

  it('US-21 AC22 — what is still ambiguous, or the wrong scale, stays refused', () => {
    // A blank unit is never guessed for a catalogued test.
    for (const unit of ['', ' ', '-']) expect(canonicalLabValue(entryOf('wbc'), 6.2, unit), JSON.stringify(unit)).toBeNull();
    // A superscript flattened into plain digits ("x103/uL") reads as 103: not folded.
    expect(normalizeLabUnit('x103/uL')).toBe('x103/µL');
    expect(canonicalLabValue(entryOf('wbc'), 6.2, 'x103/uL')).toBeNull();
    // The right notation on the wrong test is still the wrong scale.
    expect(canonicalLabValue(entryOf('rbc'), 4.8, 'x10(3)/uL')).toBeNull();
    expect(canonicalLabValue(entryOf('wbc'), 6.2, 'x10(6)/uL')).toBeNull();
    expect(canonicalLabValue(entryOf('mcv'), 90, 'x10(3)/mcL')).toBeNull();
    // mcL folds only as a whole token.
    for (const unit of ['mmcL', 'mcLx', 'mcl2']) expect(normalizeLabUnit(unit), unit).toBe(unit);
  });
});

// ---------------------------------------------------------------------------
// US-21 AC17 — every common blood test has a catalogue entry.
// ---------------------------------------------------------------------------
// Each test below landed in "Other tests" with its printed unit, so one test
// could hold a mg/dL row and a mmol/L row side by side. Now each is stored in
// its SI unit, through the factor for each spelling it accepts. The units and
// factors are the orchestrator's clinical decisions (2026-10-18).
describe('US-21 AC17 — the common blood tests are catalogued, in SI', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;

  // [printed name, value, printed unit, key, stored value, stored unit]
  const CONVERSIONS: Array<[string, number, string, string, number, string]> = [
    ['Fasting Glucose', 90, 'mg/dL', 'glucose', 4.9959, 'mmol/L'],
    ['Glucose', 5.2, 'mmol/L', 'glucose', 5.2, 'mmol/L'],
    ['Fasting Insulin', 60, 'pmol/L', 'insulin', 10.002, 'mIU/L'],
    ['Insulin', 8, 'uIU/mL', 'insulin', 8, 'mIU/L'],
    ['Insulin', 8, 'mU/L', 'insulin', 8, 'mIU/L'],
    ['Insulin', 8, 'uU/mL', 'insulin', 8, 'mIU/L'],
    ['Free Testosterone', 100, 'pg/mL', 'free_testosterone', 346.7, 'pmol/L'],
    ['Free Testosterone', 10, 'ng/dL', 'free_testosterone', 346.7, 'pmol/L'],
    ['Free Testosterone', 0.35, 'nmol/L', 'free_testosterone', 350, 'pmol/L'],
    ['Calculated Free Testosterone', 0.35, 'nmol/L', 'free_testosterone_calculated', 350, 'pmol/L'],
    ['Calculated Free T', 100, 'pg/mL', 'free_testosterone_calculated', 346.7, 'pmol/L'],
    ['Free Testosterone (calculated)', 10, 'ng/dL', 'free_testosterone_calculated', 346.7, 'pmol/L'],
    ['Random Glucose', 100, 'mg/dL', 'glucose_random', 5.551, 'mmol/L'],
    ['Non-fasting Glucose', 5.8, 'mmol/L', 'glucose_random', 5.8, 'mmol/L'],
    ['LH', 5, 'mIU/mL', 'lh', 5, 'IU/L'],
    ['Luteinizing Hormone', 5, 'U/L', 'lh', 5, 'IU/L'],
    ['FSH', 6, 'mIU/mL', 'fsh', 6, 'IU/L'],
    ['Follicle Stimulating Hormone', 6, 'IU/L', 'fsh', 6, 'IU/L'],
    ['Progesterone', 10, 'ng/mL', 'progesterone', 31.8, 'nmol/L'],
    ['DHEA-S', 200, 'ug/dL', 'dhea_s', 5.428, 'µmol/L'],
    ['DHEA Sulphate', 5.4, 'umol/L', 'dhea_s', 5.4, 'µmol/L'],
    ['IGF-1', 150, 'ng/mL', 'igf1', 19.605, 'nmol/L'],
    ['Apolipoprotein A1', 150, 'mg/dL', 'apoa1', 1.5, 'g/L'],
    ['Cystatin C', 0.9, 'mg/L', 'cystatin_c', 0.9, 'mg/L'],
    ['Homocysteine', 11, 'umol/L', 'homocysteine', 11, 'µmol/L'],
    ['Calcium', 9.5, 'mg/dL', 'calcium_total', 2.37025, 'mmol/L'],
    ['Total Calcium', 2.4, 'mmol/L', 'calcium_total', 2.4, 'mmol/L'],
    ['Phosphorus', 3.5, 'mg/dL', 'phosphate', 1.13015, 'mmol/L'],
    ['Direct Bilirubin', 0.2, 'mg/dL', 'bilirubin_direct', 3.42, 'µmol/L'],
    ['LDH', 180, 'IU/L', 'ldh', 180, 'U/L'],
    ['Lactate Dehydrogenase', 180, 'U/L', 'ldh', 180, 'U/L'],
    ['CK', 120, 'Units/L', 'ck', 120, 'U/L'],
    ['Creatine Kinase', 120, 'IU/L', 'ck', 120, 'U/L'],
    ['TIBC', 300, 'ug/dL', 'tibc', 53.7, 'µmol/L'],
    ['Transferrin', 250, 'mg/dL', 'transferrin', 2.5, 'g/L'],
    ['Anti-TPO', 12, 'kIU/L', 'anti_tpo', 12, 'IU/mL'],
    ['TPO Antibodies', 12, 'U/mL', 'anti_tpo', 12, 'IU/mL'],
    ['Free PSA', 0.3, 'ng/mL', 'psa_free', 0.3, 'µg/L'],
    ['Active B12', 70, 'pmol/L', 'b12_active', 70, 'pmol/L'],
    ['Urine Creatinine', 100, 'mg/dL', 'urine_creatinine', 8.84, 'mmol/L'],
    ['Protein Creatinine Ratio', 150, 'mg/g', 'urine_pcr', 16.95, 'mg/mmol'],
    // Same-scale spellings added in review (2026-10-18, adversary R2).
    ['IGF-1', 150, 'ug/L', 'igf1', 19.605, 'nmol/L'],
    ['IGF-1', 150, 'mcg/L', 'igf1', 19.605, 'nmol/L'],
    ['Urine Creatinine', 8840, 'umol/L', 'urine_creatinine', 8.84, 'mmol/L'],
    ['Protein Creatinine Ratio', 0.15, 'mg/mg', 'urine_pcr', 16.968, 'mg/mmol'],
    ['Protein Creatinine Ratio', 150, 'mg/g creat', 'urine_pcr', 16.95, 'mg/mmol'],
    ['Protein Creatinine Ratio', 150, 'mg/g creatinine', 'urine_pcr', 16.95, 'mg/mmol'],
    ['Albumin Creatinine Ratio', 30, 'mg/g creat', 'urine_acr', 3.39, 'mg/mmol'],
    ['Albumin Creatinine Ratio', 30, 'mg/g creatinine', 'urine_acr', 3.39, 'mg/mmol'],
    ['Insulin', 8, 'microIU/mL', 'insulin', 8, 'mIU/L'],
    ['Insulin', 8, 'mcIU/mL', 'insulin', 8, 'mIU/L'],
    ['TSH', 2.1, 'microIU/mL', 'tsh', 2.1, 'mIU/L'],
    ['TSH', 2.1, 'mcIU/mL', 'tsh', 2.1, 'mIU/L'],
    ['Prolactin', 250, 'microIU/mL', 'prolactin', 250, 'mIU/L'],
    ['Prolactin', 250, 'mcIU/mL', 'prolactin', 250, 'mIU/L'],
  ];

  it.each(CONVERSIONS)('US-21 AC17 — %s %s %s is stored as %s in SI', (name, value, unit, key, stored, storedUnit) => {
    const entry = resolveLabCatalogEntry(name);
    expect(entry?.key, name).toBe(key);
    expect(canonicalLabValue(entry!, value, unit), `${name} ${unit}`).toMatchObject({ value: stored, unit: storedUnit });
  });

  // Every alias the decision named, against the key it must reach.
  const ALIASES: Record<string, string[]> = {
    glucose: ['fasting glucose', 'fasting plasma glucose', 'plasma glucose', 'glucose fasting', 'blood glucose', 'fpg', 'fbg'],
    glucose_random: ['random glucose', 'glucose random', 'non-fasting glucose'],
    insulin: ['fasting insulin', 'serum insulin'],
    free_testosterone_calculated: ['calculated free testosterone', 'cft', 'calculated free t'],
    lh: ['luteinising hormone', 'luteinizing hormone'],
    fsh: ['follicle stimulating hormone'],
    progesterone: ['progesterone'],
    dhea_s: ['dheas', 'dhea sulphate', 'dhea sulfate', 'dehydroepiandrosterone sulfate', 'dehydroepiandrosterone sulphate'],
    igf1: ['igf 1', 'insulin-like growth factor 1', 'somatomedin c'],
    apoa1: ['apolipoprotein a1', 'apolipoprotein a-i', 'apo a1', 'apo a-1', 'apoa-1', 'apoa-i'],
    homocysteine: ['total homocysteine', 'plasma homocysteine'],
    calcium_total: ['calcium', 'total calcium', 'serum calcium', 'ca'],
    phosphate: ['phosphorus', 'inorganic phosphate', 'po4'],
    bilirubin_direct: ['direct bilirubin', 'conjugated bilirubin'],
    ldh: ['lactate dehydrogenase', 'ld'],
    ck: ['creatine kinase', 'cpk', 'creatine phosphokinase'],
    tibc: ['total iron binding capacity'],
    transferrin: ['transferrin'],
    anti_tpo: ['tpo antibodies', 'thyroid peroxidase antibodies', 'anti thyroid peroxidase', 'tpoab'],
    psa_free: ['free psa'],
    b12_active: ['holotranscobalamin', 'holotc'],
    urine_creatinine: ['creatinine urine', 'urinary creatinine', 'creatinine (urine)'],
    urine_pcr: ['protein creatinine ratio', 'protein:creatinine ratio', 'urine protein creatinine ratio', 'upcr'],
  };

  // These names are the entry's own key or label, which the resolver already
  // indexes folded, so the entry carries no alias that repeats them.
  const BY_KEY_OR_LABEL: Array<[string, string]> = [
    ['urine_creatinine', 'Urine creatinine'], ['cystatin_c', 'Cystatin C'], ['free_testosterone', 'Free testosterone'],
    ['b12_active', 'Active B12'], ['anti_tpo', 'Anti-TPO'], ['dhea_s', 'DHEA-S'], ['igf1', 'IGF-1'],
    ['free_testosterone_calculated', 'Free testosterone (calculated)'], ['glucose_random', 'Glucose (random)'],
  ];

  it.each(BY_KEY_OR_LABEL)('US-21 AC17 — %s resolves by its key and its label, folded', (key, label) => {
    expect(entryOf(key).label).toBe(label);
    for (const name of [key, key.replace(/_/g, ' '), label, label.toLowerCase(), label.toUpperCase().replace(/ /g, '_')]) {
      expect(resolveLabCatalogEntry(name)?.key, name).toBe(key);
      expect(labSlotKey(name), name).toBe(key);
    }
  });

  it.each(Object.entries(ALIASES))('US-21 AC17 — every spelling of %s resolves to it', (key, aliases) => {
    for (const alias of [key, ...aliases]) {
      expect(resolveLabCatalogEntry(alias)?.key, alias).toBe(key);
      expect(resolveLabCatalogEntry(alias.toUpperCase())?.key, alias).toBe(key);
      expect(labSlotKey(alias), alias).toBe(key);
    }
  });

  it('US-21 AC17 — each new test sits in its decided panel; metabolic is a group of its own', () => {
    const GROUPS: Record<string, string[]> = {
      renal: ['urine_creatinine', 'urine_pcr', 'cystatin_c'],
      hormones: ['lh', 'fsh', 'progesterone', 'dhea_s', 'igf1', 'free_testosterone', 'free_testosterone_calculated', 'psa_free'],
      thyroid: ['anti_tpo'],
      liver: ['bilirubin_direct', 'ldh'],
      vitamins: ['tibc', 'transferrin', 'b12_active', 'phosphate', 'calcium_total'],
      metabolic: ['glucose', 'glucose_random', 'insulin', 'apoa1', 'homocysteine', 'ck'],
    };
    for (const [group, keys] of Object.entries(GROUPS)) {
      for (const key of keys) expect(entryOf(key).group, key).toBe(group);
    }
    expect(LAB_GROUPS.find((g) => g.id === 'metabolic')?.label).toBe('Metabolic');
  });

  it('US-21 AC17 — a spelling the decision did not give is still refused, never guessed', () => {
    expect(canonicalLabValue(entryOf('cystatin c'), 0.9, 'mg/dL')).toBeNull();
    expect(canonicalLabValue(entryOf('homocysteine'), 11, 'mg/L')).toBeNull();
    expect(canonicalLabValue(entryOf('active b12'), 70, 'pg/mL')).toBeNull();
    expect(canonicalLabValue(entryOf('glucose'), 90, 'mg/L')).toBeNull();
  });

  it('US-21 AC17 — a calculated free testosterone and a random glucose are tests of their own, as corrected calcium is', () => {
    expect(labSlotKey('Free Testosterone')).toBe('free_testosterone');
    expect(labSlotKey('Calculated Free Testosterone')).toBe('free_testosterone_calculated');
    expect(labSlotKey('Fasting Glucose')).toBe('glucose');
    expect(labSlotKey('Random Glucose')).toBe('glucose_random');
    // Same unit and factors: a different test, not a different scale.
    expect(entryOf('free_testosterone_calculated')).toMatchObject({ unit: entryOf('free_testosterone').unit, conversions: entryOf('free_testosterone').conversions });
    expect(entryOf('glucose_random')).toMatchObject({ unit: entryOf('glucose').unit, conversions: entryOf('glucose').conversions });
  });

  it('US-21 AC12 fixed — a plain calcium is total calcium, never the corrected one', () => {
    expect(resolveLabCatalogEntry('Calcium')?.key).toBe('calcium_total');
    expect(labSlotKey('calcium')).toBe('calcium_total');
    expect(entryOf('calcium_corrected').aliases).not.toContain('calcium');
    for (const name of ['corrected calcium', 'adjusted calcium', 'Calcium (corrected)']) {
      expect(resolveLabCatalogEntry(name)?.key, name).toBe('calcium_corrected');
    }
  });

  it('US-21 AC17 — non-HDL cholesterol stays uncatalogued: the app derives it from total and HDL', () => {
    expect(resolveLabCatalogEntry('Non-HDL Cholesterol')).toBeUndefined();
    expect(resolveLabCatalogEntry('non_hdl_cholesterol')).toBeUndefined();
  });

  it('US-21 AC17 — free PSA and urine creatinine never reach the core PSA or creatinine', () => {
    for (const name of ['Free PSA', 'free_psa', 'PSA (free)', 'psa_free']) {
      expect(resolveCoreMetricName(name), name).toBeNull();
      expect(labSlotKey(name), name).toBe('psa_free');
    }
    for (const name of ['Urine Creatinine', 'Creatinine (urine)', 'creatinine urine', 'Urinary Creatinine', 'urine_creatinine']) {
      expect(resolveCoreMetricName(name), name).toBeNull();
      expect(labSlotKey(name), name).toBe('urine_creatinine');
    }
  });

  it('US-21 AC17 — no catalogue spelling is a core metric name, so the core resolver never shadows a test', () => {
    for (const entry of LAB_CATALOG) {
      for (const form of formsOf(entry)) expect(resolveCoreMetricName(form), `${entry.key}: ${form}`).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// US-21 AC19 — the tests the 2026-10-19 catalogue audit found missing.
// ---------------------------------------------------------------------------
// Brad approved the audit 2026-10-20 with the reviewer's corrections: D-dimer
// only in FEU, FTI uncatalogued, NT-proBNP in pmol/L and TRAb in U/L refused,
// osmolality under serum or plasma names only. Every factor is one molar mass
// (PubChem, or UniProt for PTH 1-84), written beside it in lab-catalog.ts.
// Record-keeping only: no suggestion reads a catalogued test.
describe('US-21 AC19 — the audit\'s missing tests are catalogued, in SI', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;

  // [printed name, value, printed unit, key, stored value, stored unit]
  const CONVERSIONS: Array<[string, number, string, string, number, string]> = [
    ['Lipase', 40, 'IU/L', 'lipase', 40, 'U/L'],
    ['Total T4', 8, 'ug/dL', 'total_t4', 102.96, 'nmol/L'],
    ['T4, Total', 8, 'mcg/dL', 'total_t4', 102.96, 'nmol/L'],
    ['Total T3', 120, 'ng/dL', 'total_t3', 1.8432, 'nmol/L'],
    ['T3, Total', 1.2, 'ng/mL', 'total_t3', 1.8432, 'nmol/L'],
    ['RDW-SD', 42, 'fL', 'rdw_sd', 42, 'fL'],
    ['T3 Uptake', 30, '%', 't3_uptake', 30, '%'],
    ['MPV', 10.2, 'fL', 'mpv', 10.2, 'fL'],
    ['Anion Gap', 12, 'mEq/L', 'anion_gap', 12, 'mmol/L'],
    ['Indirect Bilirubin', 0.5, 'mg/dL', 'bilirubin_indirect', 8.55, 'µmol/L'],
    ['PTH', 40, 'pg/mL', 'pth', 4.244, 'pmol/L'],
    ['Intact PTH', 40, 'ng/L', 'pth', 4.244, 'pmol/L'],
    ['Red Cell Folate', 500, 'ng/mL', 'red_cell_folate', 1133.0, 'nmol/L'],
    ['NT-proBNP', 100, 'pg/mL', 'nt_probnp', 100, 'ng/L'],
    ['Ionised Calcium', 4.8, 'mg/dL', 'calcium_ionised', 1.1976, 'mmol/L'],
    ['Ionized Calcium', 2.4, 'mEq/L', 'calcium_ionised', 1.2, 'mmol/L'],
    ['Immature Granulocytes', 20, 'cells/uL', 'immature_granulocytes', 0.02, '×10⁹/L'],
    ['Reticulocytes', 0.05, 'x10^12/L', 'reticulocytes', 50.0, '×10⁹/L'],
    ['NRBC', 0.01, 'K/uL', 'nrbc', 0.01, '×10⁹/L'],
    ['C-Peptide', 2, 'ng/mL', 'c_peptide', 662.2, 'pmol/L'],
    ['C-Peptide', 0.6, 'nmol/L', 'c_peptide', 600.0, 'pmol/L'],
    ['eAG', 117, 'mg/dL', 'eag', 6.49467, 'mmol/L'],
    ['UIBC', 200, 'ug/dL', 'uibc', 35.8, 'µmol/L'],
    ['Copper', 100, 'ug/dL', 'copper', 15.74, 'µmol/L'],
    ['Selenium', 120, 'ug/L', 'selenium', 1.5192, 'µmol/L'],
    ['Omega-3 Index', 8, '%', 'omega3_index', 8, '%'],
    ['AMH', 2, 'ng/mL', 'amh', 14.28, 'pmol/L'],
    ['Bioavailable Testosterone', 150, 'ng/dL', 'bioavailable_testosterone', 5.205, 'nmol/L'],
    ['% Free PSA', 20, '%', 'psa_free_percent', 20, '%'],
    ['Troponin T', 10, 'pg/mL', 'troponin_t', 10, 'ng/L'],
    ['Troponin I', 0.01, 'ng/mL', 'troponin_i', 10.0, 'ng/L'],
    ['Fibrinogen', 300, 'mg/dL', 'fibrinogen', 3.0, 'g/L'],
    ['Amylase', 60, 'U/L', 'amylase', 60, 'U/L'],
    ['Total IgA', 200, 'mg/dL', 'total_iga', 2.0, 'g/L'],
    ['tTG-IgA', 2, 'U/mL', 'ttg_iga', 2, 'U/mL'],
    ['Reverse T3', 15, 'ng/dL', 'reverse_t3', 230.4, 'pmol/L'],
    ['Reverse T3', 150, 'pg/mL', 'reverse_t3', 230.4, 'pmol/L'],
    ['Thyroglobulin', 10, 'ng/mL', 'thyroglobulin', 10, 'µg/L'],
    ['Thyroglobulin Antibodies', 4, 'kIU/L', 'anti_tg', 4, 'IU/mL'],
    ['TRAb', 1.2, 'IU/L', 'trab', 1.2, 'IU/L'],
    ['Vitamin A', 50, 'ug/dL', 'vitamin_a', 1.7455, 'µmol/L'],
    ['Vitamin E', 12, 'mg/L', 'vitamin_e', 27.864, 'µmol/L'],
    ['Vitamin E', 1.2, 'mg/dL', 'vitamin_e', 27.864, 'µmol/L'],
    ['Vitamin C', 1, 'mg/dL', 'vitamin_c', 56.78, 'µmol/L'],
    ['Vitamin B6', 10, 'ng/mL', 'vitamin_b6', 40.46, 'nmol/L'],
    ['Vitamin B1', 120, 'nmol/L', 'vitamin_b1', 120, 'nmol/L'],
    ['Methylmalonic Acid', 250, 'nmol/L', 'mma', 0.25, 'µmol/L'],
    ['Estrone', 50, 'pg/mL', 'estrone', 184.95, 'pmol/L'],
    ['Androstenedione', 100, 'ng/dL', 'androstenedione', 3.492, 'nmol/L'],
    ['Androstenedione', 1, 'ng/mL', 'androstenedione', 3.492, 'nmol/L'],
    ['17-OH Progesterone', 100, 'ng/dL', 'oh_progesterone_17', 3.026, 'nmol/L'],
    ['17-OH Progesterone', 1, 'ng/mL', 'oh_progesterone_17', 3.026, 'nmol/L'],
    ['DHT', 50, 'ng/dL', 'dht', 1.7215, 'nmol/L'],
    ['DHT', 500, 'pg/mL', 'dht', 1.7215, 'nmol/L'],
    ['VLDL Cholesterol', 20, 'mg/dL', 'vldl', 0.5172, 'mmol/L'],
    ['eGFR (cystatin C)', 90, 'mL/min/1.73m2', 'egfr_cystatin', 90, 'mL/min/1.73m²'],
    ['eGFR (creatinine-cystatin C)', 90, 'mL/min/1.73', 'egfr_combined', 90, 'mL/min/1.73m²'],
    ['D-Dimer', 0.4, 'ug/mL FEU', 'd_dimer', 0.4, 'mg/L FEU'],
    ['D-Dimer', 400, 'ng/mL FEU', 'd_dimer', 0.4, 'mg/L FEU'],
    ['D-Dimer', 400, 'ng/mL (FEU)', 'd_dimer', 0.4, 'mg/L FEU'],
    ['Lactate', 9, 'mg/dL', 'lactate', 0.999, 'mmol/L'],
    ['Serum Osmolality', 290, 'mOsm/kg', 'osmolality_serum', 290, 'mOsm/kg'],
    ['Procalcitonin', 0.05, 'ng/mL', 'procalcitonin', 0.05, 'µg/L'],
    ['IgE', 50, 'IU/mL', 'ige', 50, 'kU/L'],
    ['Rheumatoid Factor', 10, 'IU/mL', 'rf', 10, 'IU/mL'],
    ['Anti-CCP', 5, 'U/mL', 'anti_ccp', 5, 'U/mL'],
    ['Fructosamine', 250, 'umol/L', 'fructosamine', 250, 'µmol/L'],
    ['Soluble Transferrin Receptor', 1.2, 'mg/L', 'stfr', 1.2, 'mg/L'],
    ['ACTH', 20, 'pg/mL', 'acth', 4.404, 'pmol/L'],
    ['Growth Hormone', 1, 'ng/mL', 'gh', 1, 'µg/L'],
    ['hCG', 5, 'mIU/mL', 'hcg', 5, 'IU/L'],
    ['Caeruloplasmin', 30, 'mg/dL', 'caeruloplasmin', 0.3, 'g/L'],
    ['BNP', 50, 'pg/mL', 'bnp', 50, 'ng/L'],
  ];

  it.each(CONVERSIONS)('US-21 AC19 — %s %s %s is stored as %s in SI', (name, value, unit, key, stored, storedUnit) => {
    const entry = resolveLabCatalogEntry(name);
    expect(entry?.key, name).toBe(key);
    expect(canonicalLabValue(entry!, value, unit), `${name} ${unit}`).toMatchObject({ value: stored, unit: storedUnit });
  });

  it('US-21 AC19 — each new test sits in its panel', () => {
    const GROUPS: Record<string, string[]> = {
      renal: ['anion_gap', 'egfr_cystatin', 'egfr_combined', 'osmolality_serum'],
      liver: ['lipase', 'bilirubin_indirect', 'amylase'],
      haematology: ['rdw_sd', 'mpv', 'immature_granulocytes', 'reticulocytes', 'nrbc', 'd_dimer', 'fibrinogen'],
      thyroid: ['total_t4', 'total_t3', 't3_uptake', 'reverse_t3', 'thyroglobulin', 'anti_tg', 'trab'],
      hormones: ['pth', 'amh', 'bioavailable_testosterone', 'psa_free_percent', 'estrone', 'androstenedione', 'oh_progesterone_17', 'dht', 'acth', 'gh', 'hcg'],
      vitamins: ['red_cell_folate', 'calcium_ionised', 'uibc', 'copper', 'selenium', 'omega3_index', 'vitamin_a', 'vitamin_e', 'vitamin_c', 'vitamin_b6', 'vitamin_b1', 'mma', 'caeruloplasmin', 'stfr'],
      inflammation: ['procalcitonin', 'ige', 'rf', 'anti_ccp', 'total_iga', 'ttg_iga'],
      metabolic: ['nt_probnp', 'bnp', 'troponin_t', 'troponin_i', 'c_peptide', 'eag', 'vldl', 'lactate', 'fructosamine'],
    };
    for (const [group, keys] of Object.entries(GROUPS)) {
      for (const key of keys) expect(resolveLabCatalogEntry(key)?.group, key).toBe(group);
    }
  });

  it('US-21 AC19 — D-dimer converts only in FEU: a bare mass unit or DDU is refused', () => {
    for (const unit of ['ng/mL', 'ug/mL', 'mg/L', 'ng/mL DDU', 'µg/L DDU']) {
      expect(canonicalLabValue(entryOf('D-dimer'), 400, unit), unit).toBeNull();
    }
    expect(acceptedLabUnits(entryOf('d_dimer')).every((u) => /feu/i.test(u))).toBe(true);
  });

  it('US-21 AC19 — NT-proBNP and BNP in pmol/L, and TRAb in U/L, are refused', () => {
    expect(canonicalLabValue(entryOf('NT-proBNP'), 12, 'pmol/L')).toBeNull();
    expect(canonicalLabValue(entryOf('BNP'), 12, 'pmol/L')).toBeNull();
    expect(canonicalLabValue(entryOf('TRAb'), 1.2, 'U/L')).toBeNull();
  });

  it('US-21 AC19 — osmolality resolves only under a serum or plasma name: a urine one is never this test', () => {
    for (const name of ['Serum Osmolality', 'Plasma Osmolality', 'Osmolality, Serum', 'Osmolality (plasma)', 'osmolality_serum']) {
      expect(resolveLabCatalogEntry(name)?.key, name).toBe('osmolality_serum');
    }
    for (const name of ['Osmolality', 'Urine Osmolality', 'Osmolality, Urine']) expect(resolveLabCatalogEntry(name), name).toBeUndefined();
  });

  it('US-21 AC19 — what the audit left out stays uncatalogued: FTI, the unitless ratios, INR, PT, APTT, bare T4, T3 and troponin', () => {
    for (const name of ['Free Thyroxine Index', 'FTI', 'T7', 'T7 Index', 'Cholesterol (total/HDL)', 'Chol/HDL Ratio', 'INR', 'PT', 'APTT',
      'Free Androgen Index', 'HOMA-IR', 'A/G Ratio', 'BUN/Creatinine Ratio', 'T4', 'T3', 'Troponin', 'Base Excess', 'Lymphs', 'Eos', 'Baso']) {
      expect(resolveLabCatalogEntry(name), name).toBeUndefined();
    }
  });

  it('US-21 AC19 — a new test beside an old one is a test of its own, never one slot', () => {
    const PAIRS: Array<[string, string]> = [
      ['Red Cell Folate', 'Serum Folate'], ['Ionised Calcium', 'Calcium'], ['Ionised Calcium', 'Corrected Calcium'],
      ['RDW-SD', 'RDW'], ['eGFR (cystatin C)', 'eGFR'], ['eGFR (creatinine-cystatin C)', 'eGFR'], ['eGFR (cystatin C)', 'Cystatin C'],
      ['Total T4', 'Free T4'], ['Total T3', 'Free T3'], ['Reverse T3', 'Free T3'], ['Troponin T', 'Troponin I'],
      ['BNP', 'NT-proBNP'], ['Bioavailable Testosterone', 'Free Testosterone'], ['Indirect Bilirubin', 'Bilirubin'],
      ['% Free PSA', 'Free PSA'], ['UIBC', 'TIBC'], ['Anti-Tg', 'Thyroglobulin'],
    ];
    for (const [a, b] of PAIRS) {
      expect(resolveLabCatalogEntry(a), a).toBeDefined();
      expect(resolveLabCatalogEntry(b), b).toBeDefined();
      expect(labSlotKey(a), a).not.toBe(labSlotKey(b));
    }
  });

  it('US-21 AC19 — the AMH factor is the 140 kDa convention; reticulocytes take ×10⁹/L and ×10¹²/L, never %', () => {
    expect(canonicalLabValue(entryOf('AMH'), 1, 'ng/mL')).toMatchObject({ factor: 7.14 });
    expect(canonicalLabValue(entryOf('Reticulocytes'), 50, '×10⁹/L')).toMatchObject({ value: 50, factor: 1 });
    expect(canonicalLabValue(entryOf('Reticulocytes'), 1.2, '%')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// US-21 AC20 — the spellings real reports print for tests the record holds.
// ---------------------------------------------------------------------------
describe('US-21 AC20 — comma, bracket and "absolute" spellings reach their test; Brad\'s own HDL and LDL reach the core', () => {
  const ALIASES: Record<string, string[]> = {
    bilirubin_total: ['Bilirubin, Total'], bilirubin_direct: ['Bilirubin, Direct'], total_protein: ['Protein, Total'],
    globulin: ['Globulin, Total'], bicarbonate: ['Carbon Dioxide, Total', 'Carbon Dioxide'], iron: ['Iron, Total'],
    glucose: ['Glucose, Fasting'], folate: ['Folate, Serum'], ft4: ['T4, Free', 'Free T4 (FT4)', 'Free Thyroxine (FT4)'],
    ft3: ['T3, Free'], testosterone_total: ['Testosterone, Total'], free_testosterone: ['Testosterone, Free'],
    psa_free: ['PSA, Free'], cortisol_am: ['Cortisol, AM'], crp: ['CRP, High Sensitivity', 'Cardiac CRP', 'C Reactive Protein'],
    esr: ['Sedimentation Rate'], vitamin_d: ['Vitamin D, 25-Hydroxy', '25-Hydroxy Vitamin D', '25 OH Vitamin D', 'Vitamin D (25 OH)'],
    alt: ['ALT (SGPT)'], ast: ['AST (SGOT)'], ggt: ['Gamma GT (GGT)'], alp: ['Alk Phos', 'Alk. Phosphatase'], rdw: ['RDW-CV', 'RDW CV'],
    tibc: ['Iron Binding Capacity'], anti_tpo: ['Thyroid Peroxidase (TPO) Ab'], tsh: ['TSH (Thyroid Stimulating Hormone)'],
    haemoglobin: ['Haemoglobin (Hb)'], haematocrit: ['Haematocrit (HCT)'], shbg: ['SHBG (Sex Hormone Binding Globulin)'],
    ferritin: ['Ferritin (serum)'], vitamin_b12: ['Vitamin B12 (Cobalamin)'], egfr: ['eGFR (CKD-EPI)'],
    transferrin_sat: ['Transferrin saturation %'], urea: ['Urea Nitrogen (BUN)', 'Urea (BUN)'],
    neutrophils: ['Neutrophils (Absolute)', 'Absolute Neutrophils', 'Neutrophils Abs'],
    lymphocytes: ['Lymphocytes (Absolute)', 'Absolute Lymphocytes', 'Lymphocytes Abs', 'Lymphs (Absolute)'],
    monocytes: ['Monocytes (Absolute)', 'Absolute Monocytes', 'Monocytes Abs', 'Monocytes(Absolute)'],
    eosinophils: ['Eosinophils (Absolute)', 'Absolute Eosinophils', 'Eosinophils Abs', 'Eos (Absolute)'],
    basophils: ['Basophils (Absolute)', 'Absolute Basophils', 'Basophils Abs', 'Baso (Absolute)'],
  };

  it.each(Object.entries(ALIASES))('US-21 AC20 — the printed spellings of %s resolve to it', (key, names) => {
    for (const name of names) {
      expect(resolveLabCatalogEntry(name)?.key, name).toBe(key);
      expect(labSlotKey(name), name).toBe(key);
      expect(resolveCoreMetricName(name), name).toBeNull();
    }
  });

  it('US-21 AC20 — BUN\'s mg/dL factor needs a name that says nitrogen: "Urea (BUN)" in mg/dL is refused', () => {
    expect(canonicalLabValue(resolveLabCatalogEntry('Urea Nitrogen (BUN)')!, 15, 'mg/dL')).toMatchObject({ value: 5.355, unit: 'mmol/L' });
    expect(canonicalLabValue(resolveLabCatalogEntry('Urea (BUN)')!, 15, 'mg/dL')).toBeNull();
    expect(canonicalLabValue(resolveLabCatalogEntry('Urea (BUN)')!, 5.4, 'mmol/L')).toMatchObject({ value: 5.4, unit: 'mmol/L' });
  });

  it('US-21 AC20 — Brad\'s lab\'s HDL and LDL names, and the other core spellings the audit found, reach the core metric', () => {
    const CORE: Array<[string, string]> = [
      ['Cholesterol (HDL)', 'hdl'], ['HDL-Cholesterol', 'hdl'],
      ['Cholesterol (LDL) (calculated)', 'ldl'], ['LDL-Cholesterol', 'ldl'], ['LDL Chol Calc (NIH)', 'ldl'],
      ['Glycated haemoglobin (HbA1c)', 'hba1c'], ['PSA, Total', 'psa'], ['Prostate Specific Ag', 'psa'],
    ];
    for (const [name, metric] of CORE) {
      expect(resolveCoreMetricName(name), name).toBe(metric);
      expect(resolveLabCatalogEntry(name), name).toBeUndefined();
    }
    // Exact match only: the ratio printed on the same report is not HDL.
    expect(resolveCoreMetricName('Cholesterol (total/HDL)')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// US-21 AC19/AC20 review round (2026-10-20, Opus adversary + Codex).
// ---------------------------------------------------------------------------
describe('US-21 AC19/AC20 — review round: osmolality and reverse T3 spellings, count notes, printed names', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;

  it('US-21 AC19 — serum osmolality takes mmol/kg and mOsmol/kg as mOsm/kg; reverse T3 takes nmol/L at ×1000', () => {
    expect(canonicalLabValue(entryOf('Serum Osmolality'), 290, 'mmol/kg')).toMatchObject({ value: 290, unit: 'mOsm/kg', factor: 1 });
    expect(canonicalLabValue(entryOf('Serum Osmolality'), 290, 'mOsmol/kg')).toMatchObject({ value: 290, unit: 'mOsm/kg', factor: 1 });
    expect(canonicalLabValue(entryOf('Reverse T3'), 0.23, 'nmol/L')).toMatchObject({ value: 230, unit: 'pmol/L', factor: 1000 });
  });

  it('US-21 AC19 — immature granulocytes, reticulocytes and NRBC in % or per 100 WBC are refused with a note pointing at the count', () => {
    for (const [name, unit, phrase] of [
      ['Immature Granulocytes', '%', 'share of the white count'],
      ['Reticulocytes', '%', 'share of the red cells'],
      ['NRBC', '%', 'per 100 white cells'],
      ['NRBC', '/100 WBC', 'per 100 white cells'],
    ] as const) {
      expect(canonicalLabValue(entryOf(name), 1, unit), `${name} ${unit}`).toBeNull();
      expect(labUnitRefusalNote(entryOf(name), unit), `${name} ${unit}`).toContain(phrase);
      expect(labUnitRefusal(entryOf(name), unit), `${name} ${unit}`).toContain('Do not work the count out');
    }
  });

  it('US-21 AC19/AC20 — "Immature Grans (Abs)" and "Plasma Testosterone" reach their tests', () => {
    expect(labSlotKey('Immature Grans (Abs)')).toBe('immature_granulocytes');
    expect(labSlotKey('Plasma Testosterone')).toBe('testosterone_total');
    expect(canonicalLabValue(entryOf('Plasma Testosterone'), 500, 'ng/dL')).toMatchObject({ value: 17.35, unit: 'nmol/L' });
  });

  // What a printed BUN in mg/dL does today, by the name it arrives under. The
  // assistant routes store the printed name; the website's extractor names a
  // urea row `urea` (the prompt is unchanged until the #166 benchmark), so a
  // website BUN in mg/dL is still refused there.
  it.each([
    ['BUN', 5.355], ['Urea Nitrogen', 5.355], ['Blood Urea Nitrogen (BUN)', 5.355], ['blood_urea_nitrogen', 5.355],
    ['Urea (BUN)', null], ['urea', null],
  ] as const)('US-21 AC20 — "%s" 15 mg/dL is stored as %s mmol/L (null: refused)', (name, stored) => {
    expect(labSlotKey(name)).toBe('urea');
    const result = canonicalLabValue(entryOf(name), 15, 'mg/dL');
    if (stored === null) expect(result).toBeNull();
    else expect(result).toMatchObject({ value: stored, unit: 'mmol/L' });
  });
});

// ---------------------------------------------------------------------------
// US-21 AC21 — a value no human sample reaches is a unit printed a prefix away
// (Brad 2026-10-20: a real sheet printed free testosterone in "nmol/L" with a
// pmol/L number and range, which converted ×1000 to an impossible result).
// ---------------------------------------------------------------------------
describe('US-21 AC21 — a per-test ceiling refuses a mislabelled prefix', () => {
  const entryOf = (name: string) => resolveLabCatalogEntry(name)!;
  const NOTE = 'Free testosterone above 10,000 pmol/L is not a measured value, so the printed unit is probably wrong (nmol/L vs pmol/L). Check the report, then add it in pmol/L with + Add a blood test';

  it('US-21 AC21 — free T 312.6 nmol/L with range 163–473 nmol/L is refused, never rescaled', () => {
    const row = { value: 312.6, unit: 'nmol/L', referenceLow: 163, referenceHigh: 473 };
    expect(canonicalLabRow(entryOf('Free Testosterone'), row)).toBeNull();
    expect(labCountFault(entryOf('Free Testosterone'), row)).toBe('ceiling');
  });

  it('US-21 AC21 — free T 0.45 nmol/L converts to 450 pmol/L; 312 pmol/L is stored as printed', () => {
    expect(canonicalLabRow(entryOf('Free Testosterone'), { value: 0.45, unit: 'nmol/L', referenceLow: 0.163, referenceHigh: 0.473 }))
      .toEqual({ stored: { value: 450, unit: 'pmol/L', referenceLow: 163, referenceHigh: 473 }, factor: 1000 });
    expect(canonicalLabRow(entryOf('Free Testosterone'), { value: 312, unit: 'pmol/L', referenceLow: 163, referenceHigh: 473 }))
      .toMatchObject({ stored: { value: 312, unit: 'pmol/L' }, factor: 1 });
  });

  it('US-21 AC21 — a value in range is refused when the printed high bound converts above the ceiling', () => {
    // 5 nmol/L is 5000 pmol/L, under the ceiling; 473 nmol/L is not.
    const row = { value: 5, unit: 'nmol/L', referenceLow: 163, referenceHigh: 473 };
    expect(canonicalLabRow(entryOf('Free Testosterone'), row)).toBeNull();
    expect(labCountFault(entryOf('Free Testosterone'), row)).toBe('ceiling');
  });

  // Review R1 (2026-10-20): the ceiling catches a WRONG CONVERSION, so a row
  // printed in the canonical unit is never refused by it (a real free T on
  // heavy androgen use can pass 10,000 pmol/L).
  it('US-21 AC21 — only a converted row meets the ceiling: 11,000 pmol/L is stored, 11 nmol/L is refused', () => {
    expect(canonicalLabRow(entryOf('Free Testosterone'), { value: 11000, unit: 'pmol/L', referenceLow: 163, referenceHigh: 473 }))
      .toMatchObject({ stored: { value: 11000, unit: 'pmol/L' }, factor: 1 });
    expect(labCountFault(entryOf('Free Testosterone'), { value: 11000, unit: 'pmol/L' })).toBeNull();
    expect(canonicalLabRow(entryOf('Free Testosterone'), { value: 11, unit: 'nmol/L' })).toBeNull();
    expect(labCountFault(entryOf('Free Testosterone'), { value: 11, unit: 'nmol/L' })).toBe('ceiling');
    // The range-high trigger likewise: a canonical high bound past the ceiling stores.
    expect(canonicalLabRow(entryOf('Free Testosterone'), { value: 300, unit: 'pmol/L', referenceLow: 163, referenceHigh: 12000 }))
      .toMatchObject({ stored: { value: 300, referenceHigh: 12000 }, factor: 1 });
    expect(canonicalLabRow(entryOf('Reticulocytes'), { value: 2500, unit: 'G/L' })).toMatchObject({ stored: { value: 2500 }, factor: 1 });
    // A real unit that is not a prefix step is never blamed: a US lab's 2,900 pg/mL is 10,054 pmol/L.
    expect(labCountFault(entryOf('Free Testosterone'), { value: 2900, unit: 'pg/mL' })).toBeNull();
    expect(canonicalLabRow(entryOf('Free Testosterone'), { value: 2900, unit: 'pg/mL' })).toMatchObject({ stored: { value: 10054.3 } });
  });

  it('US-21 AC21 — the other prefix-reachable tests carry their ceilings; troponin carries none', () => {
    expect(Object.fromEntries(LAB_CATALOG.filter((e) => e.ceiling !== undefined).map((e) => [e.key, e.ceiling]))).toEqual({
      free_testosterone: 10000, free_testosterone_calculated: 10000, reverse_t3: 10000, c_peptide: 50000, reticulocytes: 2000,
    });
    expect(canonicalLabRow(entryOf('Reverse T3'), { value: 230, unit: 'nmol/L' })).toBeNull();
    expect(canonicalLabRow(entryOf('C-peptide'), { value: 600, unit: 'nmol/L' })).toBeNull();
    expect(canonicalLabRow(entryOf('Reticulocytes'), { value: 50, unit: '×10¹²/L' })).toBeNull();
    // A troponin in µg/L that converts to tens of thousands of ng/L is a real result.
    expect(canonicalLabRow(entryOf('hs troponin t'), { value: 25, unit: 'µg/L', referenceLow: 0, referenceHigh: 14 }))
      .toMatchObject({ stored: { value: 25000, unit: 'ng/L', referenceHigh: 14000 }, factor: 1000 });
    expect(labCountFault(entryOf('hs troponin t'), { value: 25, unit: 'µg/L', referenceHigh: 14 })).toBeNull();
  });

  it('US-21 AC21 — the refusal names the test, the printed unit and what to check, never the number', () => {
    expect(labUnitRefusalNote(entryOf('Free Testosterone'), 'nmol/L', 'ceiling')).toBe(NOTE);
    const message = labUnitRefusal(entryOf('Free Testosterone'), 'nmol/L', 'ceiling');
    expect(message).toContain('the printed unit is probably wrong (nmol/L vs pmol/L)');
    expect(message).toContain('do not re-send it in another unit on your own');
    expect(message).not.toContain('312');
  });
});
