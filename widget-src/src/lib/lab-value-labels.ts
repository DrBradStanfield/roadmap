import { labUnitRefusalNote, labUnitTaken, resolveLabCatalogEntry } from '@roadmap/health-core';

/**
 * Display labels for flexible lab values (beyond the 13 core metrics).
 * Maps standardized snake_case metric names to human-readable labels.
 */
export const LAB_VALUE_LABELS: Record<string, string> = {
  // FBC / CBC
  haemoglobin: 'Haemoglobin',
  rbc: 'RBC',
  wbc: 'WBC',
  platelets: 'Platelets',
  mcv: 'MCV',
  mch: 'MCH',
  haematocrit: 'Haematocrit',
  neutrophils: 'Neutrophils',
  lymphocytes: 'Lymphocytes',
  monocytes: 'Monocytes',
  eosinophils: 'Eosinophils',
  basophils: 'Basophils',

  // LFTs
  alt: 'ALT',
  ast: 'AST',
  ggt: 'GGT',
  alp: 'ALP',
  bilirubin: 'Bilirubin',
  albumin: 'Albumin',
  total_protein: 'Total Protein',
  globulin: 'Globulin',

  // U&Es
  sodium: 'Sodium',
  potassium: 'Potassium',
  urea: 'Urea',
  chloride: 'Chloride',
  bicarbonate: 'Bicarbonate',

  // Kidney
  cystatin_c: 'Cystatin C',
  egfr: 'eGFR',

  // Thyroid
  tsh: 'TSH',
  free_t4: 'Free T4',
  free_t3: 'Free T3',

  // Iron studies
  ferritin: 'Ferritin',
  iron: 'Iron',
  tibc: 'TIBC',
  transferrin_saturation: 'Transferrin Saturation',

  // Vitamins
  vitamin_b12: 'Vitamin B12',
  folate: 'Folate',
  vitamin_d: 'Vitamin D',

  // Inflammation
  crp: 'CRP',
  hs_crp: 'hs-CRP',
  esr: 'ESR',

  // Hormones
  testosterone: 'Testosterone',
  free_testosterone: 'Free Testosterone',
  shbg: 'SHBG',
  estradiol: 'Estradiol',
  prolactin: 'Prolactin',
  progesterone: 'Progesterone',
  dhea_s: 'DHEA-S',
  igf1: 'IGF-1',

  // Metabolic
  fasting_glucose: 'Fasting Glucose',
  fasting_insulin: 'Fasting Insulin',
  uric_acid: 'Uric Acid',

  // Other
  homocysteine: 'Homocysteine',
};

/** Get a human-readable label for a metric name. Falls back to title-cased snake_case. */
export function labValueLabel(metricName: string): string {
  return LAB_VALUE_LABELS[metricName]
    || metricName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * What a person reads when the record refused a lab value's unit: the unit a
 * catalogued test is stored in, or, for a unit it does take, that the number was
 * refused, and a note on what to look for instead, where there is one (US-21 AC15). Never the store's
 * message, which is the copy an assistant reads.
 */
export function labUnitRefusalLine(key: string, unit: string): string {
  const entry = resolveLabCatalogEntry(key);
  const note = labUnitRefusalNote(entry, unit);
  const lead = labUnitTaken(entry, unit)
    ? `${labValueLabel(key)}: the number was not saved.`
    : `${labValueLabel(key)}: unit not recognised (${unit}). It was not saved.${entry ? ` This test takes ${entry.unit}.` : ''}`;
  return note ? `${lead} ${note}.` : lead;
}
