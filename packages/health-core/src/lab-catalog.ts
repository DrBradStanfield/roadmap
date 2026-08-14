/**
 * Additional blood-test catalogue (US-21) — the stable-ID registry for lab
 * values beyond the core 8 matrix metrics.
 *
 * SKELETON for Brad's clinical review (2026-08-07 decisions: canonical-units
 * approach; initial panels renal/liver/thyroid/hormones/vitamins/inflammation;
 * collapsed by default; icon per group). Scope rules:
 *  - `unit` is the CANONICAL display unit (SI-leaning, matching the app's
 *    units.ts convention). Conversion factors from common alternate units are
 *    added per-metric as phase 3 lands — each factor individually verifiable.
 *  - NO clinical thresholds here: per-lab reference ranges arrive with the
 *    uploaded report (labValues already store referenceLow/High) and stay the
 *    source of truth for ok/warn display.
 *  - `aliases` are lowercase-normalized report spellings → this key. NEVER
 *    dedup or match on raw LLM text (documented gotcha) — always resolve to
 *    these keys first.
 *  - Core matrix metrics (ldl, hdl, hba1c, creatinine, …) are intentionally
 *    absent — they live in units.ts and the main matrix.
 */

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
   *  scale, different notation — e.g. haematocrit "ratio" ≡ "L/L"). Display
   *  relabeling only; a unit not listed here is genuinely different and must
   *  never be silently relabeled (AC3). */
  unitAliases?: string[];
}

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
  { key: 'sodium', label: 'Sodium', group: 'renal', unit: 'mmol/L', aliases: ['na', 'na+'] },
  { key: 'potassium', label: 'Potassium', group: 'renal', unit: 'mmol/L', aliases: ['k', 'k+'] },
  { key: 'chloride', label: 'Chloride', group: 'renal', unit: 'mmol/L', aliases: ['cl', 'cl-'] },
  { key: 'bicarbonate', label: 'Bicarbonate', group: 'renal', unit: 'mmol/L', aliases: ['hco3', 'co2', 'total co2'] },
  { key: 'urea', label: 'Urea', group: 'renal', unit: 'mmol/L', aliases: ['bun', 'blood urea nitrogen'] },
  { key: 'urate', label: 'Urate', group: 'renal', unit: 'mmol/L', aliases: ['uric acid'] },
  { key: 'urine_acr', label: 'Urine ACR', group: 'renal', unit: 'mg/mmol', aliases: ['albumin creatinine ratio', 'acr', 'microalbumin ratio'] },
  { key: 'egfr', label: 'eGFR', group: 'renal', unit: 'mL/min/1.73m²', aliases: ['estimated gfr', 'gfr', 'estimated glomerular filtration rate'] },

  // ── Liver ─────────────────────────────────────────────────────────────
  { key: 'alt', label: 'ALT', group: 'liver', unit: 'U/L', aliases: ['alanine aminotransferase', 'sgpt'] },
  { key: 'ast', label: 'AST', group: 'liver', unit: 'U/L', aliases: ['aspartate aminotransferase', 'sgot'] },
  { key: 'ggt', label: 'GGT', group: 'liver', unit: 'U/L', aliases: ['gamma gt', 'gamma-glutamyl transferase', 'γ-gt', 'ggtp'] },
  { key: 'alp', label: 'ALP', group: 'liver', unit: 'U/L', aliases: ['alkaline phosphatase'] },
  { key: 'bilirubin_total', label: 'Bilirubin (total)', group: 'liver', unit: 'µmol/L', aliases: ['total bilirubin', 'bilirubin'] },
  { key: 'albumin', label: 'Albumin', group: 'liver', unit: 'g/L', aliases: [] },
  { key: 'total_protein', label: 'Total protein', group: 'liver', unit: 'g/L', aliases: ['protein total', 'protein'] },
  { key: 'globulin', label: 'Globulin', group: 'liver', unit: 'g/L', aliases: [] },

  // ── Blood count (haematology) ─────────────────────────────────────────
  { key: 'haemoglobin', label: 'Haemoglobin', group: 'haematology', unit: 'g/L', aliases: ['hemoglobin', 'hb', 'hgb'] },
  { key: 'haematocrit', label: 'Haematocrit', group: 'haematology', unit: 'L/L', aliases: ['hematocrit', 'hct', 'pcv', 'packed cell volume'], unitAliases: ['ratio', 'fraction'] },
  { key: 'rbc', label: 'RBC', group: 'haematology', unit: '×10¹²/L', aliases: ['red blood cells', 'red blood cell count', 'red cell count', 'erythrocytes'] },
  { key: 'wbc', label: 'WBC', group: 'haematology', unit: '×10⁹/L', aliases: ['white blood cells', 'white blood cell count', 'white cell count', 'total white cell count', 'leukocytes', 'leucocytes'] },
  { key: 'platelets', label: 'Platelets', group: 'haematology', unit: '×10⁹/L', aliases: ['platelet count', 'plt'] },
  { key: 'neutrophils', label: 'Neutrophils', group: 'haematology', unit: '×10⁹/L', aliases: ['neutrophil count', 'neut'] },
  { key: 'lymphocytes', label: 'Lymphocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['lymphocyte count'] },
  { key: 'monocytes', label: 'Monocytes', group: 'haematology', unit: '×10⁹/L', aliases: ['monocyte count'] },
  { key: 'eosinophils', label: 'Eosinophils', group: 'haematology', unit: '×10⁹/L', aliases: ['eosinophil count'] },
  { key: 'basophils', label: 'Basophils', group: 'haematology', unit: '×10⁹/L', aliases: ['basophil count'] },
  { key: 'mcv', label: 'MCV', group: 'haematology', unit: 'fL', aliases: ['mean cell volume', 'mean corpuscular volume'] },
  { key: 'mch', label: 'MCH', group: 'haematology', unit: 'pg', aliases: ['mean cell haemoglobin', 'mean corpuscular hemoglobin'] },
  { key: 'mchc', label: 'MCHC', group: 'haematology', unit: 'g/L', aliases: ['mean cell haemoglobin concentration', 'mean corpuscular hemoglobin concentration'] },
  { key: 'rdw', label: 'RDW', group: 'haematology', unit: '%', aliases: ['red cell distribution width'] },

  // ── Thyroid ───────────────────────────────────────────────────────────
  { key: 'tsh', label: 'TSH', group: 'thyroid', unit: 'mIU/L', aliases: ['thyroid stimulating hormone', 'thyrotropin'] },
  { key: 'ft4', label: 'Free T4', group: 'thyroid', unit: 'pmol/L', aliases: ['free thyroxine', 't4 free', 'free t4'] },
  { key: 'ft3', label: 'Free T3', group: 'thyroid', unit: 'pmol/L', aliases: ['free triiodothyronine', 't3 free', 'free t3'] },

  // ── Hormones ──────────────────────────────────────────────────────────
  { key: 'testosterone_total', label: 'Testosterone (total)', group: 'hormones', unit: 'nmol/L', aliases: ['total testosterone', 'testosterone'] },
  { key: 'shbg', label: 'SHBG', group: 'hormones', unit: 'nmol/L', aliases: ['sex hormone binding globulin'] },
  { key: 'estradiol', label: 'Estradiol', group: 'hormones', unit: 'pmol/L', aliases: ['oestradiol', 'e2'] },
  { key: 'prolactin', label: 'Prolactin', group: 'hormones', unit: 'mIU/L', aliases: [] },
  { key: 'cortisol_am', label: 'Cortisol (morning)', group: 'hormones', unit: 'nmol/L', aliases: ['cortisol', 'am cortisol'] },

  // ── Vitamins & minerals ───────────────────────────────────────────────
  { key: 'vitamin_d', label: 'Vitamin D (25-OH)', group: 'vitamins', unit: 'nmol/L', aliases: ['25-hydroxyvitamin d', '25-oh vitamin d', 'vitamin d3', '25(oh)d'] },
  { key: 'vitamin_b12', label: 'Vitamin B12', group: 'vitamins', unit: 'pmol/L', aliases: ['b12', 'cobalamin'] },
  { key: 'folate', label: 'Folate', group: 'vitamins', unit: 'nmol/L', aliases: ['folic acid', 'serum folate'] },
  { key: 'ferritin', label: 'Ferritin', group: 'vitamins', unit: 'µg/L', aliases: [] },
  { key: 'iron', label: 'Iron', group: 'vitamins', unit: 'µmol/L', aliases: ['serum iron'] },
  { key: 'transferrin_sat', label: 'Transferrin saturation', group: 'vitamins', unit: '%', aliases: ['tsat', 'iron saturation', 'transferrin saturation'] },
  { key: 'magnesium', label: 'Magnesium', group: 'vitamins', unit: 'mmol/L', aliases: ['mg'] },
  { key: 'calcium_corrected', label: 'Calcium (corrected)', group: 'vitamins', unit: 'mmol/L', aliases: ['corrected calcium', 'adjusted calcium', 'calcium'] },
  { key: 'zinc', label: 'Zinc', group: 'vitamins', unit: 'µmol/L', aliases: [] },

  // ── Inflammation ──────────────────────────────────────────────────────
  { key: 'crp', label: 'CRP', group: 'inflammation', unit: 'mg/L', aliases: ['c-reactive protein', 'hs-crp', 'hs crp', 'high sensitivity crp', 'hscrp'] },
  { key: 'esr', label: 'ESR', group: 'inflammation', unit: 'mm/hr', aliases: ['erythrocyte sedimentation rate', 'sed rate'] },
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
  // Lowercase litre after a slash; squared metre ("m2"/"m^2") in eGFR units.
  u = u.replace(/\/l\b/g, '/L');
  u = u.replace(/m\^?2\b/g, 'm²');
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

/** Resolve a report's test name (any casing/spelling) to a catalogue entry.
 *  Tolerant of the underscore/space variance the LLM extractor produces
 *  (e.g. "free_t4" vs the catalogue alias "free t4") — this is the single
 *  resolver, so every consumer gets that normalization for free. */
export function resolveLabCatalogEntry(reportedName: string): LabCatalogEntry | undefined {
  const raw = reportedName.trim().toLowerCase();
  const spaced = raw.replace(/_/g, ' ');
  return LAB_CATALOG.find((e) =>
    e.key === raw || e.key === spaced ||
    e.label.toLowerCase() === raw || e.label.toLowerCase() === spaced ||
    e.aliases.includes(raw) || e.aliases.includes(spaced)
  );
}
