import { useState, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { ColumnHeader } from './ColumnHeader';
import { DocumentLightbox } from './DocumentLightbox';
import { DOCUMENT_TYPE_LABELS, formatDocumentDate, type ApiDocument, type ApiSupplement, HISTORY_PAGE_PATH, openHistoryLightbox,
} from '../lib/api';

/** Intercept a history link: lightbox on the standalone, normal nav on Shopify. */
const interceptHistory = (metric: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
  if (openHistoryLightbox(metric)) e.preventDefault();
};
import type { HealthInputs, ScreeningInputs } from '@roadmap/health-core';
import {
  type UnitSystem,
  fromCanonicalValue,
  toCanonicalValue,
  getDisplayLabel,
  getDisplayRange,
  UNIT_DEFS,
  FIELD_METRIC_MAP,
  medicationsToInputs,
  screeningsToInputs,
  type ApiMeasurement,
  type ApiMedication,
  type ApiScreening,
  STATIN_NAMES,
  STATIN_DRUGS,
  EZETIMIBE_OPTIONS,
  PCSK9I_OPTIONS,
  BEMPEDOIC_ACID_OPTIONS,
  SUPPLEMENT_OPTIONS,
  FEATURED_SUPPLEMENTS,
  canIncreaseDose,
  shouldSuggestSwitch,
  isOnMaxPotency,
  LIPID_TREATMENT_TARGETS,
  LIPID_DIET_ADVICE,
  resolveBestLipidMarker,
  calculateAge,
  calculateBMI,
  cmToFeetInches,
  feetInchesToCm,
  formatHeightDisplay,
  GLP1_NAMES,
  GLP1_DRUGS,
  canIncreaseGlp1Dose,
  shouldSuggestGlp1Switch,
  isOnMaxGlp1Potency,
  SGLT2I_NAMES,
  SGLT2I_DRUGS,
  METFORMIN_OPTIONS,
  HBA1C_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  BP_THRESHOLDS,
  SCREENING_FOLLOWUP_INFO,
  validateInputValue,
  isBirthYearClearlyInvalid,
  REFERENCE_HINTS,
  type SexedRefHint,
  parseLocalisedNumber,
} from '@roadmap/health-core';
import { formatShortDate } from '../lib/constants';
import { LOCAL_FIRST } from '../lib/build-flags';
import { DatePicker, InlineDatePicker, getCurrentDateValue, type DateValue } from './DatePicker';
import { BloodTestTimeline } from './BloodTestTimeline';
import { StartingInfoVitals } from './StartingInfoVitals';
import { CommitTickButton } from './CommitTickButton';

interface FieldConfig {
  field: keyof HealthInputs;
  name: string;
  step?: { si: string; conv: string };
  hint?: { si: string; conv: string };
  hintMale?: { si: string; conv: string };
  hintFemale?: { si: string; conv: string };
}

const BASIC_LONGITUDINAL_FIELDS: FieldConfig[] = [
  { field: 'weightKg', name: 'Weight' },
  { field: 'waistCm', name: 'Waist Circumference' },
];

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const ALL_MONTHS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
];

/** Look up a screening value by its snake_case DB key. */
function scrVal(scr: ScreeningInputs, dbKey: string): string | number | undefined {
  const camelKey = dbKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return scr[camelKey as keyof ScreeningInputs];
}
function scrStr(scr: ScreeningInputs, dbKey: string): string | undefined {
  return scrVal(scr, dbKey) as string | undefined;
}
function scrNum(scr: ScreeningInputs, dbKey: string): number | undefined {
  return scrVal(scr, dbKey) as number | undefined;
}

// Hint table lives in `packages/health-core/src/reference-hints.ts` so the
// matrix UI and the legacy form labels stay in lockstep. Local config below
// keeps only UI-specific bits (display name, numeric step). Hints are merged
// from REFERENCE_HINTS at module-load time.
interface BloodTestFieldBase {
  field: keyof HealthInputs;
  name: string;
  metric: string;
  step?: { si: string; conv: string };
}

const BLOOD_TEST_FIELDS_BASE: BloodTestFieldBase[] = [
  { field: 'hba1c',            name: 'HbA1c',             metric: 'hba1c',             step: { si: '1',    conv: '0.1' } },
  { field: 'creatinine',       name: 'Creatinine',        metric: 'creatinine',        step: { si: '1',    conv: '0.01' } },
  { field: 'apoB',             name: 'ApoB',              metric: 'apob',              step: { si: '0.01', conv: '1' } },
  { field: 'ldlC',             name: 'LDL Cholesterol',   metric: 'ldl',               step: { si: '0.1',  conv: '1' } },
  { field: 'totalCholesterol', name: 'Total Cholesterol', metric: 'total_cholesterol', step: { si: '0.1',  conv: '1' } },
  { field: 'hdlC',             name: 'HDL Cholesterol',   metric: 'hdl',               step: { si: '0.1',  conv: '1' } },
  { field: 'triglycerides',    name: 'Triglycerides',     metric: 'triglycerides',     step: { si: '0.1',  conv: '1' } },
  { field: 'lpa',              name: 'Lp(a)',             metric: 'lpa',               step: { si: '1',    conv: '1' } },
];

function refHintToFieldHint(rh: { si: string; conv: string }): { si: string; conv: string } {
  return { si: rh.si, conv: rh.conv };
}

const BLOOD_TEST_FIELDS: FieldConfig[] = BLOOD_TEST_FIELDS_BASE.map(({ field, name, metric, step }) => {
  const ref: SexedRefHint | undefined = (REFERENCE_HINTS as Record<string, SexedRefHint | undefined>)[metric];
  const out: FieldConfig = { field, name, step };
  if (ref) {
    out.hint = refHintToFieldHint(ref);
    if (ref.male) out.hintMale = refHintToFieldHint(ref.male);
    if (ref.female) out.hintFemale = refHintToFieldHint(ref.female);
  }
  return out;
});

interface InputPanelProps {
  inputs: Partial<HealthInputs>;
  onChange: (inputs: Partial<HealthInputs>) => void;
  errors: Record<string, string>;
  unitSystem: UnitSystem;
  onUnitSystemChange: (system: UnitSystem) => void;
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: (field: string) => void;
  isLoggedIn: boolean;
  previousMeasurements: ApiMeasurement[];
  bloodTestHistory: ApiMeasurement[];
  /** Full vitals history (weight / waist / sys-BP / dia-BP). Same source
   *  as bloodTestHistory — just a different filter. */
  vitalsHistory: ApiMeasurement[];
  onSaveBloodTestBatch: (date: string, values: Record<string, number>) => Promise<void>;
  // Click-to-correct handler for saved cells in the BloodTestTimeline matrix.
  onCorrectBloodTestValue?: (oldId: string, newValueSI: number) => Promise<boolean>;
  medications: ApiMedication[];
  onMedicationChange: (medicationKey: string, drugName: string, doseValue: number | null, doseUnit: string | null) => void;
  screenings: ApiScreening[];
  onScreeningChange: (screeningKey: string, value: string) => void;
  supplements: ApiSupplement[];
  onSupplementChange: (key: string, name: string, doseValue: number | null, doseUnit: string | null, status?: string, startedAt?: string) => void;
  onSupplementDelete: (key: string) => void;
  /** Debounced auto-save: call on every input blur. Batches rapid blurs
   *  (e.g. systolic→diastolic tab) into one save 500ms after the last blur. */
  scheduleLongitudinalSave: () => void;
  /** Flush the debounced save immediately. Call on Enter so the user gets
   *  a save without waiting for the 500ms tail. */
  flushLongitudinalSave: () => void;
  isSavingLongitudinal: boolean;
  hasApiResponse: boolean;
  // Forwarded to BloodTestTimeline so the parent (HealthTool) can flush
  // typed-but-unsaved matrix values before kicking off the upload modal.
  bloodTestFlushRef?: MutableRefObject<(() => Promise<void>) | null>;
  formStage: 1 | 2 | 3;
  lastSavedAt?: number | null;
  setShowUploadModal?: (show: boolean) => void;
  loginUrl?: string;
  activeSuggestionIds?: Set<string>;
  healthDocuments?: ApiDocument[];
  onDocumentDeleted?: (docId: string) => void;
  onAutoFocusEmail?: () => void;
}

/**
 * Auto-advance focus once a typed value is complete: fires immediately, or
 * after a short wait when the current digits could still extend to another
 * valid value (weight "25" might become "250"; inches "1" might become "11").
 * Owns the timer: each call cancels the previous pending advance, and unmount
 * cleans up. The field-specific "could this extend?" predicate stays at the
 * call site.
 */
function useAutoAdvance(): (opts: { ambiguous: boolean; advance: () => void }) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return ({ ambiguous, advance }) => {
    if (timer.current) clearTimeout(timer.current);
    if (ambiguous) timer.current = setTimeout(advance, 800);
    else advance();
  };
}

