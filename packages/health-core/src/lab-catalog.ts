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
 *  - Non-HDL cholesterol is deliberately NOT catalogued: the app derives it
 *    from total cholesterol and HDL, so a stored lab row would duplicate it.
 *    A printed one stays an uncatalogued row with its printed unit.
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
  | 'inflammation'
  | 'metabolic';

export interface LabGroup {
  id: LabGroupId;
  label: string;
  /** Icon key rendered left of the group heading (inline SVG, widget-side). */
  icon: 'kidney' | 'liver' | 'droplet' | 'thyroid' | 'hormones' | 'vitamins' | 'flame' | 'flask';
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
  /** In `unit`: a value no human sample reaches, set only where a ×1000
   *  conversion leads here (US-21 AC21). A row whose converted value or printed
   *  high bound passes it was printed a prefix away, so it is refused, never rescaled. */
  ceiling?: number;
}

/** Cell counts: every analyser spelling of ×10⁹/L. "G/L" is giga-per-litre —
 *  grams per litre only where an entry's canonical unit says so. */
const COUNT_ALIASES_9 = ['×10³/µl', 'k/µl', 'thou/µl', 'thousand/µl', 'g/l'];
/** The same, one thousand times over: ×10¹²/L. */
const COUNT_ALIASES_12 = ['×10⁶/µl', 'm/µl', 'million/µl', 't/l'];
/** A count printed per microlitre (US-21 AC15; `cells/cmm`, `cells/cumm` and,
 *  AC16, `cells/mm3` and `cells/mm³` arrive here through the folds): a microlitre is 10⁻⁶ L, so 2400 cells/µL is
 *  2.4 ×10⁹/L. Counted, so only a whole number converts — see `canonicalLabValue`. */
const CELLS_PER_UL = 'cells/µl';
const COUNT_PER_UL = { [CELLS_PER_UL]: 0.001 };
const WHOLE_COUNT = 'Counts of cells per µL are whole numbers on the same scale as their printed range, so this row is refused, never rescaled';
const WHOLE_COUNT_NOTE = `${WHOLE_COUNT}: check whether the report means thousands per µL (×10³/µL)`;
const SCALE_NOTE = 'the value and its printed range are on different scales, so the row was not stored';
/** The assistant's copy of a refusal for the number: the person decides, never a re-send. */
const NOT_ON_YOUR_OWN = 'do not re-send it in another unit on your own';
/** Real counts of these sit near zero (an eosinophil count of 0, severe
 *  neutropenia), so only WBC and platelets get the low-side check. */
const LOW_SIDE_COUNTS = new Set(['wbc', 'platelets']);
/** A differential in % is a share of the white count, not a count, and is
 *  never multiplied out from the WBC (US-21 AC15). */
const PERCENT_OF_WBC_NOTE = { '%': {
  note: 'A percentage is a share of the white count, not a count: this record keeps the absolute count (×10⁹/L or cells/µL), so look for that line on the same report',
  assistant: 'Do not work the count out from the percentage',
} };
/** NRBC in % or "/100 WBC" is a ratio to the white count (US-21 AC19). */
const NRBC_PER_100_WBC = {
  note: 'NRBC per 100 white cells is a ratio, not a count: this record keeps the absolute count (×10⁹/L), so look for that line on the same report',
  assistant: 'Do not work the count out from the ratio',
};
/** An enzyme activity: international units and "units" are the same unit. */
const ENZYME_ALIASES = ['iu/l'];
/** An electrolyte with one charge: mEq/L and mmol/L are the same number. */
const MEQ_ALIASES = ['meq/l'];
/** Free testosterone, measured or calculated: testosterone 288.42 g/mol; a
 *  nanomole is a thousand picomoles. */
const FREE_TESTOSTERONE = { 'pg/ml': 3.467, 'ng/dl': 34.67, 'nmol/l': 1000 };
/** Glucose, fasting or random: glucose 180.16 g/mol. */
const GLUCOSE = { 'mg/dl': 0.05551 };
/** A gonadotrophin: mIU/mL and U/L are IU/L, the same number. */
const GONADOTROPHIN_ALIASES = ['miu/ml', 'u/l'];
/** eGFR's unit, spaced or with the body-surface area left off (LabCorp). */
const EGFR_ALIASES = ['ml/min/1.73 m²', 'ml/min/1.73'];
/** The five differentials in their absolute form, as US reports print them (US-21 AC20). */
const absolute = (...names: string[]) => names.flatMap((n) => [`${n} (absolute)`, `absolute ${n}`, `${n} abs`]);
/** ng/mL and µg/L are the same number. */
const NG_PER_ML = ['ng/ml'];
/** pg/mL and ng/L are the same number. */
const PG_PER_ML = ['pg/ml'];
/** A milligram per decilitre is a hundredth of a gram per litre. */
const MG_DL_TO_G_L = { 'mg/dl': 0.01 };

export const LAB_GROUPS: LabGroup[] = [
  { id: 'renal', label: 'Renal & electrolytes', icon: 'kidney' },
  { id: 'liver', label: 'Liver', icon: 'liver' },
  { id: 'haematology', label: 'Blood count', icon: 'droplet' },
  { id: 'thyroid', label: 'Thyroid', icon: 'thyroid' },
  { id: 'hormones', label: 'Hormones', icon: 'hormones' },
  { id: 'vitamins', label: 'Vitamins & minerals', icon: 'vitamins' },
  { id: 'inflammation', label: 'Inflammation', icon: 'flame' },
  { id: 'metabolic', label: 'Metabolic', icon: 'flask' },
];

