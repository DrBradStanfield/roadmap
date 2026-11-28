/**
 * Card words that state the published guideline first and label where Dr Brad's
 * view goes further (US-07 AC23 to AC27). Doses, strengths and brand names stay off card
 * faces; Sources keep them. Each text is chosen by the predicates the plan already
 * uses (the weight trigger's reasons, the lipid cascade's statin state, the
 * eGFR bands), never by a new rule.
 */
import type { LipidStep, WeightStep } from './medication-cascades';
import { canIncreaseDose } from './types';
import { BMI_GUIDELINE_WITH_CONDITION, BMI_THRESHOLDS } from './bmi-thresholds';
import { EGFR_THRESHOLDS } from './units';

// ---------------------------------------------------------------- Lipids (L1, L9, L11)

type LipidKind = 'apoB' | 'nonHdl' | 'ldl';

/** How Dr Brad's lipid target compares with guideline goals: LDL-c's 1.4 mmol/L
 *  equals the very-high-risk goal; ApoB's and non-HDL's are lower than any. */
const lipidTargetVsGuideline = (kind: LipidKind) =>
  kind === 'ldl' ? 'the guideline goal for very high risk' : 'lower than guideline goals';

/** L1: the sentence that opens every cholesterol medicine card and the form's intro. */
export const lipidTargetText = (kind: LipidKind, label: string, value: string, target: string) =>
  `Your ${label} is ${value}. Guidelines set goals by heart risk. Dr Brad aims for below ${target}, ${lipidTargetVsGuideline(kind)}.`;

/** L9: a borderline lipid card. */
export const lipidBorderlineText = (kind: LipidKind, label: string, value: string, target: string) =>
  kind === 'ldl'
    ? `Your ${label} of ${value} is borderline high. Dr Brad aims for below ${target}, ${lipidTargetVsGuideline(kind)}.`
    : `Your ${label} of ${value} is borderline against Dr Brad's target of below ${target}, which is ${lipidTargetVsGuideline(kind)}.`;

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

// ---------------------------------------------------------------- Cholesterol medicines (L2 to L8)

/** The high-intensity statins whose top listed dose (types.ts STATIN_DRUGS) the
 *  2019 European guideline would also follow with Ezetimibe (L3 b). */
const HIGH_INTENSITY_STATINS: readonly string[] = ['atorvastatin', 'rosuvastatin'];

/** The statin state the lipid cascade reads (medication-cascades.ts), for the cards' words. */
interface StatinState { drug: string; dose: number | null }

/** L3: which Ezetimibe text. Not tolerated (c); a high-intensity statin at its top dose (b); else (a). */
function ezetimibeBranch({ drug, dose }: StatinState): 'not-tolerated' | 'top-dose' | 'before-top' {
  if (drug === 'not_tolerated') return 'not-tolerated';
  return HIGH_INTENSITY_STATINS.includes(drug) && dose !== null && !canIncreaseDose(drug, dose) ? 'top-dose' : 'before-top';
}

const capitalised = (drug: string) => drug.charAt(0).toUpperCase() + drug.slice(1);

/** Each cholesterol medicine card's title and text, after the L1 sentence. The
 *  pregnancy sentences are ruled words (US-07 AC14), passed in unchanged. */