export function InputPanel({
  inputs, onChange, errors, unitSystem, onUnitSystemChange,
  unitOverrides, onToggleFieldUnit,
  isLoggedIn, previousMeasurements, bloodTestHistory, vitalsHistory, onSaveBloodTestBatch,
  onCorrectBloodTestValue,
  medications, onMedicationChange,
  screenings, onScreeningChange,
  supplements, onSupplementChange, onSupplementDelete,
  scheduleLongitudinalSave, flushLongitudinalSave,
  isSavingLongitudinal, hasApiResponse,
  bloodTestFlushRef,
  formStage,
  lastSavedAt,
  setShowUploadModal, loginUrl, activeSuggestionIds,
  healthDocuments, onDocumentDeleted, onAutoFocusEmail,
}: InputPanelProps) {
  const [prefillExpanded, setPrefillExpanded] = useState(false);
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({});
  const hasAutoFocusedEmail = useRef(false);
  // One auto-advance instance per TARGET, so a new keystroke on any source
  // field cancels a pending advance to that target.
  const advanceToWeight = useAutoAdvance();
  const advanceToEmail = useAutoAdvance();
  const focusById = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
  const [dateInputs, setDateInputs] = useState<Record<string, { year: string; month: string }>>({});

  // Expand/collapse state for display-first longitudinal fields.
  // (Blood tests have their own matrix UI in BloodTestTimeline; no expand state here.)
  const [expandedVitals, setExpandedVitals] = useState<Set<string>>(new Set());
  // Latched synchronously at mount from raw localStorage. Avoids the
  // flash of the legacy form before async data hydrates. localStorage
  // holds both guest inputs AND the cached `previousMeasurements` for
  // logged-in users (HealthTool's load writes both), so a single check
  // covers both auth states. First-time-ever users (no localStorage
  // entry at all) get 'legacy'; everyone returning gets 'matrix'.
  const [vitalsViewMode] = useState<'legacy' | 'matrix'>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('health_roadmap_data') || '{}');
      const i = raw.inputs ?? {};
      const hasInputs = i.weightKg !== undefined
        || i.waistCm !== undefined
        || i.systolicBp !== undefined
        || i.diastolicBp !== undefined;
      const VITAL_TYPES = new Set(['weight', 'waist', 'systolic_bp', 'diastolic_bp']);
      const hasMeasurements = (raw.previousMeasurements ?? [])
        .some((r: { metricType?: string }) => r.metricType && VITAL_TYPES.has(r.metricType));
      return (hasInputs || hasMeasurements) ? 'matrix' : 'legacy';
    } catch {
      return 'legacy';
    }
  });
  const [bpExpanded, setBpExpanded] = useState(false);
  const focusFieldRef = useRef<string | null>(null);

  // Auto-focus and scroll to the field that triggered an expand
  useEffect(() => {
    if (!focusFieldRef.current) return;
    const field = focusFieldRef.current;
    focusFieldRef.current = null;
    requestAnimationFrame(() => {
      const input = document.getElementById(field);
      if (input) {
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, [expandedVitals, bpExpanded]);

  /** Prevent scroll wheel from changing number input values. */
  const blurOnWheel = (e: React.WheelEvent<HTMLInputElement>) => e.currentTarget.blur();

  // Shared blur/Enter auto-save handlers for every longitudinal input. Each
  // site does its own pre-work (validateOnBlur, raw-input cleanup) inline,
  // then calls autoSave.onBlur(); onKeyDown is uniform.
  const autoSaveGate = isLoggedIn && hasApiResponse;
  const autoSaveOnBlur = () => { if (autoSaveGate) scheduleLongitudinalSave(); };
  const autoSaveOnEnterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (autoSaveGate) flushLongitudinalSave();
  };

  /** Get effective unit system for a field (override or global default). */
  const fieldUnit = (field: string): UnitSystem => unitOverrides[field] ?? unitSystem;

  /** Whether a field has different SI/conventional labels (i.e., a toggle is useful). */
  const hasUnitToggle = (field: string): boolean => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return false;
    const def = UNIT_DEFS[metric];
    return def.label.si !== def.label.conventional;
  };
  const prefillComplete = !!(inputs.sex && inputs.heightCm && inputs.birthYear && inputs.birthYear >= 1900 && inputs.birthMonth);

  // Collapse only on return visits (data pre-loaded at mount). No auto-collapse on first visit.
  const isReturningUser = useRef(prefillComplete);
  const canCollapse = isReturningUser.current && prefillComplete;
  const [collapsed, setCollapsed] = useState(isReturningUser.current);
  const [collapseAnimating, setCollapseAnimating] = useState(false);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return; // Skip animation on mount — returning users start collapsed via useState
    }
    if (!canCollapse) {
      setCollapsed(false);
      setCollapseAnimating(false);
      return;
    }
    if (!prefillExpanded) {
      setCollapseAnimating(true);
      const timer = setTimeout(() => {
        setCollapsed(true);
        setCollapseAnimating(false);
      }, 400);
      return () => clearTimeout(timer);
    } else {
      setCollapsed(false);
      setCollapseAnimating(false);
    }
  }, [prefillExpanded, canCollapse]);

  // Feet/inches state for US height input
  const [heightFeet, setHeightFeet] = useState<string>('');
  const [heightInches, setHeightInches] = useState<string>('');

  // Sync heightCm → feet/inches display when loading data or switching units
  useEffect(() => {
    if (unitSystem === 'conventional' && inputs.heightCm !== undefined) {
      const { feet, inches } = cmToFeetInches(inputs.heightCm);
      setHeightFeet(String(feet));
      setHeightInches(String(inches));
    } else if (unitSystem === 'si') {
      // Clear feet/inches when switching to SI
      setHeightFeet('');
      setHeightInches('');
    }
  }, [inputs.heightCm, unitSystem]);

  // Blood test date picker state (defaults to current month/year)
  const [bloodTestDate, setBloodTestDate] = useState<DateValue>(getCurrentDateValue);

  // PSA date picker state (separate from blood test date, for prostate section)
  const [psaDate, setPsaDate] = useState<DateValue>(getCurrentDateValue);

  const updateField = <K extends keyof HealthInputs>(
    field: K,
    value: HealthInputs[K] | undefined
  ) => {
    onChange({ ...inputs, [field]: value });
  };

  const parseAndConvert = (field: string, value: string): number | undefined => {
    const num = parseLocalisedNumber(value);
    if (num === undefined) return undefined;
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return num;
    return toCanonicalValue(metric, num, fieldUnit(field));
  };

  const toDisplay = (field: string, siValue: number | undefined): string => {
    if (siValue === undefined) return '';
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return String(siValue);
    const fu = fieldUnit(field);
    const display = fromCanonicalValue(metric, siValue, fu);
    const dp = UNIT_DEFS[metric].decimalPlaces[fu];
    const rounded = parseFloat(display.toFixed(dp));
    return String(rounded);
  };

  const fieldLabel = (field: string, name: string): string => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return name;
    return `${name} (${getDisplayLabel(metric, fieldUnit(field))})`;
  };

  const range = (field: string): { min: number; max: number } => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return { min: 0, max: 999 };
    return getDisplayRange(metric, fieldUnit(field));
  };

  /** Validate on blur for identity fields (no unit conversion). Clears if out of range. */
  const validateOnBlur = (field: keyof HealthInputs) => {
    const currentValue = inputs[field] as number | undefined;
    const validated = validateInputValue(field, currentValue);
    if (validated !== currentValue) {
      updateField(field, validated);
    }
  };

  const getPreviousPlaceholder = (field: string): string | null => {
    if (!isLoggedIn) return null;
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return null;
    const measurement = previousMeasurements.find(m => m.metricType === metric);
    if (!measurement) return null;
    return toDisplay(field, measurement.value);
  };

  const getPreviousLabel = (field: string): string | null => {
    if (!isLoggedIn) return null;
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return null;
    const measurement = previousMeasurements.find(m => m.metricType === metric);
    if (!measurement) return null;

    const displayValue = toDisplay(field, measurement.value);
    const unit = getDisplayLabel(metric, fieldUnit(field));
    return `${displayValue} ${unit} · ${formatShortDate(measurement.recordedAt)}`;
  };

  // Blood-test fields are committed via BloodTestTimeline's own Save button,
  /** Check if a field has a previous saved measurement. */
  const hasPreviousValue = (field: string): boolean => {
    const metric = FIELD_METRIC_MAP[field];
    return !!metric && previousMeasurements.some(m => m.metricType === metric);
  };

  /** Whether any basic vital has saved data (for per-metric collapse). */
  const hasBpPreviousData = isLoggedIn && (hasPreviousValue('systolicBp') || hasPreviousValue('diastolicBp'));

  // Auto-collapse vitals after save completes
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !isSavingLongitudinal) {
      if (bpExpanded && inputs.systolicBp === undefined && inputs.diastolicBp === undefined) {
        setBpExpanded(false);
      }
      setExpandedVitals(prev => {
        const next = new Set(prev);
        for (const field of prev) {
          if (inputs[field as keyof typeof inputs] === undefined) next.delete(field);
        }
        return next.size === prev.size ? prev : next;
      });
    }
    wasSaving.current = isSavingLongitudinal;
  }, [isSavingLongitudinal]);

  /** Get effective value: current input or fallback to last saved measurement. */
  const getEffective = (field: keyof HealthInputs, metricType: string): number | undefined =>
    (inputs[field] as number | undefined) ?? previousMeasurements.find(m => m.metricType === metricType)?.value;

  // Shared date constants for screening date pickers
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-12
  const pastYears = Array.from({ length: 11 }, (_, i) => currentYear - i);

  /** Render a month/year date picker for screening dates. Used by both cancer screening and bone density. */
  const renderScreeningDateInput = (scr: ScreeningInputs, key: string, label: string, options?: { futureOnly?: boolean }) => {
    const futureOnly = options?.futureOnly ?? false;
    const savedValue = scrStr(scr, key) || '';
    const [savedYear, savedMonth] = savedValue.split('-');

    const localState = dateInputs[key];
    const displayYear = localState?.year ?? savedYear ?? '';
    const displayMonth = localState?.month ?? savedMonth ?? '';

    const availableYears = futureOnly
      ? Array.from({ length: 6 }, (_, i) => currentYear + i)
      : pastYears;

    const availableMonths = futureOnly
      ? (displayYear === String(currentYear)
        ? ALL_MONTHS.filter(m => parseInt(m.value, 10) >= currentMonth)
        : ALL_MONTHS)
      : (displayYear === String(currentYear)
        ? ALL_MONTHS.filter(m => parseInt(m.value, 10) <= currentMonth)
        : ALL_MONTHS);

    const handleDateChange = (newYear: string, newMonth: string) => {
      let adjustedMonth = newMonth;
      if (futureOnly) {
        if (newYear === String(currentYear) && newMonth && parseInt(newMonth, 10) < currentMonth) {
          adjustedMonth = '';
        }
      } else {
        if (newYear === String(currentYear) && newMonth && parseInt(newMonth, 10) > currentMonth) {
          adjustedMonth = '';
        }
      }

      setDateInputs(prev => ({
        ...prev,
        [key]: { year: newYear, month: adjustedMonth }
      }));

      if (newYear && adjustedMonth) {
        onScreeningChange(key, `${newYear}-${adjustedMonth}`);
      } else if (!newYear && !adjustedMonth) {
        onScreeningChange(key, '');
      }
    };

    return (
      <div className="health-field">
        <label>{label}</label>
        <div className="date-picker-row">
          <select
            id={`${key}-month`}
            value={displayMonth}
            onChange={(e) => handleDateChange(displayYear, e.target.value)}
            aria-label={`${label} month`}
          >
            <option value="">Month</option>
            {availableMonths.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <select
            id={`${key}-year`}
            value={displayYear}
            onChange={(e) => handleDateChange(e.target.value, displayMonth)}
            aria-label={`${label} year`}
          >
            <option value="">Year</option>
            {availableYears.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>
    );
  };

  /** Resolve sex-specific hint for a field config. */
  const resolveHint = (config: FieldConfig) => {
    const { hint, hintMale, hintFemale } = config;
    return (inputs.sex === 'male' && hintMale) ? hintMale
      : (inputs.sex === 'female' && hintFemale) ? hintFemale : hint;
  };

  const renderLongitudinalField = (config: FieldConfig, isBloodTest = false) => {
    const { field, name, step } = config;
    const effectiveHint = resolveHint(config);
    const r = range(field);
    const previousLabel = getPreviousLabel(field);
    const needsAttention = field === 'weightKg' && formStage === 2 && inputs.weightKg === undefined;
    // In expanded mode with previous data, show "Previous:" reference instead of placeholder
    // Blood tests no longer use this render path (they use BloodTestTimeline);
    // the `isBloodTest` arg is retained for the legacy signature but always falsy here.
    const isExpandedWithData = isLoggedIn && hasPreviousValue(field) && expandedVitals.has(field);
    return (
      <div className={`health-field${needsAttention ? ' field-attention' : ''}`} key={field}>
        <label htmlFor={field}>
          {name}{' '}
          {hasUnitToggle(field) ? (
            <button
              type="button"
              className="unit-toggle-pill"
              onClick={(e) => { e.preventDefault(); onToggleFieldUnit(field); }}
              title={`Switch to ${fieldUnit(field) === 'si' ? 'conventional' : 'metric'} units`}
            >
              {getDisplayLabel(FIELD_METRIC_MAP[field]!, fieldUnit(field))}
            </button>
          ) : (
            FIELD_METRIC_MAP[field] ? <span>({getDisplayLabel(FIELD_METRIC_MAP[field]!, fieldUnit(field))})</span> : null
          )}
        </label>
        {isExpandedWithData && previousLabel && (
          <span className="previous-reference">Previous: {previousLabel}</span>
        )}
        <div className="longitudinal-input-row">
          <input
            type="number"
            id={field}
            onWheel={blurOnWheel}
            value={rawInputs[field] !== undefined ? rawInputs[field] : toDisplay(field, inputs[field] as number | undefined)}
            onChange={(e) => {
              const raw = e.target.value;
              setRawInputs(prev => ({ ...prev, [field]: raw }));
              // Ignore browser auto-fill of 0 for empty fields (spinner click on empty input)
              if (raw === '0' && inputs[field] === undefined && rawInputs[field] === undefined) {
                return;
              }
              updateField(field, parseAndConvert(field, raw));
              if (field === 'weightKg' && !hasAutoFocusedEmail.current && onAutoFocusEmail) {
                const weightNum = parseLocalisedNumber(raw);
                if (weightNum !== undefined && /^\d{2,3}$/.test(raw) && weightNum >= r.min && weightNum <= r.max) {
                  advanceToEmail({
                    ambiguous: /^\d{2}$/.test(raw) && weightNum * 10 <= r.max,
                    advance: () => {
                      hasAutoFocusedEmail.current = true;
                      requestAnimationFrame(() => onAutoFocusEmail());
                    },
                  });
                }
              }
            }}
            onBlur={() => {
              setRawInputs(prev => { const next = { ...prev }; delete next[field]; return next; });
              autoSaveOnBlur();
            }}
            onKeyDown={autoSaveOnEnterKey}
            placeholder={isExpandedWithData ? '' : getPreviousPlaceholder(field)}
            step={step ? (fieldUnit(field) === 'si' ? step.si : step.conv) : undefined}
            min={r.min}
            max={r.max}
            className={errors[field] ? 'error' : ''}
          />
          {autoSaveGate && inputs[field] !== undefined && (
            <CommitTickButton ariaLabel={`Save ${field}`} onClick={flushLongitudinalSave}/>
          )}
        </div>
        {errors[field] && (
          <span className="error-message">{errors[field]}</span>
        )}
        {(effectiveHint || (!isExpandedWithData && previousLabel)) && (
          <div className="field-meta">
            {effectiveHint && (
              <span className="field-hint">
                {fieldUnit(field) === 'si' ? effectiveHint.si : effectiveHint.conv}
              </span>
            )}
            {!isExpandedWithData && previousLabel && (
              <a
                className="previous-value"
                href={`${HISTORY_PAGE_PATH}?metric=${FIELD_METRIC_MAP[field]}`}
                onClick={interceptHistory(FIELD_METRIC_MAP[field])}
                target="_blank"
                rel="noopener noreferrer"
              >{previousLabel}</a>
            )}
          </div>
        )}
      </div>
    );
  };

  /** Render a collapsed read-only display for a longitudinal field. */
  const renderCollapsedField = (config: FieldConfig, onExpand: () => void) => {
    const { field, name } = config;
    const metric = FIELD_METRIC_MAP[field]!;
    const measurement = previousMeasurements.find(m => m.metricType === metric);
    const effectiveHint = resolveHint(config);

    // No data — show label + [+] button only
    if (!measurement) {
      return (
        <div className="health-field" key={field}>
          <div className="collapsed-field-row collapsed-field-row--empty">
            <span className="collapsed-field-label collapsed-field-label--empty">{name}</span>
            <button type="button" className="collapsed-field-add" onClick={onExpand} title="Add new value">+</button>
          </div>
          {effectiveHint && (
            <div className="field-meta">
              <span className="field-hint">
                {fieldUnit(field) === 'si' ? effectiveHint.si : effectiveHint.conv}
              </span>
            </div>
          )}
        </div>
      );
    }

    const displayValue = toDisplay(field, measurement.value);
    const unitLabel = getDisplayLabel(metric, fieldUnit(field));
    const date = formatShortDate(measurement.recordedAt);

    return (
      <div className="health-field" key={field}>
        <div className="collapsed-field-row">
          <a
            className="collapsed-field-label"
            href={`${HISTORY_PAGE_PATH}?metric=${metric}`}
            onClick={interceptHistory(metric)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {name}
          </a>
          <span className="collapsed-field-value">
            {displayValue}{' '}
            {hasUnitToggle(field) ? (
              <button
                type="button"
                className="unit-toggle-pill"
                onClick={(e) => { e.preventDefault(); onToggleFieldUnit(field); }}
                title={`Switch to ${fieldUnit(field) === 'si' ? 'conventional' : 'metric'} units`}
              >
                {unitLabel}
              </button>
            ) : (
              <span className="collapsed-field-unit">{unitLabel}</span>
            )}
          </span>
          <span className="collapsed-field-date">{date}</span>
          <button type="button" className="collapsed-field-add" onClick={onExpand} title="Add new value">+</button>
        </div>
        {effectiveHint && (
          <div className="field-meta">
            <span className="field-hint">
              {fieldUnit(field) === 'si' ? effectiveHint.si : effectiveHint.conv}
            </span>
          </div>
        )}
      </div>
    );
  };

  /** Shared BP data for collapsed and label rendering. */
  const getBpPreviousData = (): { sysVal: string | number; diaVal: string | number; latestDate: string } | null => {
    if (!isLoggedIn) return null;
    const sysMetric = FIELD_METRIC_MAP['systolicBp'];
    const diaMetric = FIELD_METRIC_MAP['diastolicBp'];
    const sysMeasurement = sysMetric ? previousMeasurements.find(m => m.metricType === sysMetric) : null;
    const diaMeasurement = diaMetric ? previousMeasurements.find(m => m.metricType === diaMetric) : null;
    if (!sysMeasurement && !diaMeasurement) return null;

    const sysVal = sysMeasurement ? Math.round(sysMeasurement.value) : '?';
    const diaVal = diaMeasurement ? Math.round(diaMeasurement.value) : '?';
    const dates = [sysMeasurement?.recordedAt, diaMeasurement?.recordedAt].filter(Boolean) as string[];
    const latestDate = dates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    return { sysVal, diaVal, latestDate };
  };

  /** BP target text based on age. */
  const getBpTargetText = () =>
    `Target: <${(inputs.birthYear && inputs.birthMonth && calculateAge(inputs.birthYear, inputs.birthMonth) >= 65) ? '130/80' : '120/80'} mmHg`;

  /** Render collapsed BP display. */
  const renderCollapsedBp = (data: { sysVal: string | number; diaVal: string | number; latestDate: string }) => {

    return (
      <div className="health-field">
        <div className="collapsed-field-row">
          <a
            className="collapsed-field-label"
            href={`${HISTORY_PAGE_PATH}?metric=systolic_bp`}
            onClick={interceptHistory('systolic_bp')}
            target="_blank"
            rel="noopener noreferrer"
          >
            Blood Pressure
          </a>
          <span className="collapsed-field-value">{data.sysVal}/{data.diaVal} <span className="collapsed-field-unit">mmHg</span></span>
          <span className="collapsed-field-date">{formatShortDate(data.latestDate)}</span>
          <button type="button" className="collapsed-field-add" onClick={() => { focusFieldRef.current = 'systolicBp'; setBpExpanded(true); }} title="Add new value">+</button>
        </div>
        <div className="field-meta">
          <span className="field-hint">{getBpTargetText()}</span>
        </div>
      </div>
    );
  };

  // ── Section render functions (shared closure state, not separate components) ──

  const renderProfile = () => (
    <>
      <section className="health-section">
        <div className="hr-section-card-header">
          <h3
            className={`health-section-title${canCollapse ? ' health-section-title--collapsible' : ''}`}
            onClick={canCollapse ? () => setPrefillExpanded(!prefillExpanded) : undefined}
          >
            Starting Info
            {canCollapse && (
              <span className={`collapse-chevron${prefillExpanded ? ' expanded' : ''}`}>{'\u25B8'}</span>
            )}
          </h3>
          <div className="basic-info-units">
            <span className="basic-info-units-label">Units</span>
            <button
              type="button"
              className="unit-toggle-pill"
              onClick={() => onUnitSystemChange(unitSystem === 'si' ? 'conventional' : 'si')}
              title={`Switch to ${unitSystem === 'si' ? 'US (in, lbs, mg/dL)' : 'Metric (cm, kg, mmol/L)'}`}
              aria-label={`Switch units. Current: ${unitSystem === 'si' ? 'Metric' : 'US'}`}
            >
              {unitSystem === 'si' ? 'Metric (kg, cm, mmol/L)' : 'US (in, lbs, mg/dL)'}
            </button>
          </div>
        </div>

        <div className={`prefill-summary-wrapper${collapsed && !prefillExpanded ? ' visible' : ''}`}>
          <p className="prefill-summary" onClick={() => setPrefillExpanded(true)}>
            {[
              inputs.sex === 'male' ? 'Male' : inputs.sex === 'female' ? 'Female' : null,
              inputs.heightCm != null && !Number.isNaN(Number(inputs.heightCm))
                ? `${formatHeightDisplay(Number(inputs.heightCm), unitSystem)} tall`
                : null,
              inputs.birthYear && inputs.birthMonth
                ? `Born ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][inputs.birthMonth - 1]} ${inputs.birthYear} (Age ${calculateAge(inputs.birthYear, inputs.birthMonth)})`
                : null,
            ].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className={`prefill-fields-wrapper${collapseAnimating && !prefillExpanded ? ' collapsing' : ''}${collapsed && !prefillExpanded ? ' collapsed' : ''}`}>
          <div className="sex-height-row">
            <div className={`health-field${!inputs.sex ? ' field-attention' : ''}`}>
              <label>Sex
                <span className="bp-info-tooltip-wrap" tabIndex={0}>
                  <span className="bp-info-icon" aria-label="Why we ask for your sex">&#9432;</span>
                  <span className="bp-info-tooltip">
                    Used to calculate ideal body weight, kidney function, and screening programs.
                  </span>
                </span>
              </label>
              <div className="sex-toggle" role="radiogroup" aria-label="Sex">
                <button
                  type="button"
                  role="radio"
                  aria-checked={inputs.sex === 'male'}
                  className={`sex-toggle-btn${inputs.sex === 'male' ? ' sex-toggle-btn--active' : ''}`}
                  onClick={() => { updateField('sex', 'male'); focusById(unitSystem === 'si' ? 'heightCm' : 'heightFeet'); }}
                >
                  Male
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={inputs.sex === 'female'}
                  className={`sex-toggle-btn${inputs.sex === 'female' ? ' sex-toggle-btn--active' : ''}`}
                  onClick={() => { updateField('sex', 'female'); focusById(unitSystem === 'si' ? 'heightCm' : 'heightFeet'); }}
                >
                  Female
                </button>
              </div>
              {errors.sex && <span className="error-message">{errors.sex}</span>}
            </div>

            <div className={`health-field${inputs.sex && !inputs.heightCm ? ' field-attention' : ''}`}>
              <label htmlFor="heightCm">
                Height{' '}
                <button
                  type="button"
                  className="unit-toggle-pill"
                  onClick={(e) => { e.preventDefault(); onUnitSystemChange(unitSystem === 'si' ? 'conventional' : 'si'); }}
                  title={`Switch to ${unitSystem === 'si' ? 'US (in, lbs, mg/dL)' : 'Metric (cm, kg, mmol/L)'}`}
                >
                  {unitSystem === 'si' ? 'cm' : 'ft/in'}
                </button>
              </label>
              {unitSystem === 'si' ? (
                <input
                  type="number"
                  id="heightCm"
                  onWheel={blurOnWheel}
                  value={rawInputs['heightCm'] !== undefined ? rawInputs['heightCm'] : toDisplay('heightCm', inputs.heightCm)}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setRawInputs(prev => ({ ...prev, heightCm: raw }));
                    updateField('heightCm', parseAndConvert('heightCm', raw));
                    const heightNum = parseLocalisedNumber(raw);
                    const heightRange = range('heightCm');
                    // Plausible height → move on to weight.
                    if (heightNum !== undefined && /^\d{2,3}$/.test(raw) && heightNum >= heightRange.min && heightNum <= heightRange.max && inputs.weightKg === undefined) {
                      advanceToWeight({
                        ambiguous: /^\d{2}$/.test(raw) && heightNum * 10 <= heightRange.max,
                        advance: () => focusById('weightKg'),
                      });
                    }
                  }}
                  onBlur={() => setRawInputs(prev => { const next = { ...prev }; delete next['heightCm']; return next; })}
                  placeholder=""
                  min={range('heightCm').min}
                  max={range('heightCm').max}
                  className={errors.heightCm ? 'error' : ''}
                />
              ) : (
                <div className="height-fieldset">
                  <input
                    type="text"
                    id="heightFeet"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={heightFeet}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, '');
                      setHeightFeet(val);
                      const feet = parseInt(val, 10) || 0;
                      const inches = parseInt(heightInches, 10) || 0;
                      if (val !== '' || heightInches !== '') {
                        updateField('heightCm', feetInchesToCm(feet, inches));
                      } else {
                        updateField('heightCm', undefined);
                      }
                      if (val.length === 1) {
                        focusById('heightInches');
                      }
                    }}
                    placeholder=""
                    maxLength={1}
                    className={errors.heightCm ? 'error' : ''}
                  />
                  <span className="height-unit">ft</span>
                  <input
                    type="text"
                    id="heightInches"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={heightInches}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, '');
                      setHeightInches(val);
                      const feet = parseInt(heightFeet, 10) || 0;
                      const inches = parseInt(val, 10) || 0;
                      if (heightFeet !== '' || val !== '') {
                        updateField('heightCm', feetInchesToCm(feet, inches));
                      } else {
                        updateField('heightCm', undefined);
                      }
                      // Height complete → move on to weight (mirrors the cm
                      // path). A lone '1' might still become 10/11 — wait it out.
                      if (heightFeet !== '' && val !== '' && inches <= 11 && inputs.weightKg === undefined) {
                        advanceToWeight({
                          ambiguous: val === '1',
                          advance: () => focusById('weightKg'),
                        });
                      }
                    }}
                    placeholder=""
                    maxLength={2}
                    className={errors.heightCm ? 'error' : ''}
                  />
                  <span className="height-unit">in</span>
                </div>
              )}
              {errors.heightCm && (
                <span className="error-message">{errors.heightCm}</span>
              )}
            </div>
          </div>

          {(!inputs.sex || !inputs.heightCm) && (
            <p className="field-hint-attention field-hint-attention--centered">
              Enter your sex and height — then more fields will appear.
            </p>
          )}
        </div>
      </section>
    </>
  );

  const renderVitalsMatrix = () => (
    <section className="health-section">
      <StartingInfoVitals
        inputs={inputs}
        vitalsHistory={vitalsHistory}
        unitSystem={unitSystem}
        isLoggedIn={isLoggedIn}
        onSave={onSaveBloodTestBatch}
        onFieldChange={updateField}
        formStage={formStage}
        onAutoFocusEmail={onAutoFocusEmail}
        unitOverrides={unitOverrides}
        onToggleFieldUnit={onToggleFieldUnit}
      />
    </section>
  );

  // Legacy inline weight / waist / BP fields — kept for first-time users.
  // The matrix above shows historical context + a draft column, which is
  // overkill (and visually noisy) for someone entering their very first
  // measurement. Returning users with any saved vitals get the matrix.
  const renderVitalsLegacy = () => {
    const bpData = getBpPreviousData();
    const bpLabel = bpData ? `${bpData.sysVal}/${bpData.diaVal} mmHg · ${formatShortDate(bpData.latestDate)}` : null;
    return (
      <section className="health-section">
        {BASIC_LONGITUDINAL_FIELDS.map(cfg => {
          if (isLoggedIn && hasPreviousValue(cfg.field) && !expandedVitals.has(cfg.field)) {
            return renderCollapsedField(cfg, () => {
              focusFieldRef.current = cfg.field;
              setExpandedVitals(prev => new Set(prev).add(cfg.field));
            });
          }
          return renderLongitudinalField(cfg);
        })}

        {hasBpPreviousData && !bpExpanded && bpData ? (
          <div>{renderCollapsedBp(bpData)}</div>
        ) : (
          <div className="health-field">
            <label>Blood Pressure (mmHg)
              <span className="bp-info-tooltip-wrap" tabIndex={0}>
                <span className="bp-info-icon" aria-label="How to measure blood pressure">&#9432;</span>
                <span className="bp-info-tooltip">
                  Use a home blood pressure monitor or ask your doctor at your next visit.{' '}
                  <a href="https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings/monitoring-your-blood-pressure-at-home" target="_blank" rel="noopener noreferrer">Learn more &rarr;</a>
                </span>
              </span>
            </label>
            {bpExpanded && bpLabel && (
              <span className="previous-reference">Previous: {bpLabel}</span>
            )}
            <div className="longitudinal-input-row">
              <div className="bp-fieldset">
                <input
                  type="number"
                  inputMode="numeric"
                  id="systolicBp"
                  onWheel={blurOnWheel}
                  value={inputs.systolicBp ?? ''}
                  onChange={(e) => updateField('systolicBp', parseLocalisedNumber(e.target.value))}
                  onBlur={() => { validateOnBlur('systolicBp'); autoSaveOnBlur(); }}
                  onKeyDown={autoSaveOnEnterKey}
                  placeholder={bpExpanded ? '' : getPreviousPlaceholder('systolicBp')}
                  min={60}
                  max={250}
                  className={errors.systolicBp ? 'error' : ''}
                />
                <span className="bp-separator">/</span>
                <input
                  type="number"
                  inputMode="numeric"
                  id="diastolicBp"
                  onWheel={blurOnWheel}
                  value={inputs.diastolicBp ?? ''}
                  onChange={(e) => updateField('diastolicBp', parseLocalisedNumber(e.target.value))}
                  onBlur={() => { validateOnBlur('diastolicBp'); autoSaveOnBlur(); }}
                  onKeyDown={autoSaveOnEnterKey}
                  placeholder={bpExpanded ? '' : getPreviousPlaceholder('diastolicBp')}
                  min={40}
                  max={150}
                  className={errors.diastolicBp ? 'error' : ''}
                />
                {autoSaveGate && (inputs.systolicBp !== undefined || inputs.diastolicBp !== undefined) && (
                  <CommitTickButton ariaLabel="Save blood pressure" onClick={flushLongitudinalSave}/>
                )}
              </div>
            </div>
            {errors.systolicBp && <span className="error-message">{errors.systolicBp}</span>}
            {errors.diastolicBp && <span className="error-message">{errors.diastolicBp}</span>}
            <div className="field-meta">
              <span className="field-hint">{getBpTargetText()}</span>
              {!bpExpanded && bpLabel && (
                <a className="previous-value"
                   href={`${HISTORY_PAGE_PATH}?metric=systolic_bp`}
            onClick={interceptHistory('systolic_bp')}
                   target="_blank" rel="noopener noreferrer">{bpLabel}</a>
              )}
            </div>
          </div>
        )}
      </section>
    );
  };

  const renderVitals = () =>
    vitalsViewMode === 'matrix' ? renderVitalsMatrix() : renderVitalsLegacy();

  const renderBirthInfo = () => (
    <div className="health-field-group">
      <div className="health-field">
        <label htmlFor="birthMonth">Birth Month
          <span className="bp-info-tooltip-wrap" tabIndex={0}>
            <span className="bp-info-icon" aria-label="Why we ask for your birth date">&#9432;</span>
            <span className="bp-info-tooltip">
              Used to calculate age-based screening suggestions (cancer, bone density) and kidney function.
            </span>
          </span>
        </label>
        <select
          id="birthMonth"
          value={inputs.birthMonth || ''}
          onChange={(e) => updateField('birthMonth', parseLocalisedNumber(e.target.value))}
        >
          <option value="">Month...</option>
          {ALL_MONTHS.map((m, i) => (
            <option key={i + 1} value={i + 1}>{m.label}</option>
          ))}
        </select>
      </div>

      {inputs.birthMonth && (
        <div className="health-field stage-reveal">
          <label htmlFor="birthYear">Birth Year</label>
          <input
            type="number"
            id="birthYear"
            onWheel={blurOnWheel}
            value={inputs.birthYear || ''}
            onChange={(e) => {
              const num = parseLocalisedNumber(e.target.value);
              if (num !== undefined && isBirthYearClearlyInvalid(num)) return;
              updateField('birthYear', num);
            }}
            onBlur={() => validateOnBlur('birthYear')}
            placeholder=""
            min="1900"
            max={new Date().getFullYear()}
          />
        </div>
      )}
    </div>
  );

  const renderBloodTests = () => (
    <BloodTestTimeline
      bloodTestHistory={bloodTestHistory}
      unitSystem={unitSystem}
      unitOverrides={unitOverrides}
      onToggleFieldUnit={onToggleFieldUnit}
      isLoggedIn={isLoggedIn}
      onSaveBatch={onSaveBloodTestBatch}
      onCorrectValue={onCorrectBloodTestValue}
      onFieldChange={updateField}
      isSaving={isSavingLongitudinal}
      sex={inputs.sex}
      onUploadClick={isLoggedIn ? () => setShowUploadModal?.(true) : undefined}
      uploadDisabled={!isLoggedIn}
      loginUrl={loginUrl}
      hasApiResponse={hasApiResponse}
      flushRef={bloodTestFlushRef}
    />
  );

  const renderMedications = () => (
    <>
      {/* Cholesterol Medications Section — cascade when elevated/suggested, flat when any lipid entered */}
      {(() => {
          // Compute effective inputs for cascade visibility (form values + previous measurements fallback)
          const effectiveApoB = getEffective('apoB', 'apob');
          const effectiveLdl = getEffective('ldlC', 'ldl');
          const effectiveTotalChol = getEffective('totalCholesterol', 'total_cholesterol');
          const effectiveHdl = getEffective('hdlC', 'hdl');
          const effectiveNonHdl = (effectiveTotalChol !== undefined && effectiveHdl !== undefined)
            ? effectiveTotalChol - effectiveHdl : undefined;

          const lipidMarker = resolveBestLipidMarker(effectiveApoB, effectiveNonHdl, effectiveLdl);

          // Check if any suggestion recommends a cholesterol medication
          const hasCholesterolSuggestion = activeSuggestionIds &&
            ['med-statin', 'med-ezetimibe', 'med-bempedoic-acid', 'med-statin-increase', 'med-statin-switch', 'med-pcsk9i']
              .some(id => activeSuggestionIds.has(id));

          // Three modes:
          // 1. Cascade: lipids elevated OR suggestion recommends medication
          // 2. Flat: any lipid value entered (allows recording meds when values are controlled)
          // 3. Hidden: no lipid values entered
          const cascadeMode = lipidMarker?.elevated || hasCholesterolSuggestion;
          const hasAnyLipidInput = effectiveApoB !== undefined || effectiveLdl !== undefined
            || effectiveTotalChol !== undefined || effectiveHdl !== undefined;

          if (!cascadeMode && !hasAnyLipidInput) return null;

          const medInputs = medicationsToInputs(medications);
          const statin = medInputs.statin;
          const statinDrug = statin?.drug ?? 'none';
          const statinDose = statin?.dose ?? null;
          const statinTolerated = statinDrug !== 'not_tolerated';
          const onStatin = statin && statinDrug !== 'none' && statinDrug !== 'not_tolerated';

          // Get available doses for current statin
          const availableDoses = STATIN_DRUGS[statinDrug]?.doses ?? [];

          // ── Shared medication dropdowns ──

          const statinDropdown = (
            <div className="health-field">
              <label htmlFor="statin-name">Statin</label>
              {cascadeMode && <p className="med-step-hint">Statins are the most effective first step. They reduce cholesterol production in the liver.</p>}
              <div className="statin-selection-row">
                <select
                  id="statin-name"
                  value={statinDrug}
                  onChange={(e) => {
                    const newDrug = e.target.value;
                    if (cascadeMode) {
                      // Reset downstream cascade steps
                      if (medInputs.ezetimibe) onMedicationChange('ezetimibe', 'not_yet', null, null);
                      if (medInputs.statinEscalation) onMedicationChange('statin_escalation', 'not_yet', null, null);
                      if (medInputs.pcsk9i) onMedicationChange('pcsk9i', 'not_yet', null, null);
                    }
                    if (newDrug === 'none' || newDrug === 'not_tolerated') {
                      onMedicationChange('statin', newDrug, null, null);
                    } else {
                      const firstDose = STATIN_DRUGS[newDrug]?.doses[0] ?? null;
                      onMedicationChange('statin', newDrug, firstDose, 'mg');
                    }
                  }}
                >
                  {STATIN_NAMES.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {availableDoses.length > 0 && (
                  <select
                    id="statin-dose"
                    value={statinDose ?? ''}
                    onChange={(e) => {
                      const newDose = parseInt(e.target.value, 10);
                      if (cascadeMode) {
                        if (medInputs.ezetimibe) onMedicationChange('ezetimibe', 'not_yet', null, null);
                        if (medInputs.statinEscalation) onMedicationChange('statin_escalation', 'not_yet', null, null);
                        if (medInputs.pcsk9i) onMedicationChange('pcsk9i', 'not_yet', null, null);
                      }
                      onMedicationChange('statin', statinDrug, newDose, 'mg');
                    }}
                  >
                    {availableDoses.map(dose => (
                      <option key={dose} value={dose}>{dose}mg</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          );

          const ezetimibeDropdown = (
            <div className="health-field">
              <label htmlFor="ezetimibe">On Ezetimibe 10mg?</label>
              <select
                id="ezetimibe"
                value={medInputs.ezetimibe || 'not_yet'}
                onChange={e => {
                  const val = e.target.value;
                  if (val === 'yes') {
                    onMedicationChange('ezetimibe', 'ezetimibe', 10, 'mg');
                  } else {
                    onMedicationChange('ezetimibe', val, null, null);
                  }
                }}
              >
                {EZETIMIBE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          );

          const pcsk9iDropdown = (
            <div className="health-field">
              <label htmlFor="pcsk9i">On a PCSK9 inhibitor?</label>
              <select
                id="pcsk9i"
                value={medInputs.pcsk9i || 'not_yet'}
                onChange={e => {
                  const val = e.target.value;
                  if (val === 'yes') {
                    onMedicationChange('pcsk9i', 'pcsk9i', 140, 'mg');
                  } else {
                    onMedicationChange('pcsk9i', val, null, null);
                  }
                }}
              >
                {PCSK9I_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          );

          const bempedoicAcidDropdown = (
            <div className="health-field">
              <label htmlFor="bempedoic-acid">Bempedoic acid</label>
              <select
                id="bempedoic-acid"
                value={medInputs.bempedoicAcid || 'not_yet'}
                onChange={e => {
                  const val = e.target.value;
                  if (val === 'bempedoic_acid') {
                    onMedicationChange('bempedoic_acid', val, 180, 'mg');
                  } else if (val === 'bempedoic_acid_ezetimibe') {
                    onMedicationChange('bempedoic_acid', val, 180, 'mg');
                  } else {
                    onMedicationChange('bempedoic_acid', val, null, null);
                  }
                }}
              >
                {BEMPEDOIC_ACID_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          );

          // ── Flat mode: all fields visible independently (no cascade gating) ──
          if (!cascadeMode) {
            return (
              <div className="section-card">
                <section className="health-section">
                  <h3 className="health-section-title">Cholesterol Medications</h3>
                  <p className="health-section-desc">
                    Are you currently taking any cholesterol medications? Recording these helps track your health over time.
                  </p>
                  {statinDropdown}
                  {ezetimibeDropdown}
                  {bempedoicAcidDropdown}
                  {pcsk9iDropdown}
                </section>
              </div>
            );
          }

          // ── Cascade mode: progressive disclosure (existing logic) ──
          const showEzetimibe = onStatin || statinDrug === 'not_tolerated';
          const ezetimibeHandled = medInputs.ezetimibe === 'yes' || medInputs.ezetimibe === 'not_tolerated';

          const canIncrease = onStatin && canIncreaseDose(statinDrug, statinDose);
          const shouldSwitch = onStatin && shouldSuggestSwitch(statinDrug, statinDose);
          const atMaxPotency = onStatin && isOnMaxPotency(statinDrug, statinDose);

          const showStatinEscalation = showEzetimibe && ezetimibeHandled && statinTolerated && (canIncrease || shouldSwitch);
          const escalationHandled = medInputs.statinEscalation === 'not_tolerated';
          const showPcsk9i = (showEzetimibe && ezetimibeHandled) &&
            ((!statinTolerated || atMaxPotency) || (showStatinEscalation && escalationHandled));

          const lipidName = lipidMarker?.label ?? 'LDL-c';

          // Intro text for cascade mode
          let introText = '';
          if (lipidMarker?.elevated) {
            const metricKey = lipidMarker.kind === 'apoB' ? 'apoB' : 'ldlC';
            const unitKey = lipidMarker.kind === 'apoB' ? 'apob' : 'ldl';
            const val = toDisplay(metricKey, lipidMarker.value);
            const target = toDisplay(metricKey, lipidMarker.target);
            const unit = getDisplayLabel(unitKey, fieldUnit(metricKey));
            introText = `Your ${lipidMarker.label} is ${val} ${unit}, which is above the treatment target of ${target} ${unit}. `;
          }

          return (
            <div className="section-card">
            <section className="health-section medication-cascade">
              <h3 className="health-section-title">Cholesterol Medications</h3>
              <p className="health-section-desc">
                {introText}{LIPID_DIET_ADVICE} Medications can also be added in steps.
              </p>

              {statinDropdown}

              {showEzetimibe && (
                <div className="med-step-enter">
                  <p className="med-step-hint">{`Ezetimibe works differently — it blocks cholesterol absorption in the intestine, adding ~20% more ${lipidName} reduction.`}</p>
                  {ezetimibeDropdown}
                </div>
              )}

              {showEzetimibe && ezetimibeHandled && (
                <div className="med-step-enter">
                  <p className="med-step-hint">Bempedoic acid lowers cholesterol production via a different pathway than statins, and can be used alongside them.</p>
                  {bempedoicAcidDropdown}
                </div>
              )}

              {showStatinEscalation && (
                <div className="health-field med-step-enter">
                  <label htmlFor="statin-escalation">
                    {canIncrease ? 'Tried increasing statin dose?' : 'Tried switching to a more potent statin?'}
                  </label>
                  <p className="med-step-hint">
                    {canIncrease ? `A higher dose may lower your ${lipidName} further.` : `A more potent statin can provide greater ${lipidName} reduction at the same or lower dose.`}
                  </p>
                  <select
                    id="statin-escalation"
                    value={medInputs.statinEscalation || 'not_yet'}
                    onChange={e => onMedicationChange('statin_escalation', e.target.value, null, null)}
                  >
                    <option value="not_yet">Not yet</option>
                    <option value="not_tolerated">
                      {canIncrease ? "Didn't tolerate a higher dose" : "Didn't tolerate switching"}
                    </option>
                  </select>
                </div>
              )}

              {showPcsk9i && (
                <div className="med-step-enter">
                  <p className="med-step-hint">{`PCSK9 inhibitors are injectable medications that help your body clear ${lipidName} from the blood. They can reduce ${lipidName} by ~50%.`}</p>
                  {pcsk9iDropdown}
                </div>
              )}
            </section>
            </div>
          );
        })()}

      {/* Weight & Diabetes Medications Section — shown when BMI > 28 (unconditional) or BMI 25-28 with secondary criteria */}
      {(() => {
        // Compute effective values from form inputs + previous measurements fallback
        const effectiveWeight = getEffective('weightKg', 'weight');
        const effectiveHeight = getEffective('heightCm', 'height');
        const effectiveWaist = getEffective('waistCm', 'waist');
        const effectiveHba1c = getEffective('hba1c', 'hba1c');
        const effectiveTrigs = getEffective('triglycerides', 'triglycerides');
        const effectiveSbp = getEffective('systolicBp', 'systolic_bp');

        // Compute BMI and waist-to-height ratio
        const effectiveBmi = (effectiveWeight !== undefined && effectiveHeight !== undefined)
          ? calculateBMI(effectiveWeight, effectiveHeight) : undefined;
        const effectiveWhr = (effectiveWaist !== undefined && effectiveHeight !== undefined)
          ? effectiveWaist / effectiveHeight : undefined;

        // Elevated flags (computed once, used for both cascade check and reasons)
        const hba1cElevated = effectiveHba1c !== undefined && effectiveHba1c >= HBA1C_THRESHOLDS.prediabetes;
        const trigsElevated = effectiveTrigs !== undefined && effectiveTrigs >= TRIGLYCERIDES_THRESHOLDS.borderline;
        const bpElevated = effectiveSbp !== undefined && effectiveSbp >= BP_THRESHOLDS.stage1Sys;
        const waistElevated = effectiveWhr !== undefined && effectiveWhr >= 0.5;

        // Check if any suggestion recommends a weight/diabetes medication
        const hasWeightSuggestion = activeSuggestionIds &&
          ['weight-med-glp1', 'weight-med-glp1-increase', 'weight-med-glp1-switch', 'weight-med-sglt2i', 'weight-med-metformin']
            .some(id => activeSuggestionIds.has(id));

        // Three modes: cascade, flat, hidden
        let weightCascadeMode = !!hasWeightSuggestion;
        if (!weightCascadeMode && effectiveBmi !== undefined && effectiveBmi > 25) {
          weightCascadeMode = effectiveBmi > 28 || hba1cElevated || trigsElevated || bpElevated || waistElevated;
        }

        // Flat mode: any relevant input entered but no cascade trigger
        const hasAnyWeightInput = effectiveHba1c !== undefined || effectiveTrigs !== undefined
          || (effectiveWeight !== undefined && effectiveHeight !== undefined);

        if (!weightCascadeMode && !hasAnyWeightInput) return null;

        const medInputs = medicationsToInputs(medications);

        // GLP-1 state
        const glp1 = medInputs.glp1;
        const glp1Drug = glp1?.drug ?? 'none';
        const glp1Dose = glp1?.dose ?? null;
        const onGlp1 = glp1 && glp1Drug !== 'none' && glp1Drug !== 'not_tolerated' && glp1Drug !== 'other';
        const glp1OnOther = glp1Drug === 'other';
        const glp1Handled = onGlp1 || glp1OnOther || glp1Drug === 'not_tolerated';
        const availableGlp1Doses = GLP1_DRUGS[glp1Drug]?.doses ?? [];

        // GLP-1 escalation state
        const glp1Tolerated = glp1Drug !== 'not_tolerated';
        const canIncreaseGlp1 = onGlp1 && canIncreaseGlp1Dose(glp1Drug, glp1Dose);
        const shouldSwitchGlp1 = (onGlp1 && shouldSuggestGlp1Switch(glp1Drug, glp1Dose)) || glp1OnOther;
        const atMaxGlp1 = onGlp1 && isOnMaxGlp1Potency(glp1Drug, glp1Dose);
        const showGlp1Escalation = glp1Handled && glp1Tolerated && (canIncreaseGlp1 || shouldSwitchGlp1);
        const glp1EscalationHandled = medInputs.glp1Escalation === 'not_tolerated';

        // SGLT2i state
        const showSglt2i = glp1Handled && (
          !glp1Tolerated || atMaxGlp1 || (showGlp1Escalation && glp1EscalationHandled)
        );
        const sglt2i = medInputs.sglt2i;
        const sglt2iDrug = sglt2i?.drug ?? 'none';
        const sglt2iDose = sglt2i?.dose ?? null;
        const onSglt2i = sglt2i && sglt2iDrug !== 'none' && sglt2iDrug !== 'not_tolerated';
        const sglt2iHandled = onSglt2i || sglt2iDrug === 'not_tolerated';
        const availableSglt2iDoses = SGLT2I_DRUGS[sglt2iDrug]?.doses ?? [];

        // Metformin state
        const showMetformin = showSglt2i && sglt2iHandled;

        // Downstream reset helper
        const resetWeightDownstream = (from: 'glp1' | 'glp1_escalation' | 'sglt2i') => {
          if (from === 'glp1') {
            if (medInputs.glp1Escalation) onMedicationChange('glp1_escalation', 'not_yet', null, null);
            if (medInputs.sglt2i) onMedicationChange('sglt2i', 'none', null, null);
            if (medInputs.metformin) onMedicationChange('metformin', 'none', null, null);
          } else if (from === 'glp1_escalation') {
            if (medInputs.sglt2i) onMedicationChange('sglt2i', 'none', null, null);
            if (medInputs.metformin) onMedicationChange('metformin', 'none', null, null);
          } else if (from === 'sglt2i') {
            if (medInputs.metformin) onMedicationChange('metformin', 'none', null, null);
          }
        };

        // ── Shared medication dropdowns ──

        const glp1Dropdown = (
          <div className="health-field">
            <label htmlFor="glp1-name">GLP-1 Medication</label>
            {weightCascadeMode && <p className="med-step-hint">GLP-1 medications reduce appetite and improve blood sugar control, often leading to significant weight loss.</p>}
            <div className="statin-selection-row">
              <select
                id="glp1-name"
                value={glp1Drug}
                onChange={(e) => {
                  const newDrug = e.target.value;
                  if (weightCascadeMode) resetWeightDownstream('glp1');
                  if (newDrug === 'none' || newDrug === 'not_tolerated' || newDrug === 'other') {
                    onMedicationChange('glp1', newDrug, null, null);
                  } else {
                    const firstDose = GLP1_DRUGS[newDrug]?.doses[0] ?? null;
                    onMedicationChange('glp1', newDrug, firstDose, 'mg');
                  }
                }}
              >
                {GLP1_NAMES.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {availableGlp1Doses.length > 0 && (
                <select
                  id="glp1-dose"
                  value={glp1Dose ?? ''}
                  onChange={(e) => {
                    const newDose = parseLocalisedNumber(e.target.value) ?? null;
                    if (weightCascadeMode) resetWeightDownstream('glp1');
                    onMedicationChange('glp1', glp1Drug, newDose, 'mg');
                  }}
                >
                  {availableGlp1Doses.map(dose => (
                    <option key={dose} value={dose}>{dose}mg</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        );

        const sglt2iDropdown = (
          <div className="health-field">
            <label htmlFor="sglt2i-name">SGLT2 Inhibitor</label>
            {weightCascadeMode && <p className="med-step-hint">SGLT2 inhibitors help your kidneys remove excess glucose and offer additional heart and kidney protection.</p>}
            <div className="statin-selection-row">
              <select
                id="sglt2i-name"
                value={sglt2iDrug}
                onChange={(e) => {
                  const newDrug = e.target.value;
                  if (weightCascadeMode) resetWeightDownstream('sglt2i');
                  if (newDrug === 'none' || newDrug === 'not_tolerated') {
                    onMedicationChange('sglt2i', newDrug, null, null);
                  } else {
                    const firstDose = SGLT2I_DRUGS[newDrug]?.doses[0] ?? null;
                    onMedicationChange('sglt2i', newDrug, firstDose, 'mg');
                  }
                }}
              >
                {SGLT2I_NAMES.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              {availableSglt2iDoses.length > 0 && (
                <select
                  id="sglt2i-dose"
                  value={sglt2iDose ?? ''}
                  onChange={(e) => {
                    const newDose = parseLocalisedNumber(e.target.value) ?? null;
                    if (weightCascadeMode) resetWeightDownstream('sglt2i');
                    onMedicationChange('sglt2i', sglt2iDrug, newDose, 'mg');
                  }}
                >
                  {availableSglt2iDoses.map(dose => (
                    <option key={dose} value={dose}>{dose}mg</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        );

        const metforminDropdown = (
          <div className="health-field">
            <label htmlFor="metformin">Metformin</label>
            {weightCascadeMode && <p className="med-step-hint">Metformin improves insulin sensitivity. It is well-studied and inexpensive.</p>}
            <select
              id="metformin"
              value={medInputs.metformin || 'none'}
              onChange={(e) => onMedicationChange('metformin', e.target.value, null, null)}
            >
              {METFORMIN_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        );

        // ── Flat mode: all fields visible independently ──
        if (!weightCascadeMode) {
          return (
            <div className="section-card">
              <section className="health-section">
                <h3 className="health-section-title">Weight & Diabetes Medications</h3>
                <p className="health-section-desc">
                  Are you currently taking any weight or diabetes medications? Recording these helps track your health over time.
                </p>
                {glp1Dropdown}
                {sglt2iDropdown}
                {metforminDropdown}
              </section>
            </div>
          );
        }

        // ── Cascade mode: progressive disclosure ──
        const reasons: string[] = [];
        if (hba1cElevated) reasons.push('prediabetic HbA1c');
        if (trigsElevated) reasons.push('elevated triglycerides');
        if (bpElevated) reasons.push('elevated blood pressure');
        if (waistElevated) reasons.push('elevated waist-to-height ratio');

        return (
          <div className="section-card">
          <section className="health-section medication-cascade">
            <h3 className="health-section-title">Weight & Diabetes Medications</h3>
            <p className="health-section-desc">
              {reasons.length > 0
                ? `Your BMI and ${reasons.join(', ')} suggest you may benefit from medications that support weight management and metabolic health.`
                : 'Your BMI suggests you may benefit from medications that support weight management and metabolic health.'}
            </p>

            {glp1Dropdown}

            {showGlp1Escalation && (
              <div className="health-field med-step-enter">
                <label htmlFor="glp1-escalation">
                  {canIncreaseGlp1 ? 'Tried increasing GLP-1 dose?' : 'Tried switching to Tirzepatide?'}
                </label>
                <p className="med-step-hint">
                  {canIncreaseGlp1 ? 'A higher dose may improve results.' : 'Tirzepatide targets two hormones (GIP + GLP-1) and may be more effective for weight loss.'}
                </p>
                <select
                  id="glp1-escalation"
                  value={medInputs.glp1Escalation || 'not_yet'}
                  onChange={e => {
                    resetWeightDownstream('glp1_escalation');
                    onMedicationChange('glp1_escalation', e.target.value, null, null);
                  }}
                >
                  <option value="not_yet">Not yet</option>
                  <option value="not_tolerated">
                    {canIncreaseGlp1 ? "Didn't tolerate a higher dose" : "Didn't tolerate switching"}
                  </option>
                </select>
              </div>
            )}

            {showSglt2i && (
              <div className="med-step-enter">
                {sglt2iDropdown}
              </div>
            )}

            {showMetformin && (
              <div className="med-step-enter">
                {metforminDropdown}
              </div>
            )}
          </section>
          </div>
        );
      })()}
    </>
  );

  const renderScreening = () => (
    <>
      {/* Cancer Screening Section — shown when birth year is available */}
      {(() => {
        // Default to January if birthMonth not set (gives conservative age estimate)
        const age = inputs.birthYear
          ? calculateAge(inputs.birthYear, inputs.birthMonth ?? 1)
          : undefined;
        if (age === undefined) return null;

        const sex = inputs.sex;
        const scr = screeningsToInputs(screenings);

        /** Clear result and follow-up fields for a screening type. */
        const clearResultChain = (type: string) => {
          if (scrStr(scr, `${type}_result`)) onScreeningChange(`${type}_result`, '');
          if (scrStr(scr, `${type}_followup_status`)) onScreeningChange(`${type}_followup_status`, '');
          if (scrStr(scr, `${type}_followup_date`)) onScreeningChange(`${type}_followup_date`, '');
        };

        /** Render result dropdown + follow-up status + follow-up date for a screening type. */
        const renderResultFollowup = (type: string, method: string | undefined) => {
          if (!scrStr(scr,`${type}_last_date`)) return null;

          const result = scrStr(scr,`${type}_result`);
          const followupStatus = scrStr(scr,`${type}_followup_status`);
          const methodKey = method ? `${type}_${method}` : `${type}_other`;
          const info = SCREENING_FOLLOWUP_INFO[methodKey];
          const followupLabel = info?.followupName
            ? info.followupName.charAt(0).toUpperCase() + info.followupName.slice(1)
            : 'Follow-up';

          return (
            <>
              <div className="health-field">
                <label htmlFor={`${type}-result`}>Result</label>
                <select
                  id={`${type}-result`}
                  value={result || ''}
                  onChange={(e) => {
                    onScreeningChange(`${type}_result`, e.target.value);
                    if (e.target.value !== 'abnormal') {
                      if (scrStr(scr,`${type}_followup_status`)) onScreeningChange(`${type}_followup_status`, '');
                      if (scrStr(scr,`${type}_followup_date`)) onScreeningChange(`${type}_followup_date`, '');
                    }
                  }}
                >
                  <option value="">Select...</option>
                  <option value="normal">Normal</option>
                  <option value="abnormal">Abnormal</option>
                  <option value="awaiting">Awaiting results</option>
                </select>
              </div>

              {result === 'abnormal' && (
                <div className="health-field">
                  <label htmlFor={`${type}-followup-status`}>{followupLabel} status</label>
                  <select
                    id={`${type}-followup-status`}
                    value={followupStatus || ''}
                    onChange={(e) => {
                      onScreeningChange(`${type}_followup_status`, e.target.value);
                      if (e.target.value === 'not_organized' || e.target.value === '') {
                        if (scrStr(scr,`${type}_followup_date`)) onScreeningChange(`${type}_followup_date`, '');
                      }
                    }}
                  >
                    <option value="">Select...</option>
                    <option value="not_organized">Not yet organized</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="completed">Completed</option>
                  </select>
                </div>
              )}

              {result === 'abnormal' && (followupStatus === 'scheduled' || followupStatus === 'completed') && (
                renderScreeningDateInput(scr,
                  `${type}_followup_date`,
                  followupStatus === 'completed'
                    ? `When was the ${info?.followupName ?? 'follow-up'} completed?`
                    : `When is the ${info?.followupName ?? 'follow-up'} scheduled?`,
                  { futureOnly: followupStatus === 'scheduled' }
                )
              )}
            </>
          );
        };

        const hasAnyEligible =
          age >= 35 || // colorectal
          (sex === 'female' && age >= 25) || // cervical
          (sex === 'female' && age >= 40) || // breast
          (age >= 50 && age <= 80) || // lung
          (sex === 'male' && age >= 45) || // prostate
          (sex === 'female' && age >= 45); // endometrial

        if (!hasAnyEligible) return null;

        return (
          <div className="section-card">
          <section className="health-section screening-cascade">
            <h3 className="health-section-title">Cancer Screening</h3>
            <p className="health-section-desc">
              Screening recommendations based on your age and sex. Discuss all screening decisions with your doctor.
            </p>

            {/* Colorectal (age 35-85, all genders) */}
            {age >= 35 && age <= 85 && (
              <div className="screening-group">
                <h4>Colorectal</h4>
                {age < 45 && (
                  <div className="screening-notice">
                    Note: ACS guidelines recommend starting colorectal screening at age 45. Dr Brad personally starts at age 35 due to increasing rates of colorectal cancer in younger adults. Discuss timing with your doctor.
                  </div>
                )}

                {age <= 75 ? (
                  <>
                    <div className="health-field">
                      <label htmlFor="colorectal-method">Screening method</label>
                      <select
                        id="colorectal-method"
                        value={scrStr(scr, 'colorectal_method') || ''}
                        onChange={(e) => {
                          onScreeningChange('colorectal_method', e.target.value);
                          if (e.target.value === 'not_yet_started' || e.target.value === '') {
                            if (scrStr(scr, 'colorectal_last_date')) onScreeningChange('colorectal_last_date', '');
                            clearResultChain('colorectal');
                          }
                        }}
                      >
                        <option value="">Select...</option>
                        <option value="fit_annual">FIT test (annual)</option>
                        <option value="colonoscopy_10yr">Colonoscopy (every 10 years)</option>
                        <option value="other">Other method</option>
                        <option value="not_yet_started">Not yet started</option>
                      </select>
                    </div>

                    {scrStr(scr, 'colorectal_method') && scrStr(scr, 'colorectal_method') !== 'not_yet_started' && (
                      <>
                        {renderScreeningDateInput(scr,'colorectal_last_date', 'Date of last screening')}
                        {renderResultFollowup('colorectal', scrStr(scr, 'colorectal_method'))}
                      </>
                    )}
                  </>
                ) : (
                  <p className="screening-age-message">
                    Screening is individualized at your age. Discuss with your doctor whether continued screening is appropriate.
                  </p>
                )}
              </div>
            )}

            {/* Breast (female, age 40+) */}
            {sex === 'female' && age >= 40 && (
              <div className="screening-group">
                <h4>Breast</h4>
                <p className="screening-age-message">
                  {age <= 44
                    ? 'Annual mammograms are optional at your age (40\u201344).'
                    : age <= 54
                    ? 'Annual mammograms are recommended at your age (45\u201354).'
                    : 'Annual or biennial mammograms are recommended at your age (55+).'}
                </p>

                <div className="health-field">
                  <label htmlFor="breast-frequency">Screening frequency</label>
                  <select
                    id="breast-frequency"
                    value={scrStr(scr, 'breast_frequency') || ''}
                    onChange={(e) => {
                      onScreeningChange('breast_frequency', e.target.value);
                      if (e.target.value === 'not_yet_started' || e.target.value === '') {
                        if (scrStr(scr, 'breast_last_date')) onScreeningChange('breast_last_date', '');
                        clearResultChain('breast');
                      }
                    }}
                  >
                    <option value="">Select...</option>
                    <option value="annual">Annual</option>
                    <option value="biennial">Every 2 years</option>
                    <option value="not_yet_started">Not yet started</option>
                  </select>
                </div>

                {scrStr(scr, 'breast_frequency') && scrStr(scr, 'breast_frequency') !== 'not_yet_started' && (
                  <>
                    {renderScreeningDateInput(scr,'breast_last_date', 'Date of last mammogram')}
                    {renderResultFollowup('breast', scrStr(scr, 'breast_frequency'))}
                  </>
                )}
              </div>
            )}

            {/* Cervical (female, age 25+) */}
            {sex === 'female' && age >= 25 && (
              <div className="screening-group">
                <h4>Cervical</h4>
                {age <= 65 ? (
                  <>
                    <div className="health-field">
                      <label htmlFor="cervical-method">Screening method</label>
                      <select
                        id="cervical-method"
                        value={scrStr(scr, 'cervical_method') || ''}
                        onChange={(e) => {
                          onScreeningChange('cervical_method', e.target.value);
                          if (e.target.value === 'not_yet_started' || e.target.value === '') {
                            if (scrStr(scr, 'cervical_last_date')) onScreeningChange('cervical_last_date', '');
                            clearResultChain('cervical');
                          }
                        }}
                      >
                        <option value="">Select...</option>
                        <option value="hpv_every_5yr">HPV test every 5 years (preferred)</option>
                        <option value="pap_every_3yr">Pap test every 3 years</option>
                        <option value="other">Other method</option>
                        <option value="not_yet_started">Not yet started</option>
                      </select>
                    </div>

                    {scrStr(scr, 'cervical_method') && scrStr(scr, 'cervical_method') !== 'not_yet_started' && (
                      <>
                        {renderScreeningDateInput(scr,'cervical_last_date', 'Date of last screening')}
                        {renderResultFollowup('cervical', scrStr(scr, 'cervical_method'))}
                      </>
                    )}
                  </>
                ) : (
                  <p className="screening-age-message">
                    Routine cervical screening typically stops at age 65 if you have no history of abnormal results. Discuss with your doctor.
                  </p>
                )}
              </div>
            )}

            {/* Lung (age 50-80, all genders) */}
            {age >= 50 && age <= 80 && (
              <div className="screening-group">
                <h4>Lung</h4>

                <div className="health-field">
                  <label htmlFor="lung-smoking-history">Smoking history</label>
                  <select
                    id="lung-smoking-history"
                    value={scrStr(scr, 'lung_smoking_history') || ''}
                    onChange={(e) => {
                      onScreeningChange('lung_smoking_history', e.target.value);
                      if (e.target.value === 'never_smoked' || e.target.value === '') {
                        if (scrStr(scr, 'lung_pack_years') !== undefined) onScreeningChange('lung_pack_years', '');
                        if (scrStr(scr, 'lung_screening')) onScreeningChange('lung_screening', '');
                        if (scrStr(scr, 'lung_last_date')) onScreeningChange('lung_last_date', '');
                        clearResultChain('lung');
                      }
                    }}
                  >
                    <option value="">Select...</option>
                    <option value="never_smoked">Never smoked</option>
                    <option value="former_smoker">Former smoker</option>
                    <option value="current_smoker">Current smoker</option>
                  </select>
                </div>

                {(scrStr(scr, 'lung_smoking_history') === 'former_smoker' || scrStr(scr, 'lung_smoking_history') === 'current_smoker') && (
                  <>
                    <div className="health-field">
                      <label htmlFor="lung-pack-years">Pack-years (packs/day &times; years smoked)</label>
                      <input
                        type="number"
                        id="lung-pack-years"
                        onWheel={blurOnWheel}
                        value={scrNum(scr, 'lung_pack_years') ?? ''}
                        onChange={(e) => onScreeningChange('lung_pack_years', e.target.value)}
                        placeholder=""
                        min="0"
                        max="200"
                        step="1"
                      />
                      <span className="field-hint">Screening recommended if &ge;20 pack-years</span>
                    </div>

                    {scrNum(scr, 'lung_pack_years') !== undefined && scrNum(scr, 'lung_pack_years')! >= 20 && (
                      <>
                        <div className="health-field">
                          <label htmlFor="lung-screening">Screening status</label>
                          <select
                            id="lung-screening"
                            value={scrStr(scr, 'lung_screening') || ''}
                            onChange={(e) => {
                              onScreeningChange('lung_screening', e.target.value);
                              if (e.target.value === 'not_yet_started' || e.target.value === '') {
                                if (scrStr(scr, 'lung_last_date')) onScreeningChange('lung_last_date', '');
                                clearResultChain('lung');
                              }
                            }}
                          >
                            <option value="">Select...</option>
                            <option value="annual_ldct">Annual low-dose CT</option>
                            <option value="not_yet_started">Not yet started</option>
                          </select>
                        </div>

                        {scrStr(scr, 'lung_screening') === 'annual_ldct' && (
                          <>
                            {renderScreeningDateInput(scr,'lung_last_date', 'Date of last low-dose CT')}
                            {renderResultFollowup('lung', scrStr(scr, 'lung_screening'))}
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Prostate (male, age 45+) — shared decision */}
            {sex === 'male' && age >= 45 && (
              <div className="screening-group">
                <h4>Prostate</h4>
                <p className="screening-age-message">
                  {age < 50
                    ? 'Screening typically starts at 50, but consider at 45 if you are at higher risk (African American or family history).'
                    : 'PSA testing is an option after an informed discussion with your doctor.'}
                </p>

                <div className="health-field">
                  <label htmlFor="prostate-discussion">Discussed prostate screening with your doctor?</label>
                  <select
                    id="prostate-discussion"
                    value={scrStr(scr, 'prostate_discussion') || ''}
                    onChange={(e) => onScreeningChange('prostate_discussion', e.target.value)}
                  >
                    <option value="">Select...</option>
                    <option value="not_yet">Not yet</option>
                    <option value="elected_not_to">Yes, and I've elected not to screen</option>
                    <option value="will_screen">Yes, and I will screen</option>
                  </select>
                </div>

                {scrStr(scr, 'prostate_discussion') === 'will_screen' && (
                  <>
                    {/* PSA input with inline date picker */}
                    {(() => {
                      const psaMeasurement = previousMeasurements.find(m => m.metricType === 'psa');
                      const psaPreviousLabel = psaMeasurement
                        ? `${psaMeasurement.value.toFixed(1)} ng/mL · ${formatShortDate(psaMeasurement.recordedAt)}`
                        : null;

                      return (
                        <div className="health-field">
                          <label htmlFor="psa-input">PSA (ng/mL)</label>
                          <div className="psa-inline-row">
                            <input
                              type="number"
                              id="psa-input"
                              onWheel={blurOnWheel}
                              value={rawInputs.psa ?? (inputs.psa !== undefined ? String(inputs.psa) : '')}
                              onChange={(e) => {
                                const val = e.target.value;
                                setRawInputs(prev => ({ ...prev, psa: val }));
                                if (val === '') {
                                  updateField('psa', undefined);
                                } else {
                                  const num = parseLocalisedNumber(val);
                                  if (num !== undefined) updateField('psa', num);
                                }
                              }}
                              onBlur={() => {
                                setRawInputs(prev => { const next = { ...prev }; delete next.psa; return next; });
                                validateOnBlur('psa');
                                autoSaveOnBlur();
                              }}
                              onKeyDown={autoSaveOnEnterKey}
                              placeholder=""
                              step="0.1"
                              min="0"
                              max="100"
                              className={errors.psa ? 'error' : ''}
                            />
                            <InlineDatePicker value={psaDate} onChange={setPsaDate} />
                            {autoSaveGate && inputs.psa !== undefined && (
                              <CommitTickButton ariaLabel="Save PSA" onClick={flushLongitudinalSave}/>
                            )}
                          </div>
                          {errors.psa && <span className="field-error">{errors.psa}</span>}
                          <div className="field-meta">
                            <span className="field-hint">Normal: &lt;4.0 ng/mL</span>
                            {psaPreviousLabel && (
                              <a
                                className="previous-value"
                                href={`${HISTORY_PAGE_PATH}?metric=psa`}
                                onClick={interceptHistory('psa')}
                                target="_blank"
                                rel="noopener noreferrer"
                              >{psaPreviousLabel}</a>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            )}

            {/* Endometrial (female, age 45+) — awareness */}
            {sex === 'female' && age >= 45 && (
              <div className="screening-group">
                <h4>Endometrial</h4>

                <div className="health-field">
                  <label htmlFor="endometrial-discussion">Discussed endometrial cancer risk at menopause?</label>
                  <select
                    id="endometrial-discussion"
                    value={scrStr(scr, 'endometrial_discussion') || ''}
                    onChange={(e) => onScreeningChange('endometrial_discussion', e.target.value)}
                  >
                    <option value="">Select...</option>
                    <option value="not_yet">Not yet</option>
                    <option value="discussed">Yes, discussed</option>
                  </select>
                </div>

                <div className="health-field">
                  <label htmlFor="endometrial-bleeding">Any abnormal uterine bleeding?</label>
                  <select
                    id="endometrial-bleeding"
                    value={scrStr(scr, 'endometrial_abnormal_bleeding') || ''}
                    onChange={(e) => onScreeningChange('endometrial_abnormal_bleeding', e.target.value)}
                  >
                    <option value="">Select...</option>
                    <option value="no">No</option>
                    <option value="yes_reported">Yes, reported to doctor</option>
                    <option value="yes_need_to_report">Yes, need to report to doctor</option>
                  </select>
                </div>
              </div>
            )}
          </section>
          </div>
        );
      })()}
    </>
  );

  const renderBoneDensity = () => (
    <>
      {(() => {
        const age = inputs.birthYear
          ? calculateAge(inputs.birthYear, inputs.birthMonth ?? 1)
          : undefined;
        if (age === undefined) return null;

        const sex = inputs.sex;
        const dexaEligible = (sex === 'female' && age >= 50) || (sex === 'male' && age >= 70);
        if (!dexaEligible) return null;

        const scr = screeningsToInputs(screenings);

        const dexaScreening = scrStr(scr, 'dexa_screening');
        const dexaResult = scrStr(scr, 'dexa_result');
        const followupStatus = scrStr(scr, 'dexa_followup_status');

        return (
          <div className="section-card">
          <section className="health-section screening-cascade">
            <h3 className="health-section-title">Bone Density</h3>
            <p className="health-section-desc">
              DEXA scans measure bone mineral density to detect osteoporosis. Discuss screening with your doctor.
            </p>

            <div className="screening-group">
              <div className="health-field">
                <label htmlFor="dexa-screening">DEXA scan status</label>
                <select
                  id="dexa-screening"
                  value={dexaScreening || ''}
                  onChange={(e) => {
                    onScreeningChange('dexa_screening', e.target.value);
                    if (e.target.value !== 'dexa_scan') {
                      if (scrStr(scr, 'dexa_last_date')) onScreeningChange('dexa_last_date', '');
                      if (scrStr(scr, 'dexa_result')) onScreeningChange('dexa_result', '');
                      if (scrStr(scr, 'dexa_followup_status')) onScreeningChange('dexa_followup_status', '');
                      if (scrStr(scr, 'dexa_followup_date')) onScreeningChange('dexa_followup_date', '');
                    }
                  }}
                >
                  <option value="">Select...</option>
                  <option value="dexa_scan">Had a DEXA scan</option>
                  <option value="not_yet_started">Not yet started</option>
                </select>
              </div>

              {dexaScreening === 'dexa_scan' && (
                <>
                  {renderScreeningDateInput(scr,'dexa_last_date', 'Date of last DEXA scan')}

                  {scrStr(scr, 'dexa_last_date') && (
                    <div className="health-field">
                      <label htmlFor="dexa-result">Result</label>
                      <select
                        id="dexa-result"
                        value={dexaResult || ''}
                        onChange={(e) => {
                          onScreeningChange('dexa_result', e.target.value);
                          if (e.target.value !== 'osteoporosis') {
                            if (scrStr(scr, 'dexa_followup_status')) onScreeningChange('dexa_followup_status', '');
                            if (scrStr(scr, 'dexa_followup_date')) onScreeningChange('dexa_followup_date', '');
                          }
                        }}
                      >
                        <option value="">Select...</option>
                        <option value="normal">Normal</option>
                        <option value="osteopenia">Osteopenia</option>
                        <option value="osteoporosis">Osteoporosis</option>
                        <option value="awaiting">Awaiting results</option>
                      </select>
                    </div>
                  )}

                  {dexaResult === 'osteoporosis' && (
                    <div className="health-field">
                      <label htmlFor="dexa-followup-status">Treatment review status</label>
                      <select
                        id="dexa-followup-status"
                        value={followupStatus || ''}
                        onChange={(e) => {
                          onScreeningChange('dexa_followup_status', e.target.value);
                          if (e.target.value === 'not_organized' || e.target.value === '') {
                            if (scrStr(scr, 'dexa_followup_date')) onScreeningChange('dexa_followup_date', '');
                          }
                        }}
                      >
                        <option value="">Select...</option>
                        <option value="not_organized">Not yet organized</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="completed">Completed</option>
                      </select>
                    </div>
                  )}

                  {dexaResult === 'osteoporosis' && (followupStatus === 'scheduled' || followupStatus === 'completed') && (
                    renderScreeningDateInput(scr,
                      'dexa_followup_date',
                      followupStatus === 'completed' ? 'When was the treatment review completed?' : 'When is the treatment review scheduled?',
                    )
                  )}
                </>
              )}
            </div>
          </section>
          </div>
        );
      })()}
    </>
  );

  // ── Supplements section (logged-in only) ��─
  const [supplementSearch, setSupplementSearch] = useState('');
  const [showSupplementDropdown, setShowSupplementDropdown] = useState(false);
  const supplementDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showSupplementDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (supplementDropdownRef.current && !supplementDropdownRef.current.contains(e.target as Node)) {
        setShowSupplementDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSupplementDropdown]);

  const renderSupplements = () => {
    if (!isLoggedIn) return null;

    const activeSupplements = supplements.filter(s => s.status === 'active');
    const allOptions = SUPPLEMENT_OPTIONS.filter(
      opt => !activeSupplements.some(s => s.supplementKey === opt.key),
    );
    const filteredOptions = supplementSearch
      ? allOptions.filter(opt => opt.name.toLowerCase().includes(supplementSearch.toLowerCase()))
      : allOptions;

    const addSupplement = (key: string, name: string, defaultDose?: number, defaultUnit?: string) => {
      onSupplementChange(key, name, defaultDose ?? null, defaultUnit ?? null);
      setSupplementSearch('');
      setShowSupplementDropdown(false);
    };

    return (
      <div className="section-card">
        <section className="health-section">
          <h3 className="health-section-title">Supplements</h3>
          <p className="health-section-desc">Track supplements you take regularly.</p>

          {/* Featured supplement chips */}
          <div className="supplement-chips">
            {FEATURED_SUPPLEMENTS.filter(
              f => !activeSupplements.some(s => s.supplementKey === f.key),
            ).map(f => (
              <button
                key={f.key}
                type="button"
                className="supplement-chip"
                onClick={() => addSupplement(f.key, f.name, f.defaultDose, f.defaultUnit)}
              >
                + {f.name}
              </button>
            ))}
          </div>

          {/* Active supplements list */}
          {activeSupplements.map(s => (
            <div key={s.supplementKey} className="supplement-row">
              <span className="supplement-name">{s.supplementName}</span>
              <input
                type="number"
                className="supplement-dose"
                placeholder="Dose"
                value={s.doseValue ?? ''}
                onChange={e => {
                  const val = e.target.value ? parseLocalisedNumber(e.target.value) ?? null : null;
                  onSupplementChange(s.supplementKey, s.supplementName, val, s.doseUnit);
                }}
              />
              <select
                className="supplement-unit"
                value={s.doseUnit ?? ''}
                onChange={e => onSupplementChange(s.supplementKey, s.supplementName, s.doseValue, e.target.value || null)}
              >
                <option value="">Unit</option>
                <option value="mg">mg</option>
                <option value="mcg">mcg</option>
                <option value="g">g</option>
                <option value="IU">IU</option>
                <option value="capsules">capsules</option>
                <option value="scoop">scoop</option>
              </select>
              <button
                type="button"
                className="supplement-remove"
                onClick={() => onSupplementDelete(s.supplementKey)}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}

          {/* Add other supplement */}
          <div className="supplement-add" ref={supplementDropdownRef}>
            <input
              type="text"
              placeholder="Add another supplement..."
              value={supplementSearch}
              maxLength={100}
              onFocus={() => setShowSupplementDropdown(true)}
              onChange={e => {
                setSupplementSearch(e.target.value);
                setShowSupplementDropdown(true);
              }}
            />
            {showSupplementDropdown && filteredOptions.length > 0 && (
              <div className="supplement-dropdown">
                {filteredOptions.slice(0, 8).map(opt => (
                  <button
                    key={opt.key}
                    type="button"
                    className="supplement-dropdown-item"
                    onClick={() => addSupplement(opt.key, opt.name, opt.defaultDose, opt.defaultUnit)}
                  >
                    {opt.name}
                  </button>
                ))}
                {supplementSearch && !allOptions.some(o => o.name.toLowerCase() === supplementSearch.toLowerCase()) && (
                  <button
                    type="button"
                    className="supplement-dropdown-item supplement-custom"
                    onClick={() => addSupplement(`custom_${supplementSearch.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`, supplementSearch.slice(0, 100))}
                  >
                    + Add "{supplementSearch}"
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    );
  };

  // ── Render all sections with progressive disclosure (both mobile and desktop) ──
  const inputHeaderMeta = useMemo(() => {
    // Local-first has no accounts and auto-saves to the device/cloud — the
    // "New account" / "Last saved ·…" status line is meaningless here (Brad,
    // 2026-06-12). The production widget keeps it.
    if (LOCAL_FIRST) return '';
    if (!isLoggedIn) return '';
    const mostRecentMeasurementAt = previousMeasurements.reduce<number>((max, m) => {
      const t = m.recordedAt ? new Date(m.recordedAt).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    const effectiveSavedAt = lastSavedAt ?? (mostRecentMeasurementAt > 0 ? mostRecentMeasurementAt : null);
    if (effectiveSavedAt === null) return 'New account';
    return `Last saved · ${formatRelativeTime(effectiveSavedAt)}`;
  }, [isLoggedIn, previousMeasurements, lastSavedAt]);

  return (
    <div className="health-input-panel">
      <ColumnHeader step={1} title="Your information" meta={inputHeaderMeta} />
      {/* Card 1: Units + Basic Info + Vitals + Birth Info (stage 2+) */}
      <div className="section-card">
        {renderProfile()}
        {formStage >= 2 && <div className="stage-reveal">{renderVitals()}</div>}
        {formStage >= 2 && (
          <div className={`prefill-fields-wrapper${collapseAnimating && !prefillExpanded ? ' collapsing' : ''}${collapsed && !prefillExpanded ? ' collapsed' : ''}`}>
            <div>{renderBirthInfo()}</div>
          </div>
        )}
        {formStage === 2 && (
          <p className="field-hint-attention field-hint-attention--centered">
            Fill in the above — then more fields will appear.
          </p>
        )}
      </div>

      {/* Card 2: Blood Tests (stage 3+). `section-card--bt` zeros the
          card's inner padding so the timeline matrix sits flush against
          the card edges (column-fit math expects no inner padding). */}
      {formStage >= 3 && (
        <div className="section-card section-card--bt stage-reveal">
          {renderBloodTests()}
        </div>
      )}

      {formStage >= 3 && renderMedications()}
      {formStage >= 3 && renderScreening()}
      {formStage >= 3 && renderBoneDensity()}
      {formStage >= 3 && isLoggedIn && renderSupplements()}
      {healthDocuments && healthDocuments.length > 0 && (
        <HealthRecordsSection documents={healthDocuments} onDeleted={onDocumentDeleted} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health Records (scan results, clinic letters, etc.) — raw data display
// ---------------------------------------------------------------------------

function HealthRecordsSection({ documents, onDeleted }: { documents: ApiDocument[]; onDeleted?: (docId: string) => void }) {
  const [selectedDoc, setSelectedDoc] = useState<ApiDocument | null>(null);

  const scanResults = documents.filter(d => d.documentType === 'scan_result');
  const otherDocs = documents.filter(d => d.documentType !== 'scan_result');

  return (
    <>
      {scanResults.length > 0 && (
        <section className="health-records-section">
          <h3 className="results-section-title">Scan Results</h3>
          <div className="health-records-list">
            {scanResults.map(doc => (
              <button
                key={doc.id}
                className="health-record-item"
                onClick={() => setSelectedDoc(doc)}
              >
                <span className="health-record-date">{formatDocumentDate(doc.documentDate)}</span>
                <span className="health-record-title">{doc.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {otherDocs.length > 0 && (
        <section className="health-records-section">
          <h3 className="results-section-title">Documents</h3>
          <div className="health-records-list">
            {otherDocs.map(doc => (
              <button
                key={doc.id}
                className="health-record-item"
                onClick={() => setSelectedDoc(doc)}
              >
                <span className="health-record-date">{formatDocumentDate(doc.documentDate)}</span>
                <span className="health-record-info">
                  <span className={`health-record-type-badge health-record-type--${doc.documentType}`}>
                    {DOCUMENT_TYPE_LABELS[doc.documentType] || doc.documentType}
                  </span>
                  <span className="health-record-title">{doc.title}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {selectedDoc && (
        <DocumentLightbox
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onDeleted={onDeleted}
        />
      )}
    </>
  );
}
