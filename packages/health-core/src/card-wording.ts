/**
 * Card words that state the published guideline first and label where Dr Brad's
 * view goes further (US-07 AC23 to AC27). Doses, strengths and brand names leave
 * the faces of the cards this file words. Each text is chosen by a predicate the
 * plan already uses, never by a new rule. Cards whose wording is pending keep
 * their earlier words in suggestions.ts.
 */
import type { LipidStep } from './medication-cascades';

// ---------------------------------------------------------------- Lipids (L1, L10, L11)

type LipidKind = 'apoB' | 'nonHdl' | 'ldl';

/** How Dr Brad's lipid target compares with guideline goals: LDL-c's 1.4 mmol/L
 *  equals the very-high-risk goal; ApoB's and non-HDL's are lower than any. */
const lipidTargetVsGuideline = (kind: LipidKind) =>
  kind === 'ldl' ? 'the guideline goal for very high risk' : 'lower than guideline goals';

/** L1: the sentence that opens every cholesterol medicine card and the form's intro. */
export const lipidTargetText = (kind: LipidKind, label: string, value: string, target: string) =>
  `Your ${label} is ${value}. Guidelines set goals by heart risk. Dr Brad aims for below ${target}, ${lipidTargetVsGuideline(kind)}.`;

/** L11: the Lp(a) checklist's note on whose lipid target it shows. */
export const lpaLipidTargetNote = (kind: LipidKind, label: string) =>
  `The ${label} target is Dr Brad's, ${lipidTargetVsGuideline(kind)}.`;

/** L10: the very high lipid cards. */
export const LIPID_VERY_HIGH_RISK = 'Levels like this carry a much higher heart risk.';
export const LIPID_INHERITED = 'Levels this high can be inherited (familial hypercholesterolemia); your doctor can check.';

// ---------------------------------------------------------------- Dose cards (L5)

/** A dose card's text (US-06 AC8): `switchTo` names the next option at the
 *  highest dose; null when the highest dose moves on to the next medicine. */
export function doseCardText(kind: string, switchTo: string | null): string {
  return `Your ${kind} dose isn't recorded. ${switchTo
    ? `The next option to discuss with your doctor, a higher dose or ${switchTo}, depends on it. Add your dose to see which.`
    : 'Add it to see whether a higher dose is an option to discuss with your doctor.'}`;
}

// ---------------------------------------------------------------- Cholesterol medicines (L2, L4, L6 to L8)

const capitalised = (drug: string) => drug.charAt(0).toUpperCase() + drug.slice(1);

/** Each cholesterol medicine card's title and text, after the L1 sentence. The
 *  pregnancy sentences are ruled words (US-07 AC14), passed in unchanged. The
 *  Ezetimibe card and the PCSK9 inhibitor card with a statin not tolerated keep
 *  their earlier words (wording pending). */
export function lipidStepCard(step: LipidStep, statinDrug: string, switchesAtTop: boolean,
  pregnancy: { onStatin: string; unstudied: string }): [title: string, text: string] {
  const { onStatin, unstudied } = pregnancy;
  switch (step) {
    case 'statin': return ['Consider discussing a statin with your doctor',
      'Guidelines name a statin first. Dr Brad suggests a low-dose statin, such as Rosuvastatin. Consider discussing a statin with your doctor. If you are pregnant or planning a pregnancy, talk to your doctor before starting a statin.'];
    case 'ezetimibe': return ['Consider discussing Ezetimibe with your doctor', `Discuss adding Ezetimibe 10mg with your doctor. ${unstudied}`];
    case 'bempedoic-acid': return ['Consider discussing Bempedoic acid with your doctor',
      'Bempedoic acid lowers cholesterol by a different pathway than statins. Consider discussing it with your doctor. Not recommended in pregnancy; talk to your doctor if you are pregnant or planning to be.'];
    case 'statin-dose': return ['Add your statin dose', `${doseCardText('statin', switchesAtTop ? 'a more potent statin' : null)} ${onStatin}`];
    case 'statin-increase': return ['Consider discussing your statin dose with your doctor', `Consider discussing a higher statin dose with your doctor. ${onStatin}`];
    case 'statin-switch': return ['Consider discussing a more potent statin with your doctor',
      `You take the highest dose of ${capitalised(statinDrug)} this plan lists, or close to it. Consider discussing a more potent statin, such as Rosuvastatin, with your doctor. ${onStatin}`];
    case 'pcsk9i': return ['Consider discussing a PCSK9 inhibitor with your doctor', statinDrug === 'not_tolerated'
      ? `Discuss a PCSK9 inhibitor with your doctor. ${unstudied}`
      : `Consider discussing a PCSK9 inhibitor with your doctor. ${unstudied}`];
  }
}

// ---------------------------------------------------------------- Weight medicines (W3, W4)

/** W4: the GLP-1 increase card. */
export const GLP1_INCREASE_TEXT = 'Consider discussing a higher dose of your GLP-1 medicine with your doctor, including its pros and cons.';
/** W3: the switch card (SURMOUNT-5 tested Tirzepatide against Semaglutide only). */
export const GLP1_SWITCH_TEXT = 'In a head-to-head trial, people lost more weight on Tirzepatide than on Semaglutide. Consider discussing switching to Tirzepatide with your doctor.';

// ---------------------------------------------------------------- Skin (K1)

export const RETINOID_TEXT = 'Consider discussing a topical retinoid, such as Adapalene or Tretinoin, with your doctor or pharmacist. Retinoids are well studied for skin texture and collagen, and are used at night with daily sunscreen. They must not be used during pregnancy. Tretinoin needs a prescription.';
