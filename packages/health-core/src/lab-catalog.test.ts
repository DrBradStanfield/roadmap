import { describe, it, expect } from 'vitest';
import { acceptedLabUnits, canonicalLabValue, LAB_CATALOG, LAB_CONVERSIONS, LAB_GROUPS, resolveLabCatalogEntry, normalizeLabUnit, labSlotKey } from './lab-catalog';

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
