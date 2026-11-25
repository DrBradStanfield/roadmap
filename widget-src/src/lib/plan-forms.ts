// The form's medicine and screening questions, as health-core builds them (US-62 AC20, AC40):
// HealthTool hands them to usePlanView, which places a suggestion on the question that asks it,
// and My health draws a question part only where they name it. InputPanel's renderers draw the
// same sections; InputPanel.plan-forms.test.tsx pins the two together, both ways.
import { medicationForm, screeningForm, type FormSection } from '@roadmap/health-core/input-form';
import { medicationsToInputs, METRIC_TO_FIELD, screeningsToInputs, type ApiMedication, type ApiScreening } from '@roadmap/health-core/mappings';
import type { HealthInputs } from '@roadmap/health-core/types';
import type { UnitSystem } from '@roadmap/health-core/units';
import type { PlanBasis } from '../components/InputPanel';

/** Which values open the medicine questions without a cascade: any lipid; HbA1c, triglycerides, or weight with height. */
export function medicineInputs(e: Partial<HealthInputs>): { hasLipidInput: boolean; hasWeightInput: boolean } {
  return {
    hasLipidInput: e.apoB !== undefined || e.ldlC !== undefined || e.totalCholesterol !== undefined || e.hdlC !== undefined,
    hasWeightInput: e.hba1c !== undefined || e.triglycerides !== undefined || (e.weightKg !== undefined && e.heightCm !== undefined),
  };
}

export interface PlanFormsInput extends ReturnType<typeof medicineInputs> {
  medications: ApiMedication[];
  screenings: ApiScreening[];
  planBasis: Partial<Pick<PlanBasis, 'age' | 'bmi' | 'lipidMarker' | 'weightMedTrigger'>> | null;
  sex: HealthInputs['sex'];
  unitOverrides: Partial<Record<string, UnitSystem>>;
  unitSystem: UnitSystem;
}

export function planForms({ medications, screenings, planBasis, sex, unitOverrides, unitSystem, hasLipidInput, hasWeightInput }: PlanFormsInput): { medications: FormSection[]; screenings: FormSection[] } {
  return {
    medications: medicationForm(medicationsToInputs(medications), {
      lipidMarker: planBasis?.lipidMarker ?? null,
      weightMedTrigger: planBasis?.weightMedTrigger ?? { on: false, reasons: [] },
      bmi: planBasis?.bmi,
      hasLipidInput,
      hasWeightInput,
      unitFor: (metric) => unitOverrides[METRIC_TO_FIELD[metric]] ?? unitSystem,
    }),
    screenings: screeningForm(planBasis?.age, sex, screeningsToInputs(screenings)),
  };
}
