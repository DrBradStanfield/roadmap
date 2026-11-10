import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { opensFullForm, type FormStage, type RecordHoldings } from '@roadmap/health-core/mappings';
import { ONBOARDING_STEPS } from '@roadmap/health-core/product-events';
import { trackProductEvent } from '../lib/server-api';
import { safeGetItem, safeSetItem } from '../lib/storage';

/** US-62 AC31: this browser has pressed "Your plan is ready."'s Got it. A UI flag only, never in the record. */
const PLAN_READY_SEEN_KEY = 'hr_plan_ready_seen';
const planReadySeen = (): boolean => safeGetItem(PLAN_READY_SEEN_KEY) === '1';

/**
 * The onboarding of the record the screen shows (US-62 AC12, AC13, AC31).
 *
 * One state per record, keyed on the erase the screen shows (HealthTool's
 * React state, D5): an erase (this tab's or another device's, once shown)
 * starts every part of it again.
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
 * - `landing`: the jump to My health after the last answer (AC25b), one
 *   named state (`Landing`) this hook alone decides and performs. It lives
 *   here, not in the fields, so a panel remount (the 768px swap) keeps it.
 */
/**
 * The landing (US-62 AC25b): it follows the landing field the onboarding
 * ended in, while the person is still in it. The fields report two facts, in
 * any order: an answer (`lands`: typed in a landing field, the weight on the
 * Shopify build or the birth year) and the field at rest (`settled`: complete,
 * valid, and not about to grow). `open`: the onboarding has not ended here.
 * `awaiting`: it ended on a landing answer not yet at rest; `settled` keeps a
 * rest heard while the four answers had dipped, for when they hold again.
 * `spent`: it landed, or ended on another answer (sex, the chat, an upload),
 * or the person left the field. A change this tab did not make (`foreign`)
 * drops an answer not yet ended on, but not one awaiting its rest. A record
 * complete when first shown, or completed by another writer (D6), never ends
 * here, so it never lands.
 */
export type Landing =
  | { kind: 'open'; lands: boolean; settled: boolean }
  | { kind: 'awaiting'; settled: boolean }
  | { kind: 'spent' };
export type LandingEvent =
  | { type: 'answered'; lands: boolean }
  | { type: 'settled'; complete: boolean } // complete: the four answers hold as it fires
  | { type: 'ended' }
  | { type: 'completed' } // the four answers hold again after a dip
  | { type: 'left' } // the focus left the landing field, or it unmounted holding the focus
  | { type: 'foreign' }; // a change this tab did not make arrived

const SPENT: Landing = { kind: 'spent' };
/** The landing's one way to change; `land` says to jump now. */
export function transition(s: Landing, e: LandingEvent): { next: Landing; land: boolean } {
  const to = (next: Landing, land = false) => ({ next, land });
  if (s.kind === 'open') {
    if (e.type === 'answered') return to({ kind: 'open', lands: e.lands, settled: false });
    if (e.type === 'settled') return to({ ...s, settled: s.lands || s.settled });
    if (e.type === 'ended') return s.lands && s.settled ? to(SPENT, true) : to(s.lands ? { kind: 'awaiting', settled: false } : SPENT);
    return to(e.type === 'completed' ? s : { kind: 'open', lands: false, settled: false });
  }
  if (s.kind === 'awaiting') {
    if (e.type === 'answered') return to(e.lands ? { kind: 'awaiting', settled: false } : SPENT);
    if (e.type === 'settled') return e.complete ? to(SPENT, true) : to({ kind: 'awaiting', settled: true });
    if (e.type === 'completed' && s.settled) return to(SPENT, true);
    return to(e.type === 'left' ? SPENT : s);
  }
  return to(s);
}

interface RecordOnboarding {
  erase: string;
  epoch: number;
  reached: FormStage;
  opened: FormStage;
  fullForm: boolean;
  answered: boolean;
  /** The stage the step count last saw (AC13). */
  counted: FormStage;
  /** The four answers held at the last commit (AC25b: `completed`). */
  complete: boolean;
  landing: Landing;
}

