import type { HealthInputs, HealthResults, Suggestion, MedicationInputs, ScreeningInputs } from './types';
import { SCREENING_INTERVALS, POST_FOLLOWUP_INTERVALS, SCREENING_FOLLOWUP_INFO, STATIN_DRUGS, canIncreaseDose, shouldSuggestSwitch, isOnMaxPotency, canIncreaseGlp1Dose, shouldSuggestGlp1Switch, isOnMaxGlp1Potency } from './types';
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
} from './units';

/** On-treatment lipid targets (SI canonical units) */
export const LIPID_TREATMENT_TARGETS = {
  apobGl: 0.5,       // g/L (50 mg/dL)
  ldlMmol: 1.4,      // mmol/L (~54 mg/dL)
  nonHdlMmol: 1.4,   // mmol/L (~54 mg/dL)
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

  // Protein target (core recommendation)
  suggestions.push({
    id: 'protein-target',
    category: 'nutrition',
    priority: 'info',
    title: `Daily protein target: ${results.proteinTarget}g`,
    description: `Based on your ideal body weight of ${fmtWeight(results.idealBodyWeight, us)}, aim for ${results.proteinTarget}g of protein daily. This supports muscle maintenance and metabolic health.`,
  });

  // Low salt — only show if SBP ≥ 116
  if (inputs.systolicBp !== undefined && inputs.systolicBp >= 116) {
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
  if (results.eGFR !== undefined && results.eGFR >= EGFR_THRESHOLDS.mildToModerate) {
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
        const canIncreaseGlp1 = onGlp1 && canIncreaseGlp1Dose(glp1Drug!, glp1!.dose);
        const shouldSwitchGlp1 = (onGlp1 && shouldSuggestGlp1Switch(glp1Drug!, glp1!.dose)) || glp1OnOther;
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
        // BMI 25-28: suggest if waist-to-height ≥ 0.5, waist data unavailable, or triglycerides elevated
        const trigsElevated = inputs.triglycerides !== undefined &&
          inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline;
        if (whr === undefined || whr >= 0.5 || trigsElevated) {
          let reason: string;
          if (whr !== undefined && whr >= 0.5) {
            reason = 'elevated BMI and waist measurements';
          } else if (trigsElevated) {
            reason = 'elevated BMI and triglycerides';
          } else {
            reason = 'an elevated BMI';
          }
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
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 2 hypertension. Medication is typically recommended in addition to lifestyle changes.`,
      });
    } else if (sys >= BP_THRESHOLDS.stage1Sys || dia > BP_THRESHOLDS.stage1Dia) {
      const bpTarget = results.age !== undefined && results.age >= 65 ? '<130/80' : '<120/80';
      suggestions.push({
        id: 'bp-stage1',
        category: 'blood_pressure',
        priority: 'attention',
        title: 'Stage 1 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 1 hypertension. Lifestyle modifications are recommended. Target is ${bpTarget}.`,
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
      const isValidStatinDrug = statinDrug && statinDrug in STATIN_DRUGS;
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
      if (!lastDate || !method) return 'unknown';
      const intervalMonths = SCREENING_INTERVALS[method] ?? 12;
      const [year, month] = lastDate.split('-').map(Number);
      if (!year || !month) return 'unknown';
      const nextDue = new Date(year, month - 1 + intervalMonths);
      return new Date() > nextDue ? 'overdue' : 'upcoming';
    }

    function formatYYYYMM(yyyymm: string): string {
      const [y, m] = yyyymm.split('-').map(Number);
      if (!y || !m) return yyyymm;
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[m - 1]} ${y}`;
    }

    function nextDueStr(lastDate: string, method: string): string {
      const intervalMonths = SCREENING_INTERVALS[method] ?? 12;
      const [year, month] = lastDate.split('-').map(Number);
      if (!year || !month) return '';
      const d = new Date(year, month - 1 + intervalMonths);
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

    // Lung (age 50-80, smokers with 20+ pack-years)
    if (age >= 50 && age <= 80 &&
        (screenings.lungSmokingHistory === 'former_smoker' || screenings.lungSmokingHistory === 'current_smoker') &&
        screenings.lungPackYears !== undefined && screenings.lungPackYears >= 20) {
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
  }

  // === Supplement suggestions (always shown) ===
  suggestions.push(
    {
      id: 'supplement-microvitamin',
      category: 'supplements',
      priority: 'info',
      title: 'MicroVitamin+',
      description: 'Daily all-in-one to support mental function, skin elasticity, exercise performance, and gut health.',
      link: 'https://drstanfield.com/pages/my-supplements',
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

  return suggestions;
}
