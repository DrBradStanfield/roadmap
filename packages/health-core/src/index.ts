// Types
export type {
  HealthInputs,
  HealthResults,
  Suggestion,
  SuggestionReference,
  Measurement,
  MedicationInputs,
  ScreeningInputs,
  ScreeningResult,
  ScreeningFollowupStatus,
  StatinInput,
  StatinNameValue,
  EzetimibeValue,
  BempedoicAcidValue,
  Pcsk9iValue,
  Glp1Input,
  Glp1NameValue,
  Sglt2iInput,
  Sglt2iNameValue,
  MetforminValue,
  SupplementOption,
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
  // Ezetimibe, bempedoic acid & PCSK9i options
  EZETIMIBE_OPTIONS,
  BEMPEDOIC_ACID_OPTIONS,
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
  SCREENING_MIN_AGE,
  isScreeningEligible,
  // Supplement options
  SUPPLEMENT_OPTIONS,
  FEATURED_SUPPLEMENTS,
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
  getEgfrStatus,
  getLpaStatus,
  getHba1cStatus,
  getLipidStatus,
  getProteinRate,
  calculateHealthResults,
  calculateEGFR,
} from './calculations';

// Suggestions
export { generateSuggestions, LIPID_TREATMENT_TARGETS, LIPID_DIET_ADVICE, resolveBestLipidMarker } from './suggestions';
export type { LipidMarker } from './suggestions';

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
  supplementSchema,
  type ValidatedMedication,
  SCREENING_KEYS,
  screeningSchema,
  type ValidatedScreening,
  labImportRequestSchema,
  type LabImportRequest,
  bulkMeasurementSchema,
  type BulkMeasurementRequest,
  MEASUREMENT_SOURCES,
  type MeasurementSource,
  MEASUREMENT_STATUS,
  type MeasurementStatus,
  DOCUMENT_TYPES,
  type DocumentType,
} from './validation';

export { parseLocalisedNumber } from './parseNumber';

// Mappings (shared field↔metric conversions)
export {
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  METRIC_LABELS,
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

// Chat → form-edit tool schemas + validation (chatbot drives the form UI)
export {
  EDITABLE_FIELDS,
  VITALS_INPUT_FIELDS,
  PROPOSE_FIELD_EDIT_TOOL,
  PROPOSE_MEDICATION_EDIT_TOOL,
  CHAT_EDIT_TOOLS,
  PREFILL_ACK_MESSAGE,
  resolveUnitSystem,
  parseProposedEdit,
  parseProposedEdits,
  type EditableField,
  type ProposedEdit,
  type ProposedFieldEdit,
  type ProposedMedicationEdit,
} from './chat-edits';

// Evidence (stat card clinical detail)
export type { SuggestionEvidence } from './evidence';
export { STAT_CARD_EVIDENCE, getIbwEvidence, getProteinEvidence, getBmiEvidence } from './evidence';

// Reference-range hints (blood-test matrix + legacy form labels)
export type { RefHint, SexedRefHint } from './reference-hints';
export { REFERENCE_HINTS, refHintFor } from './reference-hints';

// Sentry PII/PHI scrubbing
export {
  scrubSensitiveData,
  scrubUrl,
  scrubBreadcrumbData,
} from './sentry-scrub';

// Local-first storage spine (v2) — the RoadmapFile schema + merge/migrate logic.
// Browser-coupled cloud adapters live in widget-src/src/storage/, not here.
export {
  CURRENT_SCHEMA_VERSION,
  createEmptyFile,
  createMeasurement,
  stableStringify,
  type RoadmapFile,
  type RoadmapFileMeta,
  type RoadmapProfile,
  type FileMeasurement,
  type FileLabValue,
  type FileMedication,
  type FileSupplement,
  type FileScreenings,
  type FileReminderPreference,
  type FileReminderOptIn,
  type FileDocument,
  type RecommendationSnapshot,
  type SyncStamp,
  type HistoryChangeType,
} from './roadmap-file';
export { mergeFiles, dayOf, type MergeOptions } from './merge';
export { classifyMedicationChange, classifySupplementChange, isTakingDrug } from './history-change';
export { migrateFile, SchemaTooNewError } from './migrate';

// v2 reminder schedule (client-computed; the server is a dumb scheduler — §10)
export {
  computeReminderSchedule,
  computeNextDueDates,
  SCHEDULE_LABELS,
  ANNUAL_CHECKIN_LABEL,
  type ReminderScheduleItem,
} from './reminder-schedule';

// v2 document paths — the organised-archive scheme (folders + date-first names)
export {
  buildDocumentRef,
  DOCUMENT_FOLDERS,
  extensionOf,
  sanitizeTitle,
  splitDocumentRef,
} from './document-path';

// v2 measurement recency — dated chat history + newest-active-row resolution
export {
  buildMeasurementHistory,
  latestActivePerMetric,
  latestFromHistory,
  HISTORY_CAP_PER_METRIC,
  type DatedMeasurement,
  type MeasurementHistoryMap,
} from './measurement-history';

// Product funnel events — anonymous behavioral counters (client tracker + server enum)
export { PRODUCT_EVENT_NAMES, type ProductEventName } from './product-events';

// US-21 additional blood-test catalogue (phase-1 scaffold — units/groups/aliases)
export {
  LAB_CATALOG,
  LAB_GROUPS,
  resolveLabCatalogEntry,
  normalizeLabUnit,
  displayLabUnit,
  type LabCatalogEntry,
  type LabGroup,
  type LabGroupId,
} from './lab-catalog';

// chat-history.json — chat conversations synced to the user's own cloud (Phase 6)
export {
  CHAT_HISTORY_SCHEMA_VERSION,
  CHAT_HISTORY_MAX_CONVERSATIONS,
  createEmptyChatHistoryFile,
  migrateChatHistoryFile,
  mergeChatHistoryFiles,
  mergeMessages,
  type ChatFileConversation,
  type ChatFileMessage,
  type ChatHistoryFile,
  type ChatHistoryFileMeta,
} from './chat-history';
