// Cholesterol medicine questions, one section of the form (moved out of InputPanel).
import { optionElements } from './form-kit';
import type { Placement } from './MyHealth';
import { STATIN_NAMES, STATIN_DRUGS, EZETIMIBE_OPTIONS, PCSK9I_OPTIONS, BEMPEDOIC_ACID_OPTIONS, type MedicationInputs } from '@roadmap/health-core/types';
import { medicationsToInputs, type ApiMedication, METRIC_TO_FIELD } from '@roadmap/health-core/mappings';
import { type LipidMarker, LIPID_MEDS_IN_STEPS, lipidTargetSentence } from '@roadmap/health-core/suggestions';
import type { UnitSystem } from '@roadmap/health-core/units';
import { lipidCascade } from '@roadmap/health-core/medication-cascades';
import { MEDICATION_TEXT, optionsShowing, escalationOptions, doseOptions } from '@roadmap/health-core/input-form';

interface LipidMedicationsProps {
  place: Placement;
  /** Sends one medication answer's writes, in order (health-core's rules). */
  writeMedication: (meds: MedicationInputs, cascadeMode: boolean, field: string, value: string) => void;
  medications: ApiMedication[];
  /** The plan's lipid marker, which sets cascade or flat mode (US-06 AC5). */
  lipidMarker: LipidMarker | null | undefined;
  /** The unit a field shows in. */
  fieldUnit: (field: string) => UnitSystem;
}

