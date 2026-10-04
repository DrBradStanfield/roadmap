/**
 * Additional blood-test catalogue (US-21) — the stable-ID registry for lab
 * values beyond the core 8 matrix metrics.
 *
 * SKELETON for Brad's clinical review (2026-08-07 decisions: canonical-units
 * approach; initial panels renal/liver/thyroid/hormones/vitamins/inflammation;
 * collapsed by default; icon per group). Scope rules:
 *  - `unit` is the CANONICAL SI unit, and since phase 3 (US-21) it is the unit
 *    a catalogued test is STORED in, not just displayed in: `conversions`
 *    carries the factor from every alternate spelling this record accepts, and
 *    a spelling it does not know is refused rather than guessed from the
 *    number. A test the catalogue does not know keeps the unit it was reported
 *    in — there is no SI definition to convert it to. CLINICAL CONTENT: every
 *    factor is one molar mass, written beside it.
 *  - NO clinical thresholds here: per-lab reference ranges arrive with the
 *    uploaded report (labValues already store referenceLow/High) and stay the
 *    source of truth for ok/warn display.
 *  - `aliases` are lowercase-normalized report spellings → this key. NEVER
 *    dedup or match on raw LLM text (documented gotcha) — always resolve to
 *    these keys first.
 *  - Core matrix metrics (ldl, hdl, hba1c, creatinine, …) are intentionally
 *    absent — they live in units.ts and the main matrix.
 */

import { METRIC_LABELS } from './mappings';
import { UNIT_DEFS } from './units';

export type LabGroupId =
  | 'renal'
  | 'liver'
  | 'haematology'
  | 'thyroid'
  | 'hormones'
  | 'vitamins'
  | 'inflammation';

export interface LabGroup {
  id: LabGroupId;
  label: string;
  /** Icon key rendered left of the group heading (inline SVG, widget-side). */
  icon: 'kidney' | 'liver' | 'droplet' | 'thyroid' | 'hormones' | 'vitamins' | 'flame';
}

export interface LabCatalogEntry {
  /** Stable snake_case key — the dedup/merge identity for this test. */
  key: string;
  label: string;
  group: LabGroupId;
  /** Canonical display unit. */
  unit: string;
  /** Lowercase report spellings that resolve to this key. */
  aliases: string[];
  /** Lowercase reported-unit spellings that MEAN the canonical unit (same
   *  scale, different notation — e.g. haematocrit "ratio" ≡ "L/L"). A unit not
   *  listed here or in `conversions` is genuinely different and is REFUSED,
   *  never silently relabeled or rescaled (AC3). */
  unitAliases?: string[];
  /** Lowercase reported-unit spellings (as `normalizeLabUnit` leaves them) that
   *  are a DIFFERENT scale, with the number to multiply the reported value by
   *  to reach `unit`. Every factor carries the molar mass it comes from. */
  conversions?: Record<string, number>;
  /** Conversions a PRINTED NAME adds to this entry's own: a US report's "BUN"
   *  in mg/dL is the nitrogen, and the bare molecule has no agreed mg/dL
   *  meaning, so mg/dL reaches urea only through the name "BUN". Read once, by
   *  `resolveLabCatalogEntry`, which returns the merged entry. */
  nameConversions?: Array<{ names: string[]; conversions: Record<string, number> }>;
  /** What a refusal of this spelling adds, where the list of units the test
   *  takes would not say what to do next (US-21 AC15: a differential in %):
   *  `note` for everyone, `assistant` only in the copy an assistant reads. */
  refusalNotes?: Record<string, { note: string; assistant?: string }>;
}

/** Cell counts: every analyser spelling of ×10⁹/L. "G/L" is giga-per-litre —
 *  grams per litre only where an entry's canonical unit says so. */
const COUNT_ALIASES_9 = ['×10³/µl', 'k/µl', 'thou/µl', 'thousand/µl', '×10³/mm3', 'g/l'];
/** The same, one thousand times over: ×10¹²/L. */
const COUNT_ALIASES_12 = ['×10⁶/µl', 'm/µl', 'million/µl', 't/l'];
/** A count printed per microlitre (US-21 AC15; `cells/cmm` and `cells/cumm`
 *  arrive here through the folds): a microlitre is 10⁻⁶ L, so 2400 cells/µL is
 *  2.4 ×10⁹/L. Counted, so only a whole number converts — see `canonicalLabValue`. */
