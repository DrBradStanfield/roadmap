import type { HealthInputs, HealthResults, Suggestion, MedicationInputs, ScreeningInputs } from './types';
import { SUGGESTION_EVIDENCE } from './evidence';
import { POST_FOLLOWUP_INTERVALS, SCREENING_FOLLOWUP_INFO, getScreeningNextDueDate } from './types';
import { weightCascade, lipidCascade, type WeightStep, type LipidStep } from './medication-cascades';
import {
  type UnitSystem,
  type MetricType,
  formatDisplayValue,
  formatTargetLine,
  formatGradedValue,
  getDisplayLabel,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  NON_HDL_THRESHOLDS,
  BP_THRESHOLDS,
  APOB_THRESHOLDS,
  APOB_RISK_ENHANCING,
  LIPID_TREATMENT_TARGETS,
  isWaistToHeightElevated,
  bpTargetFor,
  EGFR_THRESHOLDS,
  LPA_THRESHOLDS,
} from './units';

/** Dietary advice for elevated lipids — shared between suggestion card and InputPanel medication cascade */
export const LIPID_DIET_ADVICE = 'Specific foods can lower LDL cholesterol: oats, walnuts, almonds, ground flaxseed, edamame, and replacing butter with extra-virgin olive oil. If you don\'t have IBS or IBD, beans, lentils, chickpeas, and mixed vegetables are also great options. Psyllium husk is a soluble fibre that is well-tolerated even with IBS or IBD; discuss with your doctor whether it fits your routine.';

/** Format a metric value with its display unit, e.g. "5.7%" or "39 mmol/mol" */
function fmtMetric(metricType: MetricType, value: number, us: UnitSystem): string {
  return `${formatDisplayValue(metricType, value, us)} ${getDisplayLabel(metricType, us)}`;
}

// Metric-specific aliases for readability
const fmtHba1c = (v: number, us: UnitSystem) => fmtMetric('hba1c', v, us);
const fmtLdl = (v: number, us: UnitSystem) => fmtMetric('ldl', v, us);
const fmtHdl = (v: number, us: UnitSystem) => fmtMetric('hdl', v, us);
const fmtTrig = (v: number, us: UnitSystem) => fmtMetric('triglycerides', v, us);
const fmtTotalChol = (v: number, us: UnitSystem) => fmtMetric('total_cholesterol', v, us);
const fmtApoB = (v: number, us: UnitSystem) => fmtMetric('apob', v, us);
const fmtWeight = (v: number, us: UnitSystem) => fmtMetric('weight', v, us);
/** A lipid target as a "<X" statement prints it: the first value, at the
 *  display step, that the plan grades at or above it (US-07 AC5). */
const fmtLipidTarget = (metric: MetricType, target: number, us: UnitSystem) =>
  `${formatTargetLine(metric, target, us)} ${getDisplayLabel(metric, us)}`;

/** Resolved lipid marker from the ApoB > non-HDL > LDL-c hierarchy */
export interface LipidMarker {
  kind: 'apoB' | 'nonHdl' | 'ldl';
  label: string;
  value: number;
  /** The on-treatment target: the value should be below it. */
  target: number;
  /** At or above the target (Brad, 2026-09-28: the target itself is above target, US-07 AC5). */
  elevated: boolean;
}

/** A lipid value at or above its on-treatment target: the target itself is
 *  above target (US-07 AC5). The plan's marker and its lipid-diet card both
 *  read this one test. */
function atOrAboveTarget(value: number | undefined, target: number): boolean {
  return value !== undefined && value >= target;
}

/** Map lipid marker kind to its MetricType for unit resolution and display
 *  (non-HDL shares LDL's units) */
function lipidMarkerMetric(marker: LipidMarker): MetricType {
  return marker.kind === 'apoB' ? 'apob' : 'ldl';
}

/** The marker's value as it prints beside its "<X" target: on the side of X
 *  the plan grades it, whatever unit it was entered in (US-07 AC5). */
function fmtMarkerValue(marker: LipidMarker, us: UnitSystem): string {
  const metric = lipidMarkerMetric(marker);
  return `${formatGradedValue(metric, marker.value, us, marker.target)} ${getDisplayLabel(metric, us)}`;
}

/** The plan's one lipid marker (ApoB, else non-HDL, else LDL), judged
 *  against its on-treatment target, from the validated inputs and the results
 *  the plan was computed from. Null with no lipid on record. */
export function lipidMarkerFor(
  inputs: Pick<HealthInputs, 'apoB' | 'ldlC'>,
  results: Pick<HealthResults, 'nonHdlCholesterol'>,
): LipidMarker | null {
  const mk = (kind: LipidMarker['kind'], label: string, value: number, target: number): LipidMarker =>
    ({ kind, label, value, target, elevated: atOrAboveTarget(value, target) });
  const T = LIPID_TREATMENT_TARGETS;
  if (inputs.apoB !== undefined) return mk('apoB', 'ApoB', inputs.apoB, T.apobGl);
  if (results.nonHdlCholesterol !== undefined) return mk('nonHdl', 'non-HDL cholesterol', results.nonHdlCholesterol, T.nonHdlMmol);
  if (inputs.ldlC !== undefined) return mk('ldl', 'LDL-c', inputs.ldlC, T.ldlMmol);
  return null;
}

/** "Your LDL-c is 3.0 mmol/L; the treatment target is below 1.4 mmol/L." The
 *  plan's cholesterol cards and the form's cholesterol intro both say it. */
export function lipidTargetSentence(marker: LipidMarker, unitFor: (metric: MetricType) => UnitSystem): string {
  const metric = lipidMarkerMetric(marker);
  const u = unitFor(metric);
  return `Your ${marker.label} is ${fmtMarkerValue(marker, u)}; the treatment target is below ${fmtLipidTarget(metric, marker.target, u)}.`;
}