// Cholesterol medications, for a plan with an elevated lipid marker or any lipid
// entered. The caller checks both, so My health draws no empty topic (US-62 AC17).
export function LipidMedications(props: LipidMedicationsProps) {
  const { place, writeMedication, medications, lipidMarker, fieldUnit } = props;

  // The call site decides this too, for its hide guard; derived here again so
  // TypeScript narrows lipidMarker in the cascade branch. Keep both.
  const cascadeMode = !!lipidMarker?.elevated;

  const medInputs = medicationsToInputs(medications);
  const cascade = lipidCascade(medInputs);
  const statin = medInputs.statin;
  const statinDrug = statin?.drug ?? 'none';
  const statinDose = statin?.dose ?? null;

  // Get available doses for current statin
  const availableDoses = STATIN_DRUGS[statinDrug]?.doses ?? [];

  // ── Shared medication dropdowns ──

  const statinDropdown = (
    <div className="health-field">
      <label htmlFor="statin-name">{MEDICATION_TEXT.statinLabel}</label>
      {cascadeMode && <p className="med-step-hint">{cascade.suggest.includes('statin-dose') ? MEDICATION_TEXT.doseHint : MEDICATION_TEXT.statinHint}</p>}
      <div className="statin-selection-row">
        <select
          id="statin-name"
          value={statinDrug}
          onChange={(e) => writeMedication(medInputs, cascadeMode, 'statin', e.target.value)}
        >
          {optionElements(optionsShowing(STATIN_NAMES, statinDrug))}
        </select>
        {availableDoses.length > 0 && (
          <select
            id="statin-dose"
            value={statinDose ?? ''}
            onChange={(e) => writeMedication(medInputs, cascadeMode, 'statin_dose', e.target.value)}
          >
            {optionElements(optionsShowing(doseOptions(availableDoses), statinDose === null ? '' : String(statinDose), 'Add dose'))}
          </select>
        )}
      </div>
      {place.on('statin', 'statin_dose')}
    </div>
  );

  const ezetimibeDropdown = (
    <div className="health-field">
      <label htmlFor="ezetimibe">{MEDICATION_TEXT.ezetimibeLabel}</label>
      <select
        id="ezetimibe"
        value={medInputs.ezetimibe || 'not_yet'}
        onChange={e => writeMedication(medInputs, cascadeMode, 'ezetimibe', e.target.value)}
      >
        {optionElements(optionsShowing(EZETIMIBE_OPTIONS, medInputs.ezetimibe || 'not_yet'))}
      </select>
      {place.on('ezetimibe')}
    </div>
  );

  const pcsk9iDropdown = (
    <div className="health-field">
      <label htmlFor="pcsk9i">{MEDICATION_TEXT.pcsk9iLabel}</label>
      <select
        id="pcsk9i"
        value={medInputs.pcsk9i || 'not_yet'}
        onChange={e => writeMedication(medInputs, cascadeMode, 'pcsk9i', e.target.value)}
      >
        {optionElements(optionsShowing(PCSK9I_OPTIONS, medInputs.pcsk9i || 'not_yet'))}
      </select>
      {place.on('pcsk9i')}
    </div>
  );

  const bempedoicAcidDropdown = (
    <div className="health-field">
      <label htmlFor="bempedoic-acid">{MEDICATION_TEXT.bempedoicAcidLabel}</label>
      <select
        id="bempedoic-acid"
        value={medInputs.bempedoicAcid || 'not_yet'}
        onChange={e => writeMedication(medInputs, cascadeMode, 'bempedoic_acid', e.target.value)}
      >
        {optionElements(optionsShowing(BEMPEDOIC_ACID_OPTIONS, medInputs.bempedoicAcid || 'not_yet'))}
      </select>
      {place.on('bempedoic_acid')}
    </div>
  );

  const neutral = MEDICATION_TEXT.lipidNeutral;

  // ── Flat mode: all fields visible independently (no cascade gating) ──
  if (!cascadeMode) {
    return (
      <div className="section-card">
        <section className="health-section">
          <h4 className="mh-group-label">{MEDICATION_TEXT.lipidTitle}</h4>
          <p className="health-section-desc">{neutral}</p>
          {statinDropdown}
          {ezetimibeDropdown}
          {bempedoicAcidDropdown}
          {pcsk9iDropdown}
        </section>
      </div>
    );
  }

  // ── Cascade mode: progressive disclosure, the plan's own steps ──
  // Progressive disclosure opens the plan's next step; a step that
  // holds a recorded value always shows (US-06 AC7).
  const lipidName = lipidMarker.label;
  const step = cascade.escalation;
  const showEscalation = !!step || medInputs.statinEscalation !== undefined;
  // The steps show in the plan's order: with the statin not tolerated, the PCSK9
  // inhibitor comes before ezetimibe, and bempedoic acid comes last (US-06 AC20).
  const statinIntolerant = medInputs.statin?.drug === 'not_tolerated';
  const pcsk9iStep = (cascade.pcsk9iReached || medInputs.pcsk9i !== undefined) && (
    <div className="med-step-enter">
      <p className="med-step-hint">{MEDICATION_TEXT.pcsk9iHint(lipidName)}</p>
      {pcsk9iDropdown}
    </div>
  );
  const introText = lipidTargetSentence(lipidMarker, (metric) => fieldUnit(METRIC_TO_FIELD[metric]));

  return (
    <div className="section-card">
    <section className="health-section medication-cascade">
      <h4 className="mh-group-label">{MEDICATION_TEXT.lipidTitle}</h4>
      <p className="health-section-desc">
        {/* It recommends only while the plan shows a step's card: with every
            step answered the marker stays elevated and the plan shows none. */}
        {cascade.suggest.length === 0 ? neutral : `${introText} ${LIPID_MEDS_IN_STEPS}`}
      </p>

      {statinDropdown}

      {statinIntolerant && pcsk9iStep}

      {(cascade.ezetimibeReached || medInputs.ezetimibe !== undefined) && (
        <div className="med-step-enter">
          <p className="med-step-hint">{MEDICATION_TEXT.ezetimibeHint(lipidName)}</p>
          {ezetimibeDropdown}
        </div>
      )}

      {showEscalation && (
        <div className="health-field med-step-enter">
          <label htmlFor="statin-escalation">
            {step ? MEDICATION_TEXT.statinEscalationLabel[step] : MEDICATION_TEXT.escalationRecorded}
          </label>
          {step && (
            <p className="med-step-hint">
              {MEDICATION_TEXT.statinEscalationHint[step](lipidName)}
            </p>
          )}
          <select
            id="statin-escalation"
            value={medInputs.statinEscalation || 'not_yet'}
            onChange={e => writeMedication(medInputs, cascadeMode, 'statin_escalation', e.target.value)}
          >
            {optionElements(optionsShowing(escalationOptions(step), medInputs.statinEscalation || 'not_yet'))}
          </select>
          {place.on('statin_escalation')}
        </div>
      )}

      {!statinIntolerant && pcsk9iStep}

      {(cascade.bempedoicAcidReached || medInputs.bempedoicAcid !== undefined) && (
        <div className="med-step-enter">
          <p className="med-step-hint">{MEDICATION_TEXT.bempedoicAcidHint}</p>
          {bempedoicAcidDropdown}
        </div>
      )}
    </section>
    </div>
  );
}
