// The form: the onboarding's questions and About you, the vitals, the blood-test
// grids, the medicine, screening and supplement questions, and the value pages'
// state. My health (MyHealth.tsx, US-62 phase 5) lays its parts out by topic,
// through the slots this hands its `children`.
import { SectionIcon } from './icons';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { InfoTooltip } from './InfoTooltip';
import { type HealthInputs, type HealthResults, type ScreeningInputs, type MedicationInputs } from '@roadmap/health-core/types';
import type { CorrectFn, Refused, SaveTask } from '../lib/matrix-save';
import { blockBadNumericKeys, blockNonIntegerKeys, bpSysAdvance, mayStillFit, type Grading } from '../lib/blood-test-cell';
import { useRangeWait } from '../lib/useRangeWait';
import type { ApiLabValue, ApiSupplement } from '../lib/api-types';
import { loadFromLocalStorage } from '../lib/storage';

import { type FormStage, FIELD_METRIC_MAP, type ApiMeasurement, type ApiMedication, type ApiScreening, METRIC_TO_FIELD, VITAL_METRICS } from '@roadmap/health-core/mappings';
import { type WeightMedicationTrigger, type LipidMarker } from '@roadmap/health-core/suggestions';
import { type UnitSystem, fromCanonicalValue, toCanonicalValue, getDisplayLabel, getDisplayRange, UNIT_DEFS, hasUnitChoice, bpTargetFor } from '@roadmap/health-core/units';
import { identityFieldRange } from '@roadmap/health-core/validation';
import { formatValue } from '@roadmap/health-core/lab-limits';
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { anyScreeningEligible, medicationWrites, screeningWrites, readScreening, dexaEligible } from '@roadmap/health-core/input-form';
import { formatShortDate, MONTHS_FULL } from '../lib/constants';
import { BloodTestTimeline, type BloodTestPrefillFn } from './BloodTestTimeline';
import { AdditionalLabRows } from './AdditionalLabRows';
import { useMoveTest, type MoveTestApi } from './MoveTestPanel';
import { StartingInfoVitals, type VitalsPrefillFn } from './StartingInfoVitals';
import { CommitTickButton } from './CommitTickButton';
import { useLpaUnit } from '../lib/lpa-unit';
import { useValuePage } from '../lib/useValuePage';
import { type RowContext } from './MyDataRows';
import { ValuePage } from './ValuePage';
import { AddLabTest } from './AddLabTest';
import { SupplementsSection } from './SupplementsSection';
import type { FormSlots, Placement } from './MyHealth';
import { focusById, interceptHistory, type FormKit } from './form-kit';
import { ScreeningQuestions } from './ScreeningQuestions';
import { LipidMedications } from './LipidMedications';
import { WeightMedications } from './WeightMedications';
import { BoneDensity } from './BoneDensity';
import { AboutRows, AlcoholField, BirthFields, HeightField, SexField, useHeightPair } from './AboutYou';

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
  // My data's view state: the open value page, its history entry and the table (lib/useValuePage).
  const panelRef = useRef<HTMLDivElement>(null);
  const { pageShown, tableShown, openPage, closePage, mayLeave, showTable, pageDirty, panelMessages } = useValuePage(revealCell, panelRef);
  // A grid's typed text not yet saved, valid or not (the plan and the chat
  // read the valid part, and an upload saves it first): where the grids sit
  // hidden under the rows, each card says so and opens the table
  // (US-62 AC11). Each grid reports what it keeps.
  const [draftedVitals, setDraftedVitals] = useState(false);
  const [draftedBlood, setDraftedBlood] = useState(false);
  const unsavedCue = (shown: boolean) => !tableShown && shown && (
    <button type="button" className="md-unsaved" onClick={() => showTable(true)}>Unsaved values: review</button>
  );
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
    // About you's rows unmount as it leaves, which closes every open row.
    if (!aboutYouLow) yearJumped.current = false;
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
  // The birth year's field, once shown, stays while the birth question does:
  // a year cleared to retype keeps its field, whatever the stage. The
  // question going (an erase) starts it again.
  const birthShown = fullForm || reached >= 3;
  const yearShown = useRef(false);
  yearShown.current = birthShown && (yearShown.current || !!(inputs.birthMonth || inputs.birthYear));

  const heightPair = useHeightPair(inputs.heightCm, unitSystem);

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
  /** Send one medication answer's writes, in order (health-core's rules). */
  const writeMedication = (meds: MedicationInputs, cascadeMode: boolean, field: string, value: string) => {
    for (const w of medicationWrites(meds, cascadeMode, field, value)) onMedicationChange(w.medicationKey, w.drugName, w.doseValue, w.doseUnit);
  };
  const form: FormKit = { inputs, rawInputs, setRawInputs, errors, updateField, readable, unreadable, range, typeIn, blurOnWheel, settleOnEnter, autoSaveGate, rangeWait };

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

  // About you's fields: the onboarding's boxes and, low, the rows' editors (AboutYou.tsx).
  const heightField = (
    <HeightField form={form} pair={heightPair} unitSystem={unitSystem} onUnitSystemChange={onUnitSystemChange}
      toDisplay={toDisplay} parseAndConvert={parseAndConvert}
      mayAdvanceToWeight={inputs.weightKg === undefined && !hasPreviousValue('weightKg')} advanceToWeight={advanceToWeight}/>
  );
  const sexField = <SexField form={form} aboutYouLow={aboutYouLow}/>;
  const birthFields = (
    <BirthFields form={form} yearShown={yearShown.current}
      // The year's jump, once per record, never a returning user's edit in About you's Birth row (Codex R3).
      onYearComplete={onOnboardingDone && !aboutYouLow && reached < 4 ? () => {
        if (yearJumped.current) return;
        yearJumped.current = true;
        requestAnimationFrame(() => onOnboardingDone(true));
      } : undefined}/>
  );

  // ── Section render functions (shared closure state, not separate components) ──

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
          {aboutYouLow ? (
            <AboutRows form={form} allErrors={allErrors} unitSystem={unitSystem} planAge={planBasis?.age}
              editors={{ height: heightField, sex: sexField, birth: birthFields, alcohol: <AlcoholField form={form}/> }}/>
          ) : (
            <>
              <div className="sex-height-row">
                {heightField}
                {weightInProfile && renderLongitudinalField(WEIGHT_FIELD, true)}
                {sexInRow && sexField}
              </div>
              {!sexInRow && valueShown && <div className="stage-reveal profile-step">{sexField}</div>}
              {birthShown && <div className="stage-reveal profile-step">{birthFields}</div>}
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

    return <LipidMedications place={place} writeMedication={writeMedication} medications={medications} lipidMarker={lipidMarker} fieldUnit={fieldUnit}/>;
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

    return <WeightMedications place={place} writeMedication={writeMedication} medications={medications} planBasis={planBasis}/>;
  };

  // Null, not an empty element, when no screening applies: My health draws a topic for any element (US-62 AC17).
  const renderScreening = (place: Placement) => {
    const age = planBasis?.age;
    if (age === undefined || !anyScreeningEligible(age, inputs.sex)) return null;
    return <ScreeningQuestions place={place} form={form} screenings={screenings} onScreeningChange={onScreeningChange}
                               psaDate={psaDate} onPsaDateChange={onPsaDateChange} onPsaCommit={onPsaCommit} bloodTestHistory={bloodTestHistory}
                               age={age} writeScreening={writeScreening} renderScreeningDateInput={renderScreeningDateInput}/>;
  };

  const renderBoneDensity = (place: Placement) => {
    const age = planBasis?.age;
    if (age === undefined) return null;

    const sex = inputs.sex;
    if (!dexaEligible(age, sex)) return null;

    return <BoneDensity place={place} screenings={screenings} writeScreening={writeScreening} renderScreeningDateInput={renderScreeningDateInput}/>;
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
    supplements: () => <SupplementsSection supplements={supplements} onSupplementChange={onSupplementChange} onSupplementDelete={onSupplementDelete}/>,
  });
}

