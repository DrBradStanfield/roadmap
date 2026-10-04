import { describe, it, expect } from 'vitest';
import { acceptedLabUnits, canonicalLabRow, canonicalLabValue, LAB_CATALOG, LAB_CONVERSIONS, LAB_GROUPS, resolveLabCatalogEntry, normalizeLabUnit, labSlotKey } from './lab-catalog';

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
    expect(canonicalLabValue(entryOf('neutrophils'), 4100, 'cells/uL')).toBeNull();
    expect(canonicalLabValue(entryOf('neutrophils'), 4100, 'cells/cmm')).toBeNull();
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
      'milliunits/L', 'kUnits/L', 'gm%', 'mgm/dL', 'gm/L', 'GM/L', 'mg/gm', 'gm/dL%', 'Unit(s)/L', 'mmol/mol', 'mL/min/1.73m²', 'cells/µL', 'lakhs/cumm',
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
    // output that holds a gm/dL, Unit, Units or cmm token. Every accepted spelling is
    // a fixed point, so no input that matched one before matches differently.
    for (const entry of LAB_CATALOG) {
      for (const spelling of [entry.unit, ...LAB_CONVERSIONS.filter((c) => c.key === entry.key).map((c) => c.spelling)]) {
        expect(normalizeLabUnit(spelling).toLowerCase(), `${entry.key} ${spelling}`).toBe(spelling.toLowerCase());
      }
    }
  });
});