export function lipidStepCard(step: LipidStep, statin: StatinState, switchesAtTop: boolean,
  pregnancy: { onStatin: string; unstudied: string }): [title: string, text: string] {
  const { onStatin, unstudied } = pregnancy;
  switch (step) {
    case 'statin': return ['Consider discussing a statin with your doctor',
      'Guidelines name a statin first. Dr Brad suggests a low-dose statin, such as Rosuvastatin, then Ezetimibe before a higher dose. Consider discussing a statin with your doctor. If you are pregnant or planning a pregnancy, talk to your doctor before starting a statin.'];
    case 'ezetimibe': {
      const branch = ezetimibeBranch(statin);
      const text = branch === 'top-dose'
        ? 'Adding Ezetimibe is the next step for Dr Brad and for the European guideline (ESC/EAS 2019). Consider discussing it with your doctor.'
        : branch === 'not-tolerated'
          ? 'When a statin is not tolerated, Dr Brad comes to Ezetimibe after a PCSK9 inhibitor. Consider discussing Ezetimibe with your doctor.'
          : 'The European guideline (ESC/EAS 2019) raises a statin to the highest tolerated dose before adding Ezetimibe. Dr Brad suggests discussing Ezetimibe with your doctor first.';
      return ['Consider discussing Ezetimibe with your doctor', `${text} ${unstudied}`];
    }
    case 'bempedoic-acid': return ['Consider discussing Bempedoic acid with your doctor',
      'Bempedoic acid lowers cholesterol by a different pathway than statins. Consider discussing it with your doctor. Not recommended in pregnancy; talk to your doctor if you are pregnant or planning to be.'];
    case 'statin-dose': return ['Add your statin dose', `${doseCardText('statin', switchesAtTop ? 'a more potent statin' : null)} ${onStatin}`];
    case 'statin-increase': return ['Consider discussing your statin dose with your doctor', `Consider discussing a higher statin dose with your doctor. ${onStatin}`];
    case 'statin-switch': return ['Consider discussing a more potent statin with your doctor',
      `You take the highest dose of ${capitalised(statin.drug)} this plan lists, or close to it. Consider discussing a more potent statin, such as Rosuvastatin, with your doctor. ${onStatin}`];
    case 'pcsk9i': return ['Consider discussing a PCSK9 inhibitor with your doctor', statin.drug === 'not_tolerated'
      ? `When a statin is not tolerated, Dr Brad suggests a PCSK9 inhibitor first. Consider discussing it with your doctor. ${unstudied}`
      : `Consider discussing a PCSK9 inhibitor with your doctor. ${unstudied}`];
  }
}

// ---------------------------------------------------------------- Weight and diabetes (W1 to W6)

/** The weight trigger's reason for a diabetes-range HbA1c (suggestions.ts weightMedicationTrigger). */
export const REASON_HBA1C_DIABETES = 'an HbA1c in the diabetes range';
export const REASON_HBA1C_PREDIABETES = 'an HbA1c in the prediabetes range';
/** Waist alone is not a weight-related condition here (Brad 2026-11-28, W1). */
export const REASON_WAIST = 'elevated waist-to-height ratio';

/**
 * W1, W2: where the BMI and the trigger's reasons sit against the guideline
 * line (BMI 30, or 27 with a weight-related condition). 'diabetes': a
 * diabetes-range HbA1c, where the medicines are licensed at any BMI.
 */
function weightMedBand(bmi: number, reasons: readonly string[]): 'diabetes' | 'guideline' | 'earlier' {
  if (reasons.includes(REASON_HBA1C_DIABETES)) return 'diabetes';
  const condition = reasons.some((r) => r !== REASON_WAIST);
  return bmi >= BMI_THRESHOLDS.obese || (bmi >= BMI_GUIDELINE_WITH_CONDITION && condition) ? 'guideline' : 'earlier';
}

const withReasons = (bmi: number, and: string) => `a BMI of ${bmi}${and}`;
const andReasons = (reasons: readonly string[], join: (items: string[]) => string) =>
  reasons.length > 0 ? ` and ${join([...reasons])}` : '';

/** W1: the GLP-1 card, the cascade's first step and the standalone card. */
export function glp1Description(bmi: number, reasons: readonly string[], join: (items: string[]) => string): string {
  const who = withReasons(bmi, andReasons(reasons, join));
  switch (weightMedBand(bmi, reasons)) {
    case 'diabetes': return `With ${who}: if type 2 diabetes is confirmed, Tirzepatide and Semaglutide are licensed for it at any BMI. Consider discussing them with your doctor, alongside diet, exercise and sleep.`;
    case 'guideline': return `With ${who}, guidelines consider a weight medicine once lifestyle changes alone have not been enough. Dr Brad raises it from the start, alongside diet, exercise and sleep. Consider discussing Tirzepatide or Semaglutide with your doctor.`;
    case 'earlier': return `Guidelines consider a weight medicine from a BMI of ${BMI_THRESHOLDS.obese}, or ${BMI_GUIDELINE_WITH_CONDITION} with a weight-related condition. With ${who}, Dr Brad raises it earlier, alongside diet, exercise and sleep. A doctor may not prescribe below the licensed levels. Consider discussing Tirzepatide or Semaglutide with your doctor.`;
  }
}

/** W2: the form's weight-medicine intro. */
export function weightMedIntroText(bmi: number, reasons: readonly string[], join: (items: string[]) => string): string {
  const at = `At ${withReasons(bmi, andReasons(reasons, join))}`;
  switch (weightMedBand(bmi, reasons)) {
    case 'diabetes': return `${at}, diabetes and weight medicines are an option to discuss with your doctor.`;
    case 'guideline': return `${at}, guidelines consider a weight medicine. It is an option to discuss with your doctor.`;
    case 'earlier': return `${at}, Dr Brad raises weight medicines earlier than guidelines do. They are an option to discuss with your doctor.`;
  }
}

