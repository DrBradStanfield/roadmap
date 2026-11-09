// Weight and diabetes medicine questions, one section of the form (moved out of InputPanel).
import { optionElements } from './form-kit';
import type { Placement } from './MyHealth';
import type { PlanBasis } from './InputPanel';
import { GLP1_NAMES, GLP1_DRUGS, SGLT2I_NAMES, SGLT2I_DRUGS, METFORMIN_OPTIONS, type MedicationInputs } from '@roadmap/health-core/types';
import { medicationsToInputs, type ApiMedication } from '@roadmap/health-core/mappings';
import { weightMedIntro } from '@roadmap/health-core/suggestions';
import { weightCascade } from '@roadmap/health-core/medication-cascades';
import { MEDICATION_TEXT, optionsShowing, escalationOptions, doseOptions } from '@roadmap/health-core/input-form';

interface WeightMedicationsProps {
  place: Placement;
  /** Sends one medication answer's writes, in order (health-core's rules). */
  writeMedication: (meds: MedicationInputs, cascadeMode: boolean, field: string, value: string) => void;
  medications: ApiMedication[];
  /** The plan's weight-medicine trigger sets cascade or flat mode (US-06 AC5); its BMI, the intro. */
  planBasis: PlanBasis | null;
}

// Weight and diabetes medications, for a plan whose trigger is on or with any
// relevant value entered. The caller checks both, so My health draws no empty topic (US-62 AC17).
export function WeightMedications(props: WeightMedicationsProps) {
  const { place, writeMedication, medications, planBasis } = props;

  // The call site decides this too, for its hide guard; derived here again so
  // TypeScript narrows weightMedTrigger in the cascade branch. Keep both.
  const weightMedTrigger = planBasis?.weightMedTrigger;
  const weightCascadeMode = !!weightMedTrigger?.on;

  const medInputs = medicationsToInputs(medications);
  const cascade = weightCascade(medInputs);

  const glp1Drug = medInputs.glp1?.drug ?? 'none';
  const glp1Dose = medInputs.glp1?.dose ?? null;
  const availableGlp1Doses = GLP1_DRUGS[glp1Drug]?.doses ?? [];
  const sglt2iDrug = medInputs.sglt2i?.drug ?? 'none';
  const sglt2iDose = medInputs.sglt2i?.dose ?? null;
  const availableSglt2iDoses = SGLT2I_DRUGS[sglt2iDrug]?.doses ?? [];

  // ── Shared medication dropdowns ──

  const glp1Dropdown = (
    <div className="health-field">
      <label htmlFor="glp1-name">{MEDICATION_TEXT.glp1Label}</label>
      {weightCascadeMode && <p className="med-step-hint">{cascade.suggest.includes('glp1-dose') ? MEDICATION_TEXT.doseHint : MEDICATION_TEXT.glp1Hint}</p>}
      <div className="statin-selection-row">
        <select
          id="glp1-name"
          value={glp1Drug}
          onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'glp1', e.target.value)}
        >
          {optionElements(optionsShowing(GLP1_NAMES, glp1Drug))}
        </select>
        {availableGlp1Doses.length > 0 && (
          <select
            id="glp1-dose"
            value={glp1Dose ?? ''}
            onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'glp1_dose', e.target.value)}
          >
            {optionElements(optionsShowing(doseOptions(availableGlp1Doses), glp1Dose === null ? '' : String(glp1Dose), 'Add dose'))}
          </select>
        )}
      </div>
      {place.on('glp1', 'glp1_dose')}
    </div>
  );

  const sglt2iDropdown = (
    <div className="health-field">
      <label htmlFor="sglt2i-name">{MEDICATION_TEXT.sglt2iLabel}</label>
      {weightCascadeMode && <p className="med-step-hint">{MEDICATION_TEXT.sglt2iHint}</p>}
      <div className="statin-selection-row">
        <select
          id="sglt2i-name"
          value={sglt2iDrug}
          onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'sglt2i', e.target.value)}
        >
          {optionElements(optionsShowing(SGLT2I_NAMES, sglt2iDrug))}
        </select>
        {availableSglt2iDoses.length > 0 && (
          <select
            id="sglt2i-dose"
            value={sglt2iDose ?? ''}
            onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'sglt2i_dose', e.target.value)}
          >
            {optionElements(optionsShowing(doseOptions(availableSglt2iDoses), sglt2iDose === null ? '' : String(sglt2iDose), 'Add dose'))}
          </select>
        )}
      </div>
      {place.on('sglt2i', 'sglt2i_dose')}
    </div>
  );

  const metforminDropdown = (
    <div className="health-field">
      <label htmlFor="metformin">{MEDICATION_TEXT.metforminLabel}</label>
      {weightCascadeMode && <p className="med-step-hint">{MEDICATION_TEXT.metforminHint}</p>}
      <select
        id="metformin"
        value={medInputs.metformin || 'none'}
        onChange={(e) => writeMedication(medInputs, weightCascadeMode, 'metformin', e.target.value)}
      >
        {optionElements(optionsShowing(METFORMIN_OPTIONS, medInputs.metformin || 'none'))}
      </select>
      {place.on('metformin')}
    </div>
  );

  const neutral = MEDICATION_TEXT.weightNeutral;

  // ── Flat mode: all fields visible independently ──
  if (!weightCascadeMode) {
    return (
      <div className="section-card">
        <section className="health-section">
          <h4 className="mh-group-label">{MEDICATION_TEXT.weightTitle}</h4>
          <p className="health-section-desc">{neutral}</p>
          {glp1Dropdown}
          {sglt2iDropdown}
          {metforminDropdown}
        </section>
      </div>
    );
  }

  // ── Cascade mode: progressive disclosure, the plan's own steps and words ──
  // Progressive disclosure opens the plan's next step; a step that
  // holds a recorded value always shows (US-06 AC7).
  const step = cascade.escalation;
  const showEscalation = !!step || medInputs.glp1Escalation !== undefined;

  return (
    <div className="section-card">
    <section className="health-section medication-cascade">
      <h4 className="mh-group-label">{MEDICATION_TEXT.weightTitle}</h4>
      <p className="health-section-desc">
        {/* It recommends only while the plan shows a step's card: with every
            step answered the trigger stays on and the plan shows none. */}
        {cascade.suggest.length === 0 ? neutral : weightMedIntro(planBasis!.bmi!, weightMedTrigger.reasons)}
      </p>

      {glp1Dropdown}

      {showEscalation && (
        <div className="health-field med-step-enter">
          <label htmlFor="glp1-escalation">
            {step ? MEDICATION_TEXT.glp1EscalationLabel[step] : MEDICATION_TEXT.escalationRecorded}
          </label>
          {step && (
            <p className="med-step-hint">
              {MEDICATION_TEXT.glp1EscalationHint[step]}
            </p>
          )}
          <select
            id="glp1-escalation"
            value={medInputs.glp1Escalation || 'not_yet'}
            onChange={e => writeMedication(medInputs, weightCascadeMode, 'glp1_escalation', e.target.value)}
          >
            {optionElements(optionsShowing(escalationOptions(step), medInputs.glp1Escalation || 'not_yet'))}
          </select>
          {place.on('glp1_escalation')}
        </div>
      )}

      {(cascade.sglt2iReached || medInputs.sglt2i !== undefined) && (
        <div className="med-step-enter">
          {sglt2iDropdown}
        </div>
      )}

      {(cascade.metforminReached || medInputs.metformin !== undefined) && (
        <div className="med-step-enter">
          {metforminDropdown}
        </div>
      )}
    </section>
    </div>
  );
}
