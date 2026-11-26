// @vitest-environment jsdom
/** US-06 AC7a: the dose select beside a statin, GLP-1 or SGLT2 inhibitor name select has a name that says which
 *  medicine it belongs to. The visible label points at the name select, so the dose select had no name.
 *  Synthetic medications. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApiMedication } from '@roadmap/health-core/mappings';
import type { LipidMarker } from '@roadmap/health-core/suggestions';
import { MEDICATION_TEXT } from '@roadmap/health-core/input-form';
import { LipidMedications } from './LipidMedications';
import { WeightMedications } from './WeightMedications';
import type { PlanBasis } from './InputPanel';
import type { Placement } from './MyHealth';

afterEach(cleanup);

const place: Placement = { on: () => null, in: () => null, noteShown: () => false };
const med = (medicationKey: string, drugName: string, doseValue: number | null): ApiMedication =>
  ({ id: `m-${medicationKey}`, medicationKey, drugName, doseValue, doseUnit: doseValue === null ? null : 'mg', updatedAt: '2026-01-02T00:00:00.000Z' });
const elevated: LipidMarker = { kind: 'ldl', label: 'LDL', value: 4.2, target: 2.6, elevated: true };
const weightOn = { bmi: 32, weightMedTrigger: { on: true, reasons: [] } } as unknown as PlanBasis;

const lipid = (medications: ApiMedication[], lipidMarker: LipidMarker | null = null) => {
  const writeMedication = vi.fn();
  render(<LipidMedications place={place} writeMedication={writeMedication} medications={medications} lipidMarker={lipidMarker} fieldUnit={() => 'si'}/>);
  return writeMedication;
};
const weight = (medications: ApiMedication[], planBasis: PlanBasis | null = null) => {
  const writeMedication = vi.fn();
  render(<WeightMedications place={place} writeMedication={writeMedication} medications={medications} planBasis={planBasis}/>);
  return writeMedication;
};
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const taken = [med('glp1', 'tirzepatide', 5), med('sglt2i', 'empagliflozin', 10)];

describe('US-06 AC7a: a medicine dose select is named after its medicine', () => {
  it('the statin dose select is named "Statin dose"; the name select keeps the visible label as its name', () => {
    lipid([med('statin', 'atorvastatin', 20)]);
    expect(select('Statin dose').id).toBe('statin-dose');
    expect(select('Statin dose').value).toBe('20');
    expect(select('Statin').id).toBe('statin-name');
  });

  it('the GLP-1 and SGLT2 inhibitor dose selects each carry their own medicine name', () => {
    weight(taken);
    expect(select('GLP-1 Medication dose').id).toBe('glp1-dose');
    expect(select('GLP-1 Medication dose').value).toBe('5');
    expect(select('SGLT2 Inhibitor dose').id).toBe('sglt2i-dose');
    expect(select('SGLT2 Inhibitor dose').value).toBe('10');
    expect(select('GLP-1 Medication').id).toBe('glp1-name');
    expect(select('SGLT2 Inhibitor').id).toBe('sglt2i-name');
  });

  it('each name comes from aria-labelledby: the visible medicine label, then a hidden fixed word "dose"', () => {
    lipid([med('statin', 'atorvastatin', 20)]);
    weight(taken);
    const shown = { statin: MEDICATION_TEXT.statinLabel, glp1: MEDICATION_TEXT.glp1Label, sglt2i: MEDICATION_TEXT.sglt2iLabel };
    for (const [medicine, text] of Object.entries(shown)) {
      const dose = document.getElementById(`${medicine}-dose`)!;
      const [labelRef, wordRef] = dose.getAttribute('aria-labelledby')!.split(' ').map(id => document.getElementById(id)!);
      expect(labelRef.tagName).toBe('LABEL');
      expect(labelRef.textContent).toBe(text);
      expect(labelRef.hidden).toBe(false);
      expect(wordRef.textContent).toBe('dose');
      expect(wordRef.hidden).toBe(true);
      expect(dose.hasAttribute('aria-label')).toBe(false);
      expect(document.getElementById(`${medicine}-name`)!.hasAttribute('aria-label')).toBe(false);
    }
  });

  it('a change made through the named select is sent for that medicine dose', () => {
    const lipidWrite = lipid([med('statin', 'atorvastatin', 20)]);
    fireEvent.change(select('Statin dose'), { target: { value: '40' } });
    expect(lipidWrite.mock.calls.map(c => c.slice(2))).toEqual([['statin_dose', '40']]);
    const weightWrite = weight(taken);
    fireEvent.change(select('SGLT2 Inhibitor dose'), { target: { value: '25' } });
    fireEvent.change(select('GLP-1 Medication dose'), { target: { value: '7.5' } });
    expect(weightWrite.mock.calls.map(c => c.slice(2))).toEqual([['sglt2i_dose', '25'], ['glp1_dose', '7.5']]);
  });

  it('a dose not yet recorded has the same name', () => {
    lipid([med('statin', 'rosuvastatin', null)]);
    weight([med('glp1', 'dulaglutide', null), med('sglt2i', 'dapagliflozin', null)]);
    for (const name of ['Statin dose', 'GLP-1 Medication dose', 'SGLT2 Inhibitor dose']) {
      expect(select(name).value).toBe('');
      expect(select(name).selectedOptions[0].textContent).toBe('Add dose');
    }
  });

  it('the names are the same while the plan steps through the medicines', () => {
    lipid([med('statin', 'atorvastatin', 20)], elevated);
    weight(taken, weightOn);
    expect(select('Statin dose').id).toBe('statin-dose');
    expect(select('GLP-1 Medication dose').id).toBe('glp1-dose');
    expect(select('SGLT2 Inhibitor dose').id).toBe('sglt2i-dose');
  });

  it('a medicine with no dose list draws no dose select', () => {
    lipid([med('statin', 'not_tolerated', null)]);
    weight([med('glp1', 'other', null)]);
    expect(screen.queryByRole('combobox', { name: /dose$/i })).toBeNull();
    expect(document.querySelector('#statin-dose, #glp1-dose, #sglt2i-dose')).toBeNull();
  });
});