const CELLS_PER_UL = 'cells/µl';
const COUNT_PER_UL = { [CELLS_PER_UL]: 0.001 };
const WHOLE_COUNT_NOTE = 'Counts of cells per µL are whole numbers on the same scale as their printed range, so this row is refused, never rescaled: check whether the report means thousands per µL (×10³/µL)';
const SCALE_NOTE = 'the value and its printed range are on different scales, so the row was not stored';
/** Real counts of these sit near zero (an eosinophil count of 0, severe
 *  neutropenia), so only WBC and platelets get the low-side check. */
const LOW_SIDE_COUNTS = new Set(['wbc', 'platelets']);
/** A differential in % is a share of the white count, not a count, and is
 *  never multiplied out from the WBC (US-21 AC15). */
const PERCENT_OF_WBC_NOTE = { '%': {
  note: 'A percentage is a share of the white count, not a count: this record keeps the absolute count (×10⁹/L or cells/µL), so look for that line on the same report',
  assistant: 'Do not work the count out from the percentage',
} };
/** An enzyme activity: international units and "units" are the same unit. */
const ENZYME_ALIASES = ['iu/l'];
/** An electrolyte with one charge: mEq/L and mmol/L are the same number. */
const MEQ_ALIASES = ['meq/l'];

export const LAB_GROUPS: LabGroup[] = [
  { id: 'renal', label: 'Renal & electrolytes', icon: 'kidney' },
  { id: 'liver', label: 'Liver', icon: 'liver' },
  { id: 'haematology', label: 'Blood count', icon: 'droplet' },
  { id: 'thyroid', label: 'Thyroid', icon: 'thyroid' },
  { id: 'hormones', label: 'Hormones', icon: 'hormones' },
  { id: 'vitamins', label: 'Vitamins & minerals', icon: 'vitamins' },
  { id: 'inflammation', label: 'Inflammation', icon: 'flame' },
];

