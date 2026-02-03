import type { HealthInputs, HealthResults, Suggestion, MedicationInputs } from './types';
import { getStatinTier, MAX_STATIN_TIER } from './types';
import {
  type UnitSystem,
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

/** Format a blood-test value with its display unit, e.g. "5.7%" or "39 mmol/mol" */
function fmtHba1c(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('hba1c', value, us)} ${getDisplayLabel('hba1c', us)}`;
}
function fmtLdl(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('ldl', value, us)} ${getDisplayLabel('ldl', us)}`;
}
function fmtHdl(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('hdl', value, us)} ${getDisplayLabel('hdl', us)}`;
}
function fmtTrig(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('triglycerides', value, us)} ${getDisplayLabel('triglycerides', us)}`;
}
function fmtTotalChol(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('total_cholesterol', value, us)} ${getDisplayLabel('total_cholesterol', us)}`;
}
function fmtApoB(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('apob', value, us)} ${getDisplayLabel('apob', us)}`;
}
function fmtWeight(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('weight', value, us)} ${getDisplayLabel('weight', us)}`;
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
    discussWithDoctor: false,
  });

  // Low salt — only show if SBP ≥ 116
  if (inputs.systolicBp !== undefined && inputs.systolicBp >= 116) {
    suggestions.push({
      id: 'low-salt',
      category: 'nutrition',
      priority: 'info',
      title: 'Reduce sodium intake',
      description: 'Aim for less than 2,300mg of sodium daily. Most excess sodium comes from processed foods. Reducing sodium can help lower blood pressure.',
      discussWithDoctor: false,
    });
  }

  // Fiber — always show
  suggestions.push({
    id: 'fiber',
    category: 'nutrition',
    priority: 'info',
    title: 'Maximize fiber intake',
    description: 'Aim for 25-35g of fiber daily from whole grains, fruits, and vegetables. Increase gradually to avoid discomfort. If you have IBS or IBD, discuss appropriate fiber levels with your doctor.',
    discussWithDoctor: true,
  });

  // Exercise — always show
  suggestions.push({
    id: 'exercise',
    category: 'exercise',
    priority: 'info',
    title: 'Regular cardio and resistance training',
    description: 'Aim for at least 150 minutes of moderate-intensity cardio plus 2-3 resistance training sessions per week. This combination supports cardiovascular health, muscle mass, and metabolic function.',
    discussWithDoctor: false,
  });

  // High-potassium diet — only when eGFR ≥ 45 (safe kidney function)
  if (results.eGFR !== undefined && results.eGFR >= EGFR_THRESHOLDS.mildToModerate) {
    suggestions.push({
      id: 'high-potassium',
      category: 'nutrition',
      priority: 'info',
      title: 'Increase potassium-rich foods',
      description: 'Aim for 3,500–5,000mg of potassium daily from fruits, vegetables, and legumes. High potassium intake supports healthy blood pressure and cardiovascular function.',
      discussWithDoctor: true,
    });
  }

  // Sleep — always show
  suggestions.push({
    id: 'sleep',
    category: 'sleep',
    priority: 'info',
    title: 'Prioritize quality sleep',
    description: 'Aim for 7-9 hours of sleep per night. Maintain a consistent sleep schedule, limit screens before bed, and keep your bedroom cool and dark.',
    discussWithDoctor: false,
  });

  // GLP-1 medication suggestion for weight management (BMI status shown on snapshot tile)
  if (results.bmi !== undefined) {
    if (results.bmi > 27) {
      suggestions.push({
        id: 'weight-glp1',
        category: 'medication',
        priority: 'attention',
        title: 'Weight management medication',
        description: 'With a BMI over 27, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, in addition to diet, exercise, and sleep optimization.',
        discussWithDoctor: true,
      });
    } else if (results.bmi > 25) {
      // BMI 25-27: only suggest if waist-to-height ≥ 0.5 or waist data unavailable
      const whr = results.waistToHeightRatio;
      if (whr === undefined || whr >= 0.5) {
        suggestions.push({
          id: 'weight-glp1',
          category: 'medication',
          priority: 'attention',
          title: 'Weight management medication',
          description: 'With elevated BMI and waist measurements, you may benefit from discussing Tirzepatide (preferred) or Semaglutide with your doctor, in addition to diet, exercise, and sleep optimization.',
          discussWithDoctor: true,
        });
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
        discussWithDoctor: true,
      });
    } else if (inputs.hba1c >= HBA1C_THRESHOLDS.prediabetes) {
      suggestions.push({
        id: 'hba1c-prediabetic',
        category: 'bloodwork',
        priority: 'attention',
        title: 'HbA1c indicates prediabetes',
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us)} is in the prediabetic range. Lifestyle changes now can prevent progression to diabetes.`,
        discussWithDoctor: true,
      });
    } else {
      suggestions.push({
        id: 'hba1c-normal',
        category: 'bloodwork',
        priority: 'info',
        title: 'HbA1c in normal range',
        description: `Your HbA1c of ${fmtHba1c(inputs.hba1c, us)} is in the normal range. Continue healthy habits to maintain this.`,
        discussWithDoctor: false,
      });
    }
  }

  // LDL cholesterol (thresholds in mmol/L)
  if (inputs.ldlC !== undefined) {
    if (inputs.ldlC >= LDL_THRESHOLDS.veryHigh) {
      suggestions.push({
        id: 'ldl-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high LDL cholesterol',
        description: `Your LDL of ${fmtLdl(inputs.ldlC, us)} is significantly elevated. This may indicate familial hypercholesterolemia. Statin therapy is typically recommended.`,
        discussWithDoctor: true,
      });
    } else if (inputs.ldlC >= LDL_THRESHOLDS.high) {
      suggestions.push({
        id: 'ldl-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High LDL cholesterol',
        description: `Your LDL of ${fmtLdl(inputs.ldlC, us)} is high. Consider lifestyle modifications and discuss medication options.`,
        discussWithDoctor: true,
      });
    } else if (inputs.ldlC >= LDL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'ldl-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high LDL cholesterol',
        description: `Your LDL of ${fmtLdl(inputs.ldlC, us)} is borderline high. Optimal is <${formatDisplayValue('ldl', 2.59, us)} ${getDisplayLabel('ldl', us)} for most adults.`,
        discussWithDoctor: false,
      });
    }
  }

  // Total cholesterol (thresholds in mmol/L)
  if (inputs.totalCholesterol !== undefined) {
    if (inputs.totalCholesterol >= TOTAL_CHOLESTEROL_THRESHOLDS.high) {
      suggestions.push({
        id: 'total-chol-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High total cholesterol',
        description: `Your total cholesterol of ${fmtTotalChol(inputs.totalCholesterol, us)} is high. Desirable is <${formatDisplayValue('total_cholesterol', TOTAL_CHOLESTEROL_THRESHOLDS.borderline, us)} ${getDisplayLabel('total_cholesterol', us)}.`,
        discussWithDoctor: true,
      });
    } else if (inputs.totalCholesterol >= TOTAL_CHOLESTEROL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'total-chol-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high total cholesterol',
        description: `Your total cholesterol of ${fmtTotalChol(inputs.totalCholesterol, us)} is borderline high. Desirable is <${formatDisplayValue('total_cholesterol', TOTAL_CHOLESTEROL_THRESHOLDS.borderline, us)} ${getDisplayLabel('total_cholesterol', us)}.`,
        discussWithDoctor: false,
      });
    }
  }

  // Non-HDL cholesterol (calculated: total - HDL)
  if (results.nonHdlCholesterol !== undefined) {
    if (results.nonHdlCholesterol >= NON_HDL_THRESHOLDS.veryHigh) {
      suggestions.push({
        id: 'non-hdl-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol, us)} ${getDisplayLabel('ldl', us)} is very high. This reflects total atherogenic particle burden and indicates significantly elevated cardiovascular risk.`,
        discussWithDoctor: true,
      });
    } else if (results.nonHdlCholesterol >= NON_HDL_THRESHOLDS.high) {
      suggestions.push({
        id: 'non-hdl-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol, us)} ${getDisplayLabel('ldl', us)} is high. Consider lifestyle modifications to reduce cardiovascular risk.`,
        discussWithDoctor: true,
      });
    } else if (results.nonHdlCholesterol >= NON_HDL_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'non-hdl-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high non-HDL cholesterol',
        description: `Your non-HDL cholesterol of ${formatDisplayValue('ldl', results.nonHdlCholesterol, us)} ${getDisplayLabel('ldl', us)} is borderline. Optimal is <${formatDisplayValue('ldl', NON_HDL_THRESHOLDS.borderline, us)} ${getDisplayLabel('ldl', us)}.`,
        discussWithDoctor: false,
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
        discussWithDoctor: true,
      });
    }
  }

  // Triglycerides (thresholds in mmol/L)
  if (inputs.triglycerides !== undefined) {
    if (inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.veryHigh) {
      suggestions.push({
        id: 'trig-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high triglycerides',
        description: `Your triglycerides of ${fmtTrig(inputs.triglycerides, us)} are very high, increasing risk of pancreatitis. Immediate intervention is recommended.`,
        discussWithDoctor: true,
      });
    } else if (inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.high) {
      suggestions.push({
        id: 'trig-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High triglycerides',
        description: `Your triglycerides of ${fmtTrig(inputs.triglycerides, us)} are elevated. Reducing refined carbs and alcohol can help.`,
        discussWithDoctor: true,
      });
    } else if (inputs.triglycerides >= TRIGLYCERIDES_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'trig-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high triglycerides',
        description: `Your triglycerides of ${fmtTrig(inputs.triglycerides, us)} are borderline. Optimal is <${formatDisplayValue('triglycerides', TRIGLYCERIDES_THRESHOLDS.borderline, us)} ${getDisplayLabel('triglycerides', us)}.`,
        discussWithDoctor: false,
      });
    }
  }

  // ApoB (thresholds in g/L)
  if (inputs.apoB !== undefined) {
    if (inputs.apoB >= APOB_THRESHOLDS.veryHigh) {
      suggestions.push({
        id: 'apob-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB, us)} is very high, indicating significantly elevated cardiovascular risk. Statin therapy and lifestyle intervention are typically recommended.`,
        discussWithDoctor: true,
      });
    } else if (inputs.apoB >= APOB_THRESHOLDS.high) {
      suggestions.push({
        id: 'apob-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB, us)} is elevated. Consider lifestyle modifications and discuss treatment options to reduce cardiovascular risk.`,
        discussWithDoctor: true,
      });
    } else if (inputs.apoB >= APOB_THRESHOLDS.borderline) {
      suggestions.push({
        id: 'apob-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high ApoB',
        description: `Your ApoB of ${fmtApoB(inputs.apoB, us)} is borderline. Optimal is <${formatDisplayValue('apob', APOB_THRESHOLDS.borderline, us)} ${getDisplayLabel('apob', us)}.`,
        discussWithDoctor: false,
      });
    }
  }

  // Blood pressure (mmHg — same in both systems)
  if (inputs.systolicBp !== undefined && inputs.diastolicBp !== undefined) {
    const sys = inputs.systolicBp;
    const dia = inputs.diastolicBp;

    if (sys >= BP_THRESHOLDS.crisisSys || dia >= BP_THRESHOLDS.crisisDia) {
      suggestions.push({
        id: 'bp-crisis',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Hypertensive crisis',
        description: `Your BP of ${sys}/${dia} mmHg is dangerously high. Seek immediate medical attention if accompanied by symptoms.`,
        discussWithDoctor: true,
      });
    } else if (sys >= BP_THRESHOLDS.stage2Sys || dia >= BP_THRESHOLDS.stage2Dia) {
      suggestions.push({
        id: 'bp-stage2',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Stage 2 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 2 hypertension. Medication is typically recommended in addition to lifestyle changes.`,
        discussWithDoctor: true,
      });
    } else if (sys >= BP_THRESHOLDS.stage1Sys || dia >= BP_THRESHOLDS.stage1Dia) {
      suggestions.push({
        id: 'bp-stage1',
        category: 'bloodwork',
        priority: 'attention',
        title: 'Stage 1 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 1 hypertension. Lifestyle modifications are recommended. Target is <130/80.`,
        discussWithDoctor: true,
      });
    } else if (sys >= BP_THRESHOLDS.elevatedSys && dia < BP_THRESHOLDS.stage1Dia) {
      suggestions.push({
        id: 'bp-elevated',
        category: 'bloodwork',
        priority: 'info',
        title: 'Elevated blood pressure',
        description: `Your BP of ${sys}/${dia} mmHg is elevated. Lifestyle changes can help prevent progression to hypertension.`,
        discussWithDoctor: false,
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
      const statinTier = getStatinTier(medications.statin);
      const statinTolerated = medications.statin !== 'not_tolerated';

      // Step 1: Statin
      if (!medications.statin || medications.statin === 'none') {
        suggestions.push({
          id: 'med-statin',
          category: 'medication',
          priority: 'attention',
          title: 'Consider starting a statin',
          description: 'Your lipid levels are above target. Discuss starting a statin (e.g. Rosuvastatin 5mg) with your doctor.',
          discussWithDoctor: true,
        });
      } else {
        // On a statin or not tolerated — Step 2: Ezetimibe
        if (!medications.ezetimibe || medications.ezetimibe === 'no') {
          suggestions.push({
            id: 'med-ezetimibe',
            category: 'medication',
            priority: 'attention',
            title: 'Consider adding Ezetimibe',
            description: 'Your lipid levels remain above target. Discuss adding Ezetimibe 10mg with your doctor.',
            discussWithDoctor: true,
          });
        } else {
          // Ezetimibe handled (yes or not tolerated) — Step 3: Increase statin dose
          if (statinTolerated && statinTier > 0 && statinTier < MAX_STATIN_TIER) {
            if (!medications.statinIncrease || medications.statinIncrease === 'not_yet') {
              suggestions.push({
                id: 'med-statin-increase',
                category: 'medication',
                priority: 'attention',
                title: 'Consider increasing statin dose',
                description: 'Your lipid levels remain above target. Discuss increasing your statin dose with your doctor.',
                discussWithDoctor: true,
              });
            } else {
              // Statin increase not tolerated — Step 4: PCSK9i
              if (!medications.pcsk9i || medications.pcsk9i === 'no') {
                suggestions.push({
                  id: 'med-pcsk9i',
                  category: 'medication',
                  priority: 'attention',
                  title: 'Consider a PCSK9 inhibitor',
                  description: 'Your lipid levels remain above target despite current medications. Discuss a PCSK9 inhibitor with your doctor.',
                  discussWithDoctor: true,
                });
              }
            }
          } else {
            // Already on max statin or statin not tolerated — skip dose increase, go to PCSK9i
            if (!medications.pcsk9i || medications.pcsk9i === 'no') {
              suggestions.push({
                id: 'med-pcsk9i',
                category: 'medication',
                priority: 'attention',
                title: 'Consider a PCSK9 inhibitor',
                description: 'Your lipid levels remain above target despite current medications. Discuss a PCSK9 inhibitor with your doctor.',
                discussWithDoctor: true,
              });
            }
          }
        }
      }
    }
  }

  return suggestions;
}
