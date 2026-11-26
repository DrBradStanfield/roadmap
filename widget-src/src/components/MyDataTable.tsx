// My data's table (US-62 AC11): the vitals and blood-test grids, the move
// panel and the additional lab rows, kept mounted under the rows. Split from
// InputPanel.tsx (W1-2, US-64).
import type { Dispatch, SetStateAction } from 'react';
import type { FormStage } from '@roadmap/health-core/mappings';
import type { PanelOnboarding } from '../hooks/useOnboarding';
import { BloodTestTimeline } from './BloodTestTimeline';
import { AdditionalLabRows } from './AdditionalLabRows';
import type { useMoveTest } from './MoveTestPanel';
import { StartingInfoVitals } from './StartingInfoVitals';
import type { InputPanelProps } from './InputPanel';

type MyDataTableProps = Pick<InputPanelProps,
  'vitalsHistory' | 'unitSystem' | 'onSaveBloodTestBatch' | 'onCorrectValue' | 'planBasis' | 'unitOverrides'
  | 'onToggleFieldUnit' | 'startUnitOf' | 'vitalsPrefillRef' | 'vitalsFlushRef' | 'bloodTestHistory' | 'onUnitSwitch'
  | 'isSavingLongitudinal' | 'grading' | 'setShowUploadModal' | 'hasApiResponse' | 'bloodTestFlushRef'
  | 'bloodTestPrefillRef' | 'labValues' | 'onLabValueAdded'> & {
  tableShown: boolean;
  showTable: (shown: boolean) => void;
  move: ReturnType<typeof useMoveTest>;
  setDraftedVitals: Dispatch<SetStateAction<boolean>>;
  setDraftedBlood: Dispatch<SetStateAction<boolean>>;
  formStage: FormStage;
  answered: PanelOnboarding['answered'];
  rested: PanelOnboarding['rested'];
  weightRef: (el: HTMLInputElement | null) => void;
  weightInProfile: boolean;
};

export function MyDataTable({
  tableShown, showTable, move, setDraftedVitals, setDraftedBlood, formStage, answered, rested, weightRef, weightInProfile,
  vitalsHistory, unitSystem, onSaveBloodTestBatch, onCorrectValue, planBasis, unitOverrides,
  onToggleFieldUnit, startUnitOf, vitalsPrefillRef, vitalsFlushRef, bloodTestHistory, onUnitSwitch,
  isSavingLongitudinal, grading, setShowUploadModal, hasApiResponse, bloodTestFlushRef,
  bloodTestPrefillRef, labValues, onLabValueAdded,
}: MyDataTableProps) {
  const knownMinor = grading === null;
  const renderVitalsMatrix = () => (
    <section className="health-section">
      <StartingInfoVitals
        vitalsHistory={vitalsHistory}
        unitSystem={unitSystem}
        onSave={onSaveBloodTestBatch}
        onCorrectValue={onCorrectValue}
        onHoldsText={setDraftedVitals}
        formStage={formStage}
        plan={planBasis}
        knownMinor={knownMinor}
        onWeightAnswered={answered && (past => answered(past ? null : 'weightKg'))} weightRef={weightRef} rested={rested}
        withoutWeight={weightInProfile}
        unitOverrides={unitOverrides}
        onToggleFieldUnit={onToggleFieldUnit} startUnitOf={startUnitOf}
        prefillRef={vitalsPrefillRef}
        flushRef={vitalsFlushRef}
      />
    </section>
  );

  const renderBloodTests = () => (
    <BloodTestTimeline
      bloodTestHistory={bloodTestHistory}
      unitSystem={unitSystem}
      unitOverrides={unitOverrides}
      onToggleFieldUnit={onToggleFieldUnit} startUnitOf={startUnitOf} onUnitSwitch={onUnitSwitch}
      onSaveBatch={onSaveBloodTestBatch}
      onCorrectValue={onCorrectValue}
      move={move.headers}
      onHoldsText={setDraftedBlood}
      isSaving={isSavingLongitudinal}
      grading={grading}
      onUploadClick={() => setShowUploadModal?.(true)}
      hasApiResponse={hasApiResponse}
      flushRef={bloodTestFlushRef}
      prefillRef={bloodTestPrefillRef}
    />
  );

  return (
    <div className="md-table" hidden={!tableShown}>
      <button type="button" className="md-back md-table-back" onClick={() => showTable(false)}>‹ Show as rows</button>
      {renderVitalsMatrix()}
      {renderBloodTests()}
      {move.panel}
      <AdditionalLabRows labValues={labValues} coreValues={bloodTestHistory} onAdded={onLabValueAdded} onCorrect={onCorrectValue} move={move.headers}/>
    </div>
  );
}
