import type { HealthInputs, HealthResults, Suggestion, MedicationInputs, ScreeningInputs } from './types';
import { SCREENING_INTERVALS, POST_FOLLOWUP_INTERVALS, SCREENING_FOLLOWUP_INFO, STATIN_DRUGS, canIncreaseDose, shouldSuggestSwitch, isOnMaxPotency, canIncreaseGlp1Dose, shouldSuggestGlp1Switch, isOnMaxGlp1Potency, getScreeningNextDueDate } from './types';
import {
  type UnitSystem,
  type MetricType,
  formatDisplayValue,
  getDisplayLabel,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  NON_HDL_THRESHOLDS,
  BP_THRESHOLDS,
  APOB_THRESHOLDS,
  EGFR_THRESHOLDS,
  LPA_THRESHOLDS,
} from './units';

/** On-treatment lipid targets (SI canonical units) */
export const LIPID_TREATMENT_TARGETS = {
  apobGl: 0.5,       // g/L (50 mg/dL)
  ldlMmol: 1.4,      // mmol/L (~54 mg/dL)
  nonHdlMmol: 1.6,   // mmol/L (~62 mg/dL)
} as const;

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
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const us = unitSystem;

  // === Always-show lifestyle suggestions ===

  // Protein target (core recommendation, adjusted for CKD)
  const isCkd = results.eGFR !== undefined && results.eGFR < EGFR_THRESHOLDS.mildlyDecreased;
  suggestions.push({
    id: 'protein-target',
    category: 'nutrition',
    priority: 'info',
    title: `Daily protein target: ${results.proteinTarget}g`,
    description: isCkd
      ? `Based on your ideal body weight of ${fmtWeight(results.idealBodyWeight, us)}, aim for ${results.proteinTarget}g of protein daily (1.0g per kg, adjusted for kidney function). Discuss with your doctor.`
      : `Based on your ideal body weight of ${fmtWeight(results.idealBodyWeight, us)}, aim for ${results.proteinTarget}g of protein daily. This supports muscle maintenance and metabolic health.`,
  });

  // Low salt — age-dependent threshold (matches BP target age cutoff)
  const saltThreshold = results.age !== undefined && results.age >= 65 ? 130 : 120;
  if (inputs.systolicBp !== undefined && inputs.systolicBp > saltThreshold) {
    suggestions.push({
      id: 'low-salt',
      category: 'nutrition',
      priority: 'info',
      title: 'Reduce sodium intake',
      description: 'Aim for less than 2,300mg of sodium daily. Most excess sodium comes from processed foods. Reducing sodium can help lower blood pressure.',
    });
  }

  // Fiber — always show
  suggestions.push({
    id: 'fiber',
    category: 'nutrition',
    priority: 'info',
    title: 'Maximize fiber intake',
    description: 'Aim for 25-35g of fiber daily from whole grains, fruits, and vegetables. Increase gradually to avoid discomfort. If you have IBS or IBD, discuss appropriate fiber levels with your doctor.',
  });

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
    (results.bmi !== undefined && results.bmi > 25 && whrForAlcohol !== undefined && whrForAlcohol >= 0.5) ||
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

  // Weight & diabetes medication cascade
  // When medications are tracked, use the cascade instead of standalone GLP-1 suggestion.
  // Trigger: BMI > 28 (unconditional) OR BMI 25-28 with secondary criteria
  if (results.bmi !== undefined && results.bmi > 25 && medications) {
    const whr = results.waistToHeightRatio;
    const hba1cElevated = inputs.hba1c !== undefined && inputs.hba1c >= HBA1C_THRESHOLDS.prediabetes;
    const trigsElevated = inputs.triglycerides !== undefined && inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline;
    const bpElevated = inputs.systolicBp !== undefined && inputs.systolicBp >= BP_THRESHOLDS.stage1Sys;
    const waistElevated = whr !== undefined && whr >= 0.5;

    const hasSecondaryCriteria = hba1cElevated || trigsElevated || bpElevated || waistElevated;

    if (results.bmi > 28 || hasSecondaryCriteria) {
      const glp1 = medications.glp1;
      const glp1Drug = glp1?.drug;
      const onGlp1 = glp1 && glp1Drug && glp1Drug !== 'none' && glp1Drug !== 'not_tolerated' && glp1Drug !== 'other';
      const glp1OnOther = glp1Drug === 'other';
      const glp1Handled = onGlp1 || glp1OnOther || glp1Drug === 'not_tolerated';

      const sglt2i = medications.sglt2i;
      const sglt2iDrug = sglt2i?.drug;
      const onSglt2i = sglt2i && sglt2iDrug && sglt2iDrug !== 'none' && sglt2iDrug !== 'not_tolerated';
      const sglt2iHandled = onSglt2i || sglt2iDrug === 'not_tolerated';

      // Step 1: GLP-1
      if (!glp1 || !glp1Drug || glp1Drug === 'none') {
        // Build reason string based on which criteria triggered
        const reasons: string[] = [];
        if (hba1cElevated) reasons.push('prediabetic HbA1c');
        if (trigsElevated) reasons.push('elevated triglycerides');
        if (bpElevated) reasons.push('elevated blood pressure');
        if (waistElevated) reasons.push('elevated waist-to-height ratio');
        const reasonStr = reasons.length > 0
          ? `an elevated BMI and ${reasons.join(', ')}`
          : 'an elevated BMI';

        suggestions.push({
          id: 'weight-med-glp1',
          category: 'medication',
          priority: 'attention',
          title: 'Consider a GLP-1 medication',
          description: `With ${reasonStr}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor. These medications support weight management and metabolic health.`,
        });
      } else if (glp1Handled) {
        // Step 2: GLP-1 Escalation (dose increase or switch to tirzepatide)
        const glp1Tolerated = glp1Drug !== 'not_tolerated';
        let canIncreaseGlp1 = false;
        let shouldSwitchGlp1 = glp1OnOther;
        if (onGlp1 && glp1 && glp1Drug) {
          canIncreaseGlp1 = canIncreaseGlp1Dose(glp1Drug, glp1.dose);
          shouldSwitchGlp1 = shouldSuggestGlp1Switch(glp1Drug, glp1.dose) || glp1OnOther;
        }
        const escalationPossible = glp1Tolerated && (canIncreaseGlp1 || shouldSwitchGlp1);

        if (escalationPossible && (!medications.glp1Escalation || medications.glp1Escalation === 'not_yet')) {
          if (canIncreaseGlp1) {
            suggestions.push({
              id: 'weight-med-glp1-increase',
              category: 'medication',
              priority: 'attention',
              title: 'Consider increasing GLP-1 dose',
              description: 'You may benefit from a higher dose of your current GLP-1 medication. Discuss increasing your dose with your doctor.',
            });
          } else if (shouldSwitchGlp1) {
            suggestions.push({
              id: 'weight-med-glp1-switch',
              category: 'medication',
              priority: 'attention',
              title: 'Consider switching to Tirzepatide',
              description: 'Tirzepatide (Mounjaro/Zepbound) may be more effective for weight management. Discuss switching with your doctor.',
            });
          }
        } else {
          // Escalation handled/skipped → Step 3: SGLT2i
          if (!sglt2i || !sglt2iDrug || sglt2iDrug === 'none') {
            suggestions.push({
              id: 'weight-med-sglt2i',
              category: 'medication',
              priority: 'attention',
              title: 'Consider adding an SGLT2 inhibitor',
              description: 'SGLT2 inhibitors like Empagliflozin or Dapagliflozin provide additional metabolic benefits and cardiovascular protection. Discuss with your doctor.',
            });
          } else if (sglt2iHandled) {
            // Step 4: Metformin
            if (!medications.metformin || medications.metformin === 'none') {
              suggestions.push({
                id: 'weight-med-metformin',
                category: 'medication',
                priority: 'info',
                title: 'Consider adding Metformin',
                description: 'Metformin provides additional glycemic control and has longevity benefits. Extended-release formulations may have fewer GI side effects. Discuss with your doctor.',
              });
            }
          }
        }
      }
    }
  }

  // GLP-1 medication suggestion for weight management (standalone — only when cascade is NOT active)
  // The cascade is active when: medications provided AND (BMI > 28 OR BMI 25-28 with secondary criteria)
  if (results.bmi !== undefined) {
    const whr = results.waistToHeightRatio;
    const cascadeActive = medications && results.bmi > 25 && (
      results.bmi > 28 ||
      (inputs.hba1c !== undefined && inputs.hba1c >= HBA1C_THRESHOLDS.prediabetes) ||
      (inputs.triglycerides !== undefined && inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline) ||
      (inputs.systolicBp !== undefined && inputs.systolicBp >= BP_THRESHOLDS.stage1Sys) ||
      (whr !== undefined && whr >= 0.5)
    );

    if (!cascadeActive) {
      if (results.bmi > 28) {
        suggestions.push({
          id: 'weight-glp1',
          category: 'medication',
          priority: 'attention',
          title: 'Weight management medication',
          description: 'With a BMI over 28, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, in addition to diet, exercise, and sleep optimization.',
        });
      } else if (results.bmi > 25) {
        // BMI 25-28: suggest if waist-to-height ≥ 0.5 or triglycerides elevated
        // Don't assume risk when waist data is missing — prompt for waist measurement instead
        const trigsElevated = inputs.triglycerides !== undefined &&
          inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline;
        const waistElevatedStandalone = whr !== undefined && whr >= 0.5;
        if (waistElevatedStandalone || trigsElevated) {
          const reason = waistElevatedStandalone
            ? 'elevated BMI and waist measurements'
            : 'elevated BMI and triglycerides';
          suggestions.push({
            id: 'weight-glp1',
            category: 'medication',
            priority: 'attention',
            title: 'Weight management medication',
            description: `With ${reason}, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, in addition to diet, exercise, and sleep optimization.`,
          });
        }
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
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us)} indicates diabetes. This requires medical management and lifestyle intervention.`,
      });
    } else if (inputs.hba1c >= HBA1C_THRESHOLDS.prediabetes) {
      suggestions.push({
        id: 'hba1c-prediabetic',
        category: 'bloodwork',
        priority: 'attention',
        title: 'HbA1c indicates prediabetes',
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us)} is in the prediabetic range. Lifestyle changes now can prevent progression to diabetes.`,
      });
    } else {
      suggestions.push({
        id: 'hba1c-normal',
        category: 'bloodwork',
        priority: 'info',
        title: 'HbA1c in normal range',
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us)} is in the normal range. Continue healthy habits to maintain this.`,
      });
    }
  }

  // === Atherogenic marker hierarchy: ApoB > non-HDL > LDL-c ===
  // Only show the best available marker. ApoB is the gold standard for
  // atherogenic particle burden; non-HDL is next best; LDL-c is fallback.
  const hasApoBData = inputs.apoB !== undefined;
  const hasNonHdlData = results.nonHdlCholesterol !== undefined;

  // Track whether an elevated atherogenic marker or medication cascade will
  // produce attention/urgent suggestions, so we can suppress total cholesterol
  const lipidMedCascadeActive = medications !== undefined && (
    (inputs.apoB !== undefined && inputs.apoB > LIPID_TREATMENT_TARGETS.apobGl) ||
    (inputs.ldlC !== undefined && inputs.ldlC > LIPID_TREATMENT_TARGETS.ldlMmol) ||
    (results.nonHdlCholesterol !== undefined && results.nonHdlCholesterol > LIPID_TREATMENT_TARGETS.nonHdlMmol)
  );
  let hasElevatedAtherogenicSuggestion = false;

  // ApoB (top of hierarchy — always shown when available)
  if (hasApoBData) {
    if (inputs.apoB! >= APOB_THRESHOLDS.veryHigh) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'apob-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB!, us)} is very high, indicating significantly elevated cardiovascular risk. Statin therapy and lifestyle intervention are typically recommended.`,
      });
    } else if (inputs.apoB! >= APOB_THRESHOLDS.high) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'apob-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB!, us)} is elevated. Consider lifestyle modifications and discuss treatment options to reduce cardiovascular risk.`,
      });
    } else if (inputs.apoB! >= APOB_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'apob-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB!, us)} is borderline. Optimal is <${formatDisplayValue('apob', APOB_THRESHOLDS.borderline, us)} ${getDisplayLabel('apob', us)}.`,
      });
    }
  }

  // LDL cholesterol — only when ApoB and non-HDL are both unavailable
  if (!hasApoBData && !hasNonHdlData && inputs.ldlC !== undefined) {
    if (inputs.ldlC >= LDL_THRESHOLDS.veryHigh) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'ldl-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high LDL cholesterol',
        description: `Your LDL of ${fmtLdl(inputs.ldlC, us)} is significantly elevated. This may indicate familial hypercholesterolemia. Statin therapy is typically recommended.`,
      });
    } else if (inputs.ldlC >= LDL_THRESHOLDS.high) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'ldl-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High LDL cholesterol',
        description: `Your LDL of ${fmtLdl(inputs.ldlC, us)} is high. Consider lifestyle modifications and discuss medication options.`,
      });
    } else if (inputs.ldlC >= LDL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'ldl-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high LDL cholesterol',
        description: `Your LDL of ${fmtLdl(inputs.ldlC, us)} is borderline high. Optimal is <${formatDisplayValue('ldl', 2.59, us)} ${getDisplayLabel('ldl', us)} for most adults.`,
      });
    }
  }

  // Non-HDL cholesterol — only when ApoB is unavailable
  // Uses 'ldl' for formatDisplayValue/getDisplayLabel since non-HDL shares the same units (mmol/L / mg/dL)
  if (!hasApoBData && hasNonHdlData) {
    if (results.nonHdlCholesterol! >= NON_HDL_THRESHOLDS.veryHigh) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'non-hdl-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol!, us)} ${getDisplayLabel('ldl', us)} is very high. This reflects total atherogenic particle burden and indicates significantly elevated cardiovascular risk.`,
      });
    } else if (results.nonHdlCholesterol! >= NON_HDL_THRESHOLDS.high) {
      hasElevatedAtherogenicSuggestion = true;
      suggestions.push({
        id: 'non-hdl-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol!, us)} ${getDisplayLabel('ldl', us)} is high. Consider lifestyle modifications to reduce cardiovascular risk.`,
      });
    } else if (results.nonHdlCholesterol! >= NON_HDL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'non-hdl-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol!, us)} ${getDisplayLabel('ldl', us)} is borderline. Optimal is <${formatDisplayValue('ldl', NON_HDL_THRESHOLDS.borderline, us)} ${getDisplayLabel('ldl', us)}.`,
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
      if (inputs.apoB !== undefined) {
        const onTarget = inputs.apoB <= LIPID_TREATMENT_TARGETS.apobGl;
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} ApoB: ${fmtApoB(inputs.apoB, us)} \u2014 target \u2264${fmtApoB(LIPID_TREATMENT_TARGETS.apobGl, us)}`);
      } else if (results.nonHdlCholesterol !== undefined) {
        const onTarget = results.nonHdlCholesterol <= LIPID_TREATMENT_TARGETS.nonHdlMmol;
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} Non-HDL: ${formatDisplayValue('ldl', results.nonHdlCholesterol, us)} ${getDisplayLabel('ldl', us)} \u2014 target \u2264${formatDisplayValue('ldl', LIPID_TREATMENT_TARGETS.nonHdlMmol, us)} ${getDisplayLabel('ldl', us)}`);
      } else if (inputs.ldlC !== undefined) {
        const onTarget = inputs.ldlC <= LIPID_TREATMENT_TARGETS.ldlMmol;
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} LDL: ${fmtLdl(inputs.ldlC, us)} \u2014 target \u2264${fmtLdl(LIPID_TREATMENT_TARGETS.ldlMmol, us)}`);
      } else {
        checklist.push('\u2753 Lipids \u2014 not tested (consider getting ApoB or a lipid panel)');
      }

      // Blood pressure
      if (inputs.systolicBp !== undefined && inputs.diastolicBp !== undefined) {
        const onTarget = inputs.systolicBp < 120 && inputs.diastolicBp < 80;
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} Blood pressure: ${inputs.systolicBp}/${inputs.diastolicBp} mmHg \u2014 target <120/80`);
      } else {
        checklist.push('\u2753 Blood pressure \u2014 not entered');
      }

      // BMI — consider healthy if <25 or if 25-29.9 with healthy waist-to-height ratio
      if (results.bmi !== undefined) {
        const lpaWhr = results.waistToHeightRatio;
        const onTarget = results.bmi < 25 || (results.bmi < 30 && lpaWhr !== undefined && lpaWhr < 0.5);
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} BMI: ${results.bmi} \u2014 target <25`);
      }

      // HbA1c
      if (inputs.hba1c !== undefined) {
        const onTarget = inputs.hba1c < HBA1C_THRESHOLDS.prediabetes;
        checklist.push(`${onTarget ? '\u2705' : '\u26A0\uFE0F'} HbA1c: ${fmtHba1c(inputs.hba1c, us)} \u2014 target <${fmtHba1c(HBA1C_THRESHOLDS.prediabetes, us)}`);
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
        description: `Your total cholesterol of ${fmtTotalChol(inputs.totalCholesterol, us)} is high. Desirable is <${formatDisplayValue('total_cholesterol', TOTAL_CHOLESTEROL_THRESHOLDS.borderline, us)} ${getDisplayLabel('total_cholesterol', us)}.`,
      });
    } else if (inputs.totalCholesterol >= TOTAL_CHOLESTEROL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'total-chol-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high total cholesterol',
        description: `Your total cholesterol of ${fmtTotalChol(inputs.totalCholesterol, us)} is borderline high. Desirable is <${formatDisplayValue('total_cholesterol', TOTAL_CHOLESTEROL_THRESHOLDS.borderline, us)} ${getDisplayLabel('total_cholesterol', us)}.`,
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
        description: `Your HDL of ${fmtHdl(inputs.hdlC, us)} is below optimal (${formatDisplayValue('hdl', lowThreshold, us)} ${getDisplayLabel('hdl', us)} for ${inputs.sex === 'male' ? 'men' : 'women'}). Exercise and healthy fats can help raise HDL.`,
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
      description: `Your triglycerides of ${fmtTrig(inputs.triglycerides, us)} are very high, increasing risk of pancreatitis. Immediate intervention is recommended.`,
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
    const bpWhr = results.waistToHeightRatio;
    if (results.bmi !== undefined && (results.bmi >= 30 || (results.bmi >= 25 && bpWhr !== undefined && bpWhr >= 0.5))) {
      bpExtraParagraphs.push('Weight loss is one of the most effective ways to lower blood pressure — even a 5% reduction can make a meaningful difference. GLP-1 medications (tirzepatide, semaglutide) can assist with both weight loss and blood pressure reduction.');
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
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 2 hypertension. Medication is typically recommended at this level.\n\nLifestyle measures that also help: reduce sodium intake (<2,300mg/day), exercise regularly, and prioritize quality sleep.${bpExtra}`,
      });
    } else if (sys >= BP_THRESHOLDS.stage1Sys || dia > BP_THRESHOLDS.stage1Dia) {
      const bpTarget = results.age !== undefined && results.age >= 65 ? '<130/80' : '<120/80';
      suggestions.push({
        id: 'bp-stage1',
        category: 'blood_pressure',
        priority: 'attention',
        title: 'Stage 1 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 1 hypertension. Target is ${bpTarget}.\n\nKey lifestyle measures: reduce sodium intake (<2,300mg/day), exercise regularly (150+ min/week), and prioritize quality sleep (7-9 hours).${bpExtra}`,
      });
    }
  }

  // === Medication cascade suggestions ===
  // Only when lipids are above on-treatment targets
  if (medications) {
    const nonHdl = results.nonHdlCholesterol;
    const lipidsElevated =
      (inputs.apoB !== undefined && inputs.apoB > LIPID_TREATMENT_TARGETS.apobGl) ||
      (inputs.ldlC !== undefined && inputs.ldlC > LIPID_TREATMENT_TARGETS.ldlMmol) ||
      (nonHdl !== undefined && nonHdl > LIPID_TREATMENT_TARGETS.nonHdlMmol);

    if (lipidsElevated) {
      const statin = medications.statin;
      const statinDrug = statin?.drug;
      // Check if drug is a known valid statin (handles old tier-based values like 'tier_1')
      const isValidStatinDrug = statinDrug && Object.hasOwn(STATIN_DRUGS, statinDrug);
      const isNotTolerated = statinDrug === 'not_tolerated';
      const statinTolerated = !isNotTolerated;
      const onStatin = statin && isValidStatinDrug;

      // Step 1: Statin (handle null/undefined/invalid drug from migration or missing data)
      // 'not_tolerated' is valid - user tried statins but can't take them
      if (!statin || !statinDrug || statinDrug === 'none' || (!isValidStatinDrug && !isNotTolerated)) {
        suggestions.push({
          id: 'med-statin',
          category: 'medication',
          priority: 'attention',
          title: 'Consider starting a statin',
          description: 'Your lipid levels are above target. Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.',
        });
      } else {
        // On a statin or not tolerated — Step 2: Ezetimibe
        const ezetimibeNotHandled = !medications.ezetimibe || medications.ezetimibe === 'no' || medications.ezetimibe === 'not_yet';
        if (ezetimibeNotHandled) {
          suggestions.push({
            id: 'med-ezetimibe',
            category: 'medication',
            priority: 'attention',
            title: 'Consider adding Ezetimibe',
            description: 'Your lipid levels remain above target. Discuss adding Ezetimibe 10mg with your doctor.',
          });
        } else {
          // Ezetimibe handled (yes or not tolerated) — Step 3: Escalate statin
          const canIncrease = onStatin && canIncreaseDose(statin.drug, statin.dose);
          const shouldSwitch = onStatin && shouldSuggestSwitch(statin.drug, statin.dose);
          const atMaxPotency = onStatin && isOnMaxPotency(statin.drug, statin.dose);

          if (statinTolerated && (canIncrease || shouldSwitch)) {
            if (!medications.statinEscalation || medications.statinEscalation === 'not_yet') {
              if (canIncrease) {
                suggestions.push({
                  id: 'med-statin-increase',
                  category: 'medication',
                  priority: 'attention',
                  title: 'Consider increasing statin dose',
                  description: 'Your lipid levels remain above target. Discuss increasing your statin dose with your doctor.',
                });
              } else if (shouldSwitch) {
                // Capitalize first letter of drug name
                const drugName = statin.drug.charAt(0).toUpperCase() + statin.drug.slice(1);
                suggestions.push({
                  id: 'med-statin-switch',
                  category: 'medication',
                  priority: 'attention',
                  title: 'Consider switching to a more potent statin',
                  description: `You're on the maximum dose of ${drugName}. Discuss switching to a more potent statin (e.g. Rosuvastatin) with your doctor.`,
                });
              }
            } else {
              // Statin escalation not tolerated — Step 4: PCSK9i
              if (!medications.pcsk9i || medications.pcsk9i === 'no' || medications.pcsk9i === 'not_yet') {
                suggestions.push({
                  id: 'med-pcsk9i',
                  category: 'medication',
                  priority: 'attention',
                  title: 'Consider a PCSK9 inhibitor',
                  description: 'Your lipid levels remain above target despite current medications. Discuss a PCSK9 inhibitor with your doctor.',
                });
              }
            }
          } else {
            // Already on max potency, statin not tolerated, or no escalation possible — go to PCSK9i
            if (!medications.pcsk9i || medications.pcsk9i === 'no' || medications.pcsk9i === 'not_yet') {
              suggestions.push({
                id: 'med-pcsk9i',
                category: 'medication',
                priority: 'attention',
                title: 'Consider a PCSK9 inhibitor',
                description: 'Your lipid levels remain above target despite current medications. Discuss a PCSK9 inhibitor with your doctor.',
              });
            }
          }
        }
      }
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

    function formatYYYYMM(yyyymm: string): string {
      const [y, m] = yyyymm.split('-').map(Number);
      if (!y || !m) return yyyymm;
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[m - 1]} ${y}`;
    }

    function nextDueStr(lastDate: string, method: string): string {
      const d = getScreeningNextDueDate(lastDate, method);
      if (!d) return '';
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[d.getMonth()]} ${d.getFullYear()}`;
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
          if (status === 'overdue') {
            suggestions.push({
              id: 'screening-colorectal-overdue',
              category: 'screening',
              priority: 'attention',
              title: 'Colorectal screening overdue',
              description: `Your next colorectal screening was due ${nextDueStr(screenings.colorectalLastDate, screenings.colorectalMethod)}. Please schedule your screening.`,
            });
          } else if (status === 'upcoming') {
            suggestions.push({
              id: 'screening-colorectal-upcoming',
              category: 'screening',
              priority: 'info',
              title: 'Colorectal screening up to date',
              description: `Next screening due ${nextDueStr(screenings.colorectalLastDate, screenings.colorectalMethod)}.`,
            });
          }
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
          if (status === 'overdue') {
            suggestions.push({
              id: 'screening-breast-overdue',
              category: 'screening',
              priority: 'attention',
              title: 'Mammogram overdue',
              description: `Your next mammogram was due ${nextDueStr(screenings.breastLastDate, screenings.breastFrequency)}. Please schedule your screening.`,
            });
          } else if (status === 'upcoming') {
            suggestions.push({
              id: 'screening-breast-upcoming',
              category: 'screening',
              priority: 'info',
              title: 'Mammogram up to date',
              description: `Next mammogram due ${nextDueStr(screenings.breastLastDate, screenings.breastFrequency)}.`,
            });
          }
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
          if (status === 'overdue') {
            suggestions.push({
              id: 'screening-cervical-overdue',
              category: 'screening',
              priority: 'attention',
              title: 'Cervical screening overdue',
              description: `Your next cervical screening was due ${nextDueStr(screenings.cervicalLastDate, screenings.cervicalMethod)}. Please schedule your screening.`,
            });
          } else if (status === 'upcoming') {
            suggestions.push({
              id: 'screening-cervical-upcoming',
              category: 'screening',
              priority: 'info',
              title: 'Cervical screening up to date',
              description: `Next screening due ${nextDueStr(screenings.cervicalLastDate, screenings.cervicalMethod)}.`,
            });
          }
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
          if (status === 'overdue') {
            suggestions.push({
              id: 'screening-lung-overdue',
              category: 'screening',
              priority: 'attention',
              title: 'Lung screening overdue',
              description: `Your next low-dose CT was due ${nextDueStr(screenings.lungLastDate, screenings.lungScreening)}. Please schedule your screening.`,
            });
          } else if (status === 'upcoming') {
            suggestions.push({
              id: 'screening-lung-upcoming',
              category: 'screening',
              priority: 'info',
              title: 'Lung screening up to date',
              description: `Next low-dose CT due ${nextDueStr(screenings.lungLastDate, screenings.lungScreening)}.`,
            });
          }
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
        if (status === 'overdue') {
          suggestions.push({
            id: 'screening-prostate-overdue',
            category: 'screening',
            priority: 'attention',
            title: 'PSA test overdue',
            description: `Your next PSA test was due ${nextDueStr(screenings.prostateLastDate, 'will_screen')}. Please schedule your test.`,
          });
        } else if (status === 'upcoming') {
          suggestions.push({
            id: 'screening-prostate-upcoming',
            category: 'screening',
            priority: 'info',
            title: 'PSA test up to date',
            description: `Next PSA test due ${nextDueStr(screenings.prostateLastDate, 'will_screen')}.`,
          });
        }
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
          if (status === 'overdue') {
            suggestions.push({
              id: 'screening-dexa-overdue',
              category: 'screening',
              priority: 'attention',
              title: 'Bone density scan overdue',
              description: `Your next DEXA scan was due ${nextDueStr(screenings.dexaLastDate, 'dexa_scan')}. Please schedule your scan.`,
            });
          } else if (status === 'upcoming') {
            suggestions.push({
              id: 'screening-dexa-upcoming',
              category: 'screening',
              priority: 'info',
              title: 'Bone density scan up to date',
              description: `Next DEXA scan due around ${nextDueStr(screenings.dexaLastDate, 'dexa_scan')}.`,
            });
          }
        }
      } else if (screenings.dexaResult === 'awaiting') {
        // Awaiting results — no action needed
      } else if (screenings.dexaLastDate) {
        // Normal or osteopenia — result-based interval
        const intervalKey = screenings.dexaResult === 'osteopenia' ? 'dexa_osteopenia' : 'dexa_normal';
        const status = screeningStatus(screenings.dexaLastDate, intervalKey);
        if (status === 'overdue') {
          suggestions.push({
            id: 'screening-dexa-overdue',
            category: 'screening',
            priority: 'attention',
            title: 'Bone density scan overdue',
            description: `Your next DEXA scan was due ${nextDueStr(screenings.dexaLastDate, intervalKey)}. Please schedule your scan.`,
          });
        } else if (status === 'upcoming') {
          suggestions.push({
            id: 'screening-dexa-upcoming',
            category: 'screening',
            priority: 'info',
            title: 'Bone density scan up to date',
            description: `Next DEXA scan due around ${nextDueStr(screenings.dexaLastDate, intervalKey)}.`,
          });
        }
      }
    }
  }

  // === Supplement suggestions (always shown) ===
  suggestions.push(
    {
      id: 'supplement-microvitamin',
      category: 'supplements',
      priority: 'info',
      title: 'MicroVitamin+',
      description: 'Daily all-in-one to support mental function, skin elasticity, exercise performance, and gut health.',
      link: 'https://drstanfield.com/products/microvitamin-plus',
    },
    {
      id: 'supplement-omega3',
      category: 'supplements',
      priority: 'info',
      title: 'Omega-3',
      description: 'Essential fatty acids for cardiovascular and brain health.',
      link: 'https://amzn.to/4kgwthG',
    },
    {
      id: 'supplement-sleep',
      category: 'supplements',
      priority: 'info',
      title: 'Sleep by Dr Brad',
      description: 'Support for quality sleep and recovery.',
      link: 'https://drstanfield.com/products/sleep',
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

  return suggestions;
}
