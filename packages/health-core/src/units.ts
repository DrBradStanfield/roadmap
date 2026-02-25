/**
 * Unit system definitions, conversions, and locale detection.
 *
 * All values in the database and in HealthInputs are stored in SI canonical
 * units. This module converts between SI and conventional (US) display units.
 *
 * Canonical units:
 *   height/waist: cm       | weight: kg          | BP: mmHg (universal)
 *   HbA1c: mmol/mol (IFCC) | lipids: mmol/L
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
  | 'total_cholesterol'
  | 'systolic_bp'
  | 'diastolic_bp'
  | 'apob'
  | 'creatinine'
  | 'psa'
  | 'lpa';

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

// Lipid molecular-weight factors (mg/dL ↔ mmol/L)
const CHOLESTEROL_FACTOR = 38.67; // LDL, HDL, total cholesterol
const TRIGLYCERIDES_FACTOR = 88.57;

const APOB_FACTOR = 100; // g/L ↔ mg/dL
const CREATININE_FACTOR = 88.4; // µmol/L ↔ mg/dL

// Feet/inches conversion
const INCHES_PER_FOOT = 12;

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
// Unit definition factories (reduce boilerplate for common patterns)
// ---------------------------------------------------------------------------

type Range = { min: number; max: number };

/** mmol/L ↔ mg/dL conversion using a multiplication factor. */
function makeMmolMgdlUnit(factor: number, siRange: Range, convRange: Range, siDp = 1, convDp = 0): UnitDef {
  return {
    canonical: 'mmol/L',
    label: { si: 'mmol/L', conventional: 'mg/dL' },
    toCanonical: { si: identity, conventional: (v) => v / factor },
    fromCanonical: { si: identity, conventional: (v) => v * factor },
    validationRange: { si: siRange, conventional: convRange },
    decimalPlaces: { si: siDp, conventional: convDp },
  };
}

/** Same unit in both systems (no conversion needed). */
function makeIdentityUnit(canonical: string, range: Range, dp: number): UnitDef {
  return {
    canonical,
    label: { si: canonical, conventional: canonical },
    toCanonical: { si: identity, conventional: identity },
    fromCanonical: { si: identity, conventional: identity },
    validationRange: { si: range, conventional: range },
    decimalPlaces: { si: dp, conventional: dp },
  };
}

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

  ldl: makeMmolMgdlUnit(CHOLESTEROL_FACTOR, { min: 0, max: 12.9 }, { min: 0, max: 500 }),
  hdl: makeMmolMgdlUnit(CHOLESTEROL_FACTOR, { min: 0, max: 5.2 }, { min: 0, max: 200 }),
  total_cholesterol: makeMmolMgdlUnit(CHOLESTEROL_FACTOR, { min: 0, max: 15 }, { min: 0, max: 580 }),
  triglycerides: makeMmolMgdlUnit(TRIGLYCERIDES_FACTOR, { min: 0, max: 22.6 }, { min: 0, max: 2000 }),

  systolic_bp: makeIdentityUnit('mmHg', { min: 60, max: 250 }, 0),
  diastolic_bp: makeIdentityUnit('mmHg', { min: 40, max: 150 }, 0),

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

  creatinine: {
    canonical: 'µmol/L',
    label: { si: 'µmol/L', conventional: 'mg/dL' },
    toCanonical: {
      si: identity,
      conventional: (v) => v * CREATININE_FACTOR,
    },
    fromCanonical: {
      si: identity,
      conventional: (v) => v / CREATININE_FACTOR,
    },
    validationRange: {
      si: { min: 10, max: 2650 }, // ~0.1-30 mg/dL
      conventional: { min: 0.1, max: 30 },
    },
    decimalPlaces: { si: 0, conventional: 2 },
  },
  psa: makeIdentityUnit('ng/mL', { min: 0, max: 100 }, 1),
  lpa: makeIdentityUnit('nmol/L', { min: 0, max: 750 }, 0),
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

/** IANA timezone identifiers for the United States. */
const US_TIMEZONES = new Set([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Anchorage', 'America/Phoenix', 'America/Adak', 'America/Detroit',
  'America/Boise', 'America/Juneau', 'America/Sitka', 'America/Yakutat',
  'America/Nome', 'America/Menominee', 'America/Metlakatla',
  'Pacific/Honolulu',
]);

function isUSTimezone(tz: string): boolean {
  return US_TIMEZONES.has(tz)
    || tz.startsWith('America/Indiana/')
    || tz.startsWith('America/Kentucky/')
    || tz.startsWith('America/North_Dakota/');
}