/** W3 to W6: the later weight cascade cards, after the GLP-1 card. */
export function weightStepText(step: Exclude<WeightStep, 'glp1' | 'glp1-dose'>, reasons: readonly string[]): string {
  const diabetes = reasons.includes(REASON_HBA1C_DIABETES);
  switch (step) {
    case 'glp1-increase': return 'Consider discussing a higher dose of your GLP-1 medicine with your doctor, including its pros and cons.';
    case 'glp1-switch': return 'In a head-to-head trial, people lost more weight on Tirzepatide than on Semaglutide. Consider discussing switching to Tirzepatide with your doctor.';
    case 'sglt2i': return diabetes
      ? 'If type 2 diabetes is confirmed, SGLT2 inhibitors are licensed for it, and they also protect the heart and kidneys in some people. Consider discussing one, such as Empagliflozin or Dapagliflozin, with your doctor.'
      : `SGLT2 inhibitors are not licensed for weight loss, and guidelines advise against medicines for other conditions only to lose weight. Dr Brad includes them for heart and kidney benefits in some groups. Consider discussing one, such as Empagliflozin or Dapagliflozin, with your doctor.`;
    case 'metformin': return diabetes
      ? 'If type 2 diabetes is confirmed, Metformin is a long-used diabetes medicine. Extended-release forms may cause fewer stomach side effects. Consider discussing it with your doctor.'
      : reasons.includes(REASON_HBA1C_PREDIABETES)
        ? 'For prediabetes, diabetes guidelines consider Metformin for some people at high risk. In a large trial it cut the move to diabetes by about a third. Consider discussing it with your doctor.'
        : `Guidelines advise against medicines for other conditions only to lose weight. Dr Brad includes Metformin as a later step. Extended-release forms may cause fewer stomach side effects. Consider discussing it with your doctor.`;
  }
}

// ---------------------------------------------------------------- Blood pressure (B3)
// B1 and B2 keep their earlier words until the ACC/AHA 2025 goal wording is read in the guideline itself.

/** B3: the stage 1 and 2 cards' weight-medicine line. */
export const BP_WEIGHT_MEDICINE = ' GLP-1 medicines, such as Tirzepatide or Semaglutide, may also lower blood pressure. Consider discussing them with your doctor.';

// ---------------------------------------------------------------- Protein (P1 to P3)

const KDIGO_PROTEIN = 'With reduced kidney function, kidney guidelines (KDIGO 2024) suggest about 0.8 g of protein per kg of body weight a day.';

/**
 * P1 to P3: the protein card. `ckd` is the plan's own test, the one that lowers
 * the rate (eGFR below 45). `exactEgfr` is an eGFR not printed as a limit: 60 is
 * a label line, not a grading line (US-12 AC20), so only an exact value may pick
 * P2's words.
 */
export function proteinText(ckd: boolean, exactEgfr: number | undefined, grams: number, idealWeight: string): string {
  if (ckd) {
    return `${KDIGO_PROTEIN} Dr Brad lowers his target to ${grams}g a day, from your ideal body weight of ${idealWeight}. Discuss the right amount with your doctor.`;
  }
  if (exactEgfr !== undefined && exactEgfr < EGFR_THRESHOLDS.lowNormal) {
    return `${KDIGO_PROTEIN} Dr Brad suggests ${grams}g a day, from your ideal body weight of ${idealWeight}. Discuss the right amount with your doctor.`;
  }
  // P1 keeps its earlier words until the 0.8 g/kg allowance is read in the IOM text itself.
  return `Based on your ideal body weight of ${idealWeight}, aim for ${grams}g of protein daily. This supports muscle maintenance and metabolic health.`;
}

// ---------------------------------------------------------------- Skin and supplements (K1, K3, K4)

export const RETINOID_TEXT = 'Consider discussing a topical retinoid, such as Adapalene or Tretinoin, with your doctor or pharmacist. Retinoids are well studied for skin texture and collagen, and are used at night with daily sunscreen. They must not be used during pregnancy. Tretinoin needs a prescription.';

export const MULTIVITAMIN_VIEW = 'Suggesting a daily multivitamin is Dr Brad\'s view; no guideline recommends one for everyone.';