export const LAB_CATALOG: LabCatalogEntry[] = [
  // ── Renal & electrolytes ──────────────────────────────────────────────
  { key: 'sodium', label: 'Sodium', group: 'renal', unit: 'mmol/L', aliases: ['na', 'na+'], unitAliases: MEQ_ALIASES },
  { key: 'potassium', label: 'Potassium', group: 'renal', unit: 'mmol/L', aliases: ['k', 'k+'], unitAliases: MEQ_ALIASES },
  { key: 'chloride', label: 'Chloride', group: 'renal', unit: 'mmol/L', aliases: ['cl', 'cl-'], unitAliases: MEQ_ALIASES },
  { key: 'bicarbonate', label: 'Bicarbonate', group: 'renal', unit: 'mmol/L', aliases: ['hco3', 'co2', 'total co2'], unitAliases: MEQ_ALIASES },
  {
    key: 'urea', label: 'Urea', group: 'renal', unit: 'mmol/L', aliases: ['bun', 'blood urea nitrogen', 'urea nitrogen'],
    // mg/dL under the bare name "urea" is ambiguous — US reports print the
    // nitrogen, the rest of the world the molecule — so it is REFUSED there
    // and accepted only under a nitrogen name. Urea nitrogen is the 2 N of the
    // molecule, 28.014 g/mol: ×10 → mg/L, ÷28.014 → mmol/L.
    nameConversions: [{ names: ['bun', 'blood urea nitrogen', 'urea nitrogen'], conversions: { 'mg/dl': 0.357 } }],
  },
  { key: 'urate', label: 'Urate', group: 'renal', unit: 'mmol/L', aliases: ['uric acid'], conversions: { 'mg/dl': 0.05948, 'µmol/l': 0.001 } }, // urate 168.11 g/mol; a micromole is a thousandth of a millimole (UK labs print µmol/L)
  { key: 'urine_acr', label: 'Urine ACR', group: 'renal', unit: 'mg/mmol', aliases: ['albumin creatinine ratio', 'acr', 'microalbumin ratio'], conversions: { 'mg/g': 0.113 } }, // creatinine 113.12 g/mol: 1 g ≡ 8.840 mmol
  { key: 'egfr', label: 'eGFR', group: 'renal', unit: 'mL/min/1.73m²', aliases: ['estimated gfr', 'gfr', 'estimated glomerular filtration rate'], unitAliases: ['ml/min/1.73 m²', 'ml/min/1.73'] },

  // ── Liver ─────────────────────────────────────────────────────────────
  { key: 'alt', label: 'ALT', group: 'liver', unit: 'U/L', aliases: ['alanine aminotransferase', 'sgpt'], unitAliases: ENZYME_ALIASES },
  { key: 'ast', label: 'AST', group: 'liver', unit: 'U/L', aliases: ['aspartate aminotransferase', 'sgot'], unitAliases: ENZYME_ALIASES },
  { key: 'ggt', label: 'GGT', group: 'liver', unit: 'U/L', aliases: ['gamma gt', 'gamma-glutamyl transferase', 'γ-gt', 'ggtp'], unitAliases: ENZYME_ALIASES },
  { key: 'alp', label: 'ALP', group: 'liver', unit: 'U/L', aliases: ['alkaline phosphatase'], unitAliases: ENZYME_ALIASES },
  { key: 'bilirubin_total', label: 'Bilirubin (total)', group: 'liver', unit: 'µmol/L', aliases: ['total bilirubin', 'bilirubin'], conversions: { 'mg/dl': 17.1 } }, // bilirubin 584.66 g/mol
  { key: 'albumin', label: 'Albumin', group: 'liver', unit: 'g/L', aliases: [], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'total_protein', label: 'Total protein', group: 'liver', unit: 'g/L', aliases: ['protein total', 'protein'], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'globulin', label: 'Globulin', group: 'liver', unit: 'g/L', aliases: [], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre

  // ── Blood count (haematology) ─────────────────────────────────────────
  { key: 'haemoglobin', label: 'Haemoglobin', group: 'haematology', unit: 'g/L', aliases: ['hemoglobin', 'hb', 'hgb'], conversions: { 'g/dl': 10, 'mmol/l': 16.11 } }, // g/dL ×10; Hb per haem 16.11 g/mol (Dutch convention)
  { key: 'haematocrit', label: 'Haematocrit', group: 'haematology', unit: 'L/L', aliases: ['hematocrit', 'hct', 'pcv', 'packed cell volume'], unitAliases: ['ratio', 'fraction'], conversions: { '%': 0.01 } }, // a percentage is a hundredth
  { key: 'rbc', label: 'RBC', group: 'haematology', unit: '×10¹²/L', aliases: ['red blood cells', 'red blood cell count', 'red cell count', 'erythrocytes'], unitAliases: COUNT_ALIASES_12 },
  { key: 'wbc', label: 'WBC', group: 'haematology', unit: '×10⁹/L', aliases: ['white blood cells', 'white blood cell count', 'white cell count', 'total white cell count', 'leukocytes', 'leucocytes'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL },
  { key: 'platelets', label: 'Platelets', group: 'haematology', unit: '×10⁹/L', aliases: ['platelet count', 'plt'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL },
  { key: 'neutrophils', label: 'Neutrophils', group: 'haematology', unit: '×10⁹/L', aliases: ['neutrophil count', 'neut'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'lymphocytes', label: 'Lymphocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['lymphocyte count'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'monocytes', label: 'Monocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['monocyte count'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'eosinophils', label: 'Eosinophils', group: 'haematology', unit: '×10⁹/L', aliases: ['eosinophil count'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'basophils', label: 'Basophils', group: 'haematology', unit: '×10⁹/L', aliases: ['basophil count'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'mcv', label: 'MCV', group: 'haematology', unit: 'fL', aliases: ['mean cell volume', 'mean corpuscular volume'] },
  { key: 'mch', label: 'MCH', group: 'haematology', unit: 'pg', aliases: ['mean cell haemoglobin', 'mean corpuscular hemoglobin'] },
  { key: 'mchc', label: 'MCHC', group: 'haematology', unit: 'g/L', aliases: ['mean cell haemoglobin concentration', 'mean corpuscular hemoglobin concentration'], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'rdw', label: 'RDW', group: 'haematology', unit: '%', aliases: ['red cell distribution width'] },

  // ── Thyroid ───────────────────────────────────────────────────────────
  { key: 'tsh', label: 'TSH', group: 'thyroid', unit: 'mIU/L', aliases: ['thyroid stimulating hormone', 'thyrotropin'], unitAliases: ['µiu/ml', 'mu/l'] },
  { key: 'ft4', label: 'Free T4', group: 'thyroid', unit: 'pmol/L', aliases: ['free thyroxine', 't4 free', 'free t4'], conversions: { 'ng/dl': 12.87 } }, // thyroxine 776.87 g/mol
  { key: 'ft3', label: 'Free T3', group: 'thyroid', unit: 'pmol/L', aliases: ['free triiodothyronine', 't3 free', 'free t3'], conversions: { 'pg/ml': 1.536 } }, // triiodothyronine 650.97 g/mol

  // ── Hormones ──────────────────────────────────────────────────────────
  { key: 'testosterone_total', label: 'Testosterone (total)', group: 'hormones', unit: 'nmol/L', aliases: ['total testosterone', 'testosterone'], conversions: { 'ng/dl': 0.0347, 'ng/ml': 3.467 } }, // testosterone 288.42 g/mol
  { key: 'shbg', label: 'SHBG', group: 'hormones', unit: 'nmol/L', aliases: ['sex hormone binding globulin'] },
  { key: 'estradiol', label: 'Estradiol', group: 'hormones', unit: 'pmol/L', aliases: ['oestradiol', 'e2'], conversions: { 'pg/ml': 3.671, 'ng/l': 3.671 } }, // estradiol 272.38 g/mol
  { key: 'prolactin', label: 'Prolactin', group: 'hormones', unit: 'mIU/L', aliases: [], unitAliases: ['µiu/ml'] }, // ng/mL is deliberately REFUSED: the mIU factor is assay-dependent (~21.2 for the WHO 3rd IS), so converting would invent precision
  { key: 'cortisol_am', label: 'Cortisol (morning)', group: 'hormones', unit: 'nmol/L', aliases: ['cortisol', 'am cortisol'], conversions: { 'µg/dl': 27.59 } }, // cortisol 362.46 g/mol

  // ── Vitamins & minerals ───────────────────────────────────────────────
  { key: 'vitamin_d', label: 'Vitamin D (25-OH)', group: 'vitamins', unit: 'nmol/L', aliases: ['25-hydroxyvitamin d', '25-oh vitamin d', 'vitamin d3', '25(oh)d'], conversions: { 'ng/ml': 2.496, 'µg/l': 2.496 } }, // 25-OH-D 400.64 g/mol
  { key: 'vitamin_b12', label: 'Vitamin B12', group: 'vitamins', unit: 'pmol/L', aliases: ['b12', 'cobalamin'], conversions: { 'pg/ml': 0.738, 'ng/l': 0.738 } }, // cyanocobalamin 1355.4 g/mol
  { key: 'folate', label: 'Folate', group: 'vitamins', unit: 'nmol/L', aliases: ['folic acid', 'serum folate'], conversions: { 'ng/ml': 2.266, 'µg/l': 2.266 } }, // folate 441.4 g/mol
  { key: 'ferritin', label: 'Ferritin', group: 'vitamins', unit: 'µg/L', aliases: [], unitAliases: ['ng/ml'] },
  { key: 'iron', label: 'Iron', group: 'vitamins', unit: 'µmol/L', aliases: ['serum iron'], conversions: { 'µg/dl': 0.179 } }, // iron 55.845 g/mol
  { key: 'transferrin_sat', label: 'Transferrin saturation', group: 'vitamins', unit: '%', aliases: ['tsat', 'iron saturation', 'transferrin saturation'] },
  { key: 'magnesium', label: 'Magnesium', group: 'vitamins', unit: 'mmol/L', aliases: ['mg'], conversions: { 'mg/dl': 0.4114, 'meq/l': 0.5 } }, // magnesium 24.305 g/mol; Mg²⁺ carries two charges
  { key: 'calcium_corrected', label: 'Calcium (corrected)', group: 'vitamins', unit: 'mmol/L', aliases: ['corrected calcium', 'adjusted calcium', 'calcium'], conversions: { 'mg/dl': 0.2495 } }, // calcium 40.078 g/mol
  { key: 'zinc', label: 'Zinc', group: 'vitamins', unit: 'µmol/L', aliases: [], conversions: { 'µg/dl': 0.153 } }, // zinc 65.38 g/mol

  // ── Inflammation ──────────────────────────────────────────────────────
  { key: 'crp', label: 'CRP', group: 'inflammation', unit: 'mg/L', aliases: ['c-reactive protein', 'hs-crp', 'hs crp', 'high sensitivity crp', 'hscrp'], conversions: { 'mg/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'esr', label: 'ESR', group: 'inflammation', unit: 'mm/hr', aliases: ['erythrocyte sedimentation rate', 'sed rate'], unitAliases: ['mm/h'] },
];

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
};

/** Case fixups for the unit token after a µ prefix; tokens not listed keep
 *  their lowercase form (mol, g, kat). */
const MICRO_CASE: Record<string, string> = { iu: 'IU', u: 'U' };

/**
 * Typography-normalize a reported unit SPELLING — never a value conversion.
 * Fixes the ASCII habits of lab reports and LLM extraction: "umol/L" → "µmol/L",
 * "x 10e9/L" / "10^9/L" → "×10⁹/L", lowercase litre, "1.73m2" → "1.73m²".
 * Unknown or already-clean units pass through untouched.
 */
export function normalizeLabUnit(raw: string): string {
  let u = raw.trim();
  if (!u) return u;
  // Greek small mu (U+03BC) → micro sign (U+00B5): LLM extraction emits
  // either; left unmapped they'd falsely flag mixedUnits against each other.
  u = u.replace(/μ/g, 'µ');
  // Cell-count notation: optional x/×, "10", then e/^/*/** and digits.
  u = u.replace(/(?:[x×]\s*)?10\s*(?:e|\^|\*{1,2})\s*(\d+)/i,
    (_, d: string) => `×10${d.split('').map((c) => SUPERSCRIPT_DIGITS[c]).join('')}`);
  // ASCII micro prefix: umol/ug/uiu/ukat/uu → µ… ("U/L" alone never matches).
  u = u.replace(/\bu(mol|g|iu|kat|u)\b/gi,
    (_, s: string) => `µ${MICRO_CASE[s.toLowerCase()] ?? s.toLowerCase()}`);
  // The two spellings US analysers print for the same prefix: "mcg" is µg, and
  // "uL"/"ul" is µL (the litre keeps its capital, so the /l rule below misses it).
  u = u.replace(/\bmcg\b/gi, 'µg');
  u = u.replace(/\bul\b/gi, 'µL');
  // Lowercase litre after a slash; squared metre ("m2"/"m^2") in eGFR units.
  u = u.replace(/\/l\b/g, '/L');
  u = u.replace(/m\^?2\b/g, 'm²');
  // Three spellings of one unit (US-21 AC14), any case, only as a whole token
  // between the ends, a slash or a space: "gm/dL" is g/dL, "Unit" or "Units"
  // is U, and a cubic millimetre ("cmm", "cumm", "cu mm", "cu.mm", "c.mm") is a µL.
  // Run last, so they cannot change a spelling the catalogue already accepted.
  // Only gm/dL folds: a bare "gm/L" would land on g/L, which a count test reads
  // as G/L. A bracketed "Unit(s)" is not a whole token, so it is not folded.
  u = u.replace(/(^|[\s/])gm(?=\/dl(?:$|[\s/]))/gi, '$1g');
  u = u.replace(/(^|[\s/])units?(?=$|[\s/])/gi, '$1U');
  u = u.replace(/(^|[\s/])(?:cmm|cumm|cu[ .]mm|c\.mm)(?=$|[\s/])/gi, '$1µL');
  return u;
}

/**
 * The unit string to DISPLAY for a reported unit: the catalogue's canonical
 * unit when the reported spelling means the same unit (canonical spelling or
 * a listed unitAlias), else the typography-normalized reported unit. Genuinely
 * different units are never relabeled (AC3) — they surface via mixedUnits.
 */
export function displayLabUnit(reportedUnit: string, entry?: LabCatalogEntry): string {
  const norm = normalizeLabUnit(reportedUnit);
  if (entry) {
    const lower = norm.toLowerCase();
    if (lower === entry.unit.toLowerCase() || entry.unitAliases?.includes(lower)) return entry.unit;
  }
  return norm;
}

/**
 * Every spelling of its unit a catalogued test accepts, canonical first: what
 * a refusal names, so the message and the check can never drift apart. The
 * alternate spellings are printed as they are matched — lower case, after
 * `normalizeLabUnit`.
 */
export function acceptedLabUnits(entry: LabCatalogEntry): string[] {
  // A spelling that only a printed NAME unlocks is listed only when the entry
  // was resolved under that name — where the resolver has merged it in.
  return [...new Set([entry.unit, ...spellingsOf(entry).filter((s) => !s.reportedNames).map((s) => s.spelling)])];
}

/**
 * Why a catalogued test refused a unit, in one sentence: what it is stored in
 * and every spelling it takes — or, for a count per µL it does take, what was
 * wrong with the number (US-21 AC15). Read from the spelling and the fault
 * alone, so a health value never enters the message.
 */
export function labUnitRefusal(entry: LabCatalogEntry, unit: string, fault?: CountFault | null): string {
  if (fault === 'scale') return `${entry.label} in "${unit}": ${SCALE_NOTE}. Do not re-send it in another unit; ask the person to check the report`;
  if (labUnitTaken(entry, unit)) return `${entry.label} in "${unit}" was not stored. ${WHOLE_COUNT_NOTE}`;
  const refusal = `${entry.label} is stored in ${entry.unit}; this record takes ${acceptedLabUnits(entry).join(', ')}, not "${unit}"`;
  const extra = entry.refusalNotes?.[normalizeLabUnit(unit).toLowerCase()];
  return extra ? [refusal, extra.note, ...(extra.assistant ? [extra.assistant] : [])].join('. ') : refusal;
}

/** The part of a refusal that says what to do next, where there is one: the
 *  website's upload summary shows it under its own words. */
export function labUnitRefusalNote(entry: LabCatalogEntry | undefined, unit: string, fault?: CountFault | null): string | undefined {
  if (fault === 'scale') return SCALE_NOTE;
  return labUnitTaken(entry, unit) ? WHOLE_COUNT_NOTE : entry?.refusalNotes?.[normalizeLabUnit(unit).toLowerCase()]?.note;
}

/** True when the test takes this spelling, so a refusal in it was about the
 *  number: only a count per µL refuses a spelling it takes (US-21 AC15). */
export function labUnitTaken(entry: LabCatalogEntry | undefined, unit: string): boolean {
  return !!entry && canonicalLabValue(entry, 0, unit) !== null;
}

/** Every alternate spelling one entry accepts, with the factor that reaches
 *  its canonical unit — the one list both the refusal message and the
 *  published conversion table are built from. */
function spellingsOf(entry: LabCatalogEntry): Array<{ spelling: string; factor: number; reportedNames?: string[] }> {
  return [
    ...(entry.unitAliases ?? []).map((spelling) => ({ spelling, factor: 1 })),
    ...Object.entries(entry.conversions ?? {}).map(([spelling, factor]) => ({ spelling, factor })),
    ...(entry.nameConversions ?? []).flatMap((named) =>
      Object.entries(named.conversions).map(([spelling, factor]) => ({ spelling, factor, reportedNames: named.names }))),
  ];
}

/**
 * Binary noise from a factor, dropped: 0.1 × 3.671 is 0.36710000000000004 in
 * a double, and that number would be written into the record and read back
 * out for ever. Six decimal places is far below any assay's precision and far
 * above any lab number's magnitude.
 */
function scaleBy(value: number, factor: number): number {
  return factor === 1 ? value : Math.round(value * factor * 1e6) / 1e6;
}

/**
 * The number and unit a catalogued test is STORED in (US-21 phase 3), or
 * `null` when this record does not accept that spelling for that test: the
 * caller REFUSES rather than guessing the scale from the number. That rule is
 * the whole of phase 3 — every write door and the load-time migration end here.
 *
 * The entry is the one `resolveLabCatalogEntry` returned for the PRINTED name,
 * which is why "BUN" in mg/dL converts and a bare "urea" in mg/dL does not.
 */
export function canonicalLabValue(
  entry: LabCatalogEntry, value: number, unit: string,
): { value: number; unit: string; factor: number } | null {
  const spelling = normalizeLabUnit(unit).toLowerCase();
  if (!spelling) return null;
  const factor = spelling === entry.unit.toLowerCase() || entry.unitAliases?.includes(spelling)
    ? 1
    : entry.conversions?.[spelling];
  if (factor === undefined || countRowFault(entry, spelling, value)) return null;
  return { value: scaleBy(value, factor), unit: entry.unit, factor };
}

/** Why a count per µL was refused for its number (US-21 AC15). */
export type CountFault = 'decimal' | 'scale';

/**
 * Cells are counted, so under a per-µL label a row must read as one count
 * (US-21 AC15): the result and both bounds whole (else `decimal`), and the
 * result on its own range's scale (else `scale`, see `offRangeScale`). Either
 * means the lab printed thousands under that label, so the row is refused,
 * never rescaled. A check of the row against itself, not a clinical threshold.
 */
function countRowFault(
  entry: LabCatalogEntry, spelling: string, value: number, low?: number | null, high?: number | null,
): CountFault | null {
  if (spelling !== CELLS_PER_UL) return null;
  if (![value, low, high].every((n) => typeof n !== 'number' || Number.isInteger(n))) return 'decimal';
  return offRangeScale(entry, value, low, high) ? 'scale' : null;
}

/**
 * With both bounds printed, a result above a hundred times the high bound, or,
 * for WBC and platelets, below a hundredth of the low one. 0 reads the same on
 * any scale. A ratio, so it holds on any one scale the value and range share.
 */
function offRangeScale(entry: LabCatalogEntry, value: number, low?: number | null, high?: number | null): boolean {
  if (value === 0 || typeof low !== 'number' || typeof high !== 'number') return false;
  return value > high * 100 || (LOW_SIDE_COUNTS.has(entry.key) && value < low / 100);
}

/** The fault that refused this row, or `null` when the count check passes. */
export function labCountFault(
  entry: LabCatalogEntry,
  row: { value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null },
): CountFault | null {
  return countRowFault(entry, normalizeLabUnit(row.unit).toLowerCase(), row.value, row.referenceLow, row.referenceHigh);
}

/** A correction sent in cells/µL, against the range its row already holds:
 *  both canonical, which the ratio check does not mind (US-21 AC15). */
export function correctionOffScale(entry: LabCatalogEntry, unit: string, value: number, low: number | null, high: number | null): boolean {
  return normalizeLabUnit(unit).toLowerCase() === CELLS_PER_UL && offRangeScale(entry, value, low, high);
}

/** The stored shape of one lab row: the value and both reference bounds in the
 *  catalogue's canonical unit. */
export interface StoredLabRow {
  value: number;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
}

/**
 * One whole row converted — value and both bounds by the SAME factor, so a
 * result and the range it is read against can never end up on two scales.
 * `null` is the refusal `canonicalLabValue` returns.
 */
export function canonicalLabRow(
  entry: LabCatalogEntry,
  row: { value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null },
): { stored: StoredLabRow; factor: number } | null {
  const canonical = canonicalLabValue(entry, row.value, row.unit);
  if (!canonical || labCountFault(entry, row)) return null;
  const bound = (b: number | null | undefined) => (typeof b === 'number' ? scaleBy(b, canonical.factor) : null);
  return {
    stored: {
      value: canonical.value, unit: canonical.unit,
      referenceLow: bound(row.referenceLow), referenceHigh: bound(row.referenceHigh),
    },
    factor: canonical.factor,
  };
}

/** One accepted alternate spelling of one test's unit. */
export interface LabConversionRow {
  key: string;
  /** The entry's canonical unit — what this spelling converts TO. */
  canonical: string;
  /** The spelling as it is matched: lower case, after `normalizeLabUnit`. */
  spelling: string;
  /** Multiply a value in `spelling` by this to reach `canonical`. */
  factor: number;
  /** Set only where the printed NAME chooses the factor (urea vs BUN). */
  reportedNames?: string[];
}

/**
 * Every accepted alternate spelling, flat — the conversion table as data. The
 * clinical doc's table is checked against THIS, so the numbers Brad verifies
 * and the numbers the record uses are one list, written once.
 */
export const LAB_CONVERSIONS: readonly LabConversionRow[] = LAB_CATALOG.flatMap((entry) =>
  spellingsOf(entry).map((s) => ({ key: entry.key, canonical: entry.unit, ...s })));

/**
 * A printed name as every resolver compares it: lower case, underscores and
 * runs of whitespace flattened to one space. One fold, so a core metric and
 * a catalogued test cannot disagree on "free_t4" versus "free t4".
 */
export function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/[_\s]+/g, ' ');
}

/**
 * Every name the catalogue answers to → its entry, folded once at module load:
 * the resolver runs on every row of every read, and the catalogue never
 * changes. First entry wins a name, as the linear scan it replaced did.
 *
 * A name that carries its own factor (`nameConversions` — "BUN") maps to a
 * MERGED copy of the entry, so the printed name is read HERE and nowhere else:
 * everything downstream sees one entry with one set of conversions.
 */
const ENTRY_BY_NAME: ReadonlyMap<string, LabCatalogEntry> = (() => {
  const byName = new Map<string, LabCatalogEntry>();
  for (const entry of LAB_CATALOG) {
    const named = new Map<string, LabCatalogEntry>();
    for (const { names, conversions } of entry.nameConversions ?? []) {
      const merged = { ...entry, conversions: { ...entry.conversions, ...conversions } };
      for (const name of names) named.set(foldName(name), merged);
    }
    for (const name of [entry.key, entry.label, ...entry.aliases]) {
      const folded = foldName(name);
      if (!byName.has(folded)) byName.set(folded, named.get(folded) ?? entry);
    }
  }
  return byName;
})();

/** Resolve a report's test name (any casing/spelling) to a catalogue entry.
 *  BOTH sides are folded before comparing, so the underscore/space variance
 *  the LLM extractor and agents produce washes out in either direction:
 *  "free_t4" finds the alias "free t4", and "Vitamin D" finds the key
 *  `vitamin_d`. This is the single resolver, so every consumer gets that
 *  normalization — and the printed name's own factor — for free. */
export function resolveLabCatalogEntry(reportedName: string): LabCatalogEntry | undefined {
  return ENTRY_BY_NAME.get(foldName(reportedName));
}

/**
 * The stable slot identity of a lab test: the catalogue key when the name is
 * catalogued, otherwise the name folded to lower case with underscores and
 * runs of whitespace flattened to single spaces. One key for every spelling,
 * so "Vitamin D", `vitamin_d` and "vitamin d" share one slot at write, merge
 * and read time instead of becoming rows the app can never reconcile.
 */
export function labSlotKey(name: string): string {
  return resolveLabCatalogEntry(name)?.key ?? foldName(name);
}

// ---------------------------------------------------------------------------
// Vocabularies read off the catalogue
// ---------------------------------------------------------------------------
// Two guards need to know what a health value looks like written down: the
// feedback guard in `mcp-tools.ts` (a bug report must not carry a result) and
// the Sentry free-text scrub. Both read the words and units off METRIC_LABELS,
// UNIT_DEFS and the catalogue below rather than keeping a hand list, so a test
// added tomorrow guards both for free.

/**
 * The English a test name is built from. Read on their own these words say
 * nothing clinical — "3 of the total", "page 2 of the count" — so they are
 * dropped from the vocabulary below; every other word of every metric and
 * every catalogued test stays in.
 */
const GENERIC_NAME_WORDS = new Set([
  'total', 'free', 'blood', 'red', 'white', 'cell', 'cells', 'count', 'mean', 'volume', 'packed',
  'corpuscular', 'serum', 'acid', 'high', 'sensitivity', 'rate', 'sed', 'distribution', 'width',
  'binding', 'sex', 'hormone', 'stimulating', 'estimated', 'morning', 'adjusted', 'corrected',
  'saturation', 'ratio', 'protein',
]);

/**
 * Short names that are English (or markup) long before they are tests: "na" is
 * not applicable, "gt" is `&gt;` in every rendering bug ever filed, "am" is a
 * clock and half a sentence, "oh" is a sigh, "sat" is a verb, and "hs" is only
 * the prefix of hs-CRP, which `crp` already carries. Everything else short —
 * bp, hb, t3, t4, e2 — stays, so "BP 140/90" and "free T4 15" are refused.
 */
const SHORT_NAME_WORDS = new Set(['na', 'gt', 'hs', 'am', 'oh', 'sat']);

/** "Lp(a)" is one name, not "lp" and "a" — folded before either side is read. */
export function foldLpa(text: string): string {
  return text.toLowerCase().replace(/lp\s*\(\s*a\s*\)/g, 'lpa');
}

/**
 * Every word this record knows a metric or a lab test by, sorted so a literal
 * mirror of the list is stable. Pure digits go ("25" of 25-OH vitamin D is a
 * number in any sentence) and so do the two sets above. `minLength` is how
 * short a name a caller can afford: the feedback guard takes 2 and over-refuses
 * on purpose, the Sentry scrub takes 3 so "mg" stays a unit and not a name.
 */
export function metricNameWords(minLength: number): string[] {
  return [...new Set(
    [
      ...Object.keys(METRIC_LABELS),
      ...Object.values(METRIC_LABELS),
      ...LAB_CATALOG.flatMap((entry) => [entry.key, entry.label, ...entry.aliases]),
    ]
      .flatMap((name) => foldLpa(name).match(/[a-z0-9]+/g) ?? [])
      .filter((word) => word.length >= minLength && !/^\d+$/.test(word)
        && !GENERIC_NAME_WORDS.has(word) && !SHORT_NAME_WORDS.has(word)),
  )].sort();
}

/**
 * Every unit spelling this record can print: the three spellings of each core
 * metric's unit and every catalogued test's canonical unit. `unitAliases` are
 * deliberately absent — "ratio" and "fraction" are English before they are
 * units. Sorted, for the same stable-mirror reason.
 */
export const CATALOG_UNITS: readonly string[] = [...new Set([
  ...Object.values(UNIT_DEFS).flatMap((def) => [def.canonical, def.label.si, def.label.conventional]),
  ...LAB_CATALOG.map((entry) => entry.unit),
])].sort();
