// Types
export type {
  HealthInputs,
  HealthResults,
  Suggestion,
  Measurement,
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
} from './calculations';

// Suggestions
export { generateSuggestions } from './suggestions';

// Validation
export {
  METRIC_TYPES,
  healthInputSchema,
  measurementSchema,
  profileUpdateSchema,
  validateHealthInputs,
  getValidationErrors,
  type MetricTypeValue,
  type ValidatedHealthInputs,
  type ValidatedMeasurement,
  type ValidatedProfileUpdate,
} from './validation';

// Mappings (shared field↔metric conversions)
export {
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  PREFILL_FIELDS,
  LONGITUDINAL_FIELDS,
  measurementsToInputs,
  diffInputsToMeasurements,
  diffProfileFields,
  type ApiMeasurement,
  type ApiProfile,
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
  GLUCOSE_THRESHOLDS,
  BP_THRESHOLDS,
  type MetricType,
  type UnitSystem,
  type UnitDef,
} from './units';