export interface Onboarding {
  reached: FormStage;
  epoch: number;
  fullForm: boolean;
  aboutYouLow: boolean;
  planReady: boolean;
  /** An answer given in this tab; `lands`: typed in a landing field (AC13, AC25b). */
  answered: (lands: boolean) => void;
  /** The landing field's value is complete and at rest (AC25b). */
  rested: () => void;
  /** The focus left the landing field, or it unmounted holding the focus (AC25b). */
  left: () => void;
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
  /** A field typed in: a landing field (the weight, the birth year), or null for a weight that never lands (a past day's) (AC13, AC25b). */
  answered?: (field: 'weightKg' | 'birthYear' | null) => void;
  rested?: Onboarding['rested'];
  left?: Onboarding['left'];
}

/**
 * A landing field's ref (US-62 AC25b): `left` on its blur, and on its unmount
 * while it holds the focus (the page crossing 768px, the vitals rows
 * switching), where React fires no blur. React detaches the ref before it
 * removes the node, so the focus is still there to see.
 */
export function useLeaveField(left?: () => void): (el: HTMLInputElement | null) => void {
  const node = useRef<HTMLInputElement | null>(null);
  const leave = useRef(left);
  leave.current = left;
  const onBlur = useRef(() => leave.current?.()).current;
  return useCallback((el: HTMLInputElement | null) => {
    const was = node.current;
    was?.removeEventListener('blur', onBlur);
    if (!el && was && was === document.activeElement) onBlur();
    el?.addEventListener('blur', onBlur);
    node.current = el;
  }, [onBlur]);
}

export function useOnboarding(stage: FormStage, holdings: RecordHoldings, loaded: boolean, erase: string, land: () => void): Onboarding {
  const ref = useRef<RecordOnboarding | null>(null);
  const was = ref.current;
  if (!was || was.erase !== erase) {
    ref.current = { erase, epoch: (was?.epoch ?? 0) + 1, reached: stage, opened: stage, fullForm: false, answered: false, counted: stage, complete: stage === 4, landing: { kind: 'open', lands: false, settled: false } };
  } else if (stage > was.reached) was.reached = stage;
  const now = ref.current!;
  now.fullForm ||= opensFullForm(now.reached, holdings);
  const { epoch, reached, opened, fullForm } = now;

  const stageRef = useRef(stage);
  stageRef.current = stage;
  const landRef = useRef(land);
  landRef.current = land;
  /** The one way the landing moves; a jump runs on the next frame, never in the commit, only for the record still shown. */
  const send = useCallback((rec: RecordOnboarding, event: LandingEvent) => {
    const { next, land: jump } = transition(rec.landing, event);
    rec.landing = next;
    if (jump) requestAnimationFrame(() => { if (ref.current === rec) landRef.current(); });
  }, []);

  const [planReadyFor, setPlanReadyFor] = useState<number | null>(null);
  const [movedLow, setMovedLow] = useState<number | null>(null);
  const low = useRef(false);
  low.current = opened === 4 || movedLow === epoch;

  // A layout effect: the ending is known in the commit that shows it (R3).
  useLayoutEffect(() => {
    const rec = ref.current!;
    const wasComplete = rec.complete;
    rec.complete = stageRef.current === 4;
    if (rec.complete && !wasComplete) send(rec, { type: 'completed' });
    const from = rec.counted;
    rec.counted = rec.reached;
    if (rec.reached <= from || !rec.answered || !loaded) return;
    rec.answered = false;
    // The step that was asked is the one answered; later steps a record already held were not.
    trackProductEvent('onboarding_step', { step: ONBOARDING_STEPS[from - 1] });
    if (rec.reached === 4) {
      send(rec, { type: 'ended' });
      trackProductEvent('onboarding_done');
      if (!planReadySeen()) setPlanReadyFor(rec.epoch);
    }
  });

  const answered = useCallback((lands: boolean) => {
    const rec = ref.current!;
    rec.answered = true;
    send(rec, { type: 'answered', lands });
  }, [send]);
  const rested = useCallback(() => send(ref.current!, { type: 'settled', complete: stageRef.current === 4 }), [send]);
  const left = useCallback(() => send(ref.current!, { type: 'left' }), [send]);
  const clearAnswered = useCallback(() => {
    const rec = ref.current!;
    rec.answered = false;
    send(rec, { type: 'foreign' });
  }, [send]);
  const profileLeft = useCallback(() => {
    if (stageRef.current !== 4 || low.current) return false;
    low.current = true; // a second leave before the move commits moves nothing either
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
    aboutYouLow: low.current,
    planReady: planReadyFor === epoch,
    answered, rested, left, clearAnswered, profileLeft, dismissPlanReady,
  };
}
