// The form: the onboarding's questions and About you, the vitals, the blood-test
// grids, the medicine, screening and supplement questions, and the value pages'
// state. My health (MyHealth.tsx, US-62 phase 5) lays its parts out by topic,
// through the slots this hands its `children`.
import { SectionIcon } from './icons';
import { Fragment, useState, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { InfoTooltip } from './InfoTooltip';
import { openHistoryLightbox } from '../lib/roadmap-data';
import { SEXES } from '@roadmap/health-core';
import type { CorrectFn, Refused, SaveTask } from '../lib/matrix-save';
import { blockBadNumericKeys, blockNonIntegerKeys, bpSysAdvance, mayStillFit, type Grading } from '../lib/blood-test-cell';
import { useRangeWait } from '../lib/useRangeWait';
import type { ApiLabValue, ApiSupplement } from '../lib/api-types';
import { DRAFTS_CLEARED_EVENT, loadFromLocalStorage } from '../lib/storage';

/** Every surface opens metric history in the local lightbox. */
const interceptHistory = (metric: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
  if (openHistoryLightbox(metric)) e.preventDefault();
};
import type { FormStage, HealthInputs, HealthResults, ScreeningInputs, WeightMedicationTrigger, LipidMarker } from '@roadmap/health-core';
import {
  type UnitSystem,
  fromCanonicalValue,
  toCanonicalValue,
  getDisplayLabel,
  getDisplayRange,
  identityFieldRange,
  UNIT_DEFS,
  hasUnitChoice,
  FIELD_METRIC_MAP,
  medicationsToInputs,
  screeningsToInputs,
  type ApiMeasurement,
  formatValue,
  formatGradedOrLimit,
  type ApiMedication,
  type ApiScreening,
  STATIN_NAMES,
  STATIN_DRUGS,
  EZETIMIBE_OPTIONS,
  PCSK9I_OPTIONS,
  BEMPEDOIC_ACID_OPTIONS,
  SUPPLEMENT_OPTIONS,
  cmToFeetInches,
  feetInchesToCm,
  formatHeightDisplay,
  GLP1_NAMES,
  GLP1_DRUGS,
  weightCascade,
  lipidCascade,
  LIPID_MEDS_IN_STEPS,
  lipidTargetSentence,
  weightMedIntro,
  bpTargetFor,
  METRIC_TO_FIELD,
  VITAL_METRICS,
  SGLT2I_NAMES,
  SGLT2I_DRUGS,
  METFORMIN_OPTIONS,
  isBirthYearClearlyInvalid,
  parseLocalisedNumber,
  dayOf,
  newestUsablePsa,
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
  lungGroupShown,
  lungScreeningAsked,
  customSupplementAdd,
  customSupplementMatch,
  type FormOption,
  type MedicationInputs,
} from '@roadmap/health-core';
import { formatShortDate, MONTHS_FULL } from '../lib/constants';
import { BloodTestTimeline, useLiveRegion, type BloodTestPrefillFn } from './BloodTestTimeline';
import { AdditionalLabRows } from './AdditionalLabRows';
import { useMoveTest, type MoveTestApi } from './MoveTestPanel';
import { StartingInfoVitals, type VitalsPrefillFn } from './StartingInfoVitals';
import { CommitTickButton } from './CommitTickButton';
import { ALCOHOL_OPTIONS } from './AlcoholQuestion';
import { useLpaUnit } from '../lib/lpa-unit';
import { type RowContext, type ValueSubject } from './MyDataRows';
import { ValuePage } from './ValuePage';
import { AddLabTest } from './AddLabTest';
import type { FormSlots, Placement } from './MyHealth';
import { scrollToTop } from '../lib/reveal';

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
/** About you's rows (US-62 AC12). */
type AboutKey = 'height' | 'sex' | 'birth' | 'alcohol';
const BASIC_LONGITUDINAL_FIELDS: FieldConfig[] = [
  WEIGHT_FIELD,
  { field: 'waistCm', name: 'Waist Circumference' },
];

/** Option data (health-core's input-form) as <option> elements. */
const optionElements = (options: FormOption[]) =>
  options.map(opt => <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>);

/** What a screening's month and year pickers show: a date still being picked
 *  (year or month blank, but not both, so nothing is saved yet) as picked,
 *  else the saved date. A finished pick has just written it, and clearing
 *  both has just cleared it. A cleared or changed answer then shows as the
 *  record holds it, not as last picked (US-06 AC16). */
function shownDate(
  picking: { year: string; month: string } | undefined, savedYear: string | undefined, savedMonth: string | undefined,
): { year: string; month: string } {
  return picking && !picking.year !== !picking.month ? picking : { year: savedYear ?? '', month: savedMonth ?? '' };
}

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
  /** My health, laid out from the form's parts (US-62 phase 5). */
  children: (form: FormSlots) => ReactNode;
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
  /** The PSA's day, YYYY-MM-DD (US-06 AC15): null until picked, today shows meanwhile. */
  psaDate: string | null;
  onPsaDateChange: (day: string) => void;
  /** The PSA row is committed (US-06 AC15): saved soon when left, at once on its tick or Enter. */
  onPsaCommit: (now: boolean) => void;
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
  /** The highest stage reached on this record: what is unlocked stays (US-62 AC13). */
  reached: FormStage;
  /** The whole form shows: the onboarding was done, or the record holds more than its answers. */
  fullForm: boolean;
  /** About you is its own card of rows at the column's foot (US-62 AC12): a
   *  returning user's, or once the onboarding's answers are in and left. */
  aboutYouLow: boolean;
  /** The focus left the Starting Info card: HealthTool moves About you low if all four answers hold. */
  onProfileLeft?: () => void;
  setShowUploadModal?: (show: boolean) => void;
  /** What the plan was computed from. Null until there is a plan (no valid
   *  sex or height). */
  planBasis: PlanBasis | null;
  /** Whom the blood tests' hints and colours grade for. Null for a known minor
   *  by the validated birth info, plan or no plan: the form withholds its
   *  adult targets, hints and colours (US-07 AC6). */
  grading: Grading;
  /** The last onboarding answer is in: land at My health's top. Says whether it did (US-62 AC13, AC25). */
  onOnboardingDone?: (fromBirth?: boolean) => boolean;
  /** A chat edit that filled a grid cell (US-16 AC2): the table opens so the
   *  filled cell shows, phone and desktop. Each new edit is a new object. */
  revealCell?: { field: string; grid: boolean } | null;
}

