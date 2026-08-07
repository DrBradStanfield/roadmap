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
  | 'thyroid'
  | 'hormones'
  | 'vitamins'
  | 'inflammation';

export interface LabGroup {
  id: LabGroupId;
  label: string;
  /** Icon key rendered left of the group heading (inline SVG, widget-side). */
  icon: 'kidney' | 'liver' | 'thyroid' | 'hormones' | 'vitamins' | 'flame';
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
}

export const LAB_GROUPS: LabGroup[] = [
  { id: 'renal', label: 'Renal & electrolytes', icon: 'kidney' },
  { id: 'liver', label: 'Liver', icon: 'liver' },
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

  // ── Liver ─────────────────────────────────────────────────────────────
  { key: 'alt', label: 'ALT', group: 'liver', unit: 'U/L', aliases: ['alanine aminotransferase', 'sgpt'] },
  { key: 'ast', label: 'AST', group: 'liver', unit: 'U/L', aliases: ['aspartate aminotransferase', 'sgot'] },
  { key: 'ggt', label: 'GGT', group: 'liver', unit: 'U/L', aliases: ['gamma gt', 'gamma-glutamyl transferase', 'γ-gt', 'ggtp'] },
  { key: 'alp', label: 'ALP', group: 'liver', unit: 'U/L', aliases: ['alkaline phosphatase'] },
  { key: 'bilirubin_total', label: 'Bilirubin (total)', group: 'liver', unit: 'µmol/L', aliases: ['total bilirubin', 'bilirubin'] },
  { key: 'albumin', label: 'Albumin', group: 'liver', unit: 'g/L', aliases: [] },
  { key: 'total_protein', label: 'Total protein', group: 'liver', unit: 'g/L', aliases: ['protein total', 'protein'] },

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
  { key: 'crp', label: 'CRP', group: 'inflammation', unit: 'mg/L', aliases: ['c-reactive protein', 'hs-crp', 'high sensitivity crp', 'hscrp'] },
  { key: 'esr', label: 'ESR', group: 'inflammation', unit: 'mm/hr', aliases: ['erythrocyte sedimentation rate', 'sed rate'] },
];

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