/**
 * Detect the preferred unit system from the browser locale.
 * Falls back to 'si' if detection fails.
 *
 * For en-US locales, cross-checks the browser timezone: many non-US users
 * configure their browser to US English. If the timezone is clearly outside
 * the US (e.g. Pacific/Auckland), defaults to SI.
 *
 * Works in both browser (navigator.language) and server (defaults to 'si').
 */
export function detectUnitSystem(locale?: string, timezone?: string): UnitSystem {
  const lang = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined);
  if (!lang) return 'si';

  // Extract country code from locale (e.g. "en-US" → "US", "en-NZ" → "NZ")
  const parts = lang.split('-');
  const country = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : null;

  if (country && CONVENTIONAL_COUNTRIES.has(country)) {
    // Cross-check timezone for en-US: many non-US users use US English
    if (country === 'US') {
      const tz = timezone ?? (typeof Intl !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined);
      if (tz && !isUSTimezone(tz)) {
        return 'si';
      }
    }
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

/** Total cholesterol thresholds in mmol/L */
export const TOTAL_CHOLESTEROL_THRESHOLDS = {
  borderline: 200 / CHOLESTEROL_FACTOR, // ~5.17
  high: 240 / CHOLESTEROL_FACTOR,       // ~6.21
} as const;

/** Non-HDL cholesterol thresholds in mmol/L (LDL thresholds + 30 mg/dL for VLDL) */
export const NON_HDL_THRESHOLDS = {
  borderline: 160 / CHOLESTEROL_FACTOR, // ~4.14
  high: 190 / CHOLESTEROL_FACTOR,       // ~4.91
  veryHigh: 220 / CHOLESTEROL_FACTOR,   // ~5.69
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

/** eGFR thresholds in mL/min/1.73m² */
export const EGFR_THRESHOLDS = {
  lowNormal: 60,           // eGFR 60-69: low normal (no CKD without markers)
  mildlyDecreased: 45,     // G3a: mildly decreased
  moderatelyDecreased: 30, // G3b: moderately decreased
  severelyDecreased: 15,   // G4: severely decreased
} as const;

/** ApoB thresholds in g/L */
export const APOB_THRESHOLDS = {
  borderline: 50 / APOB_FACTOR,  // 0.5
  high: 70 / APOB_FACTOR,        // 0.7
  veryHigh: 100 / APOB_FACTOR,   // 1.0
} as const;

/** PSA thresholds in ng/mL (same in both unit systems) */
export const PSA_THRESHOLDS = {
  normal: 4.0,  // General upper limit of normal (varies by age)
} as const;

/** Lp(a) thresholds in nmol/L (same in both unit systems) */
export const LPA_THRESHOLDS = {
  normal: 75,     // <75 nmol/L is normal
  elevated: 125,  // ≥125 nmol/L is elevated
} as const;

// ---------------------------------------------------------------------------
// Feet/inches conversion helpers (for US height display)
// ---------------------------------------------------------------------------

/**
 * Convert total inches to feet and remaining inches.
 * @returns { feet: number, inches: number } - feet is whole number, inches is 0-11
 */
export function inchesToFeetInches(totalInches: number): { feet: number; inches: number } {
  const feet = Math.floor(totalInches / INCHES_PER_FOOT);
  const inches = Math.round(totalInches % INCHES_PER_FOOT);
  // Handle rounding edge case (11.5+ inches rounds to 12)
  if (inches >= INCHES_PER_FOOT) {
    return { feet: feet + 1, inches: 0 };
  }
  return { feet, inches };
}

/**
 * Convert feet and inches to total inches.
 */
export function feetInchesToInches(feet: number, inches: number): number {
  return feet * INCHES_PER_FOOT + inches;
}

/**
 * Convert cm to feet and inches for display.
 */
export function cmToFeetInches(cm: number): { feet: number; inches: number } {
  const totalInches = cm / CM_PER_INCH;
  return inchesToFeetInches(totalInches);
}

/**
 * Convert feet and inches to cm for storage.
 */
export function feetInchesToCm(feet: number, inches: number): number {
  const totalInches = feetInchesToInches(feet, inches);
  return totalInches * CM_PER_INCH;
}

/**
 * Format height for display in the user's unit system.
 * Returns "X'Y"" for conventional or "X cm" for SI.
 */
export function formatHeightDisplay(cm: number, unitSystem: UnitSystem): string {
  if (unitSystem === 'si') {
    return `${Math.round(cm)} cm`;
  }
  const { feet, inches } = cmToFeetInches(cm);
  return `${feet}'${inches}"`;
}
