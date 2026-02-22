// Types
export type {
  HealthInputs,
  HealthResults,
  Suggestion,
  Measurement,
  MedicationInputs,
  ScreeningInputs,
  ScreeningResult,
  ScreeningFollowupStatus,
  StatinInput,
  StatinNameValue,
  EzetimibeValue,
  Pcsk9iValue,
  Glp1Input,
  Glp1NameValue,
  Sglt2iInput,
  Sglt2iNameValue,
  MetforminValue,
} from './types';

export {
  // Statin configuration (BPAC 2021)
  STATIN_DRUGS,
  STATIN_NAMES,
  STATIN_POTENCY,
  MAX_STATIN_POTENCY,
  getStatinDoses,
  getCurrentPotency,
  canIncreaseDose,
  shouldSuggestSwitch,
  isOnMaxPotency,
  getStatinEscalationType,
  // Ezetimibe & PCSK9i options
  EZETIMIBE_OPTIONS,
  PCSK9I_OPTIONS,
  // GLP-1 configuration
  GLP1_DRUGS,
  GLP1_NAMES,
  // GLP-1 escalation
  MAX_GLP1_DRUG,
  canIncreaseGlp1Dose,
  shouldSuggestGlp1Switch,
  isOnMaxGlp1Potency,
  getGlp1EscalationType,
  // SGLT2i configuration
  SGLT2I_DRUGS,
  SGLT2I_NAMES,
  // Metformin options
  METFORMIN_OPTIONS,
  // Screening
  SCREENING_INTERVALS,
  getScreeningNextDueDate,
  POST_FOLLOWUP_INTERVALS,
  SCREENING_FOLLOWUP_INFO,
  // Database encoding helpers
  SEX_DB,
  UNIT_SYSTEM_DB,
  encodeSex,
  decodeSex,
  encodeUnitSystem,
  decodeUnitSystem,
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
  validateInputValue,
  isBirthYearClearlyInvalid,
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
  hasCloudData,
  type ApiMeasurement,
  type ApiProfile,
  type ApiMedication,
  medicationsToInputs,
  type ApiScreening,
  screeningsToInputs,
  computeFormStage,
  resolveEmailConfirmStatus,
} from './mappings';

// Reminders
export {
  computeDueReminders,
  filterByPreferences,
  getCategoryGroup,
  formatReminderDate,
  REMINDER_CATEGORIES,
  REMINDER_CATEGORY_LABELS,
  GROUP_COOLDOWNS,
  type ReminderGroup,
  type ReminderCategory,
  type DueReminder,
  type BloodTestDate,
  type ReminderProfile,
  type MeasurementDates,
  type MedicationRecord,
  type ComputeRemindersResult,
} from './reminders';

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
  LPA_THRESHOLDS,
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
