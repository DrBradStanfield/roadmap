import { describe, it, expect } from 'vitest';
import { classifyMedicationChange, classifySupplementChange, isTakingDrug } from './history-change';

describe('isTakingDrug', () => {
  it('treats real drug names (and legacy "yes") as taking', () => {
    expect(isTakingDrug('atorvastatin')).toBe(true);
    expect(isTakingDrug('yes')).toBe(true);
  });

  it('treats status placeholders as not taking', () => {
    expect(isTakingDrug('none')).toBe(false);
    expect(isTakingDrug('no')).toBe(false);
    expect(isTakingDrug('not_yet')).toBe(false);
    expect(isTakingDrug('not_tolerated')).toBe(false);
    expect(isTakingDrug('')).toBe(false);
    expect(isTakingDrug(undefined)).toBe(false);
    expect(isTakingDrug(null)).toBe(false);
  });
});

describe('classifyMedicationChange', () => {
  it('no previous record + real drug → started', () => {
    expect(
      classifyMedicationChange(undefined, { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' }),
    ).toBe('started');
  });

  it('no previous record + non-taking status → no history row', () => {
    expect(classifyMedicationChange(undefined, { medicationKey: 'statin', drugName: 'not_yet', doseValue: null, doseUnit: null })).toBeNull();
    expect(classifyMedicationChange(undefined, { medicationKey: 'statin', drugName: 'none', doseValue: null, doseUnit: null })).toBeNull();
  });

  it('non-taking → real drug → started', () => {
    expect(
      classifyMedicationChange(
        { drugName: 'not_yet', doseValue: null, doseUnit: null },
        { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 5, doseUnit: 'mg' },
      ),
    ).toBe('started');
  });

  it('real drug → none/not_tolerated → stopped', () => {
    expect(
      classifyMedicationChange(
        { drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
        { medicationKey: 'statin', drugName: 'none', doseValue: null, doseUnit: null },
      ),
    ).toBe('stopped');
    expect(
      classifyMedicationChange(
        { drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
        { medicationKey: 'statin', drugName: 'not_tolerated', doseValue: null, doseUnit: null },
      ),
    ).toBe('stopped');
  });

  it('same drug, dose changed → dose_changed (value or unit)', () => {
    expect(
      classifyMedicationChange(
        { drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
        { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg' },
      ),
    ).toBe('dose_changed');
    expect(
      classifyMedicationChange(
        { drugName: 'semaglutide', doseValue: 1, doseUnit: 'mg' },
        { medicationKey: 'glp1', drugName: 'semaglutide', doseValue: 1, doseUnit: 'mcg' },
      ),
    ).toBe('dose_changed');
  });

  it('different drug, same key → switched', () => {
    expect(
      classifyMedicationChange(
        { drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
        { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' },
      ),
    ).toBe('switched');
  });

  it('transitions between non-taking statuses → no history row', () => {
    expect(
      classifyMedicationChange(
        { drugName: 'none', doseValue: null, doseUnit: null },
        { medicationKey: 'statin', drugName: 'not_yet', doseValue: null, doseUnit: null },
      ),
    ).toBeNull();
    expect(
      classifyMedicationChange(
        { drugName: 'not_yet', doseValue: null, doseUnit: null },
        { medicationKey: 'statin', drugName: 'not_tolerated', doseValue: null, doseUnit: null },
      ),
    ).toBeNull();
  });

  it('identical re-save → no history row (idempotent)', () => {
    expect(
      classifyMedicationChange(
        { drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
        { medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' },
      ),
    ).toBeNull();
    expect(
      classifyMedicationChange(
        { drugName: 'not_tolerated', doseValue: null, doseUnit: null },
        { medicationKey: 'statin', drugName: 'not_tolerated', doseValue: null, doseUnit: null },
      ),
    ).toBeNull();
  });
});

// US-06 AC11: an escalation answer is not a medication. A "yes" once counted
// as taking, so its first save drew a start and a reset to "not yet" a stop.
describe('US-06 AC11: an escalation answer records no history row', () => {
  const answer = (drugName: string | undefined) =>
    drugName === undefined ? undefined : { drugName, doseValue: null, doseUnit: null };

  it.each(['statin_escalation', 'glp1_escalation'])('%s: every transition gives null', (medicationKey) => {
    const transitions: Array<[string | undefined, string]> = [
      [undefined, 'yes'], [undefined, 'not_yet'], [undefined, 'not_tolerated'],
      ['yes', 'not_yet'], ['not_yet', 'yes'], ['not_tolerated', 'yes'],
      ['yes', 'not_tolerated'], ['yes', 'none'], ['none', 'yes'], ['yes', 'yes'],
    ];
    for (const [from, to] of transitions) {
      expect(classifyMedicationChange(answer(from), { medicationKey, drugName: to, doseValue: null, doseUnit: null })).toBeNull();
    }
  });

  it('other keys are unchanged: the same "yes" answer still records a start and a stop', () => {
    expect(classifyMedicationChange(undefined, { medicationKey: 'ezetimibe', drugName: 'yes', doseValue: null, doseUnit: null })).toBe('started');
    expect(classifyMedicationChange(answer('yes'), { medicationKey: 'pcsk9i', drugName: 'not_yet', doseValue: null, doseUnit: null })).toBe('stopped');
    expect(classifyMedicationChange(undefined, { medicationKey: 'glp1', drugName: 'tirzepatide', doseValue: 5, doseUnit: 'mg' })).toBe('started');
  });
});

describe('classifySupplementChange', () => {
  const active = { supplementName: 'MicroVitamin', doseValue: 1, doseUnit: 'tablet', status: 'active' as const };

  it('no previous record + active → started', () => {
    expect(classifySupplementChange(undefined, active)).toBe('started');
  });

  it('active → stopped → stopped (soft-delete)', () => {
    expect(classifySupplementChange(active, { ...active, status: 'stopped' })).toBe('stopped');
  });

  it('stopped → active → started (restart)', () => {
    expect(classifySupplementChange({ ...active, status: 'stopped' }, active)).toBe('started');
  });

  it('stopped → stopped (repeated soft-delete) → no history row', () => {
    expect(
      classifySupplementChange({ ...active, status: 'stopped' }, { ...active, status: 'stopped' }),
    ).toBeNull();
  });

  it('active, dose changed → dose_changed', () => {
    expect(classifySupplementChange(active, { ...active, doseValue: 2 })).toBe('dose_changed');
    expect(classifySupplementChange(active, { ...active, doseUnit: 'capsule' })).toBe('dose_changed');
  });

  it('active, name changed (same key) → switched', () => {
    expect(classifySupplementChange(active, { ...active, supplementName: 'MicroVitamin+' })).toBe('switched');
  });

  it('identical re-save → no history row (idempotent)', () => {
    expect(classifySupplementChange(active, { ...active })).toBeNull();
  });
});
