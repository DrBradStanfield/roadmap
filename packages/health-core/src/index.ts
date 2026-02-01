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
  validateHealthInputs,
  getValidationErrors,
  type MetricTypeValue,
  type ValidatedHealthInputs,
  type ValidatedMeasurement,
} from './validation';

// Mappings (shared field↔metric conversions)
export {
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  measurementsToInputs,
  diffInputsToMeasurements,
  type ApiMeasurement,
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
  GLUCOSE_THRESHOLDS,
  BP_THRESHOLDS,
  type MetricType,
  type UnitSystem,
  type UnitDef,
} from './units';