export const LAB_CATALOG: LabCatalogEntry[] = [
  // ── Renal & electrolytes ──────────────────────────────────────────────
  { key: 'sodium', label: 'Sodium', group: 'renal', unit: 'mmol/L', aliases: ['na', 'na+'], unitAliases: MEQ_ALIASES },
  { key: 'potassium', label: 'Potassium', group: 'renal', unit: 'mmol/L', aliases: ['k', 'k+'], unitAliases: MEQ_ALIASES },
  { key: 'chloride', label: 'Chloride', group: 'renal', unit: 'mmol/L', aliases: ['cl', 'cl-'], unitAliases: MEQ_ALIASES },
  { key: 'bicarbonate', label: 'Bicarbonate', group: 'renal', unit: 'mmol/L', aliases: ['hco3', 'co2', 'total co2', 'carbon dioxide, total', 'carbon dioxide'], unitAliases: MEQ_ALIASES },
  {
    key: 'urea', label: 'Urea', group: 'renal', unit: 'mmol/L', aliases: ['bun', 'blood urea nitrogen', 'urea nitrogen', 'urea nitrogen (bun)', 'blood urea nitrogen (bun)', 'urea (bun)'],
    // mg/dL under the bare name "urea" is ambiguous — US reports print the
    // nitrogen, the rest of the world the molecule — so it is REFUSED there
    // and accepted only under a nitrogen name. Urea nitrogen is the 2 N of the
    // molecule, 28.014 g/mol: ×10 → mg/L, ÷28.014 → mmol/L. "Urea (BUN)" does
    // not say which a lab means, so it takes mmol/L only (US-21 AC20).
    nameConversions: [{ names: ['bun', 'blood urea nitrogen', 'urea nitrogen', 'urea nitrogen (bun)', 'blood urea nitrogen (bun)'], conversions: { 'mg/dl': 0.357 } }],
  },
  { key: 'urate', label: 'Urate', group: 'renal', unit: 'mmol/L', aliases: ['uric acid'], conversions: { 'mg/dl': 0.05948, 'µmol/l': 0.001 } }, // urate 168.11 g/mol; a micromole is a thousandth of a millimole (UK labs print µmol/L)
  { key: 'urine_acr', label: 'Urine ACR', group: 'renal', unit: 'mg/mmol', aliases: ['albumin creatinine ratio', 'acr', 'microalbumin ratio'], conversions: { 'mg/g': 0.113, 'mg/g creat': 0.113, 'mg/g creatinine': 0.113 } }, // creatinine 113.12 g/mol: 1 g ≡ 8.840 mmol
  { key: 'urine_creatinine', label: 'Urine creatinine', group: 'renal', unit: 'mmol/L', aliases: ['creatinine urine', 'urinary creatinine', 'creatinine (urine)'], conversions: { 'mg/dl': 0.0884, 'µmol/l': 0.001 } }, // creatinine 113.12 g/mol; a micromole is a thousandth of a millimole
  { key: 'urine_pcr', label: 'Urine PCR', group: 'renal', unit: 'mg/mmol', aliases: ['protein creatinine ratio', 'protein:creatinine ratio', 'urine protein creatinine ratio', 'upcr'], conversions: { 'mg/g': 0.113, 'mg/g creat': 0.113, 'mg/g creatinine': 0.113, 'mg/mg': 113.12 } }, // creatinine 113.12 g/mol: 1 g ≡ 8.840 mmol, 1 mg ≡ 1/113.12 mmol
  { key: 'cystatin_c', label: 'Cystatin C', group: 'renal', unit: 'mg/L', aliases: [] },
  { key: 'egfr', label: 'eGFR', group: 'renal', unit: 'mL/min/1.73m²', aliases: ['estimated gfr', 'gfr', 'estimated glomerular filtration rate', 'egfr (ckd-epi)'], unitAliases: EGFR_ALIASES },
  // US-21 AC19: each its own slot. An eGFR from cystatin C, or from both
  // markers, is not the creatinine eGFR. Osmolality only under a serum or
  // plasma name: a bare "osmolality" is as often the urine test.
  { key: 'egfr_cystatin', label: 'eGFR (cystatin C)', group: 'renal', unit: 'mL/min/1.73m²', aliases: ['egfrcys', 'egfr cystatin c', 'egfr cystatin'], unitAliases: EGFR_ALIASES },
  { key: 'egfr_combined', label: 'eGFR (creatinine-cystatin C)', group: 'renal', unit: 'mL/min/1.73m²', aliases: ['egfrcr-cys', 'egfr cr-cys', 'egfr creatinine-cystatin c'], unitAliases: EGFR_ALIASES },
  { key: 'anion_gap', label: 'Anion gap', group: 'renal', unit: 'mmol/L', aliases: [], unitAliases: MEQ_ALIASES },
  { key: 'osmolality_serum', label: 'Osmolality (serum)', group: 'renal', unit: 'mOsm/kg', aliases: ['serum osmolality', 'plasma osmolality', 'osmolality, serum', 'osmolality, plasma', 'osmolality (plasma)'], unitAliases: ['mmol/kg', 'mosmol/kg'] }, // mOsmol/kg is mOsm/kg spelled out; labs print the same number as mmol/kg

  // ── Liver ─────────────────────────────────────────────────────────────
  { key: 'alt', label: 'ALT', group: 'liver', unit: 'U/L', aliases: ['alanine aminotransferase', 'sgpt', 'alt (sgpt)'], unitAliases: ENZYME_ALIASES },
  { key: 'ast', label: 'AST', group: 'liver', unit: 'U/L', aliases: ['aspartate aminotransferase', 'sgot', 'ast (sgot)'], unitAliases: ENZYME_ALIASES },
  { key: 'ggt', label: 'GGT', group: 'liver', unit: 'U/L', aliases: ['gamma gt', 'gamma-glutamyl transferase', 'γ-gt', 'ggtp', 'gamma gt (ggt)'], unitAliases: ENZYME_ALIASES },
  { key: 'alp', label: 'ALP', group: 'liver', unit: 'U/L', aliases: ['alkaline phosphatase', 'alk phos', 'alk. phosphatase'], unitAliases: ENZYME_ALIASES },
  { key: 'bilirubin_total', label: 'Bilirubin (total)', group: 'liver', unit: 'µmol/L', aliases: ['total bilirubin', 'bilirubin', 'bilirubin, total'], conversions: { 'mg/dl': 17.1 } }, // bilirubin 584.66 g/mol
  { key: 'bilirubin_direct', label: 'Bilirubin (direct)', group: 'liver', unit: 'µmol/L', aliases: ['direct bilirubin', 'conjugated bilirubin', 'bilirubin, direct'], conversions: { 'mg/dl': 17.1 } }, // bilirubin 584.66 g/mol
  { key: 'ldh', label: 'LDH', group: 'liver', unit: 'U/L', aliases: ['lactate dehydrogenase', 'ld'], unitAliases: ENZYME_ALIASES },
  { key: 'albumin', label: 'Albumin', group: 'liver', unit: 'g/L', aliases: [], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'total_protein', label: 'Total protein', group: 'liver', unit: 'g/L', aliases: ['protein total', 'protein', 'protein, total'], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'globulin', label: 'Globulin', group: 'liver', unit: 'g/L', aliases: ['globulin, total'], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre
  // US-21 AC19. Indirect bilirubin is total minus direct; the app derives it nowhere, so a printed one is kept.
  { key: 'bilirubin_indirect', label: 'Bilirubin (indirect)', group: 'liver', unit: 'µmol/L', aliases: ['indirect bilirubin', 'unconjugated bilirubin', 'bilirubin, indirect'], conversions: { 'mg/dl': 17.1 } }, // bilirubin 584.66 g/mol
  { key: 'lipase', label: 'Lipase', group: 'liver', unit: 'U/L', aliases: ['serum lipase'], unitAliases: ENZYME_ALIASES },
  { key: 'amylase', label: 'Amylase', group: 'liver', unit: 'U/L', aliases: ['serum amylase'], unitAliases: ENZYME_ALIASES },

  // ── Blood count (haematology) ─────────────────────────────────────────
  { key: 'haemoglobin', label: 'Haemoglobin', group: 'haematology', unit: 'g/L', aliases: ['hemoglobin', 'hb', 'hgb', 'haemoglobin (hb)'], conversions: { 'g/dl': 10, 'mmol/l': 16.11 } }, // g/dL ×10; Hb per haem 16.11 g/mol (Dutch convention)
  { key: 'haematocrit', label: 'Haematocrit', group: 'haematology', unit: 'L/L', aliases: ['hematocrit', 'hct', 'pcv', 'packed cell volume', 'haematocrit (hct)'], unitAliases: ['ratio', 'fraction'], conversions: { '%': 0.01 } }, // a percentage is a hundredth
  { key: 'rbc', label: 'RBC', group: 'haematology', unit: '×10¹²/L', aliases: ['red blood cells', 'red blood cell count', 'red cell count', 'erythrocytes'], unitAliases: COUNT_ALIASES_12 },
  { key: 'wbc', label: 'WBC', group: 'haematology', unit: '×10⁹/L', aliases: ['white blood cells', 'white blood cell count', 'white cell count', 'total white cell count', 'leukocytes', 'leucocytes'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL },
  { key: 'platelets', label: 'Platelets', group: 'haematology', unit: '×10⁹/L', aliases: ['platelet count', 'plt'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL },
  { key: 'neutrophils', label: 'Neutrophils', group: 'haematology', unit: '×10⁹/L', aliases: ['neutrophil count', 'neut', ...absolute('neutrophils')], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'lymphocytes', label: 'Lymphocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['lymphocyte count', ...absolute('lymphocytes'), 'lymphs (absolute)'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'monocytes', label: 'Monocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['monocyte count', ...absolute('monocytes'), 'monocytes(absolute)'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'eosinophils', label: 'Eosinophils', group: 'haematology', unit: '×10⁹/L', aliases: ['eosinophil count', ...absolute('eosinophils'), 'eos (absolute)'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'basophils', label: 'Basophils', group: 'haematology', unit: '×10⁹/L', aliases: ['basophil count', ...absolute('basophils'), 'baso (absolute)'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'mcv', label: 'MCV', group: 'haematology', unit: 'fL', aliases: ['mean cell volume', 'mean corpuscular volume'] },
  { key: 'mch', label: 'MCH', group: 'haematology', unit: 'pg', aliases: ['mean cell haemoglobin', 'mean corpuscular hemoglobin'] },
  { key: 'mchc', label: 'MCHC', group: 'haematology', unit: 'g/L', aliases: ['mean cell haemoglobin concentration', 'mean corpuscular hemoglobin concentration'], conversions: { 'g/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'rdw', label: 'RDW', group: 'haematology', unit: '%', aliases: ['red cell distribution width', 'rdw-cv', 'rdw cv'] },
  // US-21 AC19. RDW-SD is the width in fL, a test of its own beside RDW-CV in %.
  { key: 'rdw_sd', label: 'RDW-SD', group: 'haematology', unit: 'fL', aliases: [] },
  { key: 'mpv', label: 'MPV', group: 'haematology', unit: 'fL', aliases: ['mean platelet volume'] },
  { key: 'immature_granulocytes', label: 'Immature granulocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['immature granulocyte count', 'immature grans (abs)'], unitAliases: COUNT_ALIASES_9, conversions: COUNT_PER_UL, refusalNotes: PERCENT_OF_WBC_NOTE },
  { key: 'reticulocytes', label: 'Reticulocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['reticulocyte count', 'retic count', 'absolute reticulocyte count'], unitAliases: COUNT_ALIASES_9, conversions: { '×10¹²/l': 1000 }, ceiling: 2000, refusalNotes: { '%': {
    note: 'A percentage is a share of the red cells, not a count: this record keeps the absolute count (×10⁹/L), so look for that line on the same report',
    assistant: 'Do not work the count out from the percentage',
  } } }, // 10¹² is a thousand 10⁹
  { key: 'nrbc', label: 'NRBC', group: 'haematology', unit: '×10⁹/L', aliases: ['nucleated red blood cells', 'nucleated rbc', 'nucleated red cells'], unitAliases: COUNT_ALIASES_9, refusalNotes: { '%': NRBC_PER_100_WBC, '/100 wbc': NRBC_PER_100_WBC } },
  // D-dimer only in fibrinogen-equivalent units: a bare ng/mL is often D-dimer
  // units (DDU), about half the FEU number, so no spelling without FEU converts.
  { key: 'd_dimer', label: 'D-dimer', group: 'haematology', unit: 'mg/L FEU', aliases: [], unitAliases: ['mg/l (feu)', 'µg/ml feu', 'µg/ml (feu)'], conversions: { 'ng/ml feu': 0.001, 'ng/ml (feu)': 0.001, 'µg/l feu': 0.001, 'µg/l (feu)': 0.001 } }, // µg/mL is mg/L; ng/mL is µg/L, a thousandth of mg/L
  { key: 'fibrinogen', label: 'Fibrinogen', group: 'haematology', unit: 'g/L', aliases: [], conversions: MG_DL_TO_G_L },

  // ── Thyroid ───────────────────────────────────────────────────────────
  { key: 'tsh', label: 'TSH', group: 'thyroid', unit: 'mIU/L', aliases: ['thyroid stimulating hormone', 'thyrotropin', 'tsh (thyroid stimulating hormone)'], unitAliases: ['µiu/ml', 'mu/l', 'microiu/ml', 'mciu/ml'] },
  { key: 'ft4', label: 'Free T4', group: 'thyroid', unit: 'pmol/L', aliases: ['free thyroxine', 't4 free', 'free t4', 't4, free', 'free t4 (ft4)', 'free thyroxine (ft4)'], conversions: { 'ng/dl': 12.87 } }, // thyroxine 776.87 g/mol
  { key: 'ft3', label: 'Free T3', group: 'thyroid', unit: 'pmol/L', aliases: ['free triiodothyronine', 't3 free', 'free t3', 't3, free'], conversions: { 'pg/ml': 1.536 } }, // triiodothyronine 650.97 g/mol
  { key: 'anti_tpo', label: 'Anti-TPO', group: 'thyroid', unit: 'IU/mL', aliases: ['tpo antibodies', 'thyroid peroxidase antibodies', 'anti thyroid peroxidase', 'tpoab', 'thyroid peroxidase (tpo) ab'], unitAliases: ['kiu/l', 'u/ml'] },
  // US-21 AC19. Total T4 and T3 are tests of their own beside the free ones;
  // a bare "T4" or "T3" can mean either, so neither is an alias. The free
  // thyroxine index stays uncatalogued: two scales share its name.
  { key: 'total_t4', label: 'Total T4', group: 'thyroid', unit: 'nmol/L', aliases: ['t4 total', 't4, total', 'thyroxine (t4)', 'total thyroxine'], conversions: { 'µg/dl': 12.87 } }, // thyroxine 776.87 g/mol
  { key: 'total_t3', label: 'Total T3', group: 'thyroid', unit: 'nmol/L', aliases: ['t3 total', 't3, total', 'triiodothyronine (t3)', 'total triiodothyronine'], conversions: { 'ng/dl': 0.01536, 'ng/ml': 1.536, 'µg/l': 1.536 } }, // triiodothyronine 650.97 g/mol
  { key: 'reverse_t3', label: 'Reverse T3', group: 'thyroid', unit: 'pmol/L', aliases: ['rt3', 'reverse triiodothyronine'], conversions: { 'pg/ml': 1.536, 'ng/dl': 15.36, 'nmol/l': 1000 }, ceiling: 10000 }, // reverse T3 650.97 g/mol, as T3; a nanomole is a thousand picomoles
  { key: 't3_uptake', label: 'T3 uptake', group: 'thyroid', unit: '%', aliases: ['t-uptake', 't3u'] }, // a ratio (THBR) or arbitrary units is refused
  { key: 'thyroglobulin', label: 'Thyroglobulin', group: 'thyroid', unit: 'µg/L', aliases: [], unitAliases: NG_PER_ML },
  // Antibody assays: no conversion across assays. TRAb in U/L is refused: older non-WHO assays are not IU/L.
  { key: 'anti_tg', label: 'Anti-Tg', group: 'thyroid', unit: 'IU/mL', aliases: ['thyroglobulin antibodies', 'anti-thyroglobulin', 'anti thyroglobulin antibodies', 'tgab'], unitAliases: ['kiu/l'] },
  { key: 'trab', label: 'TRAb', group: 'thyroid', unit: 'IU/L', aliases: ['tsh receptor antibodies', 'tsh receptor antibody', 'thyrotropin receptor antibodies'] },

  // ── Hormones ──────────────────────────────────────────────────────────
  { key: 'testosterone_total', label: 'Testosterone (total)', group: 'hormones', unit: 'nmol/L', aliases: ['total testosterone', 'testosterone', 'testosterone, total', 'plasma testosterone'], conversions: { 'ng/dl': 0.0347, 'ng/ml': 3.467 } }, // testosterone 288.42 g/mol
  // Measured and calculated free testosterone are two tests, as total and
  // corrected calcium are: same unit and factors, never one slot.
  { key: 'free_testosterone', label: 'Free testosterone', group: 'hormones', unit: 'pmol/L', aliases: ['testosterone, free'], conversions: FREE_TESTOSTERONE, ceiling: 10000 },
  { key: 'free_testosterone_calculated', label: 'Free testosterone (calculated)', group: 'hormones', unit: 'pmol/L', aliases: ['calculated free testosterone', 'cft', 'calculated free t'], conversions: FREE_TESTOSTERONE, ceiling: 10000 },
  { key: 'shbg', label: 'SHBG', group: 'hormones', unit: 'nmol/L', aliases: ['sex hormone binding globulin', 'shbg (sex hormone binding globulin)'] },
  { key: 'estradiol', label: 'Estradiol', group: 'hormones', unit: 'pmol/L', aliases: ['oestradiol', 'e2'], conversions: { 'pg/ml': 3.671, 'ng/l': 3.671 } }, // estradiol 272.38 g/mol
  { key: 'prolactin', label: 'Prolactin', group: 'hormones', unit: 'mIU/L', aliases: [], unitAliases: ['µiu/ml', 'microiu/ml', 'mciu/ml'] }, // ng/mL is deliberately REFUSED: the mIU factor is assay-dependent (~21.2 for the WHO 3rd IS), so converting would invent precision
  { key: 'cortisol_am', label: 'Cortisol (morning)', group: 'hormones', unit: 'nmol/L', aliases: ['cortisol', 'am cortisol', 'cortisol, am'], conversions: { 'µg/dl': 27.59 } }, // cortisol 362.46 g/mol
  { key: 'psa_free', label: 'PSA (free)', group: 'hormones', unit: 'µg/L', aliases: ['free psa', 'psa, free'], unitAliases: ['ng/ml'] },
  { key: 'lh', label: 'LH', group: 'hormones', unit: 'IU/L', aliases: ['luteinising hormone', 'luteinizing hormone'], unitAliases: GONADOTROPHIN_ALIASES },
  { key: 'fsh', label: 'FSH', group: 'hormones', unit: 'IU/L', aliases: ['follicle stimulating hormone'], unitAliases: GONADOTROPHIN_ALIASES },
  { key: 'progesterone', label: 'Progesterone', group: 'hormones', unit: 'nmol/L', aliases: [], conversions: { 'ng/ml': 3.180 } }, // progesterone 314.46 g/mol
  { key: 'dhea_s', label: 'DHEA-S', group: 'hormones', unit: 'µmol/L', aliases: ['dheas', 'dhea sulphate', 'dhea sulfate', 'dehydroepiandrosterone sulfate', 'dehydroepiandrosterone sulphate'], conversions: { 'µg/dl': 0.02714 } }, // DHEA sulfate 368.49 g/mol
  { key: 'igf1', label: 'IGF-1', group: 'hormones', unit: 'nmol/L', aliases: ['igf 1', 'insulin-like growth factor 1', 'somatomedin c'], conversions: { 'ng/ml': 0.1307, 'µg/l': 0.1307 } }, // IGF-1 7649 g/mol; µg/L is the ng/mL number
  // US-21 AC19.
  { key: 'pth', label: 'PTH', group: 'hormones', unit: 'pmol/L', aliases: ['parathyroid hormone', 'intact pth', 'pth intact', 'pth, intact'], conversions: { 'pg/ml': 0.1061, 'ng/l': 0.1061 } }, // PTH 1-84 9424.7 g/mol (UniProt P01270, residues 32-115)
  { key: 'amh', label: 'AMH', group: 'hormones', unit: 'pmol/L', aliases: ['anti-mullerian hormone', 'anti-müllerian hormone', 'anti mullerian hormone'], conversions: { 'ng/ml': 7.14 } }, // the 140 kDa dimer convention, as insulin's 6.00 is one
  { key: 'bioavailable_testosterone', label: 'Bioavailable testosterone', group: 'hormones', unit: 'nmol/L', aliases: ['testosterone, bioavailable'], conversions: { 'ng/dl': 0.0347 } }, // testosterone 288.42 g/mol
  { key: 'psa_free_percent', label: 'PSA (% free)', group: 'hormones', unit: '%', aliases: ['% free psa', 'percent free psa', 'free psa %', 'psa % free'] },
  { key: 'estrone', label: 'Estrone', group: 'hormones', unit: 'pmol/L', aliases: ['oestrone', 'e1'], conversions: { 'pg/ml': 3.699 } }, // estrone 270.37 g/mol
  { key: 'androstenedione', label: 'Androstenedione', group: 'hormones', unit: 'nmol/L', aliases: [], conversions: { 'ng/dl': 0.03492, 'ng/ml': 3.492 } }, // androstenedione 286.41 g/mol
  { key: 'oh_progesterone_17', label: '17-OH progesterone', group: 'hormones', unit: 'nmol/L', aliases: ['17-hydroxyprogesterone', '17 hydroxyprogesterone', '17-ohp'], conversions: { 'ng/dl': 0.03026, 'ng/ml': 3.026 } }, // 17-hydroxyprogesterone 330.46 g/mol
  { key: 'dht', label: 'DHT', group: 'hormones', unit: 'nmol/L', aliases: ['dihydrotestosterone'], conversions: { 'ng/dl': 0.03443, 'pg/ml': 0.003443 } }, // dihydrotestosterone 290.44 g/mol
  { key: 'acth', label: 'ACTH', group: 'hormones', unit: 'pmol/L', aliases: ['adrenocorticotropic hormone', 'corticotropin'], conversions: { 'pg/ml': 0.2202, 'ng/l': 0.2202 } }, // ACTH 1-39 4541 g/mol
  { key: 'gh', label: 'Growth hormone', group: 'hormones', unit: 'µg/L', aliases: ['hgh', 'human growth hormone', 'somatotropin'], unitAliases: NG_PER_ML }, // mIU/L is assay-dependent: refused
  { key: 'hcg', label: 'hCG', group: 'hormones', unit: 'IU/L', aliases: ['beta hcg', 'beta-hcg', 'b-hcg', 'human chorionic gonadotropin', 'total hcg'], unitAliases: ['miu/ml'] },

  // ── Vitamins & minerals ───────────────────────────────────────────────
  { key: 'vitamin_d', label: 'Vitamin D (25-OH)', group: 'vitamins', unit: 'nmol/L', aliases: ['25-hydroxyvitamin d', '25-oh vitamin d', 'vitamin d3', '25(oh)d', 'vitamin d, 25-hydroxy', '25-hydroxy vitamin d', '25 oh vitamin d', 'vitamin d (25 oh)'], conversions: { 'ng/ml': 2.496, 'µg/l': 2.496 } }, // 25-OH-D 400.64 g/mol
  { key: 'vitamin_b12', label: 'Vitamin B12', group: 'vitamins', unit: 'pmol/L', aliases: ['b12', 'cobalamin', 'vitamin b12 (cobalamin)'], conversions: { 'pg/ml': 0.738, 'ng/l': 0.738 } }, // cyanocobalamin 1355.4 g/mol
  { key: 'b12_active', label: 'Active B12', group: 'vitamins', unit: 'pmol/L', aliases: ['holotranscobalamin', 'holotc'] },
  { key: 'folate', label: 'Folate', group: 'vitamins', unit: 'nmol/L', aliases: ['folic acid', 'serum folate', 'folate, serum'], conversions: { 'ng/ml': 2.266, 'µg/l': 2.266 } }, // folate 441.4 g/mol
  { key: 'ferritin', label: 'Ferritin', group: 'vitamins', unit: 'µg/L', aliases: ['ferritin (serum)'], unitAliases: ['ng/ml'] },
  { key: 'iron', label: 'Iron', group: 'vitamins', unit: 'µmol/L', aliases: ['serum iron', 'iron, total'], conversions: { 'µg/dl': 0.179 } }, // iron 55.845 g/mol
  { key: 'tibc', label: 'TIBC', group: 'vitamins', unit: 'µmol/L', aliases: ['total iron binding capacity', 'iron binding capacity'], conversions: { 'µg/dl': 0.179 } }, // iron 55.845 g/mol
  { key: 'transferrin', label: 'Transferrin', group: 'vitamins', unit: 'g/L', aliases: [], conversions: { 'mg/dl': 0.01 } }, // a milligram per decilitre is a hundredth of a gram per litre
  { key: 'transferrin_sat', label: 'Transferrin saturation', group: 'vitamins', unit: '%', aliases: ['tsat', 'iron saturation', 'transferrin saturation', 'transferrin saturation %'] },
  { key: 'magnesium', label: 'Magnesium', group: 'vitamins', unit: 'mmol/L', aliases: ['mg'], conversions: { 'mg/dl': 0.4114, 'meq/l': 0.5 } }, // magnesium 24.305 g/mol; Mg²⁺ carries two charges
  { key: 'calcium_corrected', label: 'Calcium (corrected)', group: 'vitamins', unit: 'mmol/L', aliases: ['corrected calcium', 'adjusted calcium'], conversions: { 'mg/dl': 0.2495 } }, // calcium 40.078 g/mol
  { key: 'calcium_total', label: 'Calcium (total)', group: 'vitamins', unit: 'mmol/L', aliases: ['calcium', 'total calcium', 'serum calcium', 'ca'], conversions: { 'mg/dl': 0.2495 } }, // calcium 40.078 g/mol
  { key: 'phosphate', label: 'Phosphate', group: 'vitamins', unit: 'mmol/L', aliases: ['phosphorus', 'inorganic phosphate', 'po4'], conversions: { 'mg/dl': 0.3229 } }, // phosphorus 30.97 g/mol
  { key: 'zinc', label: 'Zinc', group: 'vitamins', unit: 'µmol/L', aliases: [], conversions: { 'µg/dl': 0.153 } }, // zinc 65.38 g/mol
  // US-21 AC19. Red cell folate and ionised calcium are tests of their own,
  // never one slot with serum folate or total and corrected calcium.
  { key: 'red_cell_folate', label: 'Red cell folate', group: 'vitamins', unit: 'nmol/L', aliases: ['rbc folate', 'erythrocyte folate', 'red blood cell folate'], conversions: { 'ng/ml': 2.266, 'µg/l': 2.266 } }, // folate 441.4 g/mol
  { key: 'calcium_ionised', label: 'Calcium (ionised)', group: 'vitamins', unit: 'mmol/L', aliases: ['ionised calcium', 'ionized calcium', 'free calcium', 'ca++', 'calcium, ionized', 'calcium, ionised'], conversions: { 'mg/dl': 0.2495, 'meq/l': 0.5 } }, // calcium 40.078 g/mol; Ca²⁺ carries two charges
  { key: 'uibc', label: 'UIBC', group: 'vitamins', unit: 'µmol/L', aliases: ['unsaturated iron binding capacity'], conversions: { 'µg/dl': 0.179 } }, // iron 55.845 g/mol
  { key: 'stfr', label: 'Soluble transferrin receptor', group: 'vitamins', unit: 'mg/L', aliases: [] }, // nmol/L is assay-dependent: refused
  { key: 'copper', label: 'Copper', group: 'vitamins', unit: 'µmol/L', aliases: ['serum copper'], conversions: { 'µg/dl': 0.1574 } }, // copper 63.546 g/mol
  { key: 'caeruloplasmin', label: 'Caeruloplasmin', group: 'vitamins', unit: 'g/L', aliases: ['ceruloplasmin'], conversions: MG_DL_TO_G_L },
  { key: 'selenium', label: 'Selenium', group: 'vitamins', unit: 'µmol/L', aliases: [], conversions: { 'µg/l': 0.01266, 'ng/ml': 0.01266 } }, // selenium 78.971 g/mol
  { key: 'omega3_index', label: 'Omega-3 index', group: 'vitamins', unit: '%', aliases: ['omega 3 index'] },
  { key: 'vitamin_a', label: 'Vitamin A', group: 'vitamins', unit: 'µmol/L', aliases: ['retinol'], conversions: { 'µg/dl': 0.03491 } }, // retinol 286.45 g/mol
  { key: 'vitamin_e', label: 'Vitamin E', group: 'vitamins', unit: 'µmol/L', aliases: ['alpha-tocopherol', 'alpha tocopherol'], conversions: { 'mg/l': 2.322, 'mg/dl': 23.22 } }, // alpha-tocopherol 430.71 g/mol
  { key: 'vitamin_c', label: 'Vitamin C', group: 'vitamins', unit: 'µmol/L', aliases: ['ascorbic acid'], conversions: { 'mg/dl': 56.78 } }, // ascorbic acid 176.12 g/mol
  { key: 'vitamin_b6', label: 'Vitamin B6', group: 'vitamins', unit: 'nmol/L', aliases: ['pyridoxal 5-phosphate', "pyridoxal 5'-phosphate", 'pyridoxal phosphate', 'plp'], conversions: { 'ng/ml': 4.046, 'µg/l': 4.046 } }, // pyridoxal 5'-phosphate 247.14 g/mol
  { key: 'vitamin_b1', label: 'Vitamin B1', group: 'vitamins', unit: 'nmol/L', aliases: ['thiamine', 'thiamin'] }, // thiamine and its diphosphate differ in mass: no factor guessed
  { key: 'mma', label: 'Methylmalonic acid', group: 'vitamins', unit: 'µmol/L', aliases: [], conversions: { 'nmol/l': 0.001 } }, // a nanomole is a thousandth of a micromole

  // ── Inflammation ──────────────────────────────────────────────────────
  { key: 'crp', label: 'CRP', group: 'inflammation', unit: 'mg/L', aliases: ['c-reactive protein', 'hs-crp', 'hs crp', 'high sensitivity crp', 'hscrp', 'crp, high sensitivity', 'cardiac crp', 'c reactive protein'], conversions: { 'mg/dl': 10 } }, // a decilitre is a tenth of a litre
  { key: 'esr', label: 'ESR', group: 'inflammation', unit: 'mm/hr', aliases: ['erythrocyte sedimentation rate', 'sed rate', 'sedimentation rate'], unitAliases: ['mm/h'] },
  // US-21 AC19. Antibody assays take their own unit only: no conversion across assays.
  { key: 'procalcitonin', label: 'Procalcitonin', group: 'inflammation', unit: 'µg/L', aliases: [], unitAliases: NG_PER_ML },
  { key: 'ige', label: 'IgE (total)', group: 'inflammation', unit: 'kU/L', aliases: ['total ige', 'immunoglobulin e', 'serum ige'], unitAliases: ['iu/ml', 'kiu/l'] }, // a kU/L of IgE is an IU/mL
  { key: 'rf', label: 'Rheumatoid factor', group: 'inflammation', unit: 'IU/mL', aliases: [], unitAliases: ['kiu/l'] },
  { key: 'anti_ccp', label: 'Anti-CCP', group: 'inflammation', unit: 'U/mL', aliases: ['ccp antibodies', 'anti-cyclic citrullinated peptide', 'cyclic citrullinated peptide antibodies'] },
  { key: 'total_iga', label: 'IgA (total)', group: 'inflammation', unit: 'g/L', aliases: ['total iga', 'iga', 'immunoglobulin a', 'serum iga'], conversions: MG_DL_TO_G_L },
  { key: 'ttg_iga', label: 'tTG-IgA', group: 'inflammation', unit: 'U/mL', aliases: ['tissue transglutaminase iga', 'anti-ttg iga', 'tissue transglutaminase antibody iga'] },

  // ── Metabolic ─────────────────────────────────────────────────────────
  { key: 'glucose', label: 'Glucose', group: 'metabolic', unit: 'mmol/L', aliases: ['fasting glucose', 'fasting plasma glucose', 'plasma glucose', 'glucose fasting', 'blood glucose', 'fpg', 'fbg', 'glucose, fasting'], conversions: GLUCOSE },
  { key: 'glucose_random', label: 'Glucose (random)', group: 'metabolic', unit: 'mmol/L', aliases: ['random glucose', 'glucose random', 'non-fasting glucose'], conversions: GLUCOSE }, // not a fasting glucose: a test of its own
  { key: 'insulin', label: 'Insulin', group: 'metabolic', unit: 'mIU/L', aliases: ['fasting insulin', 'serum insulin'], unitAliases: ['µiu/ml', 'mu/l', 'µu/ml', 'microiu/ml', 'mciu/ml'], conversions: { 'pmol/l': 0.1667 } }, // 1 µIU/mL = 6.00 pmol/L (the insulin-standardisation convention)
  { key: 'apoa1', label: 'ApoA1', group: 'metabolic', unit: 'g/L', aliases: ['apolipoprotein a1', 'apolipoprotein a-i', 'apo a1', 'apo a-1', 'apoa-1', 'apoa-i'], conversions: { 'mg/dl': 0.01 } }, // a milligram per decilitre is a hundredth of a gram per litre
  { key: 'homocysteine', label: 'Homocysteine', group: 'metabolic', unit: 'µmol/L', aliases: ['total homocysteine', 'plasma homocysteine'] },
  { key: 'ck', label: 'CK', group: 'metabolic', unit: 'U/L', aliases: ['creatine kinase', 'cpk', 'creatine phosphokinase'], unitAliases: ENZYME_ALIASES },
  // US-21 AC19. The natriuretic peptides in pmol/L are refused. Troponin T and
  // I are two tests; a bare "troponin" says neither, so it is no alias.
  { key: 'nt_probnp', label: 'NT-proBNP', group: 'metabolic', unit: 'ng/L', aliases: ['nt pro bnp', 'ntprobnp', 'n-terminal pro-bnp', 'n-terminal pro b-type natriuretic peptide'], unitAliases: PG_PER_ML },
  { key: 'bnp', label: 'BNP', group: 'metabolic', unit: 'ng/L', aliases: ['b-type natriuretic peptide', 'brain natriuretic peptide'], unitAliases: PG_PER_ML },
  { key: 'troponin_t', label: 'Troponin T', group: 'metabolic', unit: 'ng/L', aliases: ['hs troponin t', 'hs-troponin t', 'high sensitivity troponin t', 'hs-tnt', 'hs-ctnt'], unitAliases: PG_PER_ML, conversions: { 'µg/l': 1000, 'ng/ml': 1000 } }, // a microgram is a thousand nanograms
  { key: 'troponin_i', label: 'Troponin I', group: 'metabolic', unit: 'ng/L', aliases: ['hs troponin i', 'hs-troponin i', 'high sensitivity troponin i', 'hs-tni', 'hs-ctni'], unitAliases: PG_PER_ML, conversions: { 'µg/l': 1000, 'ng/ml': 1000 } }, // a microgram is a thousand nanograms
  { key: 'c_peptide', label: 'C-peptide', group: 'metabolic', unit: 'pmol/L', aliases: [], conversions: { 'ng/ml': 331.1, 'µg/l': 331.1, 'nmol/l': 1000 }, ceiling: 50000 }, // C-peptide 3020.3 g/mol; a nanomole is a thousand picomoles
  // Derived values the app does not derive (eAG from HbA1c, VLDL from triglycerides): kept as printed tests.
  { key: 'eag', label: 'eAG', group: 'metabolic', unit: 'mmol/L', aliases: ['estimated average glucose'], conversions: GLUCOSE },
  { key: 'vldl', label: 'VLDL cholesterol', group: 'metabolic', unit: 'mmol/L', aliases: ['vldl-c', 'vldl chol'], conversions: { 'mg/dl': 0.02586 } }, // cholesterol 386.65 g/mol
  { key: 'lactate', label: 'Lactate', group: 'metabolic', unit: 'mmol/L', aliases: ['lactic acid'], conversions: { 'mg/dl': 0.111 } }, // lactic acid 90.08 g/mol
  { key: 'fructosamine', label: 'Fructosamine', group: 'metabolic', unit: 'µmol/L', aliases: [] },
];

/**
 * The tests US-21 AC19 added. The extraction prompt does not suggest their
 * keys until the #166 Haiku benchmark: a prompt change waits for it. The
 * catalogue still resolves whatever name the model returns.
 */
export const PROMPT_DEFERRED_KEYS: ReadonlySet<string> = new Set([
  'egfr_cystatin', 'egfr_combined', 'anion_gap', 'osmolality_serum', 'bilirubin_indirect', 'lipase', 'amylase', 'rdw_sd',
  'mpv', 'immature_granulocytes', 'reticulocytes', 'nrbc', 'd_dimer', 'fibrinogen', 'total_t4', 'total_t3', 'reverse_t3',
  't3_uptake', 'thyroglobulin', 'anti_tg', 'trab', 'pth', 'amh', 'bioavailable_testosterone', 'psa_free_percent', 'estrone',
  'androstenedione', 'oh_progesterone_17', 'dht', 'acth', 'gh', 'hcg', 'red_cell_folate', 'calcium_ionised', 'uibc', 'stfr',
  'copper', 'caeruloplasmin', 'selenium', 'omega3_index', 'vitamin_a', 'vitamin_e', 'vitamin_c', 'vitamin_b6', 'vitamin_b1',
  'mma', 'procalcitonin', 'ige', 'rf', 'anti_ccp', 'total_iga', 'ttg_iga', 'nt_probnp', 'bnp', 'troponin_t', 'troponin_i',
  'c_peptide', 'eag', 'vldl', 'lactate', 'fructosamine',
]);

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
  // "mm3" and "mm³" are a µL only as a denominator, after a slash (AC16): a
  // bare mm³ is a volume, such as a plaque volume, and is never folded.
  // Run last, so they cannot change a spelling the catalogue already accepted.
  // Only gm/dL folds: a bare "gm/L" would land on g/L, which a count test reads
  // as G/L. A bracketed "Unit(s)" is not a whole token, so it is not folded.
  u = u.replace(/(^|[\s/])gm(?=\/dl(?:$|[\s/]))/gi, '$1g');
  u = u.replace(/(^|[\s/])units?(?=$|[\s/])/gi, '$1U');
  u = u.replace(/(^|[\s/])(?:cmm|cumm|cu[ .]mm|c\.mm)(?=$|[\s/])/gi, '$1µL');
  u = u.replace(/\/mm[3³](?=$|[\s/])/gi, '/µL');
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
  if (fault === 'ceiling') return `${entry.label} in "${unit}": ${ceilingNote(entry, unit)}. Ask the person to check the report; ${NOT_ON_YOUR_OWN}`;
  if (fault === 'scale') return `${entry.label} in "${unit}": ${SCALE_NOTE}. Ask the person to check the report; ${NOT_ON_YOUR_OWN}`;
  if (labUnitTaken(entry, unit)) {
    return `${entry.label} in "${unit}" was not stored. ${WHOLE_COUNT}: ask the person whether the report means thousands per µL (×10³/µL); ${NOT_ON_YOUR_OWN}`;
  }
  const refusal = `${entry.label} is stored in ${entry.unit}; this record takes ${acceptedLabUnits(entry).join(', ')}, not "${unit}"`;
  const extra = entry.refusalNotes?.[normalizeLabUnit(unit).toLowerCase()];
  return extra ? [refusal, extra.note, ...(extra.assistant ? [extra.assistant] : [])].join('. ') : refusal;
}

/** The part of a refusal that says what to do next, where there is one: the
 *  website's upload summary shows it under its own words. */
export function labUnitRefusalNote(entry: LabCatalogEntry | undefined, unit: string, fault?: CountFault | null): string | undefined {
  if (fault === 'scale') return SCALE_NOTE;
  if (entry && fault === 'ceiling') return `${ceilingNote(entry, unit)}. Check the report, then type it in`;
  return labUnitTaken(entry, unit) ? WHOLE_COUNT_NOTE : entry?.refusalNotes?.[normalizeLabUnit(unit).toLowerCase()]?.note;
}

/** Why a row above its test's ceiling was refused (US-21 AC21): the ceiling is the catalogue's, never the row's number. */
function ceilingNote(entry: LabCatalogEntry, unit: string): string {
  const printed = normalizeLabUnit(unit);
  const pair = printed.toLowerCase() === entry.unit.toLowerCase() ? '' : ` (${printed} vs ${entry.unit})`;
  return `${entry.label} above ${entry.ceiling?.toLocaleString('en-US')} ${entry.unit} is not a measured value, so the printed unit is probably wrong${pair}`;
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
  const factor = factorOf(entry, spelling);
  if (factor === undefined || countRowFault(entry, spelling, value)) return null;
  return { value: scaleBy(value, factor), unit: entry.unit, factor };
}

/** The factor from a matched spelling to the entry's unit, or `undefined` when it takes no such spelling. */
function factorOf(entry: LabCatalogEntry, spelling: string): number | undefined {
  if (!spelling) return undefined;
  return spelling === entry.unit.toLowerCase() || entry.unitAliases?.includes(spelling) ? 1 : entry.conversions?.[spelling];
}

/** Why a row in a spelling its test takes was refused for its numbers: a count
 *  per µL (US-21 AC15), or a value past the test's ceiling (US-21 AC21). */
export type CountFault = 'decimal' | 'scale' | 'ceiling';

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

/** The fault that refused this row, or `null` when the count and ceiling checks pass. */
export function labCountFault(
  entry: LabCatalogEntry,
  row: { value: number; unit: string; referenceLow?: number | null; referenceHigh?: number | null },
): CountFault | null {
  const spelling = normalizeLabUnit(row.unit).toLowerCase();
  const fault = countRowFault(entry, spelling, row.value, row.referenceLow, row.referenceHigh);
  const factor = factorOf(entry, spelling);
  if (fault || entry.ceiling === undefined || factor === undefined) return fault;
  // The value or the printed high bound past the ceiling once converted (US-21 AC21).
  return [row.value, row.referenceHigh].some((n) => typeof n === 'number' && n * factor > entry.ceiling!) ? 'ceiling' : null;
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
  'like', 'random', 'direct', 'active', 'factor', 'growth', 'capacity', 'calculated', 'anti',
  'antibodies', 'inorganic', 'conjugated', 'non',
  // US-21 AC19 and AC20.
  'absolute', 'abs', 'average', 'beta', 'brain', 'carbon', 'cardiac', 'combined', 'dioxide', 'gap', 'human',
  'immature', 'index', 'indirect', 'intact', 'ionised', 'ionized', 'nucleated', 'percent', 'pro', 'receptor',
  'reverse', 'soluble', 'terminal', 'tissue', 'type', 'unconjugated', 'unsaturated', 'uptake',
]);

/**
 * Short names that are English (or markup) long before they are tests: "na" is
 * not applicable, "gt" is `&gt;` in every rendering bug ever filed, "am" is a
 * clock and half a sentence, "oh" is a sigh, "sat" is a verb, and "hs" is only
 * the prefix of hs-CRP, which `crp` already carries. "gh" is GitHub, "ab" an
 * A/B test and "sd" a standard deviation in any bug report. Everything else short —
 * bp, hb, t3, t4, e2 — stays, so "BP 140/90" and "free T4 15" are refused.
 */
const SHORT_NAME_WORDS = new Set(['na', 'gt', 'hs', 'am', 'oh', 'sat', 'gh', 'ab', 'sd']);

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
