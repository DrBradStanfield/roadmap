import { useCallback, useEffect, useRef, useState } from 'react';
import { opensFullForm, type FormStage, type RecordHoldings } from '@roadmap/health-core/mappings';
import { ONBOARDING_STEPS } from '@roadmap/health-core/product-events';
import { getShownErase } from '../lib/roadmap-data';
import { trackProductEvent } from '../lib/server-api';
import { safeGetItem, safeSetItem } from '../lib/storage';

/** US-62 AC31: this browser has pressed "Your plan is ready."'s Got it. A UI flag only, never in the record. */
const PLAN_READY_SEEN_KEY = 'hr_plan_ready_seen';
const planReadySeen = (): boolean => safeGetItem(PLAN_READY_SEEN_KEY) === '1';

/**
 * The onboarding of the record the screen shows (US-62 AC12, AC13, AC31).
 *
 * One state per record, keyed on the erase the screen shows: an erase (this
 * tab's or another device's, once shown) starts every part of it again.
 *
 * - `reached`: the highest stage this record has shown. It only rises, so
 *   nothing unlocked goes away while an answer is retyped. Stage 1 asks the
 *   measurements, 2 sex, 3 the birth date; 4 is done.
 * - `opened`: the stage the record was first shown at.
 * - `fullForm`: the whole form is open. It latches until an erase (a deleted
 *   document that opened it does not close it).
 * - `answered`: the person did something in this tab that can answer a step
 *   (the form, a matrix weight, the chat's proposal, an upload). A change
 *   from another writer clears it. Only a rise in `reached` while it is set,
 *   once the record has loaded, counts, as the step that was asked (AC13): a
 *   returning user, an answer retyped, or a jump from another device or tab
 *   sends none. The step's name only, never its answer.
 * - About you moves low (`aboutYouLow`) for a record complete when first
 *   shown, or once it is complete and the focus leaves its card (AC12). A
 *   record another device completes stays put until then (Brad 2026-11-10, D6).
 * - "Your plan is ready." (`planReady`) shows once, for the record whose
 *   onboarding ended in this tab, until Got it (AC31).
 */
interface RecordOnboarding {
  erase: string;
  epoch: number;
  reached: FormStage;
  opened: FormStage;
  fullForm: boolean;
  answered: boolean;
  /** The stage the step count last saw (AC13). */
  counted: FormStage;
}

export interface Onboarding {
  reached: FormStage;
  epoch: number;
  fullForm: boolean;
  aboutYouLow: boolean;
  planReady: boolean;
  /** The latest stage, for a call made after the render that changed it. */
  isComplete: () => boolean;
  markAnswered: () => void;
  /** A change this tab did not make: another writer's, or a refused save's re-read. */
  clearAnswered: () => void;
  /** The focus left About you's card. Says whether it moves low, so the caller can measure before it does. */
  profileLeft: () => boolean;
  dismissPlanReady: () => void;
}

/** The onboarding as InputPanel sees it (US-62 AC12, AC13, AC25): this hook's state, and the landing. */
export interface PanelOnboarding extends Pick<Onboarding, 'reached' | 'fullForm' | 'aboutYouLow'> {
  /** The first answer the record lacks: 1 height and weight, 2 sex, 3 birth date, 4 none. */
  stage: FormStage;
  profileLeft?: Onboarding['profileLeft'];
  /** The last onboarding answer is in: land at My health's top. Says whether it did (AC13, AC25). */
  done?: (fromBirth?: boolean) => boolean;
}

export function useOnboarding(stage: FormStage, holdings: RecordHoldings, loaded: boolean): Onboarding {
  const ref = useRef<RecordOnboarding | null>(null);
  const erase = getShownErase();
  const was = ref.current;
  if (!was || was.erase !== erase) {
    ref.current = { erase, epoch: (was?.epoch ?? 0) + 1, reached: stage, opened: stage, fullForm: false, answered: false, counted: stage };
  } else if (stage > was.reached) was.reached = stage;
  const now = ref.current!;
  now.fullForm ||= opensFullForm(now.reached, holdings);
  const { epoch, reached, opened, fullForm } = now;

  const stageRef = useRef(stage);
  stageRef.current = stage;

  const [planReadyFor, setPlanReadyFor] = useState<number | null>(null);
  const [movedLow, setMovedLow] = useState<number | null>(null);

  useEffect(() => {
    const rec = ref.current!;
    const from = rec.counted;
    rec.counted = rec.reached;
    if (rec.reached <= from || !rec.answered || !loaded) return;
    rec.answered = false;
    // The step that was asked is the one answered; later steps a record already held were not.
    trackProductEvent('onboarding_step', { step: ONBOARDING_STEPS[from - 1] });
    if (rec.reached === 4) {
      trackProductEvent('onboarding_done');
      if (!planReadySeen()) setPlanReadyFor(rec.epoch);
    }
  });

  const markAnswered = useCallback(() => { ref.current!.answered = true; }, []);
  const clearAnswered = useCallback(() => { ref.current!.answered = false; }, []);
  const isComplete = useCallback(() => stageRef.current === 4, []);
  const profileLeft = useCallback(() => {
    if (stageRef.current !== 4) return false;
    setMovedLow(ref.current!.epoch);
    return true;
  }, []);
  const dismissPlanReady = useCallback(() => {
    trackProductEvent('plan_ready_dismissed');
    safeSetItem(PLAN_READY_SEEN_KEY, '1'); // private mode: gone for this visit only
    setPlanReadyFor(null);
  }, []);

  return {
    reached, epoch, fullForm,
    aboutYouLow: opened === 4 || movedLow === epoch,
    planReady: planReadyFor === epoch,
    isComplete, markAnswered, clearAnswered, profileLeft, dismissPlanReady,
  };
}