/** A height for the feet and inches boxes to show: one there is, and not the
 *  one they just wrote themselves (US-02 AC11). */
function showsOtherHeight(heightCm: number | undefined, typed: number | undefined): heightCm is number {
  return heightCm !== undefined && heightCm !== typed;
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
  children, inputs, effectiveInputs, onChange: updateField, errors: allErrors, unitSystem, onUnitSystemChange,
  unitOverrides, onToggleFieldUnit,
  previousMeasurements, bloodTestHistory, vitalsHistory, labValues, onLabValueAdded, onSaveBloodTestBatch,
  onCorrectValue, moveTest, onDraftValue,
  medications, onMedicationChange,
  screenings, onScreeningChange, psaDate, onPsaDateChange, onPsaCommit,
  supplements, onSupplementChange, onSupplementDelete,
  scheduleLongitudinalSave, flushLongitudinalSave,
  isSavingLongitudinal, fieldsSaved, hasApiResponse,
  bloodTestFlushRef, vitalsFlushRef, bloodTestPrefillRef, vitalsPrefillRef,
  formStage, reached, fullForm, aboutYouLow, onProfileLeft,
  setShowUploadModal, planBasis, grading,
  onOnboardingDone, revealCell = null,
}: InputPanelProps) {
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
  const hasLandedOnMyHealth = useRef(false);
  // The birth year's jump (Brad 2026-11-02): once per record, as the weight's is once.
  const yearJumped = useRef(false);
  // One auto-advance instance per TARGET, so a new keystroke on any source
  // field cancels a pending advance to that target.
  const advanceToWeight = useAutoAdvance();
  const advanceToMyHealth = useAutoAdvance();
  const advanceToDiastolic = useAutoAdvance();
  const focusById = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());
  // Shared keydown combos: numeric-only guard (US-02 AC4) + Enter-to-save.
  const onNumericEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { blockBadNumericKeys(e); settleOnEnter(e); autoSaveOnEnterKey(e); };
  const onIntegerEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { blockNonIntegerKeys(e); settleOnEnter(e); autoSaveOnEnterKey(e); };
  const settleOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') rangeWait.settle(); };
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
  // site does its own pre-work (raw-input cleanup) inline, then calls
  // autoSaveOnBlur(); onKeyDown is uniform. Enter also shows a held range error.
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

  // ── My data, phone and desktop (US-62 AC8-AC12) ──
  // Rows replace the grids, which stay mounted but hidden: their drafts, the
  // chat's prefill (US-16 AC2) and the save before an upload all keep working.
  // "All results as a table" shows them; so does a chat edit that filled one.
  const [lpaUnit] = useLpaUnit(unitSystem);
  const rowCtx = useMemo<RowContext>(() => ({
    grading,
    plan: planBasis,
    unitOf: m => (m === 'lpa' ? lpaUnit : unitOverrides[METRIC_TO_FIELD[m]] ?? unitSystem),
  }), [grading, planBasis, lpaUnit, unitOverrides, unitSystem]);
  const [valuePage, setValuePage] = useState<ValueSubject | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [seenReveal, setSeenReveal] = useState<{ field: string; grid: boolean } | null>(null);
  // A chat reveal closes the value page; only a filled grid cell opens the table (adversary R6).
  const revealing = !!revealCell && revealCell !== seenReveal;
  const tableShown = tableOpen || (revealing && revealCell.grid);
  const pageShown = !revealing ? valuePage : null;
  // A page is a history entry (a state marker, no URL change), so the phone's
  // back gesture closes it, and "‹ My data" goes back. Typed, unsaved Add
  // input is never dropped silently: leaving asks first. Back returns to the
  // row it opened from, scrolled and focused as it was.
  const cameFrom = useRef<{ el: Element | null; y: number }>({ el: null, y: 0 });
  const pageDirty = useRef(false);
  const onPageEntry = () => !!window.history.state?.[VALUE_PAGE_STATE];
  const mayLeave = () => !pageDirty.current || window.confirm(LEAVE_UNSAVED);
  // `from` is the row pressed: WebKit does not focus a button on a tap, so the active element is stale.
  const openPage = (subject: ValueSubject, from?: Element) => {
    cameFrom.current = { el: from ?? document.activeElement, y: window.scrollY };
    setSeenReveal(revealCell);
    setValuePage(subject);
    if (!onPageEntry()) window.history.pushState({ ...window.history.state, [VALUE_PAGE_STATE]: true }, '');
    scrollToTop(panelRef.current);
  };
  const finishClose = () => {
    pageDirty.current = false;
    setValuePage(null);
    requestAnimationFrame(() => {
      const { el, y } = cameFrom.current;
      if (el instanceof HTMLElement && el.isConnected) {
        el.scrollIntoView({ block: 'center' });
        el.focus({ preventScroll: true });
      } else window.scrollTo?.(0, y);
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
      // Settings cover the page: Back closes them (HealthTool), and the page keeps its entry.
      if (panelRef.current?.querySelector('.mh-page-host[hidden]')) {
        window.history.pushState({ ...window.history.state, [VALUE_PAGE_STATE]: true }, '');
        return;
      }
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
  // A chat edit closes any open page, so the field it filled shows (US-16 AC2):
  // the table opens only for a grid cell (adversary R6).
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
  // read the valid part, and an upload saves it first): where the grids sit
  // hidden under the rows, each card says so and opens the table
  // (US-62 AC11). Each grid reports what it keeps.
  const [draftedVitals, setDraftedVitals] = useState(false);
  const [draftedBlood, setDraftedBlood] = useState(false);
  const unsavedCue = (shown: boolean) => !tableShown && shown && (
    <button type="button" className="md-unsaved" onClick={() => showTable(true)}>Unsaved values: review</button>
  );
  const showTable = (open: boolean) => { setSeenReveal(revealCell); setTableOpen(open); };
  const panelRef = useRef<HTMLDivElement>(null);
  // A grid mounted hidden never scrolled to its newest column: do it on showing.
  useEffect(() => {
    if (!tableShown) return;
    panelRef.current?.querySelectorAll<HTMLElement>('.md-table .bt-timeline-scroll').forEach(el => { el.scrollLeft = el.scrollWidth; });
  }, [tableShown]);
  // About you sits low, as on the iPhone, phone and desktop (US-62 AC12): for
  // a record complete when first shown, and once the onboarding's four answers
  // hold and the focus leaves its card, never mid-typing. The card travels to
  // the foot (FLIP: each card measured before, then animated from there, by
  // transform only) while its rows fade in; the cards below slide up, so the
  // next card takes its place on screen. Reduced motion moves it at once.
  const aboutRef = useRef<HTMLDivElement>(null);
  // With About you low the person is in the returning layout, so the vitals
  // are rows. If the focus went into a first-time vitals field as the profile
  // card was left, or one holds a value not yet saved, the rows wait until
  // the focus leaves the vitals card: no field goes from under the cursor.
  const vitalsRef = useRef<HTMLDivElement>(null);
  const [vitalsLeft, setVitalsLeft] = useState(aboutYouLow);
  useEffect(() => {
    // An erase takes About you back to the top: the next record starts again (Codex R2, adversary R4).
    setVitalsLeft(aboutYouLow && !vitalsRef.current?.contains(document.activeElement));
    if (!aboutYouLow) { yearJumped.current = false; setAboutOpen(new Set()); }
  }, [aboutYouLow]);
  const vitalPending = (['weightKg', 'waistCm', 'systolicBp', 'diastolicBp'] as const).some(f => inputs[f] !== undefined);
  const vitalsAsRows = aboutYouLow && vitalsLeft && !vitalPending;
  const flipFrom = useRef<Map<Element, number> | null>(null);
  // A press inside the card is not leaving it: Safari gives a focusout with
  // no next target for a click on a button (Male, the unit pill) or on text.
  // Such a press leaves nothing focused, so the next press or focus outside
  // the card is the leaving (N4); focus back inside the card cancels it.
  const pressedInside = useRef(false);
  const leavePending = useRef(false);
  const leaveCard = () => {
    leavePending.current = false;
    if (formStage !== 4) return; // the move needs all four answers: measure only for it
    flipFrom.current = new Map([...(panelRef.current?.children ?? [])].map(el => [el, el.getBoundingClientRect().top]));
    onProfileLeft?.();
  };
  const leaveProfile = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (!e.relatedTarget && pressedInside.current) { leavePending.current = true; return; }
    leaveCard();
  };
  useEffect(() => {
    if (aboutYouLow) return;
    const outside = (e: Event) => {
      if (leavePending.current && !aboutRef.current?.contains(e.target as Node)) leaveCard();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
    };
  });
  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    if (!from || !aboutYouLow || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // The cards below ease out as they rise; About you eases in too, so its
    // first steps down are seen before it travels out of view.
    const rise = { duration: 400, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
    const travel = { duration: 450, easing: 'cubic-bezier(0.45, 0, 0.2, 1)' };
    for (const el of panelRef.current?.children ?? []) {
      const top = from.get(el);
      const dy = top === undefined ? 0 : top - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) el.animate?.([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], el === aboutRef.current ? travel : rise);
    }
    aboutRef.current?.querySelector('.prefill-fields-wrapper')?.animate?.([{ opacity: 0 }, { opacity: 1 }], travel);
  }, [aboutYouLow]);
  // Something is on record (height and weight, or more): the sex question and the storage notice (US-09 AC5).
  const valueShown = fullForm || reached >= 2;
  // The onboarding asks the weight beside the height (US-62 AC13). A weight
  // typed there stays there for this visit, so the whole form opening, or the
  // weight cleared to retype, never moves the field being typed in; the
  // first-time vitals then leave it out. Otherwise it joins the vitals when
  // the whole form opens, shown once, and sex sits beside the height.
  const weightShown = useRef(false);
  const weightTyped = useRef(false);
  if (weightShown.current && inputs.weightKg !== undefined) weightTyped.current = true;
  const weightInProfile = !aboutYouLow && (!fullForm || weightTyped.current);
  weightShown.current = weightInProfile;
  const sexInRow = fullForm && !weightInProfile;
  // Low, About you is rows, as on the iPhone (US-62 AC12): label left, value
  // right, a tap opens the field itself in the row's place. The onboarding's
  // boxes never turn into rows under someone typing. A missing or refused
  // answer opens its field, which stays open while it is typed in, until Done.
  const [aboutOpen, setAboutOpen] = useState<ReadonlySet<AboutKey>>(new Set());
  // The birth year's field, once shown, stays while the birth question does:
  // a year cleared to retype keeps its field, whatever the stage. The
  // question going (an erase) starts it again.
  const birthShown = fullForm || reached >= 3;
  const yearShown = useRef(false);
  yearShown.current = birthShown && (yearShown.current || !!(inputs.birthMonth || inputs.birthYear));

  // Feet/inches state for US height input
  const [heightFeet, setHeightFeet] = useState<string>('');
  const [heightInches, setHeightInches] = useState<string>('');
  // The height the feet and inches boxes last wrote (US-02 AC11).
  const typedHeightCm = useRef<number | undefined>(undefined);

  // Sync heightCm → feet/inches display when loading data or switching units,
  // never from the boxes' own edit, which keeps what was typed (US-02 AC11).
  useEffect(() => {
    if (unitSystem === 'conventional' && showsOtherHeight(inputs.heightCm, typedHeightCm.current)) {
      const { feet, inches } = cmToFeetInches(inputs.heightCm);
      setHeightFeet(String(feet));
      setHeightInches(String(inches));
    } else if (unitSystem === 'si') {
      // Clear feet/inches when switching to SI
      typedHeightCm.current = undefined;
      setHeightFeet('');
      setHeightInches('');
    }
  }, [inputs.heightCm, unitSystem]);

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
    if (!metric) return identityFieldRange(field) ?? { min: 0, max: 999 };
    return getDisplayRange(metric, fieldUnit(field));
  };

  // US-02 AC9: the field being typed in keeps its range error back while more
  // digits could still fix it ("19" on the way to 190); leaving the field or
  // pressing Enter shows it. Display only: what saves is unchanged.
  const rangeWait = useRangeWait();
  // Held only while the field still shows the text typed: a unit switch or a
  // chat fill shows another number, judged at once (N7). The feet and inches
  // pair reformats as it is typed, so it is held by key alone.
  const shownText = (field: string) => field === 'heightCm' && unitSystem !== 'si'
    ? undefined
    : rawInputs[field] ?? String(inputs[field as keyof HealthInputs] ?? '');
  const errors = Object.fromEntries(Object.entries(allErrors).filter(([field]) => !rangeWait.waits(field, shownText(field))));
  const typeIn = (field: string, raw: string) => rangeWait.typed(field, raw, mayStillFit(raw, range(field).min, range(field).max));
  // Imperial height, feet then inches: could some inches still bring it in range ("1" may be 10 or 11)?
  // The feet box hands on to the inches box: only leaving the pair shows the error (Codex R2).
  const leaveHeightPair = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!['heightFeet', 'heightInches'].includes((e.relatedTarget as HTMLElement | null)?.id ?? '')) rangeWait.settle();
  };
  const heightMayFit = (feet: string, inches: string, inFeet: boolean) => {
    const { min, max } = getDisplayRange(FIELD_METRIC_MAP.heightCm!, 'si');
    const choices = inFeet || inches === '' ? [...Array(12).keys()] : inches === '1' ? [1, 10, 11] : [parseInt(inches, 10) || 0];
    return choices.some(i => { const cm = feetInchesToCm(parseInt(feet, 10) || 0, i); return cm >= min && cm <= max; });
  };

  /** A saved value as shown, a printed limit with its symbol (US-12 AC20). */
  const savedText = (field: string, m: ApiMeasurement): string => {
    const metric = FIELD_METRIC_MAP[field];
    return metric && m.comparator ? formatValue(metric, m.value, fieldUnit(field), m.comparator) : toDisplay(field, m.value);
  };

  const getPreviousPlaceholder = (field: string): string | undefined => {
    const metric = FIELD_METRIC_MAP[field];
    if (!metric) return undefined;
    const measurement = previousMeasurements.find(m => m.metricType === metric);
    if (!measurement) return undefined;
    return savedText(field, measurement);
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

    const { year: displayYear, month: displayMonth } = shownDate(dateInputs[key], savedYear, savedMonth);

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

  /** `box`: the onboarding's weight (US-62 AC13), a plain box like the
   *  height's beside it, holding the saved value; a number typed over it saves
   *  through the same path (one active row per day, US-03 AC3). */
  const renderLongitudinalField = (config: FieldConfig, box = false) => {
    const { field, name, step } = config;
    const effectiveHint = resolveHint(config);
    const r = range(field);
    const metric = FIELD_METRIC_MAP[field];
    const previous = metric && previousMeasurements.find(m => m.metricType === metric);
    const shown = metric && previous ? `${savedText(field, previous)} ${getDisplayLabel(metric, fieldUnit(field))}` : '';
    const previousLabel = previous && !box ? `${shown} · ${formatShortDate(previous.recordedAt)}` : null;
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
            value={rawInputs[field] !== undefined ? rawInputs[field] : toDisplay(field, (inputs[field] as number | undefined) ?? (box ? previous?.value : undefined))}
            onChange={(e) => {
              const raw = e.target.value;
              typeIn(field, raw);
              setRawInputs(prev => ({ ...prev, [field]: raw }));
              if (!readable(field, e)) return;
              // Ignore browser auto-fill of 0 for empty fields (spinner click on empty input)
              if (raw === '0' && inputs[field] === undefined && rawInputs[field] === undefined) {
                return;
              }
              updateField(field, parseAndConvert(field, raw), fieldUnit(field));
              if (field === 'weightKg' && !hasLandedOnMyHealth.current && onOnboardingDone) {
                const weightNum = parseLocalisedNumber(raw);
                if (weightNum !== undefined && /^\d{2,3}$/.test(raw) && weightNum >= r.min && weightNum <= r.max) {
                  advanceToMyHealth({
                    ambiguous: /^\d{2}$/.test(raw) && weightNum * 10 <= r.max,
                    advance: () => requestAnimationFrame(() => { if (onOnboardingDone()) hasLandedOnMyHealth.current = true; }),
                  });
                }
              }
            }}
            onBlur={() => {
              rangeWait.settle();
              if (unreadable[field]) return;
              setRawInputs(prev => { const next = { ...prev }; delete next[field]; return next; });
              autoSaveOnBlur();
            }}
            onKeyDown={onNumericEnter}
            placeholder={isExpandedWithData || box ? '' : getPreviousPlaceholder(field)}
            step={step ? (fieldUnit(field) === 'si' ? step.si : step.conv) : undefined}
            min={r.min}
            max={r.max}
            className={errors[field] ? 'error' : ''}
          />
          {autoSaveGate && inputs[field] !== undefined && (
            <CommitTickButton ariaLabel={`Save ${field}`} onClick={flushLongitudinalSave}/>
          )}
        </div>
        {box && previous && inputs[field] !== undefined && (
          <span className="previous-reference">{previousReference(shown, previous.recordedAt)}</span>
        )}
        {/* The box shows a saved value of any age: say when it was saved, unless today. */}
        {box && previous && inputs[field] === undefined && rawInputs[field] === undefined && dayOf(previous.recordedAt) !== localDay(new Date()) && (
          <span className="previous-reference">Saved {formatShortDate(previous.recordedAt)}</span>
        )}
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

    const displayValue = savedText(field, measurement);
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

  const renderSex = () => (
    <div className={`health-field${!inputs.sex ? ' field-attention' : ''}`}>
      <label>Sex</label>
      <div className="sex-toggle" role="radiogroup" aria-label="Sex">
        {SEXES.map(sex => (
          <button
            key={sex}
            type="button"
            role="radio"
            aria-checked={inputs.sex === sex}
            className={`sex-toggle-btn${inputs.sex === sex ? ' sex-toggle-btn--active' : ''}`}
            onClick={() => { updateField('sex', sex); if (!inputs.birthMonth) focusById('birthMonth'); }}
          >
            {sex === 'male' ? 'Male' : 'Female'}
          </button>
        ))}
      </div>
      {/* Brad 2026-11-02: the why-line asks; once answered it goes. About you's
          Sex row keeps it: someone opening it is reconsidering. */}
      {(!inputs.sex || aboutYouLow) && <p className="field-why">Used to calculate ideal body weight, kidney function, and screening programs.</p>}
      {errors.sex && <span className="error-message">{errors.sex}</span>}
    </div>
  );

  const renderHeight = () => (
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
          onKeyDown={e => { blockBadNumericKeys(e); settleOnEnter(e); }}
          onWheel={blurOnWheel}
          value={rawInputs['heightCm'] !== undefined ? rawInputs['heightCm'] : toDisplay('heightCm', inputs.heightCm)}
          onChange={(e) => {
            const raw = e.target.value;
            setRawInputs(prev => ({ ...prev, heightCm: raw }));
            if (!readable('heightCm', e)) return;
            typeIn('heightCm', raw);
            updateField('heightCm', parseAndConvert('heightCm', raw));
            const heightNum = parseLocalisedNumber(raw);
            const heightRange = range('heightCm');
            // Plausible height → move on to weight.
            if (heightNum !== undefined && /^\d{2,3}$/.test(raw) && heightNum >= heightRange.min && heightNum <= heightRange.max && inputs.weightKg === undefined && !hasPreviousValue('weightKg')) {
              advanceToWeight({
                ambiguous: /^\d{2}$/.test(raw) && heightNum * 10 <= heightRange.max,
                advance: () => focusById('weightKg'),
              });
            }
          }}
          onBlur={() => { rangeWait.settle(); if (!unreadable.heightCm) setRawInputs(prev => { const next = { ...prev }; delete next['heightCm']; return next; }); }}
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
              rangeWait.typed('heightCm', `${val}/${heightInches}`, heightMayFit(val, heightInches, true));
              const feet = parseInt(val, 10) || 0;
              const inches = parseInt(heightInches, 10) || 0;
              if (val !== '' || heightInches !== '') {
                typedHeightCm.current = feetInchesToCm(feet, inches);
                updateField('heightCm', typedHeightCm.current);
              } else {
                updateField('heightCm', undefined);
              }
              if (val.length === 1) {
                focusById('heightInches');
              }
            }}
            placeholder=""
            maxLength={1}
            onBlur={leaveHeightPair}
            onKeyDown={settleOnEnter}
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
              rangeWait.typed('heightCm', `${heightFeet}/${val}`, heightMayFit(heightFeet, val, false));
              const feet = parseInt(heightFeet, 10) || 0;
              const inches = parseInt(val, 10) || 0;
              if (heightFeet !== '' || val !== '') {
                typedHeightCm.current = feetInchesToCm(feet, inches);
                updateField('heightCm', typedHeightCm.current);
              } else {
                updateField('heightCm', undefined);
              }
              // Height complete → move on to weight (mirrors the cm
              // path). A lone '1' might still become 10/11 — wait it out.
              if (heightFeet !== '' && val !== '' && inches <= 11 && inputs.weightKg === undefined && !hasPreviousValue('weightKg')) {
                advanceToWeight({
                  ambiguous: val === '1',
                  advance: () => focusById('weightKg'),
                });
              }
            }}
            placeholder=""
            maxLength={2}
            onBlur={leaveHeightPair}
            onKeyDown={settleOnEnter}
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

  // US-60 AC4: the answer the plan's "Reduce alcohol intake" Dismiss asks for,
  // in About you's rows only, never during onboarding (Brad 2026-11-02). Tapping
  // the chosen answer clears it (M2: the card comes back), so these are pressed
  // toggle buttons, not radios (a checked radio cannot uncheck).
  const renderAlcohol = () => (
    <div className="health-field">
      <label>Alcohol</label>
      <div id="alcohol" className="sex-toggle" role="group" aria-label="Alcohol">
        {ALCOHOL_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={inputs.alcohol === value}
            className={`sex-toggle-btn${inputs.alcohol === value ? ' sex-toggle-btn--active' : ''}`}
            onClick={() => updateField('alcohol', inputs.alcohol === value ? undefined : value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="field-why">Used to decide whether advice on alcohol applies to you.</p>
    </div>
  );

  /** About you's rows (US-62 AC12); each row's editor is the field itself, with its why-line. */
  const renderAboutRows = () => {
    const month = inputs.birthMonth ? MONTHS_FULL[inputs.birthMonth - 1]?.label : undefined;
    const rows: Array<{ key: AboutKey; label: string; value: string | null; missing: boolean; editor: () => ReactNode }> = [
      { key: 'height', label: 'Height', editor: renderHeight,
        value: inputs.heightCm != null ? formatHeightDisplay(inputs.heightCm, unitSystem) : null,
        missing: inputs.heightCm == null || !!allErrors.heightCm || !!unreadable.heightCm },
      { key: 'sex', label: 'Sex', editor: renderSex,
        value: inputs.sex === 'male' ? 'Male' : inputs.sex === 'female' ? 'Female' : null,
        missing: !inputs.sex || !!allErrors.sex },
      { key: 'birth', label: 'Birth', editor: renderBirthInfo,
        // The plan's age beside it, as the old collapsed summary said it (US-06 AC5): none when the plan sets the year aside.
        value: inputs.birthYear ? `${[month, inputs.birthYear].filter(Boolean).join(' ')}${planBasis?.age !== undefined ? ` (Age ${planBasis.age})` : ''}` : null,
        missing: !inputs.birthYear || !!allErrors.birthMonth || !!allErrors.birthYear },
      // US-60 AC4: unanswered is an answer here, so it never opens itself.
      { key: 'alcohol', label: 'Alcohol', editor: renderAlcohol, missing: false,
        value: ALCOHOL_OPTIONS.find(o => o.value === inputs.alcohol)?.label ?? 'Not answered' },
    ];
    const open = (key: AboutKey) => {
      setAboutOpen(prev => new Set(prev).add(key));
      // The row's own field, never the unit pill beside its label (adversary R5).
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-about="${key}"]`);
        (row?.querySelector<HTMLElement>('input, select, [role="radio"]') ?? row?.querySelector<HTMLElement>('button'))?.focus();
      });
    };
    const done = (key: AboutKey) => {
      setAboutOpen(prev => { const next = new Set(prev); next.delete(key); return next; });
      focusById(`about-${key}`);
    };
    // A missing or refused answer's row opens and stays open while it is
    // typed in, until Done (one set, updated as it renders).
    // The render-phase setAboutOpen is safe only because renderAboutRows is a
    // plain function in InputPanel's own render, not a child component.
    const opened = rows.filter(row => row.missing && !aboutOpen.has(row.key)).map(row => row.key);
    if (opened.length > 0) setAboutOpen(prev => new Set([...prev, ...opened]));
    return (
      <ul className="md-rows about-rows">
        {rows.map(row => {
          return (
            <li key={row.key}>
              {aboutOpen.has(row.key) || row.missing ? (
                <div className="about-editor" data-about={row.key}>
                  {row.editor()}
                  <button type="button" className="md-back about-done" onClick={() => done(row.key)}>Done</button>
                </div>
              ) : (
                <button type="button" id={`about-${row.key}`} className="about-row" onClick={() => open(row.key)}>
                  <span className="about-row-label">{row.label}</span>
                  {row.value ? <span className="about-row-value">{row.value}</span> : <span className="md-row-add">Add</span>}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  // data-unit-control="all": a press here closes every open saved-value editor
  // unsaved (US-05 AC2, US-04 AC1).
  const unitPill = (
    <button
      type="button"
      className="unit-toggle-pill"
      data-unit-control="all"
      onClick={() => onUnitSystemChange(unitSystem === 'si' ? 'conventional' : 'si')}
      title={`Switch to ${unitSystem === 'si' ? 'US (in, lbs, mg/dL)' : 'Metric (cm, kg, mmol/L)'}`}
      aria-label={`Switch units. Current: ${unitSystem === 'si' ? 'Metric' : 'US'}`}
    >
      {unitSystem === 'si' ? 'Metric' : 'US'}<span className="unit-pill-detail">{unitSystem === 'si' ? ' (kg, cm, mmol/L)' : ' (in, lbs, mg/dL)'}</span>
    </button>
  );

  const renderProfile = () => (
    <>
      <section className="health-section">
        <div className="hr-section-card-header">
          <h3 className="health-section-title">
            <SectionIcon section="aboutYou"/>{aboutYouLow ? 'About you' : 'Starting info'}
          </h3>
          <div className="basic-info-units">
            <span className="basic-info-units-label">Units</span>
            {unitPill}
          </div>
        </div>

        <div className="prefill-fields-wrapper">
          {/* The onboarding, one question at a time (US-62 AC13): height and
              weight, then sex, then the birth date. Each answer saves. Every
              slot keeps its place as the form opens, so a field being typed
              in is never remounted under the cursor. */}
          {aboutYouLow ? renderAboutRows() : (
            <>
              <div className="sex-height-row">
                {renderHeight()}
                {weightInProfile && renderLongitudinalField(WEIGHT_FIELD, true)}
                {sexInRow && renderSex()}
              </div>
              {!sexInRow && valueShown && <div className="stage-reveal profile-step">{renderSex()}</div>}
              {birthShown && <div className="stage-reveal profile-step">{renderBirthInfo()}</div>}
            </>
          )}
          {!fullForm && (
            <p className="field-hint-attention field-hint-attention--centered">
              {formStage === 1 ? 'Enter your height and weight, then more fields will appear.' : 'Fill in the above, then more fields will appear.'}
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
        onOnboardingDone={onOnboardingDone}
        withoutWeight={weightInProfile}
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
        <h3 className="health-section-title"><SectionIcon section="vitals"/>Vitals</h3>
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
                    typeIn('systolicBp', e.target.value);
                    updateField('systolicBp', parseLocalisedNumber(e.target.value));
                    // US-02 AC6: hop to diastolic once systolic is unambiguous.
                    const adv = bpSysAdvance(e.target.value);
                    if (adv !== 'stay' && inputs.diastolicBp === undefined) {
                      advanceToDiastolic({ ambiguous: adv === 'defer', advance: () => focusById('diastolicBp') });
                    }
                  }}
                  onBlur={() => { rangeWait.settle(); autoSaveOnBlur(); }}
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
                  onChange={(e) => { typeIn('diastolicBp', e.target.value); updateField('diastolicBp', parseLocalisedNumber(e.target.value)); }}
                  onBlur={() => { rangeWait.settle(); autoSaveOnBlur(); }}
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
          {/* US-02 AC5: a year out of range stays, saying why; the store refuses it. */}
          {errors.birthYear && errors.birthYear !== errors.birthMonth && <span className="error-message">{errors.birthYear}</span>}
        </div>

        {/* Once shown on this record it stays, so clearing a year to retype keeps the field (US-62 AC13). */}
        {yearShown.current && (
          <div className={`health-field stage-reveal${!inputs.birthYear ? ' field-attention' : ''}`}>
            <label htmlFor="birthYear">Birth Year</label>
            <input
              type="number"
              id="birthYear"
              onKeyDown={e => { blockNonIntegerKeys(e); settleOnEnter(e); }}
              onWheel={blurOnWheel}
              value={inputs.birthYear || ''}
              onChange={(e) => {
                const num = parseLocalisedNumber(e.target.value);
                if (num !== undefined && isBirthYearClearlyInvalid(num)) return;
                typeIn('birthYear', e.target.value);
                updateField('birthYear', num);
                // Brad 2026-11-02: a complete year in range, the month set, is the
                // last answer: on to My health's top, out of the card, so About
                // you moves without waiting for a blur. "199" never does, nor a
                // returning user's edit in About you's Birth row (Codex R3).
                const years = identityFieldRange('birthYear')!;
                if (onOnboardingDone && !yearJumped.current && !aboutYouLow && reached < 4 && inputs.birthMonth && num !== undefined && /^\d{4}$/.test(e.target.value) && num >= years.min && num <= years.max) {
                  yearJumped.current = true;
                  requestAnimationFrame(() => onOnboardingDone(true));
                }
              }}
              onBlur={rangeWait.settle}
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

  // Cholesterol medications: a cascade when the plan's lipid marker is elevated (US-06 AC5), flat when any lipid is entered.
  const renderLipidMedications = (place: Placement) => {
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
        {place.on('statin', 'statin_dose')}
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
        {place.on('ezetimibe')}
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
        {place.on('pcsk9i')}
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
        {place.on('bempedoic_acid')}
      </div>
    );

    const neutral = MEDICATION_TEXT.lipidNeutral;

    // ── Flat mode: all fields visible independently (no cascade gating) ──
    if (!cascadeMode) {
      return (
        <div className="section-card">
          <section className="health-section">
            <h4 className="mh-group-label">{MEDICATION_TEXT.lipidTitle}</h4>
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
        <h4 className="mh-group-label">{MEDICATION_TEXT.lipidTitle}</h4>
        <p className="health-section-desc">
          {/* It recommends only while the plan shows a step's card: with every
              step answered the marker stays elevated and the plan shows none. */}
          {cascade.suggest.length === 0 ? neutral : `${introText} ${LIPID_MEDS_IN_STEPS}`}
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
            {place.on('statin_escalation')}
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
  };

  // Weight and diabetes medications: they recommend only when the plan's trigger is on (US-06 AC5).
  const renderWeightMedications = (place: Placement) => {
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
        {place.on('glp1', 'glp1_dose')}
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
        {place.on('sglt2i', 'sglt2i_dose')}
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
        {place.on('metformin')}
      </div>
    );

    const neutral = MEDICATION_TEXT.weightNeutral;

    // ── Flat mode: all fields visible independently ──
    if (!weightCascadeMode) {
      return (
        <div className="section-card">
          <section className="health-section">
            <h4 className="mh-group-label">{MEDICATION_TEXT.weightTitle}</h4>
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
        <h4 className="mh-group-label">{MEDICATION_TEXT.weightTitle}</h4>
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
            {place.on('glp1_escalation')}
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
  };

  // Cancer screening: shown when the plan has an age.
  const renderScreening = (place: Placement) => {
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
        <p className="health-section-desc">
          {SCREENING_TEXT.intro}
        </p>

        {/* Colorectal (age 35-85, all genders) */}
        {age >= 35 && age <= 85 && (
          <div className="screening-group">
            <h4>Colorectal</h4>
            {place.in('colorectal')}
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
            {place.in('breast')}
            {place.noteShown('breast', SCREENING_TEXT.breastByAge(age)) && (
              <p className="screening-age-message">
                {SCREENING_TEXT.breastByAge(age)}
              </p>
            )}

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
            {place.in('cervical')}
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

        {/* Lung (age 50-80, all genders; past 80 for an abnormal CT or any stored LDCT answer, US-07 AC1g) */}
        {lungGroupShown(age, scr) && (
          <div className="screening-group">
            <h4>Lung</h4>
            {place.in('lung')}

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

                {lungScreeningAsked(scr) && (
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
            {place.in('prostate')}
            {place.noteShown('prostate', SCREENING_TEXT.prostateByAge(age)) && (
              <p className="screening-age-message">
                {SCREENING_TEXT.prostateByAge(age)}
              </p>
            )}

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
                  const today = localDay(new Date());
                  const psaDay = psaDate ?? today;
                  const psaDayError = !psaDay || psaDay > today ? 'Choose a day up to today.' : null;
                  // One PSA per day: a value typed for a day that holds one corrects it, so say so,
                  // while a value is typed (US-06 AC15).
                  const psaHeld = inputs.psa === undefined ? undefined
                    : bloodTestHistory.find(m => m.metricType === 'psa' && dayOf(m.recordedAt) === psaDay);
                  const psaMeasurement = newestUsablePsa(bloodTestHistory, new Date()); // the PSA the plan reads (US-06 AC14)
                  const psaPreviousLabel = psaHeld
                    ? `Replaces ${formatGradedOrLimit('psa', psaHeld.value, 'si', psaHeld.comparator)} ng/mL`
                    : psaMeasurement
                    ? `${formatGradedOrLimit('psa', psaMeasurement.value, 'si', psaMeasurement.comparator)} ng/mL · ${formatShortDate(psaMeasurement.recordedAt)}`
                    : null;

                  return (
                    <div className="health-field">
                      <label htmlFor="psa-input">{SCREENING_TEXT.psaLabel}</label>
                      {/* Saves once focus leaves the row, so a date picked after the value counts (US-06 AC15). */}
                      <div className="psa-inline-row" onBlur={(e) => {
                        if (autoSaveGate && !unreadable.psa && !e.currentTarget.contains(e.relatedTarget as Node | null)) onPsaCommit(false);
                      }}>
                        <input
                          type="number"
                          id="psa-input"
                          onWheel={blurOnWheel}
                          value={rawInputs.psa ?? (inputs.psa !== undefined ? String(inputs.psa) : '')}
                          onChange={(e) => {
                            const val = e.target.value;
                            typeIn('psa', val);
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
                            rangeWait.settle();
                            setRawInputs(prev => { const next = { ...prev }; delete next.psa; return next; });
                          }}
                          onKeyDown={(e) => {
                            blockBadNumericKeys(e); settleOnEnter(e);
                            if (e.key !== 'Enter') return;
                            e.preventDefault();
                            if (autoSaveGate && !unreadable.psa) onPsaCommit(true);
                          }}
                          placeholder=""
                          step="0.1"
                          min={range('psa').min}
                          max={range('psa').max}
                          className={errors.psa ? 'error' : ''}
                        />
                        <input type="date" aria-label="PSA test date" value={psaDay} max={today}
                               onChange={(e) => onPsaDateChange(e.target.value)} />
                        {autoSaveGate && inputs.psa !== undefined && (
                          <CommitTickButton ariaLabel="Save PSA" onClick={() => onPsaCommit(true)}/>
                        )}
                      </div>
                      {(unreadable.psa || errors.psa || psaDayError) && <span className="field-error">{unreadable.psa ? 'Enter a number' : errors.psa ?? psaDayError}</span>}
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
            {place.in('endometrial')}

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
  };

  const renderBoneDensity = (place: Placement) => {
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
        <h4 className="mh-group-label">{SCREENING_TEXT.boneTitle}</h4>
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
            {place.in('dexa')}
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
  };

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
        <section className="health-section" aria-label={SUPPLEMENT_TEXT.title}>
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

  const aboutCard = (
    <div key="about" ref={aboutRef} className={`section-card about-card${aboutYouLow ? ' md-about-you' : ''}`}
         onBlurCapture={aboutYouLow ? undefined : leaveProfile}
         onPointerDownCapture={() => { pressedInside.current = true; }}
         onPointerUpCapture={() => { setTimeout(() => { pressedInside.current = false; }, 0); }}
         onPointerCancelCapture={() => { pressedInside.current = false; }}
         onFocusCapture={() => { pressedInside.current = false; leavePending.current = false; }}>
      {renderProfile()}
    </div>
  );

  // The vitals' rows stand in for their fields once saved (a returning record, or the
  // onboarding's card left); a first visit's fields stay while they are typed in.
  const vitalsRows = vitalsViewMode === 'matrix' || vitalsAsRows || (vitalsHistory.length > 0 && fieldsSaved === 0);

  return children({
    panelRef, messages: panelMessages, aboutCard, aboutYouLow, unitPill, fullForm, planReady: !!planBasis,
    pageOpen: !!pageShown,
    renderPage: tiles => pageShown && (
      <ValuePage key={JSON.stringify(pageShown)} subject={pageShown} history={[...vitalsHistory, ...bloodTestHistory]} labValues={labValues}
                 ctx={rowCtx} tiles={tiles} onSave={onSaveBloodTestBatch} onCorrect={onCorrectValue} onLabAdded={onLabValueAdded} onClose={closePage} onOpen={subject => mayLeave() && openPage(subject)} dirtyRef={pageDirty}/>
    ),
    rows: { ctx: rowCtx, open: openPage, vitals: vitalsHistory, blood: bloodTestHistory, labs: labValues, vitalsAsRows: vitalsRows, withoutWeight: weightInProfile },
    legacyVitals: !vitalsRows && (
      <div ref={vitalsRef} className="section-card stage-reveal"
           onBlurCapture={aboutYouLow && !vitalsLeft ? e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setVitalsLeft(true); } : undefined}>
        {renderVitalsLegacy()}
      </div>
    ),
    vitalsCue: unsavedCue(draftedVitals),
    bloodCue: unsavedCue(draftedBlood),
    tableShown,
    showTable,
    // The grids stay mounted, hidden under the rows: their drafts, the chat's
    // prefill (US-16 AC2) and the save before an upload keep working (US-62 AC11).
    table: (
      <div className="md-table" hidden={!tableShown}>
        <button type="button" className="md-back md-table-back" onClick={() => showTable(false)}>‹ Show as rows</button>
        {vitalsRows && renderVitalsMatrix()}
        {renderBloodTests()}
        {move.panel}
        <AdditionalLabRows labValues={labValues} coreValues={bloodTestHistory} onAdded={onLabValueAdded} onCorrect={onCorrectValue} move={move.headers}/>
      </div>
    ),
    addTest: onLabValueAdded && <AddLabTest onAdded={onLabValueAdded} labValues={labValues} coreValues={bloodTestHistory} onCorrect={onCorrectValue}/>,
    weightMedications: renderWeightMedications,
    lipidMedications: renderLipidMedications,
    screening: renderScreening,
    boneDensity: renderBoneDensity,
    supplements: renderSupplements,
  });
}

