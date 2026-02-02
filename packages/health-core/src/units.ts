/**
 * Unit system definitions, conversions, and locale detection.
 *
 * All values in the database and in HealthInputs are stored in SI canonical
 * units. This module converts between SI and conventional (US) display units.
 *
 * Canonical units:
 *   height/waist: cm       | weight: kg          | BP: mmHg (universal)
 *   HbA1c: mmol/mol (IFCC) | lipids/glucose: mmol/L
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricType =
  | 'height'
  | 'weight'
  | 'waist'
  | 'hba1c'
  | 'ldl'
  | 'hdl'
  | 'triglycerides'
  | 'fasting_glucose'
  | 'systolic_bp'
  | 'diastolic_bp'
  | 'apob';

/** SI = metric + mmol/L (NZ, UK, AU, EU). Conventional = imperial + mg/dL (US). */
export type UnitSystem = 'si' | 'conventional';

export interface UnitDef {
  /** Label of the canonical (stored) unit, e.g. "mmol/L" */
  canonical: string;
  /** Display label per unit system */
  label: Record<UnitSystem, string>;
  /** Convert a display-unit value to the canonical unit */
  toCanonical: Record<UnitSystem, (v: number) => number>;
  /** Convert a canonical value to the display unit */
  fromCanonical: Record<UnitSystem, (v: number) => number>;
  /** Valid input range expressed in each unit system's display units */
  validationRange: Record<UnitSystem, { min: number; max: number }>;
  /** Number of decimal places to round to for display */
  decimalPlaces: Record<UnitSystem, number>;
}

// ---------------------------------------------------------------------------
// Conversion constants
// ---------------------------------------------------------------------------

const LBS_PER_KG = 2.20462;
const CM_PER_INCH = 2.54;

// Lipid & glucose molecular-weight factors (mg/dL ↔ mmol/L)
const CHOLESTEROL_FACTOR = 38.67; // LDL, HDL, total cholesterol
const TRIGLYCERIDES_FACTOR = 88.57;
const GLUCOSE_FACTOR = 18.016;
const APOB_FACTOR = 100; // g/L ↔ mg/dL

