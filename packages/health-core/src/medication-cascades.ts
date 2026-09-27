/**
 * The medication cascades' step decisions: which step the plan suggests now,
 * and how far the steps have opened. The plan's cards and the input form's
 * step disclosure read the same function, so the form never steps through
 * what the plan does not (US-06 AC5). Each cascade runs only while its
 * trigger is on: `weightMedicationTrigger`, or an elevated lipid marker.
 * Both answer in one shape: the steps the plan suggests now, which later
 * steps are open (`<step>Reached`), and how the current drug could step up
 * (`escalation`, null until the step before it is answered).
 */
import {
  STATIN_DRUGS,
  canIncreaseDose,
  shouldSuggestSwitch,
  canIncreaseGlp1Dose,
  shouldSuggestGlp1Switch,
  type MedicationInputs,
} from './types';

/** An escalation step stays open until it is answered with anything but "not yet". */
function escalationOpen(escalation: 'increase' | 'switch' | null, answer: string | undefined): boolean {
  return escalation !== null && (!answer || answer === 'not_yet');
}

/** A weight-medication step card; the plan's id is `weight-med-<step>`. */
export type WeightStep = 'glp1' | 'glp1-increase' | 'glp1-switch' | 'sglt2i' | 'metformin';

export interface WeightCascade {
  /** How the recorded GLP-1 could step up, answered or not; null until a GLP-1 is answered, or when it cannot. */
  escalation: 'increase' | 'switch' | null;
  /** The SGLT2 inhibitor step is open. */
  sglt2iReached: boolean;
  /** The metformin step is open. */
  metforminReached: boolean;
  /** The step the plan suggests now, one at most; empty once every step is answered. */
  suggest: WeightStep[];
}

/** GLP-1 → a higher dose or tirzepatide → SGLT2 inhibitor → metformin. */
export function weightCascade(meds: MedicationInputs): WeightCascade {
  const glp1 = meds.glp1;
  const glp1Drug = glp1?.drug;
  const glp1Answered = !!glp1Drug && glp1Drug !== 'none';
  const onOther = glp1Drug === 'other';
  const onGlp1 = glp1Answered && glp1Drug !== 'not_tolerated' && !onOther;
  const dose = glp1?.dose ?? null;
  const canIncrease = onGlp1 && canIncreaseGlp1Dose(glp1Drug, dose);
  const shouldSwitch = onOther || (onGlp1 && shouldSuggestGlp1Switch(glp1Drug, dose));
  const escalation = canIncrease ? 'increase' : shouldSwitch ? 'switch' : null;
  // Any answer but "not yet" moves on, as does a drug or dose with no step up.
  const escalating = escalationOpen(escalation, meds.glp1Escalation);

  const sglt2iReached = glp1Answered && !escalating;
  const sglt2iAnswered = !!meds.sglt2i?.drug && meds.sglt2i.drug !== 'none';
  const metforminReached = sglt2iReached && sglt2iAnswered;
  const metforminAnswered = !!meds.metformin && meds.metformin !== 'none';

  const step: WeightStep | null = !glp1Answered ? 'glp1'
    : escalating ? (escalation === 'increase' ? 'glp1-increase' : 'glp1-switch')
    : !sglt2iAnswered ? 'sglt2i'
    : !metforminAnswered ? 'metformin'
    : null;
  return { escalation, sglt2iReached, metforminReached, suggest: step ? [step] : [] };
}

/** A cholesterol-medication step card; the plan's id is `med-<step>`. */
export type LipidStep = 'statin' | 'ezetimibe' | 'bempedoic-acid' | 'statin-increase' | 'statin-switch' | 'pcsk9i';

export interface LipidCascade {
  /** A known statin, or not tolerated: the ezetimibe step is open. */
  ezetimibeReached: boolean;
  /** Ezetimibe answered too: the bempedoic acid step is open. */
  bempedoicAcidReached: boolean;
  /** How the recorded statin could step up, answered or not; null until
   *  ezetimibe is answered, or when it cannot. */
  escalation: 'increase' | 'switch' | null;
  /** The PCSK9 inhibitor step is open. */
  pcsk9iReached: boolean;
  /** The steps the plan suggests now, in its order. Empty once every open step is answered. */
  suggest: LipidStep[];
}

/** Statin → ezetimibe → bempedoic acid, and a higher dose or a stronger statin → PCSK9 inhibitor. */
export function lipidCascade(meds: MedicationInputs): LipidCascade {
  const statin = meds.statin;
  const statinDrug = statin?.drug;
  // hasOwnProperty.call, not Object.hasOwn: the widget must run on iOS WebKit
  // < 15.4, which lacks the ES2022 API. A legacy value such as 'tier_1' is
  // not a known statin, so the statin step stays open.
  const onStatin = !!statinDrug && Object.prototype.hasOwnProperty.call(STATIN_DRUGS, statinDrug);
  const statinAnswered = onStatin || statinDrug === 'not_tolerated';
  const ezetimibeAnswered = statinAnswered && !!meds.ezetimibe && meds.ezetimibe !== 'no' && meds.ezetimibe !== 'not_yet';

  const dose = statin?.dose ?? null;
  const escalation = !ezetimibeAnswered || !onStatin ? null
    : canIncreaseDose(statinDrug, dose) ? 'increase'
    : shouldSuggestSwitch(statinDrug, dose) ? 'switch'
    : null;
  const escalating = escalationOpen(escalation, meds.statinEscalation);
  const pcsk9iReached = ezetimibeAnswered && !escalating;

  const suggest: LipidStep[] = [];
  if (!statinAnswered) suggest.push('statin');
  else if (!ezetimibeAnswered) suggest.push('ezetimibe');
  else {
    const b = meds.bempedoicAcid;
    if (!b || b === 'not_yet' || b === 'none') suggest.push('bempedoic-acid');
    if (escalating) suggest.push(escalation === 'increase' ? 'statin-increase' : 'statin-switch');
    else if (!meds.pcsk9i || meds.pcsk9i === 'no' || meds.pcsk9i === 'not_yet') suggest.push('pcsk9i');
  }
  return { ezetimibeReached: statinAnswered, bempedoicAcidReached: ezetimibeAnswered, escalation, pcsk9iReached, suggest };
}
