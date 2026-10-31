import { Fragment, useState, useEffect, useRef, type MutableRefObject } from 'react';
import { ColumnHeader } from './ColumnHeader';
import { InfoTooltip } from './InfoTooltip';
import { DocumentLightbox } from './DocumentLightbox';
import { DOCUMENT_TYPE_LABELS, formatDocumentDate } from '../lib/document-format';
import { openHistoryLightbox } from '../lib/roadmap-data';
import { isLabArchiveDocument } from '@roadmap/health-core';
import type { CorrectFn, Refused, SaveTask } from '../lib/matrix-save';
import { blockBadNumericKeys, blockNonIntegerKeys, bpSysAdvance, type Grading } from '../lib/blood-test-cell';
import type { ApiDocument, ApiLabValue, ApiSupplement } from '../lib/api-types';
import { DRAFTS_CLEARED_EVENT, loadFromLocalStorage } from '../lib/storage';

/** Every surface opens metric history in the local lightbox. */
const interceptHistory = (metric: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
  if (openHistoryLightbox(metric)) e.preventDefault();
};
import type { AlcoholAnswer, FormStage, HealthInputs, HealthResults, ScreeningInputs, WeightMedicationTrigger, LipidMarker } from '@roadmap/health-core';
import {
  type UnitSystem,
  fromCanonicalValue,
  toCanonicalValue,
  getDisplayLabel,
  getDisplayRange,
  UNIT_DEFS,
  hasUnitChoice,
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
  LIPID_DIET_ADVICE,
  cmToFeetInches,
  feetInchesToCm,
  formatHeightDisplay,
  GLP1_NAMES,
  GLP1_DRUGS,
  weightCascade,
  lipidCascade,
  lipidTargetSentence,
  weightMedIntro,
  bpTargetFor,
  METRIC_TO_FIELD,
  VITAL_METRICS,
  SGLT2I_NAMES,
  SGLT2I_DRUGS,
  METFORMIN_OPTIONS,
  validateInputValue,
  isBirthYearClearlyInvalid,
  parseLocalisedNumber,
  dayOf,
  localDay,
  MEDICATION_TEXT,
  SCREENING_TEXT,
  SCREENING_OPTIONS,
  SCREENING_LABELS,
  SUPPLEMENT_TEXT,
  SUPPLEMENT_DOSE_UNITS,
  optionsShowing,
  escalationOptions,
  doseOptions,
  medicationWrites,
  screeningWrites,
  readScreening,
  followupName,
  followupDateLabel,
  anyScreeningEligible,
  dexaEligible,
  customSupplementAdd,
  customSupplementMatch,
  type FormOption,
  type MedicationInputs,
} from '@roadmap/health-core';
import { formatShortDate, MONTHS_FULL } from '../lib/constants';
import { InlineDatePicker, getCurrentDateValue, type DateValue } from './DatePicker';
import { BloodTestTimeline, useLiveRegion, type BloodTestPrefillFn } from './BloodTestTimeline';
import { AdditionalLabRows } from './AdditionalLabRows';
import { useMoveTest, type MoveTestApi } from './MoveTestPanel';
import { StartingInfoVitals, type VitalsPrefillFn } from './StartingInfoVitals';
import { CommitTickButton } from './CommitTickButton';
import { ALCOHOL_OPTIONS } from './AlcoholQuestion';
import { StorageNotice } from '../lib/storage-notice';
import { useIsMobile } from '../lib/useIsMobile';
import { useLpaUnit } from '../lib/lpa-unit';
import { BloodTestRows, VitalsRows, type RowContext, type ValueSubject } from './MyDataRows';
import { ValuePage } from './ValuePage';

/** The history-state key a phone value page's entry carries (US-62 AC10). */
const VALUE_PAGE_STATE = 'hrValuePage';
const LEAVE_UNSAVED = 'Leave without saving the value you typed?';
/** Said when a chat edit closes a page that held typed input. */
const TYPED_NOT_SAVED = 'Your typed value was not saved.';

interface FieldConfig {
  field: keyof HealthInputs;
  name: string;
  step?: { si: string; conv: string };
  hint?: { si: string; conv: string };
  hintMale?: { si: string; conv: string };
  hintFemale?: { si: string; conv: string };
}

const WEIGHT_FIELD: FieldConfig = { field: 'weightKg', name: 'Weight' };
const BASIC_LONGITUDINAL_FIELDS: FieldConfig[] = [
  WEIGHT_FIELD,
  { field: 'waistCm', name: 'Waist Circumference' },
];

/** Option data (health-core's input-form) as <option> elements. */
const optionElements = (options: FormOption[]) =>
  options.map(opt => <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>);

/** What the form reads from the plan, so it never recommends, targets or
 *  steps through what the plan does not (US-06 AC5). HealthTool computes it
 *  beside the plan, from the same validated inputs and results: the plan's
 *  age, BMI, weight target (kg) and validated height (cm), which sets the
 *  vitals matrix's waist line. */
export type PlanBasis = Pick<HealthResults, 'age' | 'bmi' | 'idealBodyWeight' | 'heightCm'> & {
  weightMedTrigger: WeightMedicationTrigger;
  /** The plan's lipid marker: ApoB, then non-HDL, then LDL-c. */
  lipidMarker: LipidMarker | null;
};