/** Join a list the way the plan writes it: "a, b and c". */
export function joinWithAnd(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Raised blood pressure: systolic ≥130 or diastolic >80. Either half counts
 *  on its own; the BP card checks separately that it has both to display. */
function isBpRaised(systolic: number | undefined, diastolic: number | undefined): boolean {
  return (systolic !== undefined && systolic >= BP_THRESHOLDS.stage1Sys)
    || (diastolic !== undefined && diastolic > BP_THRESHOLDS.stage1Dia);
}

/** A lipid marker at its 2018 AHA/ACC risk-enhancing line (Table 6): ApoB
 *  ≥130 mg/dL, LDL-C ≥160 mg/dL, non-HDL-C ≥190 mg/dL. */
const LIPID_RISK_ENHANCING: Record<LipidMarker['kind'], { line: number; reason: string }> = {
  apoB: { line: APOB_RISK_ENHANCING, reason: 'elevated ApoB' },
  nonHdl: { line: NON_HDL_THRESHOLDS.high, reason: 'elevated non-HDL cholesterol' },
  ldl: { line: LDL_THRESHOLDS.high, reason: 'elevated LDL cholesterol' },
};

/** Overweight or Obese. getBMICategory counts BMI 25–29.9 with a
 *  waist-to-height ratio under 0.5 as Normal. */
function isBmiElevated(category: string | undefined): boolean {
  return category !== undefined && category !== 'Normal' && category !== 'Underweight';
}

/** Whether the weight and diabetes medication cascade is on, and why. */
export interface WeightMedicationTrigger {
  on: boolean;
  /** The raised markers beside the BMI, in the plan's words. Empty when off. */
  reasons: string[];
}

/**
 * The cascade's trigger (US-06 AC6): BMI 25 or more with a raised marker, or
 * an elevated BMI category with a BMI over 28. A healthy waist does not block
 * a raised marker. The plan and the input form both read it, so the form never
 * recommends what the plan does not (US-06 AC5). Pass the validated inputs
 * and the results the plan was computed from.
 */
export function weightMedicationTrigger(inputs: HealthInputs, results: HealthResults): WeightMedicationTrigger {
  const { bmi, waistToHeightRatio: whr } = results;
  if (bmi === undefined || bmi < 25) return { on: false, reasons: [] };
  const reasons: string[] = [];
  if (inputs.hba1c !== undefined && inputs.hba1c >= HBA1C_THRESHOLDS.prediabetes) reasons.push('prediabetic HbA1c');
  if (inputs.triglycerides !== undefined && inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline) reasons.push('elevated triglycerides');
  if (isBpRaised(inputs.systolicBp, inputs.diastolicBp)) reasons.push('elevated blood pressure');
  const lipid = lipidMarkerFor(inputs, results);
  if (lipid && lipid.value >= LIPID_RISK_ENHANCING[lipid.kind].line) reasons.push(LIPID_RISK_ENHANCING[lipid.kind].reason);
  if (whr !== undefined && isWaistToHeightElevated(whr)) reasons.push('elevated waist-to-height ratio');
  return { on: reasons.length > 0 || (isBmiElevated(results.bmiCategory) && bmi > 28), reasons };
}

/** The GLP-1 card's text, shared by the cascade's first step and the standalone card. */
function glp1Description(bmi: number, reasons: string[]): string {
  const and = reasons.length > 0 ? ` and ${joinWithAnd(reasons)}` : '';
  return `With a BMI of ${bmi}${and}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, alongside diet, exercise and sleep. These medications support weight management and metabolic health.`;
}

/** The form's weight-medication intro, in the plan's words: the BMI and the
 *  trigger's reasons, as the GLP-1 card names them (US-06 AC5). */
export function weightMedIntro(bmi: number, reasons: string[]): string {
  const and = reasons.length > 0 ? ` and ${joinWithAnd(reasons)} suggest` : ' suggests';
  return `Your BMI of ${bmi}${and} you may benefit from medications that support weight management and metabolic health.`;
}

/**
 * Generate personalized health suggestions based on inputs and calculated results.
 *
 * All input values and thresholds are in SI canonical units.
 * The `unitSystem` parameter controls how values are formatted in suggestion text.
 */
export function generateSuggestions(
  inputs: HealthInputs,
  results: HealthResults,
  unitSystem: UnitSystem = 'si',
  medications?: MedicationInputs,
  screenings?: ScreeningInputs,
  unitOverrides?: Partial<Record<MetricType, UnitSystem>>,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  /** Resolve effective unit system for a given metric (per-field override or global default) */
  const us = (metric: MetricType): UnitSystem => unitOverrides?.[metric] ?? unitSystem;

  // === Always-show lifestyle suggestions ===

  // Protein target (core recommendation, adjusted for CKD)
  const isCkd = results.eGFR !== undefined && results.eGFR < EGFR_THRESHOLDS.mildlyDecreased;
  suggestions.push({
    id: 'protein-target',
    category: 'nutrition',
    priority: 'info',
    title: `Daily protein target: ${results.proteinTarget}g`,
    description: isCkd
      ? `Based on your ideal body weight of ${fmtWeight(results.idealBodyWeight, us('weight'))}, aim for ${results.proteinTarget}g of protein daily (1.0g per kg, adjusted for kidney function). Discuss with your doctor.`
      : `Based on your ideal body weight of ${fmtWeight(results.idealBodyWeight, us('weight'))}, aim for ${results.proteinTarget}g of protein daily. This supports muscle maintenance and metabolic health.`,
  });

  // Low salt — above the age-dependent BP target
  if (inputs.systolicBp !== undefined && inputs.systolicBp > bpTargetFor(results.age)) {
    suggestions.push({
      id: 'low-salt',
      category: 'nutrition',
      priority: 'info',
      title: 'Reduce sodium intake',
      description: 'Aim for less than 1,500mg of sodium daily. Most excess sodium comes from processed foods. Reducing sodium can help lower blood pressure.',
    });
  }

  // Whether any atherogenic marker is at or above its on-treatment target, the
  // marker's own test (used for lipid-diet and fiber suppression, US-07 AC5)
  const hasElevatedLipids = atOrAboveTarget(inputs.apoB, LIPID_TREATMENT_TARGETS.apobGl)
    || atOrAboveTarget(results.nonHdlCholesterol, LIPID_TREATMENT_TARGETS.nonHdlMmol)
    || atOrAboveTarget(inputs.ldlC, LIPID_TREATMENT_TARGETS.ldlMmol);

  // Fiber — show when lipid-diet is not active (lipid-diet covers fiber advice more specifically)
  if (!hasElevatedLipids) {
    suggestions.push({
      id: 'fiber',
      category: 'nutrition',
      priority: 'info',
      title: 'Maximize fiber intake',
      description: 'Aim for 25-35g of fiber daily from whole grains, fruits, and vegetables. Increase gradually to avoid discomfort. If you have IBS or IBD, discuss appropriate fiber levels with your doctor.',
    });
  }

  // High-potassium diet — only when eGFR ≥ 45 (safe kidney function)
  if (results.eGFR !== undefined && results.eGFR >= EGFR_THRESHOLDS.mildlyDecreased) {
    suggestions.push({
      id: 'high-potassium',
      category: 'nutrition',
      priority: 'info',
      title: 'Increase potassium-rich foods',
      description: 'Aim for 3,500–5,000mg of potassium daily from fruits, vegetables, and legumes. High potassium intake supports healthy blood pressure and cardiovascular function.',
    });
  }

  // Lipid-lowering diet — specific foods when any atherogenic marker is borderline or above
  if (hasElevatedLipids) {
    suggestions.push({
      id: 'lipid-diet',
      category: 'nutrition',
      priority: 'info',
      title: 'Foods that lower cholesterol',
      description: LIPID_DIET_ADVICE,
    });
  }

  // Triglycerides nutrition advice — diet is first-line treatment for elevated trigs
  if (inputs.triglycerides !== undefined && inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline) {
    suggestions.push({
      id: 'trig-nutrition',
      category: 'nutrition',
      priority: 'attention',
      title: 'Reduce triglycerides with diet',
      description: 'Blood triglycerides are very diet-sensitive—improvements can be seen within 2-3 weeks. Key measures: limit alcohol, reduce sugar intake, and reduce total fat and calorie intake.',
    });
  }

  // Reduce alcohol — when obesity (BMI >= 30), or overweight with central adiposity, or triglycerides elevated
  const whrForAlcohol = results.waistToHeightRatio;
  if (
    (results.bmi !== undefined && results.bmi >= 30) ||
    (results.bmi !== undefined && results.bmi > 25 && whrForAlcohol !== undefined && isWaistToHeightElevated(whrForAlcohol)) ||
    (inputs.triglycerides !== undefined && inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline)
  ) {
    suggestions.push({
      id: 'reduce-alcohol',
      category: 'nutrition',
      priority: 'attention',
      title: 'Reduce alcohol intake',
      description: 'Reduce and ideally completely stop alcohol intake. Alcohol contributes to weight gain, elevated triglycerides, and increased blood pressure.',
    });
  }

  // Exercise — always show
  suggestions.push({
    id: 'exercise',
    category: 'exercise',
    priority: 'info',
    title: 'Regular cardio and resistance training',
    description: 'Aim for at least 150 minutes of moderate-intensity cardio plus 2-3 resistance training sessions per week. This combination supports cardiovascular health, muscle mass, and metabolic function.',
  });

  // Sleep — always show
  suggestions.push({
    id: 'sleep',
    category: 'sleep',
    priority: 'info',
    title: 'Prioritize quality sleep',
    description: 'Aim for 7-9 hours of sleep per night. Maintain a consistent sleep schedule, limit screens before bed, and keep your bedroom cool and dark.',
  });

  // GLP-1 weight management: the cascade when medications are tracked,
  // one standalone suggestion when they are not. Both read one trigger.
  const weightMeds = weightMedicationTrigger(inputs, results);
  if (weightMeds.on) {
    const glp1Text = glp1Description(results.bmi!, weightMeds.reasons);
    if (!medications) {
      suggestions.push({ id: 'weight-glp1', category: 'medication', priority: 'attention', title: 'Weight management medication', description: glp1Text });
    } else {
      // Weight & diabetes medication cascade (GLP-1 → escalate → SGLT2i → Metformin)
      const stepCards: Record<WeightStep, [priority: Suggestion['priority'], title: string, text: string]> = {
        glp1: ['attention', 'Consider a GLP-1 medication', glp1Text],
        'glp1-increase': ['attention', 'Consider increasing GLP-1 dose', 'You may benefit from a higher dose of your current GLP-1 medication. Discuss increasing your dose with your doctor.'],
        'glp1-switch': ['attention', 'Consider switching to Tirzepatide', 'Tirzepatide (Mounjaro/Zepbound) may be more effective for weight management. Discuss switching with your doctor.'],
        sglt2i: ['attention', 'Consider adding an SGLT2 inhibitor', 'SGLT2 inhibitors like Empagliflozin or Dapagliflozin provide additional metabolic benefits and cardiovascular protection. Discuss with your doctor.'],
        metformin: ['info', 'Consider adding Metformin', 'Metformin provides additional glycemic control and has longevity benefits. Extended-release formulations may have fewer GI side effects. Discuss with your doctor.'],
      };
      for (const step of weightCascade(medications).suggest) {
        const [priority, title, description] = stepCards[step];
        suggestions.push({ id: `weight-med-${step}`, category: 'medication', priority, title, description });
      }
    }
  }

  // Prompt to measure waist circumference when BMI 25-29.9 and waist data missing
  if (results.bmi !== undefined && results.bmi > 25 && results.bmi < 30 && results.waistToHeightRatio === undefined) {
    suggestions.push({
      id: 'measure-waist',
      category: 'general',
      priority: 'attention',
      title: 'Measure your waist circumference',
      description: 'With a BMI in the 25\u201330 range, waist circumference helps determine whether your body composition poses health risks. Keep your waist below half your height. Enter your waist measurement above for a more accurate assessment.',
    });
  }

  // HbA1c suggestions (thresholds in mmol/mol IFCC)
  if (inputs.hba1c !== undefined) {
    if (inputs.hba1c >= HBA1C_THRESHOLDS.diabetes) {
      suggestions.push({
        id: 'hba1c-diabetic',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'HbA1c in diabetic range',
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us('hba1c'))} indicates diabetes. This requires medical management and lifestyle intervention.`,
      });
    } else if (inputs.hba1c >= HBA1C_THRESHOLDS.prediabetes) {
      suggestions.push({
        id: 'hba1c-prediabetic',
        category: 'bloodwork',
        priority: 'attention',
        title: 'HbA1c indicates prediabetes',
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us('hba1c'))} is in the prediabetic range. Lifestyle changes now can prevent progression to diabetes.`,
      });
    } else {
      suggestions.push({
        id: 'hba1c-normal',
        category: 'bloodwork',
        priority: 'info',
        title: 'HbA1c in normal range',
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us('hba1c'))} is in the normal range. Continue healthy habits to maintain this.`,
      });
    }
  }

  // === Atherogenic marker hierarchy: ApoB > non-HDL > LDL-c ===
  // Only show the best available marker. ApoB is the gold standard for
  // atherogenic particle burden; non-HDL is next best; LDL-c is fallback.
  const hasApoBData = inputs.apoB !== undefined;
  const hasNonHdlData = results.nonHdlCholesterol !== undefined;
  const lipidMarker = lipidMarkerFor(inputs, results);

  // Track whether medication cascade will absorb lipid context,
  // so we can suppress standalone atherogenic marker cards and total cholesterol.
  // Only suppress when user has engaged with medication questions (statin status recorded).
  // When medications is {} (no statin decision), show both standalone cards and cascade.
  const statinStatusRecorded = medications?.statin?.drug !== undefined;
  const lipidMedCascadeActive = statinStatusRecorded && (lipidMarker?.elevated ?? false);
  let hasElevatedAtherogenicSuggestion = false;

  // ApoB (top of hierarchy — always shown when available)
  // Suppressed when medication cascade is active (cascade descriptions include specific values)
  if (hasApoBData && !lipidMedCascadeActive) {
    if (inputs.apoB! >= APOB_THRESHOLDS.veryHigh) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'apob-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB!, us('apob'))} is very high, indicating significantly elevated cardiovascular risk. Statin therapy and lifestyle intervention are typically recommended.`,
      });
    } else if (inputs.apoB! >= APOB_THRESHOLDS.high) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'apob-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB!, us('apob'))} is elevated. Consider lifestyle modifications and discuss treatment options to reduce cardiovascular risk.`,
      });
    } else if (inputs.apoB! >= APOB_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'apob-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB!, us('apob'))} is borderline. Optimal is <${fmtLipidTarget('apob', APOB_THRESHOLDS.borderline, us('apob'))}.`,
      });
    }
  }

  // LDL cholesterol — only when ApoB and non-HDL are both unavailable
  if (!hasApoBData && !hasNonHdlData && inputs.ldlC !== undefined && !lipidMedCascadeActive) {
    if (inputs.ldlC >= LDL_THRESHOLDS.veryHigh) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'ldl-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high LDL cholesterol',
        description: `Your LDL-c of ${fmtLdl(inputs.ldlC, us('ldl'))} is significantly elevated. This may indicate familial hypercholesterolemia. Statin therapy is typically recommended.`,
      });
    } else if (inputs.ldlC >= LDL_THRESHOLDS.high) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'ldl-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High LDL cholesterol',
        description: `Your LDL-c of ${fmtLdl(inputs.ldlC, us('ldl'))} is high. Consider lifestyle modifications and discuss medication options.`,
      });
    } else if (inputs.ldlC >= LDL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'ldl-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high LDL cholesterol',
        description: `Your LDL-c of ${fmtLdl(inputs.ldlC, us('ldl'))} is borderline high. Optimal is <${fmtLipidTarget('ldl', LIPID_TREATMENT_TARGETS.ldlMmol, us('ldl'))}.`,
      });
    }
  }

  // Non-HDL cholesterol — only when ApoB is unavailable
  // Uses 'ldl' for formatDisplayValue/getDisplayLabel since non-HDL shares the same units (mmol/L / mg/dL)
  if (!hasApoBData && hasNonHdlData && !lipidMedCascadeActive) {
    if (results.nonHdlCholesterol! >= NON_HDL_THRESHOLDS.veryHigh) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'non-hdl-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol!, us('ldl'))} ${getDisplayLabel('ldl', us('ldl'))} is very high. This reflects total atherogenic particle burden and indicates significantly elevated cardiovascular risk.`,
      });
    } else if (results.nonHdlCholesterol! >= NON_HDL_THRESHOLDS.high) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'non-hdl-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol!, us('ldl'))} ${getDisplayLabel('ldl', us('ldl'))} is high. Consider lifestyle modifications to reduce cardiovascular risk.`,
      });
    } else if (results.nonHdlCholesterol! >= NON_HDL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'non-hdl-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol!, us('ldl'))} ${getDisplayLabel('ldl', us('ldl'))} is borderline. Optimal is <${fmtLipidTarget('ldl', LIPID_TREATMENT_TARGETS.nonHdlMmol, us('ldl'))}.`,
      });
    }
  }

  // === Lp(a) — personalized risk context card ===
  // Lp(a) is genetic and unmodifiable. When elevated, show a personalized
  // checklist of modifiable risk factors showing which are on/off target.
  if (inputs.lpa !== undefined) {
    if (inputs.lpa >= LPA_THRESHOLDS.elevated) {
      const checklist: string[] = [];

      // Lipids (ApoB > non-HDL > LDL hierarchy, using on-treatment targets)
      if (lipidMarker) {
        const icon = lipidMarker.elevated ? '\u26A0\uFE0F' : '\u2705';
        const metric = lipidMarkerMetric(lipidMarker);
        const u = us(metric);
        checklist.push(`${icon} ${lipidMarker.label}: ${fmtMarkerValue(lipidMarker, u)} \u2014 target <${fmtLipidTarget(metric, lipidMarker.target, u)}`);
      } else {
        checklist.push('\u2753 Lipids \u2014 not tested (consider getting ApoB or a lipid panel)');
      }

      // Blood pressure, against the plan's age-dependent target
      if (inputs.systolicBp !== undefined && inputs.diastolicBp !== undefined) {
        const sysTarget = bpTargetFor(results.age);
        const onTarget = inputs.systolicBp < sysTarget && inputs.diastolicBp < 80;
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} Blood pressure: ${inputs.systolicBp}/${inputs.diastolicBp} mmHg \u2014 target <${sysTarget}/80`);
      } else {
        checklist.push('\u2753 Blood pressure \u2014 not entered');
      }

      // BMI — consider healthy if <25 or if 25-29.9 with healthy waist-to-height ratio
      if (results.bmi !== undefined) {
        const lpaWhr = results.waistToHeightRatio;
        const onTarget = results.bmi < 25 || (results.bmi < 30 && lpaWhr !== undefined && !isWaistToHeightElevated(lpaWhr));
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} BMI: ${results.bmi} \u2014 target <25`);
      }

      // HbA1c
      if (inputs.hba1c !== undefined) {
        const onTarget = inputs.hba1c < HBA1C_THRESHOLDS.prediabetes;
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} HbA1c: ${fmtHba1c(inputs.hba1c, us('hba1c'))} \u2014 target <${fmtHba1c(HBA1C_THRESHOLDS.prediabetes, us('hba1c'))}`);
      } else {
        checklist.push('\u2753 HbA1c \u2014 not tested');
      }

      // Medication status (only when medications are tracked)
      if (medications) {
        const statinDrug = medications.statin?.drug;
        if (statinDrug && statinDrug !== 'none' && statinDrug !== 'not_tolerated') {
          const name = statinDrug.charAt(0).toUpperCase() + statinDrug.slice(1);
          const doseStr = medications.statin?.dose ? ` ${medications.statin.dose}mg` : '';
          checklist.push(`\u2705 Statin: ${name}${doseStr}`);
        } else if (statinDrug === 'not_tolerated') {
          checklist.push('\u26A0\uFE0F Statin: not tolerated');
        } else {
          checklist.push('\u26A0\uFE0F Statin: not started \u2014 discuss with your doctor');
        }

        if (medications.ezetimibe === 'yes') {
          checklist.push('\u2705 Ezetimibe: taking');
        } else if (medications.ezetimibe === 'not_tolerated') {
          checklist.push('\u26A0\uFE0F Ezetimibe: not tolerated');
        } else {
          checklist.push('\u26A0\uFE0F Ezetimibe: not started \u2014 discuss with your doctor');
        }

        if (medications.pcsk9i === 'yes') {
          checklist.push('\u2705 PCSK9 inhibitor: taking (also lowers Lp(a) ~25\u201330%)');
        } else if (medications.pcsk9i === 'not_tolerated') {
          checklist.push('\u26A0\uFE0F PCSK9 inhibitor: not tolerated');
        } else {
          checklist.push('\u26A0\uFE0F PCSK9 inhibitor: not started \u2014 can lower Lp(a) ~25\u201330%');
        }
      }

      suggestions.push({
        id: 'lpa-elevated',
        category: 'bloodwork',
        priority: 'attention',
        title: `Elevated Lp(a): ${Math.round(inputs.lpa)} nmol/L`,
        description: `Lp(a) is genetically determined and cannot be changed by diet or lifestyle. With an elevated Lp(a), reducing all other modifiable cardiovascular risk factors is especially important.\n\nYour modifiable risk factors:\n${checklist.join('\n')}`,
      });
    } else if (inputs.lpa >= LPA_THRESHOLDS.normal) {
      suggestions.push({
        id: 'lpa-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: `Borderline Lp(a): ${Math.round(inputs.lpa)} nmol/L`,
        description: 'Your Lp(a) is in the borderline range (75\u2013125 nmol/L). Lp(a) is genetically determined and does not change with lifestyle. Continue to optimize other cardiovascular risk factors.',
      });
    } else {
      suggestions.push({
        id: 'lpa-normal',
        category: 'bloodwork',
        priority: 'info',
        title: `Lp(a): ${Math.round(inputs.lpa)} nmol/L`,
        description: 'Your Lp(a) is in the normal range (<75 nmol/L). This is a one-time test \u2014 Lp(a) is genetically determined and does not change significantly over time.',
      });
    }
  }

  // Total cholesterol — suppress when elevated atherogenic marker or medication cascade
  // provides actionable cholesterol suggestions (avoids redundant info in Foundation)
  if (inputs.totalCholesterol !== undefined && !hasElevatedAtherogenicSuggestion && !lipidMedCascadeActive) {
    if (inputs.totalCholesterol >= TOTAL_CHOLESTEROL_THRESHOLDS.high) {
      suggestions.push({
        id: 'total-chol-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High total cholesterol',
        description: `Your total cholesterol of ${fmtTotalChol(inputs.totalCholesterol, us('total_cholesterol'))} is high. Desirable is <${formatDisplayValue('total_cholesterol', TOTAL_CHOLESTEROL_THRESHOLDS.borderline, us('total_cholesterol'))} ${getDisplayLabel('total_cholesterol', us('total_cholesterol'))}.`,
      });
    } else if (inputs.totalCholesterol >= TOTAL_CHOLESTEROL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'total-chol-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high total cholesterol',
        description: `Your total cholesterol of ${fmtTotalChol(inputs.totalCholesterol, us('total_cholesterol'))} is borderline high. Desirable is <${formatDisplayValue('total_cholesterol', TOTAL_CHOLESTEROL_THRESHOLDS.borderline, us('total_cholesterol'))} ${getDisplayLabel('total_cholesterol', us('total_cholesterol'))}.`,
      });
    }
  }

  // HDL cholesterol (thresholds in mmol/L)
  if (inputs.hdlC !== undefined) {
    const lowThreshold = inputs.sex === 'male' ? HDL_THRESHOLDS.lowMale : HDL_THRESHOLDS.lowFemale;
    if (inputs.hdlC < lowThreshold) {
      suggestions.push({
        id: 'hdl-low',
        category: 'bloodwork',
        priority: 'attention',
        title: 'Low HDL cholesterol',
        description: `Your HDL of ${fmtHdl(inputs.hdlC, us('hdl'))} is below optimal (${us('hdl') === 'si' ? lowThreshold.toFixed(2) : formatDisplayValue('hdl', lowThreshold, us('hdl'))} ${getDisplayLabel('hdl', us('hdl'))} for ${inputs.sex === 'male' ? 'men' : 'women'}). Exercise and healthy fats can help raise HDL.`,
      });
    }
  }

  // Triglycerides — only show urgent warning for very high (pancreatitis risk)
  // Lower thresholds handled by trig-nutrition suggestion above
  if (inputs.triglycerides !== undefined && inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.veryHigh) {
    suggestions.push({
      id: 'trig-very-high',
      category: 'bloodwork',
      priority: 'urgent',
      title: 'Very high triglycerides',
      description: `Your triglycerides of ${fmtTrig(inputs.triglycerides, us('triglycerides'))} are very high, increasing risk of pancreatitis. Immediate intervention is recommended.`,
    });
  }

  // Blood pressure (mmHg — same in both systems)
  if (inputs.systolicBp !== undefined && inputs.diastolicBp !== undefined) {
    const sys = inputs.systolicBp;
    const dia = inputs.diastolicBp;

    // Build conditional lifestyle paragraphs for stage 1 & 2
    const bpExtraParagraphs: string[] = [];
    if (results.eGFR !== undefined && results.eGFR >= EGFR_THRESHOLDS.mildlyDecreased) {
      bpExtraParagraphs.push('Increase potassium-rich foods (3,500–5,000mg/day).');
    }
    if (weightMeds.on) {
      bpExtraParagraphs.push('Weight loss is one of the most effective ways to lower blood pressure. Even a 5% reduction can make a meaningful difference. GLP-1 medications (tirzepatide, semaglutide) can assist with both weight loss and blood pressure reduction.');
    }
    const bpExtra = bpExtraParagraphs.length > 0 ? '\n\n' + bpExtraParagraphs.join('\n\n') : '';

    if (sys >= BP_THRESHOLDS.crisisSys || dia >= BP_THRESHOLDS.crisisDia) {
      suggestions.push({
        id: 'bp-crisis',
        category: 'blood_pressure',
        priority: 'urgent',
        title: 'Hypertensive crisis',
        description: `Your BP of ${sys}/${dia} mmHg is dangerously high. Seek immediate medical attention if accompanied by symptoms.`,
      });
    } else if (sys >= BP_THRESHOLDS.stage2Sys || dia >= BP_THRESHOLDS.stage2Dia) {
      suggestions.push({
        id: 'bp-stage2',
        category: 'blood_pressure',
        priority: 'urgent',
        title: 'Stage 2 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 2 hypertension. Medication is typically recommended at this level.\n\nLifestyle measures that also help: reduce sodium intake (<1,500mg/day), exercise regularly, and prioritize quality sleep.${bpExtra}`,
      });
    } else if (isBpRaised(sys, dia)) {
      suggestions.push({
        id: 'bp-stage1',
        category: 'blood_pressure',
        priority: 'attention',
        title: 'Stage 1 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 1 hypertension. Target is <${bpTargetFor(results.age)}/80.\n\nKey lifestyle measures: reduce sodium intake (<1,500mg/day), exercise regularly (150+ min/week), and prioritize quality sleep (7-9 hours).${bpExtra}`,
      });
    }
  }

  // === Medication cascade suggestions ===
  // Only when lipids are at or above on-treatment targets (using resolved hierarchy marker)
  if (medications && lipidMarker?.elevated) {
    const lipidReason = lipidTargetSentence(lipidMarker, us);

    const statinDrug = medications.statin?.drug ?? '';
    const stepCards: Record<LipidStep, [title: string, text: string]> = {
      statin: ['Consider starting a statin', 'Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.'],
      ezetimibe: ['Consider adding Ezetimibe', 'Discuss adding Ezetimibe 10mg with your doctor.'],
      'bempedoic-acid': ['Consider adding bempedoic acid', 'Bempedoic acid (Nexletol) lowers cholesterol via a different pathway than statins. Discuss with your doctor.'],
      'statin-increase': ['Consider increasing statin dose', 'Discuss increasing your statin dose with your doctor.'],
      'statin-switch': ['Consider switching to a more potent statin', `You're on the maximum dose of ${statinDrug.charAt(0).toUpperCase() + statinDrug.slice(1)}. Discuss switching to a more potent statin (e.g. Rosuvastatin) with your doctor.`],
      pcsk9i: ['Consider a PCSK9 inhibitor', 'Discuss a PCSK9 inhibitor with your doctor.'],
    };
    // Statin → ezetimibe → bempedoic acid, then escalate the statin or a PCSK9 inhibitor
    for (const step of lipidCascade(medications).suggest) {
      const [title, text] = stepCards[step];
      suggestions.push({ id: `med-${step}`, category: 'medication', priority: 'attention', title, description: `${lipidReason} ${text}` });
    }
  }

  // === Cancer screening suggestions ===
  if (screenings && results.age !== undefined) {
    const age = results.age;
    const sex = inputs.sex;

    /** Check if a screening is overdue given its last date and method's interval. */
    function screeningStatus(lastDate: string | undefined, method: string | undefined): 'overdue' | 'upcoming' | 'unknown' {
      const nextDue = getScreeningNextDueDate(lastDate, method);
      if (!nextDue) return 'unknown';
      return new Date() > nextDue ? 'overdue' : 'upcoming';
    }

    function nextDueStr(lastDate: string, method: string): string {
      const d = getScreeningNextDueDate(lastDate, method);
      if (!d) return '';
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[d.getMonth()]} ${d.getFullYear()}`;
    }

    /** Push overdue/upcoming screening suggestion based on status. */
    function pushScreeningStatus(
      idPrefix: string, status: 'overdue' | 'upcoming' | 'unknown',
      overdueTitle: string, overdueDesc: string,
      upToDateTitle: string, upToDateDesc: string,
    ): void {
      if (status === 'overdue') {
        suggestions.push({ id: `screening-${idPrefix}-overdue`, category: 'screening', priority: 'attention', title: overdueTitle, description: overdueDesc });
      } else if (status === 'upcoming') {
        suggestions.push({ id: `screening-${idPrefix}-upcoming`, category: 'screening', priority: 'info', title: upToDateTitle, description: upToDateDesc });
      }
    }

    /**
     * Check if a screening has an abnormal result requiring follow-up.
     * Returns a suggestion if follow-up logic applies, or null to fall through to normal overdue/upcoming logic.
     */
    function screeningFollowup(
      type: string,
      method: string | undefined,
      result: string | undefined,
      followupStatus: string | undefined,
      followupDate: string | undefined,
    ): Suggestion | null {
      if (!result || result === 'normal' || result === 'awaiting') return null;

      // result === 'abnormal'
      const methodKey = method ? `${type}_${method}` : `${type}_other`;
      const info = SCREENING_FOLLOWUP_INFO[methodKey] ?? { followupName: 'follow-up', abnormalMeans: 'abnormal result' };
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      if (!followupStatus || followupStatus === 'not_organized') {
        return {
          id: `screening-${type}-followup`,
          category: 'screening',
          priority: 'urgent',
          title: `Organize ${info.followupName}`,
          description: `Your screening showed a ${info.abnormalMeans}. Please organize a ${info.followupName} with your doctor.`,
        };
      }

      if (followupStatus === 'scheduled') {
        return {
          id: `screening-${type}-followup`,
          category: 'screening',
          priority: 'info',
          title: `${type.charAt(0).toUpperCase() + type.slice(1)} follow-up scheduled`,
          description: `Your ${info.followupName} is scheduled. Keep your appointment.`,
        };
      }

      if (followupStatus === 'completed' && followupDate) {
        const postInterval = POST_FOLLOWUP_INTERVALS[methodKey] ?? POST_FOLLOWUP_INTERVALS[`${type}_other`] ?? 12;
        const [year, month] = followupDate.split('-').map(Number);
        if (year && month) {
          const nextDue = new Date(year, month - 1 + postInterval);
          const nextDueLabel = `${months[nextDue.getMonth()]} ${nextDue.getFullYear()}`;
          if (new Date() > nextDue) {
            return {
              id: `screening-${type}-followup`,
              category: 'screening',
              priority: 'attention',
              title: `${type.charAt(0).toUpperCase() + type.slice(1)} screening overdue`,
              description: `Following your ${info.abnormalMeans}, your next screening was due ${nextDueLabel}. Please schedule your screening.`,
            };
          }
          return {
            id: `screening-${type}-followup`,
            category: 'screening',
            priority: 'info',
            title: `${type.charAt(0).toUpperCase() + type.slice(1)} screening up to date`,
            description: `Following your ${info.abnormalMeans}, next screening due ${nextDueLabel}.`,
          };
        }
      }

      return null; // Fall through to default logic
    }

    // Colorectal (age 35-75)
    if (age >= 35 && age <= 75) {
      if (!screenings.colorectalMethod || screenings.colorectalMethod === 'not_yet_started') {
        suggestions.push({
          id: 'screening-colorectal',
          category: 'screening',
          priority: 'attention',
          title: 'Start colorectal cancer screening',
          description: 'Colorectal screening is recommended. Options include annual FIT testing or colonoscopy every 10 years. Discuss with your doctor.',
        });
      } else if (screenings.colorectalLastDate) {
        const followup = screeningFollowup('colorectal', screenings.colorectalMethod, screenings.colorectalResult, screenings.colorectalFollowupStatus, screenings.colorectalFollowupDate);
        if (followup) {
          suggestions.push(followup);
        } else {
          const status = screeningStatus(screenings.colorectalLastDate, screenings.colorectalMethod);
          const due = nextDueStr(screenings.colorectalLastDate, screenings.colorectalMethod);
          pushScreeningStatus('colorectal', status,
            'Colorectal screening overdue', `Your next colorectal screening was due ${due}. Please schedule your screening.`,
            'Colorectal screening up to date', `Next screening due ${due}.`);
        }
      }
    }

    // Breast (female, age 40+)
    if (sex === 'female' && age >= 40) {
      if (!screenings.breastFrequency || screenings.breastFrequency === 'not_yet_started') {
        suggestions.push({
          id: 'screening-breast',
          category: 'screening',
          priority: age >= 45 ? 'attention' : 'info',
          title: 'Start breast cancer screening',
          description: age >= 45
            ? 'Mammography is recommended at your age. Discuss with your doctor.'
            : 'Mammography is optional at your age (40\u201344). Discuss with your doctor.',
        });
      } else if (screenings.breastLastDate) {
        const followup = screeningFollowup('breast', screenings.breastFrequency, screenings.breastResult, screenings.breastFollowupStatus, screenings.breastFollowupDate);
        if (followup) {
          suggestions.push(followup);
        } else {
          const status = screeningStatus(screenings.breastLastDate, screenings.breastFrequency);
          const due = nextDueStr(screenings.breastLastDate, screenings.breastFrequency);
          pushScreeningStatus('breast', status,
            'Mammogram overdue', `Your next mammogram was due ${due}. Please schedule your screening.`,
            'Mammogram up to date', `Next mammogram due ${due}.`);
        }
      }
    }

    // Cervical (female, age 25-65)
    if (sex === 'female' && age >= 25 && age <= 65) {
      if (!screenings.cervicalMethod || screenings.cervicalMethod === 'not_yet_started') {
        suggestions.push({
          id: 'screening-cervical',
          category: 'screening',
          priority: 'attention',
          title: 'Start cervical cancer screening',
          description: 'HPV testing every 5 years (preferred) or Pap test every 3 years is recommended. Discuss with your doctor.',
        });
      } else if (screenings.cervicalLastDate) {
        const followup = screeningFollowup('cervical', screenings.cervicalMethod, screenings.cervicalResult, screenings.cervicalFollowupStatus, screenings.cervicalFollowupDate);
        if (followup) {
          suggestions.push(followup);
        } else {
          const status = screeningStatus(screenings.cervicalLastDate, screenings.cervicalMethod);
          const due = nextDueStr(screenings.cervicalLastDate, screenings.cervicalMethod);
          pushScreeningStatus('cervical', status,
            'Cervical screening overdue', `Your next cervical screening was due ${due}. Please schedule your screening.`,
            'Cervical screening up to date', `Next screening due ${due}.`);
        }
      }
    }

    // Lung (age 50-80, smokers with 15+ pack-years — USPSTF 2021)
    if (age >= 50 && age <= 80 &&
        (screenings.lungSmokingHistory === 'former_smoker' || screenings.lungSmokingHistory === 'current_smoker') &&
        screenings.lungPackYears !== undefined && screenings.lungPackYears >= 15) {
      if (!screenings.lungScreening || screenings.lungScreening === 'not_yet_started') {
        suggestions.push({
          id: 'screening-lung',
          category: 'screening',
          priority: 'attention',
          title: 'Start lung cancer screening',
          description: `With ${screenings.lungPackYears} pack-years of smoking history, annual low-dose CT screening is recommended. Discuss with your doctor.`,
        });
      } else if (screenings.lungLastDate) {
        const followup = screeningFollowup('lung', screenings.lungScreening, screenings.lungResult, screenings.lungFollowupStatus, screenings.lungFollowupDate);
        if (followup) {
          suggestions.push(followup);
        } else {
          const status = screeningStatus(screenings.lungLastDate, screenings.lungScreening);
          const due = nextDueStr(screenings.lungLastDate, screenings.lungScreening);
          pushScreeningStatus('lung', status,
            'Lung screening overdue', `Your next low-dose CT was due ${due}. Please schedule your screening.`,
            'Lung screening up to date', `Next low-dose CT due ${due}.`);
        }
      }
    }

    // Prostate (male, age 45+) — shared decision
    if (sex === 'male' && age >= 45) {
      if (!screenings.prostateDiscussion || screenings.prostateDiscussion === 'not_yet') {
        suggestions.push({
          id: 'screening-prostate',
          category: 'screening',
          priority: age >= 50 ? 'info' : 'info',
          title: 'Discuss prostate cancer screening',
          description: 'PSA testing is an option after an informed discussion with your doctor. Benefits and risks vary by individual.',
        });
      } else if (screenings.prostateDiscussion === 'will_screen' && screenings.prostateLastDate) {
        const status = screeningStatus(screenings.prostateLastDate, 'will_screen');
        const due = nextDueStr(screenings.prostateLastDate, 'will_screen');
        pushScreeningStatus('prostate', status,
          'PSA test overdue', `Your next PSA test was due ${due}. Please schedule your test.`,
          'PSA test up to date', `Next PSA test due ${due}.`);
      }

      // Elevated PSA warning
      if (screenings.prostatePsaValue !== undefined && screenings.prostatePsaValue > 4.0) {
        suggestions.push({
          id: 'screening-prostate-elevated',
          category: 'screening',
          priority: 'attention',
          title: 'Elevated PSA',
          description: `Your PSA of ${screenings.prostatePsaValue.toFixed(1)} ng/mL is above the typical reference range (\u22644.0). Discuss with your doctor \u2014 elevated PSA can have multiple causes.`,
        });
      }
    }

    // Endometrial — abnormal bleeding (urgent)
    if (sex === 'female' && age >= 45 && screenings.endometrialAbnormalBleeding === 'yes_need_to_report') {
      suggestions.push({
        id: 'screening-endometrial-bleeding',
        category: 'screening',
        priority: 'urgent',
        title: 'Report abnormal uterine bleeding',
        description: 'Abnormal uterine bleeding should be evaluated by your doctor promptly, especially after menopause.',
      });
    }

    // Endometrial — discussion reminder
    if (sex === 'female' && age >= 45 && (!screenings.endometrialDiscussion || screenings.endometrialDiscussion === 'not_yet')) {
      suggestions.push({
        id: 'screening-endometrial',
        category: 'screening',
        priority: 'info',
        title: 'Discuss endometrial cancer awareness',
        description: 'Women at menopause should be informed about the risks and symptoms of endometrial cancer. Discuss with your doctor.',
      });
    }

    // === Bone density (DEXA) screening ===
    // Separate section from cancer screening — women ≥50, men ≥70
    const dexaEligible = (sex === 'female' && age >= 50) || (sex === 'male' && age >= 70);

    if (dexaEligible) {
      if (!screenings.dexaScreening || screenings.dexaScreening === 'not_yet_started') {
        suggestions.push({
          id: 'screening-dexa',
          category: 'screening',
          priority: 'attention',
          title: 'Consider a DEXA bone density scan',
          description: 'A DEXA scan measures bone mineral density and can detect osteoporosis before a fracture occurs. Discuss with your doctor.',
        });
      } else if (screenings.dexaResult === 'osteoporosis') {
        // Osteoporosis — use follow-up pattern
        const followup = screeningFollowup('dexa', 'dexa_scan', 'abnormal', screenings.dexaFollowupStatus, screenings.dexaFollowupDate);
        if (followup) {
          suggestions.push(followup);
        } else if (screenings.dexaLastDate) {
          const status = screeningStatus(screenings.dexaLastDate, 'dexa_scan');
          const due = nextDueStr(screenings.dexaLastDate, 'dexa_scan');
          pushScreeningStatus('dexa', status,
            'Bone density scan overdue', `Your next DEXA scan was due ${due}. Please schedule your scan.`,
            'Bone density scan up to date', `Next DEXA scan due around ${due}.`);
        }
      } else if (screenings.dexaResult === 'awaiting') {
        // Awaiting results — no action needed
      } else if (screenings.dexaLastDate) {
        // Normal or osteopenia — result-based interval
        const intervalKey = screenings.dexaResult === 'osteopenia' ? 'dexa_osteopenia' : 'dexa_normal';
        const status = screeningStatus(screenings.dexaLastDate, intervalKey);
        const due = nextDueStr(screenings.dexaLastDate, intervalKey);
        pushScreeningStatus('dexa', status,
          'Bone density scan overdue', `Your next DEXA scan was due ${due}. Please schedule your scan.`,
          'Bone density scan up to date', `Next DEXA scan due around ${due}.`);
      }
    }
  }

  // === Supplement suggestions (always shown) ===
  // Generic, evidence-based ingredient profiles — no product names, no links.
  suggestions.push(
    {
      id: 'supplement-micronutrient-base',
      category: 'supplements',
      priority: 'info',
      title: 'Micronutrient base',
      description: 'A COSMOS trial sub-study (2023) found that a daily multivitamin improved cognitive function in older adults — evidence that broad micronutrient support may benefit brain health alongside filling common dietary gaps.',
      ingredients: [
        'Methylated B-complex',
        'Vitamin D3 with K2',
        'Magnesium taurate',
        'Trace minerals in glycinate form',
        'Lutein and zeaxanthin',
        'TMG (trimethylglycine)',
        'Lycopene',
      ],
    },
    {
      id: 'supplement-creatine',
      category: 'supplements',
      priority: 'info',
      title: 'Creatine',
      description: 'One of the most-studied supplements: a meta-analysis found creatine (3–5 g/day) significantly increases muscle strength and lean mass with resistance training, with emerging evidence for cognitive benefits.',
    },
    {
      id: 'supplement-collagen',
      category: 'supplements',
      priority: 'info',
      title: 'Collagen peptides',
      description: 'A 2023 meta-analysis of 26 randomised controlled trials found collagen peptides (10–15 g/day) improve skin hydration and elasticity compared with placebo.',
    },
    {
      id: 'supplement-omega3',
      category: 'supplements',
      priority: 'info',
      title: 'Omega-3',
      description: 'A meta-analysis of interventional trials found omega-3 (EPA/DHA) reduces cardiovascular events and cardiac death, with dose-dependent benefits strongest for EPA-rich formulations. Randomised trials also show omega-3 is needed for B vitamins to slow age-related brain atrophy.',
    },
    {
      id: 'supplement-sleep',
      category: 'supplements',
      priority: 'info',
      title: 'Sleep support',
      description: 'An umbrella review of meta-analyses found melatonin reduces the time taken to fall asleep and improves sleep quality, with a good safety profile — useful as part of a good sleep-hygiene routine.',
      ingredients: [
        'Low-dose melatonin',
        'Glycine',
        'Magnesium glycinate',
      ],
    },
  );

  // === Skin health suggestions (age 18+) ===
  if (results.age === undefined || results.age >= 18) {
    suggestions.push(
      {
        id: 'skin-moisturizer',
        category: 'skin',
        priority: 'info',
        title: 'Daily moisturizer with ceramides',
        description: 'Use a moisturizer containing ceramides and nicotinamide (vitamin B3) daily. Ceramides restore the skin barrier and reduce wrinkles, while nicotinamide improves hydration and reduces pigmentation.',
        link: 'https://amzn.to/47pGGmj',
      },
      {
        id: 'skin-sunscreen',
        category: 'skin',
        priority: 'info',
        title: 'Daily broad-spectrum sunscreen',
        description: unitSystem === 'conventional'
          ? 'Apply broad-spectrum SPF 50+ sunscreen daily to exposed skin. In the US, CeraVe 100% Mineral Sunscreen SPF 50 is a good option — mineral filters (zinc oxide, titanium dioxide) are FDA-recognized as safe and effective with no systemic absorption.'
          : 'Apply broad-spectrum SPF 50+ sunscreen daily to exposed skin. Beauty of Joseon Relief Sun SPF50+ PA++++ uses newer-generation chemical filters (Tinosorb S, Uvinul A Plus) that are photostable and do not absorb into the bloodstream.',
        link: unitSystem === 'conventional'
          ? 'https://www.amazon.com/Mineral-Sunscreen-Titanium-Dioxide-Sensitive/dp/B07KLY4RYG'
          : 'https://beautyofjoseon.com/products/relief-sun-rice-probiotics',
      },
      {
        id: 'skin-retinoid',
        category: 'skin',
        priority: 'info',
        title: 'Topical retinoid',
        description: 'A topical retinoid (adapalene 0.3% or tretinoin 0.05%) applied at night stimulates collagen production and improves skin texture. Start with 2–3 nights per week and increase as tolerated. Always use sunscreen when using retinoids. Caution: retinoids must not be used during pregnancy.',
      },
      {
        id: 'skin-advanced',
        category: 'skin',
        priority: 'info',
        title: 'Advanced skin treatments',
        description: 'For further skin rejuvenation, consider discussing these options with a dermatologist: red light therapy (LED, 630–850nm), fractional laser resurfacing, intense pulsed light (IPL) for pigmentation, and microneedling for collagen induction.',
      },
    );
  }

  // Attach clinical evidence (reason, guidelines, references) from evidence.ts
  for (const s of suggestions) {
    // Direct match first, then prefix match for screening variants (-overdue, -upcoming, -followup)
    const evidence = SUGGESTION_EVIDENCE[s.id]
      || SUGGESTION_EVIDENCE[s.id.replace(/-(?:overdue|upcoming|followup)$/, '')];
    if (evidence) {
      // Supplement cards already surface the trial summary in their visible
      // `description`, so the "Why this suggestion?" expansion shows only the
      // study citations (references) — no duplicated reason prose. Clinical
      // cards keep the full reason + guidelines + references.
      if (s.category !== 'supplements') {
        s.reason = evidence.reason;
        s.guidelines = evidence.guidelines;
      }
      s.references = evidence.references;
    }
  }

  return suggestions;
}