// HbA1c: NGSP % ↔ IFCC mmol/mol
// NGSP = 0.09148 × IFCC + 2.152
// IFCC = (NGSP - 2.152) / 0.09148
function hba1cNgspToIfcc(ngsp: number): number {
  return (ngsp - 2.152) / 0.09148;
}
function hba1cIfccToNgsp(ifcc: number): number {
  return 0.09148 * ifcc + 2.152;
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

const identity = (v: number) => v;

// ---------------------------------------------------------------------------
// Unit definitions
// ---------------------------------------------------------------------------

export const UNIT_DEFS: Record<MetricType, UnitDef> = {
  height: {
    canonical: 'cm',
    label: { si: 'cm', conventional: 'in' },
    toCanonical: {
      si: identity,
      conventional: (v) => v * CM_PER_INCH,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v / CM_PER_INCH,
    },
    validationRange: {
      si: { min: 50, max: 250 },
      conventional: { min: 20, max: 98 }, // ~50-250 cm
    },
    decimalPlaces: { si: 0, conventional: 1 },
  },

  weight: {
    canonical: 'kg',
    label: { si: 'kg', conventional: 'lbs' },
    toCanonical: {
      si: identity,
      conventional: (v) => v / LBS_PER_KG,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v * LBS_PER_KG,
    },
    validationRange: {
      si: { min: 20, max: 300 },
      conventional: { min: 44, max: 661 }, // ~20-300 kg
    },
    decimalPlaces: { si: 1, conventional: 0 },
  },

  waist: {
    canonical: 'cm',
    label: { si: 'cm', conventional: 'in' },
    toCanonical: {
      si: identity,
      conventional: (v) => v * CM_PER_INCH,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v / CM_PER_INCH,
    },
    validationRange: {
      si: { min: 40, max: 200 },
      conventional: { min: 16, max: 79 }, // ~40-200 cm
    },
    decimalPlaces: { si: 0, conventional: 1 },
  },

  hba1c: {
    canonical: 'mmol/mol',
    label: { si: 'mmol/mol', conventional: '%' },
    toCanonical: {
      si: identity,
      conventional: hba1cNgspToIfcc,
    },
    fromCanonical: {
      si: identity,
      conventional: hba1cIfccToNgsp,
    },
    validationRange: {
      si: { min: 9, max: 195 }, // ~3-20% NGSP
      conventional: { min: 3, max: 20 },
    },
    decimalPlaces: { si: 0, conventional: 1 },
  },

  ldl: {
    canonical: 'mmol/L',
    label: { si: 'mmol/L', conventional: 'mg/dL' },
    toCanonical: {
      si: identity,
      conventional: (v) => v / CHOLESTEROL_FACTOR,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v * CHOLESTEROL_FACTOR,
    },
    validationRange: {
      si: { min: 0, max: 12.9 }, // ~0-500 mg/dL
      conventional: { min: 0, max: 500 },
    },
    decimalPlaces: { si: 1, conventional: 0 },
  },

  hdl: {
    canonical: 'mmol/L',
    label: { si: 'mmol/L', conventional: 'mg/dL' },
    toCanonical: {
      si: identity,
      conventional: (v) => v / CHOLESTEROL_FACTOR,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v * CHOLESTEROL_FACTOR,
    },
    validationRange: {
      si: { min: 0, max: 5.2 }, // ~0-200 mg/dL
      conventional: { min: 0, max: 200 },
    },
    decimalPlaces: { si: 1, conventional: 0 },
  },

  triglycerides: {
    canonical: 'mmol/L',
    label: { si: 'mmol/L', conventional: 'mg/dL' },
    toCanonical: {
      si: identity,
      conventional: (v) => v / TRIGLYCERIDES_FACTOR,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v * TRIGLYCERIDES_FACTOR,
    },
    validationRange: {
      si: { min: 0, max: 22.6 }, // ~0-2000 mg/dL
      conventional: { min: 0, max: 2000 },
    },
    decimalPlaces: { si: 1, conventional: 0 },
  },

  fasting_glucose: {
    canonical: 'mmol/L',
    label: { si: 'mmol/L', conventional: 'mg/dL' },
    toCanonical: {
      si: identity,
      conventional: (v) => v / GLUCOSE_FACTOR,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v * GLUCOSE_FACTOR,
    },
    validationRange: {
      si: { min: 0, max: 27.8 }, // ~0-500 mg/dL
      conventional: { min: 0, max: 500 },
    },
    decimalPlaces: { si: 1, conventional: 0 },
  },

  systolic_bp: {
    canonical: 'mmHg',
    label: { si: 'mmHg', conventional: 'mmHg' },
    toCanonical: { si: identity, conventional: identity },
    fromCanonical: { si: identity, conventional: identity },
    validationRange: {
      si: { min: 60, max: 250 },
      conventional: { min: 60, max: 250 },
    },
    decimalPlaces: { si: 0, conventional: 0 },
  },

  diastolic_bp: {
    canonical: 'mmHg',
    label: { si: 'mmHg', conventional: 'mmHg' },
    toCanonical: { si: identity, conventional: identity },
    fromCanonical: { si: identity, conventional: identity },
    validationRange: {
      si: { min: 40, max: 150 },
      conventional: { min: 40, max: 150 },
    },
    decimalPlaces: { si: 0, conventional: 0 },
  },

  apob: {
    canonical: 'g/L',
    label: { si: 'g/L', conventional: 'mg/dL' },
    toCanonical: {
      si: identity,
      conventional: (v) => v / APOB_FACTOR,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v * APOB_FACTOR,
    },
    validationRange: {
      si: { min: 0, max: 3 },
      conventional: { min: 0, max: 300 },
    },
    decimalPlaces: { si: 2, conventional: 0 },
  },
};

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/** Convert a display-unit value to the canonical (SI) unit for storage. */
export function toCanonicalValue(
  metric: MetricType,
  displayValue: number,
  system: UnitSystem,
): number {
  return UNIT_DEFS[metric].toCanonical[system](displayValue);
}

/** Convert a canonical (SI) value to the display unit. */
export function fromCanonicalValue(
  metric: MetricType,
  canonicalValue: number,
  system: UnitSystem,
): number {
  return UNIT_DEFS[metric].fromCanonical[system](canonicalValue);
}

/** Format a canonical value for display (converted + rounded). */
export function formatDisplayValue(
  metric: MetricType,
  canonicalValue: number,
  system: UnitSystem,
): string {
  const display = fromCanonicalValue(metric, canonicalValue, system);
  const dp = UNIT_DEFS[metric].decimalPlaces[system];
  return display.toFixed(dp);
}

/** Get the display unit label for a metric (e.g. "mg/dL" or "mmol/L"). */
export function getDisplayLabel(metric: MetricType, system: UnitSystem): string {
  return UNIT_DEFS[metric].label[system];
}

/** Get the validation range in the user's display units. */
export function getDisplayRange(
  metric: MetricType,
  system: UnitSystem,
): { min: number; max: number } {
  return UNIT_DEFS[metric].validationRange[system];
}

// ---------------------------------------------------------------------------
// Locale detection
// ---------------------------------------------------------------------------

/** Countries that use conventional (US) units: US, Liberia, Myanmar. */
const CONVENTIONAL_COUNTRIES = new Set(['US', 'LR', 'MM']);

/**
 * Detect the preferred unit system from the browser locale.
 * Falls back to 'si' if detection fails.
 *
 * Works in both browser (navigator.language) and server (defaults to 'si').
 */
export function detectUnitSystem(locale?: string): UnitSystem {
  const lang = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
  if (!lang) return 'si';

  // Extract country code from locale (e.g. "en-US" → "US", "en-NZ" → "NZ")
  const parts = lang.split('-');
  const country = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : null;

  if (country && CONVENTIONAL_COUNTRIES.has(country)) {
    return 'conventional';
  }

  return 'si';
}

// ---------------------------------------------------------------------------
// Clinical threshold helpers (in SI canonical units)
// ---------------------------------------------------------------------------

/** HbA1c thresholds in mmol/mol (IFCC) */
export const HBA1C_THRESHOLDS = {
  prediabetes: hba1cNgspToIfcc(5.7), // ~38.8 mmol/mol
  diabetes: hba1cNgspToIfcc(6.5),     // ~47.5 mmol/mol
} as const;

/** LDL thresholds in mmol/L */
export const LDL_THRESHOLDS = {
  borderline: 130 / CHOLESTEROL_FACTOR,  // ~3.36
  high: 160 / CHOLESTEROL_FACTOR,        // ~4.14
  veryHigh: 190 / CHOLESTEROL_FACTOR,    // ~4.91
} as const;

/** HDL thresholds in mmol/L */
export const HDL_THRESHOLDS = {
  lowMale: 40 / CHOLESTEROL_FACTOR,   // ~1.03
  lowFemale: 50 / CHOLESTEROL_FACTOR, // ~1.29
} as const;

/** Triglycerides thresholds in mmol/L */
export const TRIGLYCERIDES_THRESHOLDS = {
  borderline: 150 / TRIGLYCERIDES_FACTOR, // ~1.69
  high: 200 / TRIGLYCERIDES_FACTOR,       // ~2.26
  veryHigh: 500 / TRIGLYCERIDES_FACTOR,   // ~5.64
} as const;

/** Fasting glucose thresholds in mmol/L */
export const GLUCOSE_THRESHOLDS = {
  prediabetes: 100 / GLUCOSE_FACTOR, // ~5.55
  diabetes: 126 / GLUCOSE_FACTOR,    // ~6.99
} as const;

/** Blood pressure thresholds (mmHg — same in both systems) */
export const BP_THRESHOLDS = {
  elevatedSys: 120,
  stage1Sys: 130,
  stage1Dia: 80,
  stage2Sys: 140,
  stage2Dia: 90,
  crisisSys: 180,
  crisisDia: 120,
} as const;

/** ApoB thresholds in g/L */
export const APOB_THRESHOLDS = {
  borderline: 50 / APOB_FACTOR,  // 0.5
  high: 70 / APOB_FACTOR,        // 0.7
  veryHigh: 100 / APOB_FACTOR,   // 1.0
} as const;
