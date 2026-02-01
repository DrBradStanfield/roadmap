import type { HealthInputs, HealthResults, Suggestion } from './types';
import {
  type UnitSystem,
  formatDisplayValue,
  getDisplayLabel,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  GLUCOSE_THRESHOLDS,
  BP_THRESHOLDS,
} from './units';

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
function fmtGlucose(value: number, us: UnitSystem): string {
  return `${formatDisplayValue('fasting_glucose', value, us)} ${getDisplayLabel('fasting_glucose', us)}`;
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
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const us = unitSystem;

  // Always show protein target (core recommendation)
  suggestions.push({
    id: 'protein-target',
    category: 'nutrition',
    priority: 'info',
    title: `Daily protein target: ${results.proteinTarget}g`,
    description: `Based on your ideal body weight of ${fmtWeight(results.idealBodyWeight, us)}, aim for ${results.proteinTarget}g of protein daily. This supports muscle maintenance and metabolic health.`,
    discussWithDoctor: false,
  });

  // BMI-based suggestions
  if (results.bmi !== undefined) {
    if (results.bmi < 18.5) {
      suggestions.push({
        id: 'bmi-underweight',
        category: 'general',
        priority: 'attention',
        title: 'BMI indicates underweight',
        description: `Your BMI of ${results.bmi} is below the healthy range (18.5-24.9). Consider discussing nutrition strategies to reach a healthy weight.`,
        discussWithDoctor: true,
      });
    } else if (results.bmi >= 30) {
      suggestions.push({
        id: 'bmi-obese',
        category: 'general',
        priority: 'attention',
        title: 'BMI in obese range',
        description: `Your BMI of ${results.bmi} is in the obese range (≥30). This is associated with increased health risks. Consider discussing weight management strategies.`,
        discussWithDoctor: true,
      });
    } else if (results.bmi >= 25) {
      suggestions.push({
        id: 'bmi-overweight',
        category: 'general',
        priority: 'info',
        title: 'BMI indicates overweight',
        description: `Your BMI of ${results.bmi} is in the overweight range (25-29.9). Lifestyle modifications may help reduce health risks.`,
        discussWithDoctor: false,
      });
    }
  }

  // Waist-to-height ratio
  if (results.waistToHeightRatio !== undefined && results.waistToHeightRatio > 0.5) {
    suggestions.push({
      id: 'waist-height-elevated',
      category: 'general',
      priority: 'attention',
      title: 'Elevated waist-to-height ratio',
      description: `Your ratio of ${results.waistToHeightRatio} exceeds 0.5, which is associated with increased cardiometabolic risk. Reducing waist circumference can improve health outcomes.`,
      discussWithDoctor: true,
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

  // Fasting glucose (thresholds in mmol/L)
  if (inputs.fastingGlucose !== undefined) {
    if (inputs.fastingGlucose >= GLUCOSE_THRESHOLDS.diabetes) {
      suggestions.push({
        id: 'glucose-diabetic',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Fasting glucose in diabetic range',
        description: `Your fasting glucose of ${fmtGlucose(inputs.fastingGlucose, us)} indicates diabetes. This requires medical evaluation.`,
        discussWithDoctor: true,
      });
    } else if (inputs.fastingGlucose >= GLUCOSE_THRESHOLDS.prediabetes) {
      suggestions.push({
        id: 'glucose-prediabetic',
        category: 'bloodwork',
        priority: 'attention',
        title: 'Fasting glucose indicates prediabetes',
        description: `Your fasting glucose of ${fmtGlucose(inputs.fastingGlucose, us)} is in the prediabetic range. Lifestyle changes can help prevent diabetes.`,
        discussWithDoctor: true,
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

  return suggestions;
}