interface InputPanelProps {
  /** US-09 AC30: the Sign in button, in the header on desktop and on a phone. */
  storageBar?: React.ReactNode;
  inputs: Partial<HealthInputs>;
  /** What the plan reads: the form, the drafts that stand in over it, and
   *  the record's latest values under both. The medication cascades follow it. */
  effectiveInputs: Partial<HealthInputs>;
  /** One field's new value; `unit`: the unit a weight or waist was typed in. */
  onChange: <K extends keyof HealthInputs>(field: K, value: HealthInputs[K] | undefined, unit?: UnitSystem) => void;
  errors: Record<string, string>;
  unitSystem: UnitSystem;
  onUnitSystemChange: (system: UnitSystem) => void;
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: (field: string) => void;
  previousMeasurements: ApiMeasurement[];
  bloodTestHistory: ApiMeasurement[];
  /** Full vitals history (weight / waist / sys-BP / dia-BP). Same source
   *  as bloodTestHistory — just a different filter. */
  vitalsHistory: ApiMeasurement[];
  /** Stored additional lab values (beyond the core 8) — read-only surfacing
   *  beneath the matrix (US-21 phase 1). */
  labValues: ApiLabValue[];
  /** US-21 phase 2: present = manual add enabled; called after a saved add. */
  onLabValueAdded?: () => void;
  /** `erase`: the erase the values were typed under (US-16 AC2a); the page's shown one by default. */
  onSaveBloodTestBatch: (tasks: SaveTask[], erase?: string) => Promise<Refused>;
  // Click-to-correct handler for saved cells in every matrix: blood tests,
  // vitals and the additional lab rows.
  onCorrectValue?: CorrectFn;
  /** Moves a saved blood test to another day (US-04 AC5), from either blood-test matrix. */
  moveTest?: MoveTestApi;
  /** A matrix's draft value as the plan reads it (both matrices). */
  onDraftValue: (field: keyof HealthInputs, value: number | undefined, day?: string) => void;
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
  /** Counts the saves of the first-time vitals fields. */
  fieldsSaved: number;
  hasApiResponse: boolean;
  // Forwarded to each matrix, so the parent (HealthTool) can commit its
  // draft before the upload modal's own save.
  bloodTestFlushRef?: MutableRefObject<(() => Promise<void>) | null>;
  vitalsFlushRef?: MutableRefObject<(() => Promise<void>) | null>;
  // Forwarded to BloodTestTimeline so the chatbot can pre-fill a blood-test cell.
  bloodTestPrefillRef?: MutableRefObject<BloodTestPrefillFn | null>;
  // Forwarded to StartingInfoVitals (matrix mode only) so the chatbot can
  // pre-fill + flash a vitals cell. Non-null on the ref ⇒ the vitals matrix is
  // mounted; HealthTool uses that to route vitals chat edits here vs the field.
  vitalsPrefillRef?: MutableRefObject<VitalsPrefillFn | null>;
  /** The first answer the record lacks (US-62 AC13): 1 height and weight,
   *  2 sex, 3 birth date, 4 none. */
  formStage: FormStage;
  /** The whole form shows: the onboarding is done, or a blood test is saved. */
  fullForm: boolean;
  setShowUploadModal?: (show: boolean) => void;
  /** What the plan was computed from. Null until there is a plan (no valid
   *  sex or height). */
  planBasis: PlanBasis | null;
  /** Whom the blood tests' hints and colours grade for. Null for a known minor
   *  by the validated birth info, plan or no plan: the form withholds its
   *  adult targets, hints and colours (US-07 AC6). */
  grading: Grading;
  healthDocuments?: ApiDocument[];
  onDocumentDeleted?: (docId: string) => void;
  onAutoFocusEmail?: () => void;
  /** A chat edit that filled a grid cell on a phone (US-16 AC2): the table
   *  opens so the filled cell shows. Each new edit is a new object. */
  revealCell?: { field: string } | null;
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
  storageBar, inputs, effectiveInputs, onChange: updateField, errors, unitSystem, onUnitSystemChange,
  unitOverrides, onToggleFieldUnit,
  previousMeasurements, bloodTestHistory, vitalsHistory, labValues, onLabValueAdded, onSaveBloodTestBatch,
  onCorrectValue, moveTest, onDraftValue,
  medications, onMedicationChange,
  screenings, onScreeningChange,
  supplements, onSupplementChange, onSupplementDelete,
  scheduleLongitudinalSave, flushLongitudinalSave,
  isSavingLongitudinal, fieldsSaved, hasApiResponse,
  bloodTestFlushRef, vitalsFlushRef, bloodTestPrefillRef, vitalsPrefillRef,
  formStage, fullForm,
  setShowUploadModal, planBasis, grading,
  healthDocuments, onDocumentDeleted, onAutoFocusEmail, revealCell = null,
}: InputPanelProps) {
  const [prefillExpanded, setPrefillExpanded] = useState(false);
  const [rawInputs, setRawInputs] = useState<Record<string, string>>({});
  // Number boxes holding text the browser could not read ("175,500" gives "" with
  // validity.badInput): not a clear, so nothing is written or saved (US-02 AC7).
  const [unreadable, setUnreadable] = useState<Record<string, boolean>>({});
  /** Records whether the box can be read; false means leave the saved value alone. */
  const readable = (field: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const bad = e.target.validity.badInput;
    setUnreadable(prev => ({ ...prev, [field]: bad }));
    return !bad;
  };
  const hasAutoFocusedEmail = useRef(false);
  // One auto-advance instance per TARGET, so a new keystroke on any source
  // field cancels a pending advance to that target.
  const advanceToWeight = useAutoAdvance();
  const advanceToEmail = useAutoAdvance();
  const advanceToDiastolic = useAutoAdvance();
  const focusById = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
  // Shared keydown combos: numeric-only guard (US-02 AC4) + Enter-to-save.
  const onNumericEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { blockBadNumericKeys(e); autoSaveOnEnterKey(e); };
  const onIntegerEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { blockNonIntegerKeys(e); autoSaveOnEnterKey(e); };
  const [dateInputs, setDateInputs] = useState<Record<string, { year: string; month: string }>>({});

  // Expand/collapse state for display-first longitudinal fields.
  // (Blood tests have their own matrix UI in BloodTestTimeline; no expand state here.)
  const [expandedVitals, setExpandedVitals] = useState<Set<string>>(new Set());
  // Latched synchronously at mount from the mirror. Avoids the flash of the
  // legacy form before async data hydrates. The mirror keeps saved vitals
  // only as `previousMeasurements` rows (its `inputs` hold the profile
  // fields), so one check covers every returning user. First-time users (no
  // saved vitals) get 'legacy'; everyone returning gets 'matrix'.
  const [vitalsViewMode] = useState<'legacy' | 'matrix'>(() =>
    loadFromLocalStorage()?.previousMeasurements.some(r => VITAL_METRICS.includes(r.metricType)) ? 'matrix' : 'legacy');
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
  const autoSaveGate = hasApiResponse;
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
    return !!metric && hasUnitChoice(metric);
  };
  const prefillComplete = !!(inputs.sex && inputs.heightCm && inputs.birthYear && inputs.birthYear >= 1900);

  // Collapse only on return visits with the onboarding done at mount (data
  // pre-loaded). No auto-collapse on first visit, nor mid-onboarding.
  const isReturningUser = useRef(prefillComplete && fullForm);
  const canCollapse = isReturningUser.current && prefillComplete && fullForm;
  const [collapsed, setCollapsed] = useState(isReturningUser.current);

  // ── The phone's My data (US-62 AC8-AC12) ──
  // Rows replace the grids, which stay mounted but hidden: their drafts, the
  // chat's prefill (US-16 AC2) and the save before an upload all keep working.
  // "All results as a table" shows them; so does a chat edit that filled one.
  const isPhone = useIsMobile();
  const [lpaUnit] = useLpaUnit(unitSystem);
  const rowCtx: RowContext = {
    grading,
    plan: planBasis,
    unitOf: m => (m === 'lpa' ? lpaUnit : unitOverrides[METRIC_TO_FIELD[m]] ?? unitSystem),
  };
  const [valuePage, setValuePage] = useState<ValueSubject | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [seenReveal, setSeenReveal] = useState<{ field: string } | null>(null);
  const revealing = !!revealCell && revealCell !== seenReveal;
  const tableShown = !isPhone || tableOpen || revealing;
  const pageShown = isPhone && !revealing ? valuePage : null;
  // A page is a history entry (a state marker, no URL change), so the phone's
  // back gesture closes it, and "‹ My data" goes back. Typed, unsaved Add
  // input is never dropped silently: leaving asks first. Back returns to the
  // row it opened from, scrolled and focused as it was.
  const cameFrom = useRef<{ el: Element | null; y: number }>({ el: null, y: 0 });
  const pageDirty = useRef(false);
  const onPageEntry = () => !!window.history.state?.[VALUE_PAGE_STATE];
  const mayLeave = () => !pageDirty.current || window.confirm(LEAVE_UNSAVED);
  const openPage = (subject: ValueSubject) => {
    cameFrom.current = { el: document.activeElement, y: window.scrollY };
    setSeenReveal(revealCell);
    setValuePage(subject);
    if (!onPageEntry()) window.history.pushState({ ...window.history.state, [VALUE_PAGE_STATE]: true }, '');
    window.scrollTo?.(0, panelTop());
  };
  const finishClose = () => {
    pageDirty.current = false;
    setValuePage(null);
    requestAnimationFrame(() => {
      window.scrollTo?.(0, cameFrom.current.y);
      if (cameFrom.current.el instanceof HTMLElement) cameFrom.current.el.focus({ preventScroll: true });
    });
  };
  const closePage = () => {
    if (!mayLeave()) return;
    pageDirty.current = false;
    if (onPageEntry()) window.history.back(); // its popstate closes the page
    else finishClose();
  };
  // A reload on a page's entry opens on the rows: drop the stale marker, so the next page pushes its own.
  useEffect(() => {
    if (onPageEntry()) window.history.replaceState({ ...window.history.state, [VALUE_PAGE_STATE]: undefined }, '');
  }, []);
  useEffect(() => {
    if (!valuePage) return;
    const onPop = () => {
      // A page left open on My data while another tab shows does not answer Back.
      if (onPageEntry() || panelRef.current?.closest('[hidden]')) return;
      // Back from a page holding typed input, declined: stay, and keep the entry.
      if (!mayLeave()) { window.history.pushState({ ...window.history.state, [VALUE_PAGE_STATE]: true }, ''); return; }
      finishClose();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [valuePage]);
  // An erase, here or on another device, closes an open page and drops what it held (US-16 AC2a).
  useEffect(() => {
    const drop = () => {
      if (!valuePageRef.current) return;
      setValuePage(null);
      pageDirty.current = false;
      if (onPageEntry()) window.history.back();
    };
    window.addEventListener(DRAFTS_CLEARED_EVENT, drop);
    return () => window.removeEventListener(DRAFTS_CLEARED_EVENT, drop);
  }, []);
  const valuePageRef = useRef(valuePage);
  valuePageRef.current = valuePage;
  // A chat edit that fills a grid cell closes any open page, so the table shows.
  const [sayPanel, panelMessages] = useLiveRegion('md-panel-messages');
  // Read as the reveal renders: the page unmounts in this commit, and its form clears the mark as it goes.
  const revealDropsTyping = useRef(false);
  if (revealing && valuePage && pageDirty.current) revealDropsTyping.current = true;
  useEffect(() => {
    if (!revealing || !valuePage) return;
    if (revealDropsTyping.current) sayPanel(TYPED_NOT_SAVED);
    revealDropsTyping.current = false;
    setValuePage(null);
    pageDirty.current = false;
    if (onPageEntry()) window.history.back();
  }, [revealing]);
  // A grid's typed text not yet saved, valid or not (the plan and the chat
  // read the valid part, and an upload saves it first): on a phone, where the
  // grids sit hidden under the rows, each card says so and opens the table
  // (US-62 AC11). Each grid reports what it keeps.
  const [draftedVitals, setDraftedVitals] = useState(false);
  const [draftedBlood, setDraftedBlood] = useState(false);
  const unsavedCue = (shown: boolean) => isPhone && !tableShown && shown && (
    <button type="button" className="md-unsaved" onClick={() => showTable(true)}>Unsaved values: review</button>
  );
  const showTable = (open: boolean) => { setSeenReveal(revealCell); setTableOpen(open); };
  const panelRef = useRef<HTMLDivElement>(null);
  const panelTop = () => (panelRef.current ? panelRef.current.getBoundingClientRect().top + window.scrollY - 60 : window.scrollY);
  // A grid mounted hidden never scrolled to its newest column: do it on showing.
  useEffect(() => {
    if (!isPhone || !tableShown) return;
    panelRef.current?.querySelectorAll<HTMLElement>('.md-table .bt-timeline-scroll').forEach(el => { el.scrollLeft = el.scrollWidth; });
  }, [isPhone, tableShown]);
  // About you sits low, as on the iPhone, once the onboarding is done.
  // Decided at mount, then held as long as the whole form is (an answer
  // retyped never moves it); a new user finishes it first, at the top
  // (US-62 AC12, AC13).
  const profileAtMount = useRef(formStage === 4);
  const aboutYouLow = isPhone && profileAtMount.current && fullForm;
  // The onboarding asks the weight beside the height (US-62 AC13). A weight
  // typed there stays there for this visit, so the whole form opening, or the
  // weight cleared to retype, never moves the field being typed in; the
  // first-time vitals then leave it out. Otherwise it joins the vitals when
  // the whole form opens, shown once, and sex sits beside the height.
  const weightShown = useRef(false);
  const weightTyped = useRef(false);
  if (weightShown.current && inputs.weightKg !== undefined) weightTyped.current = true;
  const weightInProfile = !fullForm || weightTyped.current;
  weightShown.current = weightInProfile;
  const sexInRow = fullForm && !weightInProfile;
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

  // PSA date picker state (for prostate section)
  const [psaDate, setPsaDate] = useState<DateValue>(getCurrentDateValue);

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

  const getPreviousPlaceholder = (field: string): string | undefined => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return undefined;
    const measurement = previousMeasurements.find(m => m.metricType === metric);
    if (!measurement) return undefined;
    return toDisplay(field, measurement.value);
  };

  /** The line over an open field whose metric holds a saved value: "Previous:
   *  82 kg · 3 Sep", or "Replaces 82 kg" when that value is today's, since one
   *  day holds one value and what is typed here corrects it (US-03 AC3). */
  const previousReference = (shown: string, recordedAt: string): string =>
    dayOf(recordedAt) === localDay(new Date()) ? `Replaces ${shown}` : `Previous: ${shown} · ${formatShortDate(recordedAt)}`;

  // Blood-test fields are committed via BloodTestTimeline's own Save button,
  /** Check if a field has a previous saved measurement. */
  const hasPreviousValue = (field: string): boolean => {
    const metric = FIELD_METRIC_MAP[field];
    return !!metric && previousMeasurements.some(m => m.metricType === metric);
  };

  /** Whether any basic vital has saved data (for per-metric collapse). */
  const hasBpPreviousData = (hasPreviousValue('systolicBp') || hasPreviousValue('diastolicBp'));

  // Close the vitals fields a save emptied. A count of saves, not the saving
  // flag: React batches the flag's true and false into one render, so an
  // effect waiting for it to fall never ran and a saved field stayed open.
  useEffect(() => {
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
  }, [fieldsSaved]);

  // Shared date constants for screening date pickers
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-12
  const pastYears = Array.from({ length: 11 }, (_, i) => currentYear - i);

  /** Render a month/year date picker for screening dates. Used by both cancer screening and bone density. */
  const renderScreeningDateInput = (scr: ScreeningInputs, key: string, label: string, options?: { futureOnly?: boolean }) => {
    const futureOnly = options?.futureOnly ?? false;
    const savedValue = readScreening(scr, key);
    const [savedYear, savedMonth] = savedValue.split('-');

    const localState = dateInputs[key];
    const displayYear = localState?.year ?? savedYear ?? '';
    const displayMonth = localState?.month ?? savedMonth ?? '';

    const availableYears = futureOnly
      ? Array.from({ length: 6 }, (_, i) => currentYear + i)
      : pastYears;

    const availableMonths = futureOnly
      ? (displayYear === String(currentYear)
        ? MONTHS_FULL.filter(m => parseInt(m.value, 10) >= currentMonth)
        : MONTHS_FULL)
      : (displayYear === String(currentYear)
        ? MONTHS_FULL.filter(m => parseInt(m.value, 10) <= currentMonth)
        : MONTHS_FULL);

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

  const renderLongitudinalField = (config: FieldConfig) => {
    const { field, name, step } = config;
    const effectiveHint = resolveHint(config);
    const r = range(field);
    const metric = FIELD_METRIC_MAP[field];
    const previous = metric && previousMeasurements.find(m => m.metricType === metric);
    const shown = metric && previous ? `${toDisplay(field, previous.value)} ${getDisplayLabel(metric, fieldUnit(field))}` : '';
    const previousLabel = previous ? `${shown} · ${formatShortDate(previous.recordedAt)}` : null;
    const needsAttention = field === 'weightKg' && formStage === 1 && inputs.heightCm !== undefined && inputs.weightKg === undefined;
    // In expanded mode with previous data, show "Previous:" reference instead of placeholder
    // (blood tests no longer use this render path — they use BloodTestTimeline).
    const isExpandedWithData = !!previous && expandedVitals.has(field);
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
        {isExpandedWithData && previous && (
          <span className="previous-reference">{previousReference(shown, previous.recordedAt)}</span>
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
              if (!readable(field, e)) return;
              // Ignore browser auto-fill of 0 for empty fields (spinner click on empty input)
              if (raw === '0' && inputs[field] === undefined && rawInputs[field] === undefined) {
                return;
              }
              updateField(field, parseAndConvert(field, raw), fieldUnit(field));
              // Only as the last answer: a first weight is step 1, sex comes next (US-62 AC13).
              if (field === 'weightKg' && prefillComplete && !hasAutoFocusedEmail.current && onAutoFocusEmail) {
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
              if (unreadable[field]) return;
              setRawInputs(prev => { const next = { ...prev }; delete next[field]; return next; });
              autoSaveOnBlur();
            }}
            onKeyDown={onNumericEnter}
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
        {(unreadable[field] || errors[field]) && (
          <span className="error-message">{unreadable[field] ? 'Enter a number' : errors[field]}</span>
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
                href="#health-history"
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
            href="#health-history"
            onClick={interceptHistory(metric)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {name}
          </a>
          {/* Whole value column expands the row — Clarity showed users dead-clicking
              the value/unit text expecting exactly that (the 28px + button was the
              only target). Unit pill stops propagation so toggling stays a toggle. */}
          <span className="collapsed-field-value" onClick={onExpand} title="Add new value">
            {displayValue}{' '}
            {hasUnitToggle(field) ? (
              <button
                type="button"
                className="unit-toggle-pill"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFieldUnit(field); }}
                title={`Switch to ${fieldUnit(field) === 'si' ? 'conventional' : 'metric'} units`}
              >
                {unitLabel}
              </button>
            ) : (
              <span className="collapsed-field-unit" title="This unit is fixed">{unitLabel}</span>
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
  const getBpPreviousData = (): { sysVal: number; diaVal: number; latestDate: string } | null => {
    const sysMetric = FIELD_METRIC_MAP['systolicBp'];
    const diaMetric = FIELD_METRIC_MAP['diastolicBp'];
    const sysMeasurement = sysMetric ? previousMeasurements.find(m => m.metricType === sysMetric) : null;
    const diaMeasurement = diaMetric ? previousMeasurements.find(m => m.metricType === diaMetric) : null;
    // A half-pair rendered as "120/?" reads as broken and invites repair clicks
    // (top dead-click target in the 2026-08 Clarity audit). BP is atomic
    // (bpPairReady) — treat a half-pair as no previous BP at all.
    if (!sysMeasurement || !diaMeasurement) return null;

    const sysVal = Math.round(sysMeasurement.value);
    const diaVal = Math.round(diaMeasurement.value);
    const dates = [sysMeasurement?.recordedAt, diaMeasurement?.recordedAt].filter(Boolean) as string[];
    const latestDate = dates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    return { sysVal, diaVal, latestDate };
  };

  const knownMinor = grading === null;
  /** BP target text based on the plan's age; none with no plan (US-06 AC5)
   *  or for a known minor, whose plan holds no adult reading (US-07 AC6). */
  const bpTargetText = planBasis && !knownMinor ? `Target: <${bpTargetFor(planBasis.age)}/80 mmHg` : null;

  /** Render collapsed BP display. */
  const renderCollapsedBp = (data: { sysVal: number; diaVal: number; latestDate: string }) => {

    return (
      <div className="health-field">
        <div className="collapsed-field-row">
          <a
            className="collapsed-field-label"
            href="#health-history"
            onClick={interceptHistory('systolic_bp')}
            target="_blank"
            rel="noopener noreferrer"
          >
            Blood Pressure
          </a>
          <span
            className="collapsed-field-value"
            onClick={() => { focusFieldRef.current = 'systolicBp'; setBpExpanded(true); }}
            title="Add new value"
          >{data.sysVal}/{data.diaVal} <span className="collapsed-field-unit" title="Blood pressure is always measured in mmHg">mmHg</span></span>
          <span className="collapsed-field-date">{formatShortDate(data.latestDate)}</span>
          <button type="button" className="collapsed-field-add" onClick={() => { focusFieldRef.current = 'systolicBp'; setBpExpanded(true); }} title="Add new value">+</button>
        </div>
        {bpTargetText && (
          <div className="field-meta">
            <span className="field-hint">{bpTargetText}</span>
          </div>
        )}
      </div>
    );
  };

  // ── Section render functions (shared closure state, not separate components) ──

  const sexField = (
  <div className={`health-field${!inputs.sex ? ' field-attention' : ''}`}>
    <label>Sex</label>
    <div className="sex-toggle" role="radiogroup" aria-label="Sex">
      <button
        type="button"
        role="radio"
        aria-checked={inputs.sex === 'male'}
        className={`sex-toggle-btn${inputs.sex === 'male' ? ' sex-toggle-btn--active' : ''}`}
        onClick={() => { updateField('sex', 'male'); if (!inputs.birthMonth) focusById('birthMonth'); }}
      >
        Male
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={inputs.sex === 'female'}
        className={`sex-toggle-btn${inputs.sex === 'female' ? ' sex-toggle-btn--active' : ''}`}
        onClick={() => { updateField('sex', 'female'); if (!inputs.birthMonth) focusById('birthMonth'); }}
      >
        Female
      </button>
    </div>
    <p className="field-why">Used to calculate ideal body weight, kidney function, and screening programs.</p>
    {errors.sex && <span className="error-message">{errors.sex}</span>}
  </div>
  );

  const heightField = (
  <div className={`health-field${!inputs.heightCm ? ' field-attention' : ''}`}>
    <label htmlFor="heightCm">
      Height{' '}
      <button
        type="button"
        className="unit-toggle-pill"
        data-unit-control="all"
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
        onKeyDown={blockBadNumericKeys}
        onWheel={blurOnWheel}
        value={rawInputs['heightCm'] !== undefined ? rawInputs['heightCm'] : toDisplay('heightCm', inputs.heightCm)}
        onChange={(e) => {
          const raw = e.target.value;
          setRawInputs(prev => ({ ...prev, heightCm: raw }));
          if (!readable('heightCm', e)) return;
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
        onBlur={() => { if (!unreadable.heightCm) setRawInputs(prev => { const next = { ...prev }; delete next['heightCm']; return next; }); }}
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
    {((unreadable.heightCm && unitSystem === 'si') || errors.heightCm) && (
      <span className="error-message">{unreadable.heightCm && unitSystem === 'si' ? 'Enter a number' : errors.heightCm}</span>
    )}
  </div>
  );

  const renderProfile = () => (
    <>
      <section className="health-section">
        <div className="hr-section-card-header">
          <h3
            className={`health-section-title${canCollapse ? ' health-section-title--collapsible' : ''}`}
            onClick={canCollapse ? () => setPrefillExpanded(!prefillExpanded) : undefined}
          >
            {aboutYouLow ? 'About you' : 'Starting Info'}
            {canCollapse && (
              <span className={`collapse-chevron${prefillExpanded ? ' expanded' : ''}`}>{'\u25B8'}</span>
            )}
          </h3>
          <div className="basic-info-units">
            <span className="basic-info-units-label">Units</span>
            {/* data-unit-control="all": a press here closes every open
                saved-value editor unsaved (US-05 AC2, US-04 AC1). */}
            <button
              type="button"
              className="unit-toggle-pill"
              data-unit-control="all"
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
                ? `Born ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][inputs.birthMonth - 1]} ${inputs.birthYear}${planBasis?.age !== undefined ? ` (Age ${planBasis.age})` : ''}`
                : null,
            ].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className={`prefill-fields-wrapper${collapseAnimating && !prefillExpanded ? ' collapsing' : ''}${collapsed && !prefillExpanded ? ' collapsed' : ''}`}>
          {/* The onboarding, one question at a time (US-62 AC13): height and
              weight, then sex, then the birth date. Each answer saves. Every
              slot keeps its place as the form opens, so a field being typed
              in is never remounted under the cursor. */}
          <div className="sex-height-row">
            {heightField}
            {weightInProfile && renderVital(WEIGHT_FIELD)}
            {sexInRow && sexField}
          </div>
          {!sexInRow && (fullForm || formStage >= 2) && <div className="stage-reveal profile-step">{sexField}</div>}
          {(fullForm || formStage >= 3) && <div className="stage-reveal profile-step">{renderBirthInfo()}</div>}
          {fullForm && renderAlcohol()}
          {!fullForm && (
            <p className="field-hint-attention field-hint-attention--centered">
              {formStage === 1 ? 'Enter your height and weight — then more fields will appear.' : 'Fill in the above — then more fields will appear.'}
            </p>
          )}
        </div>
      </section>
    </>
  );

  const renderVitalsMatrix = () => (
    <section className="health-section">
      <StartingInfoVitals
        vitalsHistory={vitalsHistory}
        unitSystem={unitSystem}
        onSave={onSaveBloodTestBatch}
        onCorrectValue={onCorrectValue}
        onDraftValue={onDraftValue}
        onHoldsText={setDraftedVitals}
        formStage={formStage}
        plan={planBasis}
        knownMinor={knownMinor}
        onAutoFocusEmail={prefillComplete ? onAutoFocusEmail : undefined /* only as the last answer (US-62 AC13) */}
        unitOverrides={unitOverrides}
        onToggleFieldUnit={onToggleFieldUnit}
        prefillRef={vitalsPrefillRef}
        flushRef={vitalsFlushRef}
      />
    </section>
  );

  /** A first-time vitals field: its saved value with a +, or the field. It
   *  saves when left (500 ms later), one active row per day (US-03 AC3). */
  const renderVital = (cfg: FieldConfig) => {
    if (hasPreviousValue(cfg.field) && !expandedVitals.has(cfg.field)) {
      return renderCollapsedField(cfg, () => {
        focusFieldRef.current = cfg.field;
        setExpandedVitals(prev => new Set(prev).add(cfg.field));
      });
    }
    return renderLongitudinalField(cfg);
  };

  // Legacy inline weight / waist / BP fields — kept for first-time users.
  // The matrix above shows historical context + a draft column, which is
  // overkill (and visually noisy) for someone entering their very first
  // measurement. Returning users with any saved vitals get the matrix.
  const renderVitalsLegacy = () => {
    const bpData = getBpPreviousData();
    const bpShown = bpData ? `${bpData.sysVal}/${bpData.diaVal} mmHg` : '';
    const bpLabel = bpData ? `${bpShown} · ${formatShortDate(bpData.latestDate)}` : null;
    return (
      <section className="health-section">
        {BASIC_LONGITUDINAL_FIELDS.filter(cfg => !(weightInProfile && cfg === WEIGHT_FIELD)).map(renderVital)}

        {hasBpPreviousData && !bpExpanded && bpData ? (
          <div>{renderCollapsedBp(bpData)}</div>
        ) : (
          <div className="health-field">
            <label>Blood Pressure (mmHg)
              <InfoTooltip ariaLabel="How to measure blood pressure">
                Use a home blood pressure monitor or ask your doctor at your next visit.{' '}
                <a href="https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings/monitoring-your-blood-pressure-at-home" target="_blank" rel="noopener noreferrer">Learn more &rarr;</a>
              </InfoTooltip>
            </label>
            {bpExpanded && bpData && (
              <span className="previous-reference">{previousReference(bpShown, bpData.latestDate)}</span>
            )}
            <div className="longitudinal-input-row">
              <div className="bp-fieldset">
                <input
                  type="number"
                  inputMode="numeric"
                  id="systolicBp"
                  onWheel={blurOnWheel}
                  value={inputs.systolicBp ?? ''}
                  onChange={(e) => {
                    updateField('systolicBp', parseLocalisedNumber(e.target.value));
                    // US-02 AC6: hop to diastolic once systolic is unambiguous.
                    const adv = bpSysAdvance(e.target.value);
                    if (adv !== 'stay' && inputs.diastolicBp === undefined) {
                      advanceToDiastolic({ ambiguous: adv === 'defer', advance: () => focusById('diastolicBp') });
                    }
                  }}
                  onBlur={() => { validateOnBlur('systolicBp'); autoSaveOnBlur(); }}
                  onKeyDown={onIntegerEnter}
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
                  onKeyDown={onIntegerEnter}
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
            {/* A pair the wrong way up is one error on both halves (US-02 AC8): said once. */}
            {errors.diastolicBp && errors.diastolicBp !== errors.systolicBp && <span className="error-message">{errors.diastolicBp}</span>}
            <div className="field-meta">
              {bpTargetText && <span className="field-hint">{bpTargetText}</span>}
              {!bpExpanded && bpLabel && (
                <a className="previous-value"
                   href="#health-history"
            onClick={interceptHistory('systolic_bp')}
                   target="_blank" rel="noopener noreferrer">{bpLabel}</a>
              )}
            </div>
          </div>
        )}
      </section>
    );
  };

  const renderVitals = () => {
    // A phone shows rows for any saved vitals, the mirror's or the record's
    // (a new device), unless the plain fields saved one this visit: those
    // stay, so nothing moves under someone typing.
    const phoneRows = isPhone && (vitalsViewMode === 'matrix' || (vitalsHistory.length > 0 && fieldsSaved === 0));
    if (!phoneRows) return vitalsViewMode === 'matrix' ? renderVitalsMatrix() : renderVitalsLegacy();
    return (
      <>
        {!tableShown && <VitalsRows history={vitalsHistory} ctx={rowCtx} onOpen={openPage}/>}
        {unsavedCue(draftedVitals)}
        <div className="md-table" hidden={!tableShown}>
          <button type="button" className="md-back md-table-back" onClick={() => showTable(false)}>‹ Show as rows</button>
          {renderVitalsMatrix()}
        </div>
      </>
    );
  };

  const renderBirthInfo = () => (
    <>
      <div className="health-field-group">
        <div className={`health-field${!inputs.birthMonth && !inputs.birthYear ? ' field-attention' : ''}`}>
          <label htmlFor="birthMonth">Birth Month</label>
          <select
            id="birthMonth"
            value={inputs.birthMonth || ''}
            onChange={(e) => updateField('birthMonth', parseLocalisedNumber(e.target.value))}
          >
            <option value="">Month...</option>
            {MONTHS_FULL.map((m, i) => (
              <option key={i + 1} value={i + 1}>{m.label}</option>
            ))}
          </select>
          {/* US-54 AC5b: a birth month in the future, left out of the plan. */}
          {errors.birthMonth && <span className="error-message">{errors.birthMonth}</span>}
        </div>

        {(inputs.birthMonth || inputs.birthYear) && (
          <div className={`health-field stage-reveal${!inputs.birthYear ? ' field-attention' : ''}`}>
            <label htmlFor="birthYear">Birth Year</label>
            <input
              type="number"
              id="birthYear"
              onKeyDown={blockNonIntegerKeys}
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
      <p className="field-why">Used to calculate age-based screening suggestions (cancer, bone density) and kidney function.</p>
    </>
  );

  // US-60: the answer the plan's "Reduce alcohol intake" Dismiss asks for. Not
  // an onboarding question, so it shows with the whole form.
  const renderAlcohol = () => (
    <div className="health-field">
      <label htmlFor="alcohol">Alcohol</label>
      <select
        id="alcohol"
        value={inputs.alcohol ?? ''}
        onChange={(e) => updateField('alcohol', (e.target.value || undefined) as AlcoholAnswer | undefined)}
      >
        {ALCOHOL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );

  // One move for both blood-test matrices: their headers pick it, the panel sits between them (US-04 AC5).
  const move = useMoveTest({ api: moveTest, unitSystem, unitOverrides, bloodTestHistory, labValues });

  const renderBloodTests = () => (
    <BloodTestTimeline
      bloodTestHistory={bloodTestHistory}
      unitSystem={unitSystem}
      unitOverrides={unitOverrides}
      onToggleFieldUnit={onToggleFieldUnit}
      onSaveBatch={onSaveBloodTestBatch}
      onCorrectValue={onCorrectValue}
      move={move.headers}
      onDraftValue={onDraftValue}
      onHoldsText={setDraftedBlood}
      isSaving={isSavingLongitudinal}
      grading={grading}
      onUploadClick={() => setShowUploadModal?.(true)}
      hasApiResponse={hasApiResponse}
      flushRef={bloodTestFlushRef}
      prefillRef={bloodTestPrefillRef}
    />
  );

  /** Send one medication answer's writes, in order (health-core's rules). */
  const writeMedication = (meds: MedicationInputs, cascadeMode: boolean, field: string, value: string) => {
    for (const w of medicationWrites(meds, cascadeMode, field, value)) onMedicationChange(w.medicationKey, w.drugName, w.doseValue, w.doseUnit);
  };
  /** Send one screening answer and the clears it implies, in order (health-core's rules). */
  const writeScreening = (scr: ScreeningInputs, key: string, value: string) => {
    for (const [k, v] of screeningWrites(scr, key, value)) onScreeningChange(k, v);
  };

  const renderMedications = () => (
    <>
      {/* Cholesterol Medications Section — cascade when the plan's lipid marker is elevated (US-06 AC5), flat when any lipid entered */}
      {(() => {
          const { apoB: effectiveApoB, ldlC: effectiveLdl, totalCholesterol: effectiveTotalChol, hdlC: effectiveHdl } = effectiveInputs;
          const lipidMarker = planBasis?.lipidMarker;

          // Three modes:
          // 1. Cascade: the plan's lipid marker is at or above its target
          // 2. Flat: any lipid value entered (allows recording meds when values are controlled)
          // 3. Hidden: no lipid values entered
          const cascadeMode = !!lipidMarker?.elevated;
          const hasAnyLipidInput = effectiveApoB !== undefined || effectiveLdl !== undefined
            || effectiveTotalChol !== undefined || effectiveHdl !== undefined;

          if (!cascadeMode && !hasAnyLipidInput) return null;

          const medInputs = medicationsToInputs(medications);
          const cascade = lipidCascade(medInputs);
          const statin = medInputs.statin;
          const statinDrug = statin?.drug ?? 'none';
          const statinDose = statin?.dose ?? null;

          // Get available doses for current statin
          const availableDoses = STATIN_DRUGS[statinDrug]?.doses ?? [];

          // ── Shared medication dropdowns ──

          const statinDropdown = (
            <div className="health-field">
              <label htmlFor="statin-name">{MEDICATION_TEXT.statinLabel}</label>
              {cascadeMode && <p className="med-step-hint">{cascade.suggest.includes('statin-dose') ? MEDICATION_TEXT.doseHint : MEDICATION_TEXT.statinHint}</p>}
              <div className="statin-selection-row">
                <select
                  id="statin-name"
                  value={statinDrug}
                  onChange={(e) => writeMedication(medInputs, cascadeMode, 'statin', e.target.value)}
                >
                  {optionElements(optionsShowing(STATIN_NAMES, statinDrug))}
                </select>
                {availableDoses.length > 0 && (
                  <select
                    id="statin-dose"
                    value={statinDose ?? ''}
                    onChange={(e) => writeMedication(medInputs, cascadeMode, 'statin_dose', e.target.value)}
                  >
                    {optionElements(optionsShowing(doseOptions(availableDoses), statinDose === null ? '' : String(statinDose), 'Add dose'))}
                  </select>
                )}
              </div>
            </div>
          );

          const ezetimibeDropdown = (
            <div className="health-field">
              <label htmlFor="ezetimibe">{MEDICATION_TEXT.ezetimibeLabel}</label>
              <select
                id="ezetimibe"
                value={medInputs.ezetimibe || 'not_yet'}
                onChange={e => writeMedication(medInputs, cascadeMode, 'ezetimibe', e.target.value)}
              >
                {optionElements(optionsShowing(EZETIMIBE_OPTIONS, medInputs.ezetimibe || 'not_yet'))}
              </select>
            </div>
          );

          const pcsk9iDropdown = (
            <div className="health-field">
              <label htmlFor="pcsk9i">{MEDICATION_TEXT.pcsk9iLabel}</label>
              <select
                id="pcsk9i"
                value={medInputs.pcsk9i || 'not_yet'}
                onChange={e => writeMedication(medInputs, cascadeMode, 'pcsk9i', e.target.value)}
              >
                {optionElements(optionsShowing(PCSK9I_OPTIONS, medInputs.pcsk9i || 'not_yet'))}
              </select>
            </div>
          );

          const bempedoicAcidDropdown = (
            <div className="health-field">
              <label htmlFor="bempedoic-acid">{MEDICATION_TEXT.bempedoicAcidLabel}</label>
              <select
                id="bempedoic-acid"
                value={medInputs.bempedoicAcid || 'not_yet'}
                onChange={e => writeMedication(medInputs, cascadeMode, 'bempedoic_acid', e.target.value)}
              >
                {optionElements(optionsShowing(BEMPEDOIC_ACID_OPTIONS, medInputs.bempedoicAcid || 'not_yet'))}
              </select>
            </div>
          );

          const neutral = MEDICATION_TEXT.lipidNeutral;

          // ── Flat mode: all fields visible independently (no cascade gating) ──
          if (!cascadeMode) {
            return (
              <div className="section-card">
                <section className="health-section">
                  <h3 className="health-section-title">{MEDICATION_TEXT.lipidTitle}</h3>
                  <p className="health-section-desc">{neutral}</p>
                  {statinDropdown}
                  {ezetimibeDropdown}
                  {bempedoicAcidDropdown}
                  {pcsk9iDropdown}
                </section>
              </div>
            );
          }

          // ── Cascade mode: progressive disclosure, the plan's own steps ──
          // Progressive disclosure opens the plan's next step; a step that
          // holds a recorded value always shows (US-06 AC7).
          const lipidName = lipidMarker.label;
          const step = cascade.escalation;
          const showEscalation = !!step || medInputs.statinEscalation !== undefined;
          const introText = lipidTargetSentence(lipidMarker, (metric) => fieldUnit(METRIC_TO_FIELD[metric]));

          return (
            <div className="section-card">
            <section className="health-section medication-cascade">
              <h3 className="health-section-title">{MEDICATION_TEXT.lipidTitle}</h3>
              <p className="health-section-desc">
                {/* It recommends only while the plan shows a step's card: with every
                    step answered the marker stays elevated and the plan shows none. */}
                {cascade.suggest.length === 0 ? neutral : `${introText} ${LIPID_DIET_ADVICE} Medications can also be added in steps.`}
              </p>

              {statinDropdown}

              {(cascade.ezetimibeReached || medInputs.ezetimibe !== undefined) && (
                <div className="med-step-enter">
                  <p className="med-step-hint">{MEDICATION_TEXT.ezetimibeHint(lipidName)}</p>
                  {ezetimibeDropdown}
                </div>
              )}

              {(cascade.bempedoicAcidReached || medInputs.bempedoicAcid !== undefined) && (
                <div className="med-step-enter">
                  <p className="med-step-hint">{MEDICATION_TEXT.bempedoicAcidHint}</p>
                  {bempedoicAcidDropdown}
                </div>
              )}

              {showEscalation && (
                <div className="health-field med-step-enter">
                  <label htmlFor="statin-escalation">
                    {step ? MEDICATION_TEXT.statinEscalationLabel[step] : MEDICATION_TEXT.escalationRecorded}
                  </label>
                  {step && (
                    <p className="med-step-hint">
                      {MEDICATION_TEXT.statinEscalationHint[step](lipidName)}
                    </p>
                  )}
                  <select
                    id="statin-escalation"
                    value={medInputs.statinEscalation || 'not_yet'}
                    onChange={e => writeMedication(medInputs, cascadeMode, 'statin_escalation', e.target.value)}
                  >
                    {optionElements(optionsShowing(escalationOptions(step), medInputs.statinEscalation || 'not_yet'))}
                  </select>
                </div>
              )}

              {(cascade.pcsk9iReached || medInputs.pcsk9i !== undefined) && (
                <div className="med-step-enter">
                  <p className="med-step-hint">{MEDICATION_TEXT.pcsk9iHint(lipidName)}</p>
                  {pcsk9iDropdown}
                </div>
              )}
            </section>
            </div>
          );
        })()}

      {/* Weight & Diabetes Medications Section — recommends only when the plan's trigger is on (US-06 AC5) */}
      {(() => {
        const {
          weightKg: effectiveWeight, heightCm: effectiveHeight,
          hba1c: effectiveHba1c, triglycerides: effectiveTrigs,
        } = effectiveInputs;

        // Three modes: cascade (the plan's trigger is on), flat, hidden
        const weightMedTrigger = planBasis?.weightMedTrigger;
        const weightCascadeMode = !!weightMedTrigger?.on;

        // Flat mode: any relevant input entered but no cascade trigger
        const hasAnyWeightInput = effectiveHba1c !== undefined || effectiveTrigs !== undefined
          || (effectiveWeight !== undefined && effectiveHeight !== undefined);

        if (!weightCascadeMode && !hasAnyWeightInput) return null;

        const medInputs = medicationsToInputs(medications);
        const cascade = weightCascade(medInputs);

        const glp1Drug = medInputs.glp1?.drug ?? 'none';
        const glp1Dose = medInputs.glp1?.dose ?? null;
        const availableGlp1Doses = GLP1_DRUGS[glp1Drug]?.doses ?? [];
        const sglt2iDrug = medInputs.sglt2i?.drug ?? 'none';
        const sglt2iDose = medInputs.sglt2i?.dose ?? null;
        const availableSglt2iDoses = SGLT2I_DRUGS[sglt2iDrug]?.doses ?? [];

        // ── Shared medication dropdowns ──

        const glp1Dropdown = (
          <div className="health-field">
            <label htmlFor="glp1-name">{MEDICATION_TEXT.glp1Label}</label>
            {weightCascadeMode && <p className="med-step-hint">{cascade.suggest.includes('glp1-dose') ? MEDICATION_TEXT.doseHint : MEDICATION_TEXT.glp1Hint}</p>}
            <div className="statin-selection-row">
              <select
                id="glp1-name"
                value={glp1Drug}
                onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'glp1', e.target.value)}
              >
                {optionElements(optionsShowing(GLP1_NAMES, glp1Drug))}
              </select>
              {availableGlp1Doses.length > 0 && (
                <select
                  id="glp1-dose"
                  value={glp1Dose ?? ''}
                  onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'glp1_dose', e.target.value)}
                >
                  {optionElements(optionsShowing(doseOptions(availableGlp1Doses), glp1Dose === null ? '' : String(glp1Dose), 'Add dose'))}
                </select>
              )}
            </div>
          </div>
        );

        const sglt2iDropdown = (
          <div className="health-field">
            <label htmlFor="sglt2i-name">{MEDICATION_TEXT.sglt2iLabel}</label>
            {weightCascadeMode && <p className="med-step-hint">{MEDICATION_TEXT.sglt2iHint}</p>}
            <div className="statin-selection-row">
              <select
                id="sglt2i-name"
                value={sglt2iDrug}
                onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'sglt2i', e.target.value)}
              >
                {optionElements(optionsShowing(SGLT2I_NAMES, sglt2iDrug))}
              </select>
              {availableSglt2iDoses.length > 0 && (
                <select
                  id="sglt2i-dose"
                  value={sglt2iDose ?? ''}
                  onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'sglt2i_dose', e.target.value)}
                >
                  {optionElements(optionsShowing(doseOptions(availableSglt2iDoses), sglt2iDose === null ? '' : String(sglt2iDose), 'Add dose'))}
                </select>
              )}
            </div>
          </div>
        );

        const metforminDropdown = (
          <div className="health-field">
            <label htmlFor="metformin">{MEDICATION_TEXT.metforminLabel}</label>
            {weightCascadeMode && <p className="med-step-hint">{MEDICATION_TEXT.metforminHint}</p>}
            <select
              id="metformin"
              value={medInputs.metformin || 'none'}
              onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'metformin', e.target.value)}
            >
              {optionElements(optionsShowing(METFORMIN_OPTIONS, medInputs.metformin || 'none'))}
            </select>
          </div>
        );

        const neutral = MEDICATION_TEXT.weightNeutral;

        // ── Flat mode: all fields visible independently ──
        if (!weightCascadeMode) {
          return (
            <div className="section-card">
              <section className="health-section">
                <h3 className="health-section-title">{MEDICATION_TEXT.weightTitle}</h3>
                <p className="health-section-desc">{neutral}</p>
                {glp1Dropdown}
                {sglt2iDropdown}
                {metforminDropdown}
              </section>
            </div>
          );
        }

        // ── Cascade mode: progressive disclosure, the plan's own steps and words ──
        // Progressive disclosure opens the plan's next step; a step that
        // holds a recorded value always shows (US-06 AC7).
        const step = cascade.escalation;
        const showEscalation = !!step || medInputs.glp1Escalation !== undefined;

        return (
          <div className="section-card">
          <section className="health-section medication-cascade">
            <h3 className="health-section-title">{MEDICATION_TEXT.weightTitle}</h3>
            <p className="health-section-desc">
              {/* It recommends only while the plan shows a step's card: with every
                  step answered the trigger stays on and the plan shows none. */}
              {cascade.suggest.length === 0 ? neutral : weightMedIntro(planBasis!.bmi!, weightMedTrigger.reasons)}
            </p>

            {glp1Dropdown}

            {showEscalation && (
              <div className="health-field med-step-enter">
                <label htmlFor="glp1-escalation">
                  {step ? MEDICATION_TEXT.glp1EscalationLabel[step] : MEDICATION_TEXT.escalationRecorded}
                </label>
                {step && (
                  <p className="med-step-hint">
                    {MEDICATION_TEXT.glp1EscalationHint[step]}
                  </p>
                )}
                <select
                  id="glp1-escalation"
                  value={medInputs.glp1Escalation || 'not_yet'}
                  onChange={e => writeMedication(medInputs, weightCascadeMode, 'glp1_escalation', e.target.value)}
                >
                  {optionElements(optionsShowing(escalationOptions(step), medInputs.glp1Escalation || 'not_yet'))}
                </select>
              </div>
            )}

            {(cascade.sglt2iReached || medInputs.sglt2i !== undefined) && (
              <div className="med-step-enter">
                {sglt2iDropdown}
              </div>
            )}

            {(cascade.metforminReached || medInputs.metformin !== undefined) && (
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
        // The plan's age, from the validated birth year (January when no month)
        const age = planBasis?.age;
        if (age === undefined) return null;

        const sex = inputs.sex;
        const scr = screeningsToInputs(screenings);

        /** Render result dropdown + follow-up status + follow-up date for a screening type. */
        const renderResultFollowup = (type: string, method: string | undefined) => {
          if (!readScreening(scr, `${type}_last_date`)) return null;

          const result = readScreening(scr, `${type}_result`);
          const followupStatus = readScreening(scr, `${type}_followup_status`);
          const name = followupName(type, method);
          const followupLabel = name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Follow-up';

          return (
            <>
              <div className="health-field">
                <label htmlFor={`${type}-result`}>{SCREENING_LABELS.result}</label>
                <select
                  id={`${type}-result`}
                  value={result}
                  onChange={(e) => writeScreening(scr, `${type}_result`, e.target.value)}
                >
                  {optionElements(SCREENING_OPTIONS.result)}
                </select>
              </div>

              {result === 'abnormal' && (
                <div className="health-field">
                  <label htmlFor={`${type}-followup-status`}>{followupLabel} status</label>
                  <select
                    id={`${type}-followup-status`}
                    value={followupStatus}
                    onChange={(e) => writeScreening(scr, `${type}_followup_status`, e.target.value)}
                  >
                    {optionElements(SCREENING_OPTIONS.followup_status)}
                  </select>
                </div>
              )}

              {result === 'abnormal' && (followupStatus === 'scheduled' || followupStatus === 'completed') && (
                renderScreeningDateInput(scr,
                  `${type}_followup_date`,
                  followupDateLabel(name, followupStatus),
                  { futureOnly: followupStatus === 'scheduled' }
                )
              )}
            </>
          );
        };

        if (!anyScreeningEligible(age, sex)) return null;

        return (
          <div className="section-card">
          <section className="health-section screening-cascade">
            <h3 className="health-section-title">{SCREENING_TEXT.title}</h3>
            <p className="health-section-desc">
              {SCREENING_TEXT.intro}
            </p>

            {/* Colorectal (age 35-85, all genders) */}
            {age >= 35 && age <= 85 && (
              <div className="screening-group">
                <h4>Colorectal</h4>
                {age < 45 && (
                  <div className="screening-notice">
                    {SCREENING_TEXT.colorectalEarly}
                  </div>
                )}

                {age <= 75 ? (
                  <>
                    <div className="health-field">
                      <label htmlFor="colorectal-method">{SCREENING_LABELS.method}</label>
                      <select
                        id="colorectal-method"
                        value={readScreening(scr, 'colorectal_method')}
                        onChange={(e) => writeScreening(scr, 'colorectal_method', e.target.value)}
                      >
                        {optionElements(SCREENING_OPTIONS.colorectal_method)}
                      </select>
                    </div>

                    {readScreening(scr, 'colorectal_method') && readScreening(scr, 'colorectal_method') !== 'not_yet_started' && (
                      <>
                        {renderScreeningDateInput(scr, 'colorectal_last_date', SCREENING_LABELS.lastScreening)}
                        {renderResultFollowup('colorectal', readScreening(scr, 'colorectal_method'))}
                      </>
                    )}
                  </>
                ) : (
                  <p className="screening-age-message">
                    {SCREENING_TEXT.colorectalIndividual}
                  </p>
                )}
              </div>
            )}

            {/* Breast (female, age 40+) */}
            {sex === 'female' && age >= 40 && (
              <div className="screening-group">
                <h4>Breast</h4>
                <p className="screening-age-message">
                  {SCREENING_TEXT.breastByAge(age)}
                </p>

                <div className="health-field">
                  <label htmlFor="breast-frequency">{SCREENING_LABELS.frequency}</label>
                  <select
                    id="breast-frequency"
                    value={readScreening(scr, 'breast_frequency')}
                    onChange={(e) => writeScreening(scr, 'breast_frequency', e.target.value)}
                  >
                    {optionElements(SCREENING_OPTIONS.breast_frequency)}
                  </select>
                </div>

                {readScreening(scr, 'breast_frequency') && readScreening(scr, 'breast_frequency') !== 'not_yet_started' && (
                  <>
                    {renderScreeningDateInput(scr, 'breast_last_date', SCREENING_LABELS.lastMammogram)}
                    {renderResultFollowup('breast', readScreening(scr, 'breast_frequency'))}
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
                      <label htmlFor="cervical-method">{SCREENING_LABELS.method}</label>
                      <select
                        id="cervical-method"
                        value={readScreening(scr, 'cervical_method')}
                        onChange={(e) => writeScreening(scr, 'cervical_method', e.target.value)}
                      >
                        {optionElements(SCREENING_OPTIONS.cervical_method)}
                      </select>
                    </div>

                    {readScreening(scr, 'cervical_method') && readScreening(scr, 'cervical_method') !== 'not_yet_started' && (
                      <>
                        {renderScreeningDateInput(scr, 'cervical_last_date', SCREENING_LABELS.lastScreening)}
                        {renderResultFollowup('cervical', readScreening(scr, 'cervical_method'))}
                      </>
                    )}
                  </>
                ) : (
                  <p className="screening-age-message">
                    {SCREENING_TEXT.cervicalStop}
                  </p>
                )}
              </div>
            )}

            {/* Lung (age 50-80, all genders) */}
            {age >= 50 && age <= 80 && (
              <div className="screening-group">
                <h4>Lung</h4>

                <div className="health-field">
                  <label htmlFor="lung-smoking-history">{SCREENING_LABELS.smokingHistory}</label>
                  <select
                    id="lung-smoking-history"
                    value={readScreening(scr, 'lung_smoking_history')}
                    onChange={(e) => writeScreening(scr, 'lung_smoking_history', e.target.value)}
                  >
                    {optionElements(SCREENING_OPTIONS.lung_smoking_history)}
                  </select>
                </div>

                {(readScreening(scr, 'lung_smoking_history') === 'former_smoker' || readScreening(scr, 'lung_smoking_history') === 'current_smoker') && (
                  <>
                    <div className="health-field">
                      <label htmlFor="lung-pack-years">{SCREENING_TEXT.packYearsLabel}</label>
                      <input
                        type="number"
                        id="lung-pack-years"
                        onKeyDown={blockNonIntegerKeys}
                        onWheel={blurOnWheel}
                        value={scr.lungPackYears ?? ''}
                        onChange={(e) => { if (readable('lung_pack_years', e)) onScreeningChange('lung_pack_years', e.target.value); }}
                        placeholder=""
                        min="0"
                        max="200"
                        step="1"
                      />
                      {unreadable.lung_pack_years && <span className="field-error">Enter a number</span>}
                      <span className="field-hint">{SCREENING_TEXT.packYearsHint}</span>
                    </div>

                    {scr.lungPackYears !== undefined && scr.lungPackYears >= 20 && (
                      <>
                        <div className="health-field">
                          <label htmlFor="lung-screening">{SCREENING_LABELS.lungScreening}</label>
                          <select
                            id="lung-screening"
                            value={readScreening(scr, 'lung_screening')}
                            onChange={(e) => writeScreening(scr, 'lung_screening', e.target.value)}
                          >
                            {optionElements(SCREENING_OPTIONS.lung_screening)}
                          </select>
                        </div>

                        {readScreening(scr, 'lung_screening') === 'annual_ldct' && (
                          <>
                            {renderScreeningDateInput(scr, 'lung_last_date', SCREENING_LABELS.lastLdct)}
                            {renderResultFollowup('lung', readScreening(scr, 'lung_screening'))}
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
                  {SCREENING_TEXT.prostateByAge(age)}
                </p>

                <div className="health-field">
                  <label htmlFor="prostate-discussion">{SCREENING_LABELS.prostateDiscussion}</label>
                  <select
                    id="prostate-discussion"
                    value={readScreening(scr, 'prostate_discussion')}
                    onChange={(e) => writeScreening(scr, 'prostate_discussion', e.target.value)}
                  >
                    {optionElements(SCREENING_OPTIONS.prostate_discussion)}
                  </select>
                </div>

                {readScreening(scr, 'prostate_discussion') === 'will_screen' && (
                  <>
                    {/* PSA input with inline date picker */}
                    {(() => {
                      const psaMeasurement = previousMeasurements.find(m => m.metricType === 'psa');
                      const psaPreviousLabel = psaMeasurement
                        ? `${psaMeasurement.value.toFixed(1)} ng/mL · ${formatShortDate(psaMeasurement.recordedAt)}`
                        : null;

                      return (
                        <div className="health-field">
                          <label htmlFor="psa-input">{SCREENING_TEXT.psaLabel}</label>
                          <div className="psa-inline-row">
                            <input
                              type="number"
                              id="psa-input"
                              onWheel={blurOnWheel}
                              value={rawInputs.psa ?? (inputs.psa !== undefined ? String(inputs.psa) : '')}
                              onChange={(e) => {
                                const val = e.target.value;
                                setRawInputs(prev => ({ ...prev, psa: val }));
                                if (!readable('psa', e)) return;
                                if (val === '') {
                                  updateField('psa', undefined);
                                } else {
                                  const num = parseLocalisedNumber(val);
                                  if (num !== undefined) updateField('psa', num);
                                }
                              }}
                              onBlur={() => {
                                if (unreadable.psa) return;
                                setRawInputs(prev => { const next = { ...prev }; delete next.psa; return next; });
                                validateOnBlur('psa');
                                autoSaveOnBlur();
                              }}
                              onKeyDown={onNumericEnter}
                              placeholder=""
                              step="0.1"
                              min={range('psa').min}
                              max={range('psa').max}
                              className={errors.psa ? 'error' : ''}
                            />
                            <InlineDatePicker value={psaDate} onChange={setPsaDate} />
                            {autoSaveGate && inputs.psa !== undefined && (
                              <CommitTickButton ariaLabel="Save PSA" onClick={flushLongitudinalSave}/>
                            )}
                          </div>
                          {(unreadable.psa || errors.psa) && <span className="field-error">{unreadable.psa ? 'Enter a number' : errors.psa}</span>}
                          <div className="field-meta">
                            <span className="field-hint">{SCREENING_TEXT.psaHint}</span>
                            {psaPreviousLabel && (
                              <a
                                className="previous-value"
                                href="#health-history"
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
                  <label htmlFor="endometrial-discussion">{SCREENING_LABELS.endometrialDiscussion}</label>
                  <select
                    id="endometrial-discussion"
                    value={readScreening(scr, 'endometrial_discussion')}
                    onChange={(e) => writeScreening(scr, 'endometrial_discussion', e.target.value)}
                  >
                    {optionElements(SCREENING_OPTIONS.endometrial_discussion)}
                  </select>
                </div>

                <div className="health-field">
                  <label htmlFor="endometrial-bleeding">{SCREENING_LABELS.endometrialBleeding}</label>
                  <select
                    id="endometrial-bleeding"
                    value={readScreening(scr, 'endometrial_abnormal_bleeding')}
                    onChange={(e) => writeScreening(scr, 'endometrial_abnormal_bleeding', e.target.value)}
                  >
                    {optionElements(SCREENING_OPTIONS.endometrial_abnormal_bleeding)}
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
        const age = planBasis?.age;
        if (age === undefined) return null;

        const sex = inputs.sex;
        if (!dexaEligible(age, sex)) return null;

        const scr = screeningsToInputs(screenings);

        const dexaScreening = readScreening(scr, 'dexa_screening');
        const dexaResult = readScreening(scr, 'dexa_result');
        const followupStatus = readScreening(scr, 'dexa_followup_status');

        return (
          <div className="section-card">
          <section className="health-section screening-cascade">
            <h3 className="health-section-title">{SCREENING_TEXT.boneTitle}</h3>
            <p className="health-section-desc">
              {SCREENING_TEXT.boneIntro}
            </p>

            <div className="screening-group">
              <div className="health-field">
                <label htmlFor="dexa-screening">{SCREENING_LABELS.dexaScreening}</label>
                <select
                  id="dexa-screening"
                  value={dexaScreening}
                  onChange={(e) => writeScreening(scr, 'dexa_screening', e.target.value)}
                >
                  {optionElements(SCREENING_OPTIONS.dexa_screening)}
                </select>
              </div>

              {dexaScreening === 'dexa_scan' && (
                <>
                  {renderScreeningDateInput(scr, 'dexa_last_date', SCREENING_LABELS.lastDexa)}

                  {readScreening(scr, 'dexa_last_date') && (
                    <div className="health-field">
                      <label htmlFor="dexa-result">{SCREENING_LABELS.result}</label>
                      <select
                        id="dexa-result"
                        value={dexaResult}
                        onChange={(e) => writeScreening(scr, 'dexa_result', e.target.value)}
                      >
                        {optionElements(SCREENING_OPTIONS.dexa_result)}
                      </select>
                    </div>
                  )}

                  {dexaResult === 'osteoporosis' && (
                    <div className="health-field">
                      <label htmlFor="dexa-followup-status">{SCREENING_LABELS.dexaFollowupStatus}</label>
                      <select
                        id="dexa-followup-status"
                        value={followupStatus}
                        onChange={(e) => writeScreening(scr, 'dexa_followup_status', e.target.value)}
                      >
                        {optionElements(SCREENING_OPTIONS.followup_status)}
                      </select>
                    </div>
                  )}

                  {dexaResult === 'osteoporosis' && (followupStatus === 'scheduled' || followupStatus === 'completed') && (
                    renderScreeningDateInput(scr,
                      'dexa_followup_date',
                      followupDateLabel('treatment review', followupStatus),
                      { futureOnly: followupStatus === 'scheduled' }
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
  const [supplementDoseDrafts, setSupplementDoseDrafts] = useState<Record<string, string | undefined>>({});
  const [showSupplementDropdown, setShowSupplementDropdown] = useState(false);
  const supplementDropdownRef = useRef<HTMLDivElement>(null);

  // An erase clears off-file drafts too, including one under a later reused key.
  useEffect(() => {
    const drop = () => setSupplementDoseDrafts({});
    window.addEventListener(DRAFTS_CLEARED_EVENT, drop);
    return () => window.removeEventListener(DRAFTS_CLEARED_EVENT, drop);
  }, []);

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

    const activeSupplements = supplements.filter(s => s.status === 'active');
    const allOptions = SUPPLEMENT_OPTIONS.filter(
      opt => !activeSupplements.some(s => s.supplementKey === opt.key),
    );
    const filteredOptions = supplementSearch
      ? allOptions.filter(opt => opt.name.toLowerCase().includes(supplementSearch.toLowerCase()))
      : allOptions;
    const trimmedSearch = supplementSearch.trim();
    // A typed name with no exact preset match can always be added as a custom
    // supplement — this must NOT be gated on filteredOptions having matches, or
    // a supplement matching no preset can never be added.
    // A name already taken is hidden too, as a preset is: re-adding it would clear its dose (US-06 AC1a).
    const canAddCustomSupplement = !!trimmedSearch
      && !allOptions.some(o => o.name.toLowerCase() === trimmedSearch.toLowerCase())
      && customSupplementMatch(trimmedSearch, supplements)?.status !== 'active';

    const addSupplement = (key: string, name: string, defaultDose?: number, defaultUnit?: string) => {
      setSupplementDoseDrafts(prev => ({ ...prev, [key]: undefined }));
      onSupplementChange(key, name, defaultDose ?? null, defaultUnit ?? null);
      setSupplementSearch('');
      setShowSupplementDropdown(false);
    };

    return (
      <div className="section-card">
        <section className="health-section">
          <h3 className="health-section-title">{SUPPLEMENT_TEXT.title}</h3>
          <p className="health-section-desc">{SUPPLEMENT_TEXT.intro}</p>

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
            <Fragment key={s.supplementKey}>
              <div className="supplement-row">
                <span className="supplement-name">{s.supplementName}</span>
                <input
                  type="number"
                  className="supplement-dose"
                  placeholder="Dose"
                  min={Number.MIN_VALUE}
                  max={99999}
                  step="any"
                  onKeyDown={blockBadNumericKeys}
                  value={supplementDoseDrafts[s.supplementKey] ?? s.doseValue ?? ''}
                  aria-invalid={supplementDoseDrafts[s.supplementKey] !== undefined || undefined}
                  aria-describedby={supplementDoseDrafts[s.supplementKey] !== undefined ? `supplement-dose-error-${s.supplementKey}` : undefined}
                  onChange={e => {
                    const raw = e.target.value;
                    const val = raw ? parseLocalisedNumber(raw) ?? null : null;
                    // Autosave bypasses native form validation. Keep invalid drafts
                    // out of the accepted row, including badInput's empty value.
                    const invalid = e.target.validity.badInput || (raw !== '' && (val === null || val <= 0 || val > 99999));
                    setSupplementDoseDrafts(prev => ({ ...prev, [s.supplementKey]: invalid ? raw : undefined }));
                    if (invalid) return;
                    onSupplementChange(s.supplementKey, s.supplementName, val, s.doseUnit);
                  }}
                />
                <select
                  className="supplement-unit"
                  value={s.doseUnit ?? ''}
                  onChange={e => onSupplementChange(s.supplementKey, s.supplementName, s.doseValue, e.target.value || null)}
                >
                  <option value="">Unit</option>
                  {SUPPLEMENT_DOSE_UNITS.map(unit => <option key={unit} value={unit}>{unit}</option>)}
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
              {supplementDoseDrafts[s.supplementKey] !== undefined && (
                <span className="error-message" id={`supplement-dose-error-${s.supplementKey}`} role="alert">Enter a dose greater than 0 and no more than 99999. This dose was not saved.</span>
              )}
            </Fragment>
          ))}

          {/* Add other supplement */}
          <div className="supplement-add" ref={supplementDropdownRef}>
            <input
              type="text"
              placeholder={SUPPLEMENT_TEXT.addPlaceholder}
              value={supplementSearch}
              maxLength={100}
              onFocus={() => setShowSupplementDropdown(true)}
              onChange={e => {
                setSupplementSearch(e.target.value);
                setShowSupplementDropdown(true);
              }}
            />
            {showSupplementDropdown && (filteredOptions.length > 0 || canAddCustomSupplement) && (
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
                {canAddCustomSupplement && (
                  <button
                    type="button"
                    className="supplement-dropdown-item supplement-custom"
                    onClick={() => {
                      const { supplementKey, supplementName } = customSupplementAdd(trimmedSearch, supplements);
                      addSupplement(supplementKey, supplementName);
                    }}
                  >
                    + Add "{trimmedSearch}"
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
  const bloodTestGrids = (
    <>
      {renderBloodTests()}
      {move.panel}
      <AdditionalLabRows labValues={labValues} onAdded={onLabValueAdded} onCorrect={onCorrectValue} move={move.headers}/>
    </>
  );
  return (
    <div ref={panelRef} className={`health-input-panel${pageShown ? ' md-page-open' : ''}`}>
      {pageShown && (
        <ValuePage key={JSON.stringify(pageShown)} subject={pageShown} history={[...vitalsHistory, ...bloodTestHistory]} labValues={labValues}
                   ctx={rowCtx} onSave={onSaveBloodTestBatch} onCorrect={onCorrectValue} onLabAdded={onLabValueAdded} onClose={closePage} dirtyRef={pageDirty}/>
      )}
      <ColumnHeader step={1} title="Your information" meta={storageBar} actions={!!storageBar} />
      {panelMessages}
      {/* Card 1: the profile (the onboarding's questions until they are
          answered, US-62 AC13), then the vitals once the whole form shows.
          On a phone with the onboarding done, About you moves to the foot
          (US-62 AC12). */}
      <div className="section-card">
        {!aboutYouLow && renderProfile()}
        {fullForm && <div className="stage-reveal">{renderVitals()}</div>}
      </div>

      {/* Card 2: Blood Tests (the whole form). `section-card--bt` zeros the
          card's inner padding so the timeline matrix sits flush against
          the card edges (column-fit math expects no inner padding). On a
          phone, rows, with the grids one tap away (US-62 AC11). */}
      {fullForm && (
        <div className="section-card section-card--bt stage-reveal">
          {isPhone && !tableShown && (
            <BloodTestRows history={bloodTestHistory} labValues={labValues} ctx={rowCtx} onOpen={openPage}>
              {unsavedCue(draftedBlood)}
              <div className="md-foot">
                <button type="button" className="md-foot-btn" onClick={() => showTable(true)}>All results as a table</button>
                {setShowUploadModal && <button type="button" className="md-foot-btn" onClick={() => setShowUploadModal(true)}>Upload lab results</button>}
              </div>
            </BloodTestRows>
          )}
          {isPhone ? (
            <div className="md-table" hidden={!tableShown}>
              <button type="button" className="md-back md-table-back" onClick={() => showTable(false)}>‹ Show as rows</button>
              {bloodTestGrids}
            </div>
          ) : bloodTestGrids}
        </div>
      )}

      {fullForm && renderMedications()}
      {fullForm && renderScreening()}
      {fullForm && renderBoneDensity()}
      {fullForm && renderSupplements()}
      {aboutYouLow && (
        <div className="section-card md-about-you">
          {renderProfile()}
        </div>
      )}
      {healthDocuments && healthDocuments.length > 0 && (
        <HealthRecordsSection documents={healthDocuments} onDeleted={onDocumentDeleted} />
      )}
      {/* US-09 AC5: once a value exists: height and weight, or a saved blood test. */}
      {(formStage >= 2 || fullForm) && <StorageNotice surface="input" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health Records (scan results, clinic letters, etc.) — raw data display
// ---------------------------------------------------------------------------

function HealthRecordsSection({ documents, onDeleted }: { documents: ApiDocument[]; onDeleted?: (docId: string) => void }) {
  const [selectedDoc, setSelectedDoc] = useState<ApiDocument | null>(null);

  // Blood-test reports are persisted to the user's cloud but never listed here —
  // their extracted values already appear in the Blood Test Results table.
  const visible = documents.filter(d => !isLabArchiveDocument(d));
  const scanResults = visible.filter(d => d.documentType === 'scan_result');
  const otherDocs = visible.filter(d => d.documentType !== 'scan_result');

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
