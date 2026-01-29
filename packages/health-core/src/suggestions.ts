import type { HealthInputs, HealthResults, Suggestion } from './types';

/**
 * Generate personalized health suggestions based on inputs and calculated results
 */
export function generateSuggestions(
  inputs: HealthInputs,
  results: HealthResults
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Always show protein target (core recommendation)
  suggestions.push({
    id: 'protein-target',
    category: 'nutrition',
    priority: 'info',
    title: `Daily protein target: ${results.proteinTarget}g`,
    description: `Based on your ideal body weight of ${results.idealBodyWeight}kg, aim for ${results.proteinTarget}g of protein daily. This supports muscle maintenance and metabolic health.`,
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

  // HbA1c suggestions
  if (inputs.hba1c !== undefined) {
    if (inputs.hba1c >= 6.5) {
      suggestions.push({
        id: 'hba1c-diabetic',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'HbA1c in diabetic range',
        description: `Your HbA1c of ${inputs.hba1c}% is ≥6.5%, indicating diabetes. This requires medical management and lifestyle intervention.`,
        discussWithDoctor: true,
      });
    } else if (inputs.hba1c >= 5.7) {
      suggestions.push({
        id: 'hba1c-prediabetic',
        category: 'bloodwork',
        priority: 'attention',
        title: 'HbA1c indicates prediabetes',
        description: `Your HbA1c of ${inputs.hba1c}% is in the prediabetic range (5.7-6.4%). Lifestyle changes now can prevent progression to diabetes.`,
        discussWithDoctor: true,
      });
    } else {
      suggestions.push({
        id: 'hba1c-normal',
        category: 'bloodwork',
        priority: 'info',
        title: 'HbA1c in normal range',
        description: `Your HbA1c of ${inputs.hba1c}% is in the normal range (<5.7%). Continue healthy habits to maintain this.`,
        discussWithDoctor: false,
      });
    }
  }

  // LDL cholesterol
  if (inputs.ldlC !== undefined) {
    if (inputs.ldlC >= 190) {
      suggestions.push({
        id: 'ldl-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high LDL cholesterol',
        description: `Your LDL of ${inputs.ldlC} mg/dL is significantly elevated (≥190). This may indicate familial hypercholesterolemia. Statin therapy is typically recommended.`,
        discussWithDoctor: true,
      });
    } else if (inputs.ldlC >= 160) {
      suggestions.push({
        id: 'ldl-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High LDL cholesterol',
        description: `Your LDL of ${inputs.ldlC} mg/dL is high (160-189). Consider lifestyle modifications and discuss medication options.`,
        discussWithDoctor: true,
      });
    } else if (inputs.ldlC >= 130) {
      suggestions.push({
        id: 'ldl-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high LDL cholesterol',
        description: `Your LDL of ${inputs.ldlC} mg/dL is borderline high (130-159). Optimal is <100 mg/dL for most adults.`,
        discussWithDoctor: false,
      });
    }
  }

  // HDL cholesterol
  if (inputs.hdlC !== undefined) {
    const lowThreshold = inputs.sex === 'male' ? 40 : 50;
    if (inputs.hdlC < lowThreshold) {
      suggestions.push({
        id: 'hdl-low',
        category: 'bloodwork',
        priority: 'attention',
        title: 'Low HDL cholesterol',
        description: `Your HDL of ${inputs.hdlC} mg/dL is below optimal (${lowThreshold} for ${inputs.sex === 'male' ? 'men' : 'women'}). Exercise and healthy fats can help raise HDL.`,
        discussWithDoctor: true,
      });
    }
  }

  // Triglycerides
  if (inputs.triglycerides !== undefined) {
    if (inputs.triglycerides >= 500) {
      suggestions.push({
        id: 'trig-very-high',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Very high triglycerides',
        description: `Your triglycerides of ${inputs.triglycerides} mg/dL are very high (≥500), increasing risk of pancreatitis. Immediate intervention is recommended.`,
        discussWithDoctor: true,
      });
    } else if (inputs.triglycerides >= 200) {
      suggestions.push({
        id: 'trig-high',
        category: 'bloodwork',
        priority: 'attention',
        title: 'High triglycerides',
        description: `Your triglycerides of ${inputs.triglycerides} mg/dL are elevated (200-499). Reducing refined carbs and alcohol can help.`,
        discussWithDoctor: true,
      });
    } else if (inputs.triglycerides >= 150) {
      suggestions.push({
        id: 'trig-borderline',
        category: 'bloodwork',
        priority: 'info',
        title: 'Borderline high triglycerides',
        description: `Your triglycerides of ${inputs.triglycerides} mg/dL are borderline (150-199). Optimal is <150 mg/dL.`,
        discussWithDoctor: false,
      });
    }
  }

  // Fasting glucose
  if (inputs.fastingGlucose !== undefined) {
    if (inputs.fastingGlucose >= 126) {
      suggestions.push({
        id: 'glucose-diabetic',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Fasting glucose in diabetic range',
        description: `Your fasting glucose of ${inputs.fastingGlucose} mg/dL is ≥126, indicating diabetes. This requires medical evaluation.`,
        discussWithDoctor: true,
      });
    } else if (inputs.fastingGlucose >= 100) {
      suggestions.push({
        id: 'glucose-prediabetic',
        category: 'bloodwork',
        priority: 'attention',
        title: 'Fasting glucose indicates prediabetes',
        description: `Your fasting glucose of ${inputs.fastingGlucose} mg/dL is in the prediabetic range (100-125). Lifestyle changes can help prevent diabetes.`,
        discussWithDoctor: true,
      });
    }
  }

  // Blood pressure
  if (inputs.systolicBp !== undefined && inputs.diastolicBp !== undefined) {
    const sys = inputs.systolicBp;
    const dia = inputs.diastolicBp;

    if (sys >= 180 || dia >= 120) {
      suggestions.push({
        id: 'bp-crisis',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Hypertensive crisis',
        description: `Your BP of ${sys}/${dia} mmHg is dangerously high. Seek immediate medical attention if accompanied by symptoms.`,
        discussWithDoctor: true,
      });
    } else if (sys >= 140 || dia >= 90) {
      suggestions.push({
        id: 'bp-stage2',
        category: 'bloodwork',
        priority: 'urgent',
        title: 'Stage 2 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 2 hypertension. Medication is typically recommended in addition to lifestyle changes.`,
        discussWithDoctor: true,
      });
    } else if (sys >= 130 || dia >= 80) {
      suggestions.push({
        id: 'bp-stage1',
        category: 'bloodwork',
        priority: 'attention',
        title: 'Stage 1 hypertension',
        description: `Your BP of ${sys}/${dia} mmHg indicates stage 1 hypertension. Lifestyle modifications are recommended. Target is <130/80.`,
        discussWithDoctor: true,
      });
    } else if (sys >= 120 && dia < 80) {
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
