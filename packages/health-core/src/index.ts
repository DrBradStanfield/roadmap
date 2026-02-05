// Types
export type {
  HealthInputs,
  HealthResults,
  Suggestion,
  Measurement,
  MedicationInputs,
  ScreeningInputs,
  StatinValue,
} from './types';

export {
  STATIN_OPTIONS,
  MAX_STATIN_TIER,
  getStatinTier,
  SCREENING_INTERVALS,
} from './types';

// Calculations
export {
  calculateIBW,
  calculateProteinTarget,
  calculateBMI,
  calculateWaistToHeight,
  calculateAge,
  getBMICategory,
  calculateHealthResults,
  calculateEGFR,
} from './calculations';

// Suggestions
export { generateSuggestions, LIPID_TREATMENT_TARGETS } from './suggestions';

// Validation
export {
  METRIC_TYPES,
  healthInputSchema,
  measurementSchema,
  profileUpdateSchema,
  validateHealthInputs,
  getValidationErrors,
  convertValidationErrorsToUnits,
  type MetricTypeValue,
  type ValidatedHealthInputs,
  type ValidatedMeasurement,
  type ValidatedProfileUpdate,
  MEDICATION_KEYS,
  medicationSchema,
  type ValidatedMedication,
  SCREENING_KEYS,
  screeningSchema,
  type ValidatedScreening,
} from './validation';

// Mappings (shared field↔metric conversions)
export {
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  PREFILL_FIELDS,
  LONGITUDINAL_FIELDS,
  BLOOD_TEST_METRICS,
  measurementsToInputs,
  diffInputsToMeasurements,
  diffProfileFields,
  type ApiMeasurement,
  type ApiProfile,
  type ApiMedication,
  medicationsToInputs,
  type ApiScreening,
  screeningsToInputs,
} from './mappings';

// Units
export {
  UNIT_DEFS,
  toCanonicalValue,
  fromCanonicalValue,
  formatDisplayValue,
  getDisplayLabel,
  getDisplayRange,
  detectUnitSystem,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  NON_HDL_THRESHOLDS,
  BP_THRESHOLDS,
  APOB_THRESHOLDS,
  EGFR_THRESHOLDS,
  PSA_THRESHOLDS,
  // Feet/inches height conversion helpers
  inchesToFeetInches,
  feetInchesToInches,
  cmToFeetInches,
  feetInchesToCm,
  formatHeightDisplay,
  type MetricType,
  type UnitSystem,
  type UnitDef,
} from './units';
