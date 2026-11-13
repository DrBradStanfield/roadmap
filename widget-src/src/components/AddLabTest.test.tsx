// @vitest-environment jsdom
/**
 * US-21 phase 2 (AC2/AC4) — "+ Add a blood test" beneath the additional-lab
 * groups. Catalogue-driven: picking a known test fixes its canonical unit
 * (AC3 — one unit per row) and saves under the STABLE catalogue key so
 * manual and upload-extracted values land in the same row (AC4).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { addLabValue as addRecordLabValue } from '@roadmap/health-core/record-edits';
import { createEmptyFile, type FileLabValue } from '@roadmap/health-core/roadmap-file';
import { labUnitRefusalLine } from '@roadmap/health-core/lab-series';

afterEach(cleanup);

// The form saves through health-core's one lab add (US-25 AC25). The mock runs the REAL rule on a
// record holding `held`, so a test sees the words and the replace offer a person would.
const held: FileLabValue[] = [];
const addLabValue = vi.fn();
const trackProductEvent = vi.fn();
vi.mock('../lib/roadmap-data', () => ({
  addLabValue: (...args: unknown[]) => addLabValue(...args),
  getShownErase: () => 'erase-1',
  getEraseIdentity: () => 'erase-1',
}));
const realAdd = (input: Parameters<typeof addRecordLabValue>[1]) =>
  addRecordLabValue({ ...createEmptyFile({ deviceId: 'test', now: new Date().toISOString() }), labValues: held }, input, new Date().toISOString());
const holding = (...rows: Array<Record<string, unknown>>) => held.splice(0, held.length, ...rows.map((r) => ({ status: 'active', correctsId: null, ...r }) as FileLabValue));
vi.mock('../lib/server-api', () => ({
  trackProductEvent: (...args: unknown[]) => trackProductEvent(...args),
}));

import { AddLabTest, addTransition, RECORD_CHANGED, type AddEvent, type AddMode } from './AddLabTest';
import { AdditionalLabRows } from './AdditionalLabRows';
import { reportedToCanonical } from '@roadmap/health-core/units';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { validateTypedValue } from '../lib/blood-test-cell';

beforeEach(() => {
  held.splice(0);
  addLabValue.mockReset().mockImplementation(async (input) => realAdd(input));
  trackProductEvent.mockReset();
});

function openForm() {
  const onAdded = vi.fn();
  const utils = render(<AddLabTest onAdded={onAdded} />);
  fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
  return { ...utils, onAdded };
}

// Read at assertion time, not module load: a run that crosses local midnight stamps rows with the new day.
const todayIso = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

describe('US-21 phase 2 — AddLabTest', () => {
  it('starts as a single "+ Add a blood test" button (no form)', () => {
    const { queryByLabelText, getByRole } = render(<AddLabTest onAdded={vi.fn()} />);
    expect(getByRole('button', { name: /add a blood test/i })).toBeTruthy();
    expect(queryByLabelText('Test')).toBeNull();
  });

  it('US-16 AC2d: a save the record refuses with its erase unchanged keeps the form and the value, and asks for a retry', async () => {
    addLabValue.mockResolvedValue(null);
    const { getByLabelText, getByRole, findByText, onAdded } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'ggt' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '30' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    expect(await findByText('Could not save — please try again.')).toBeTruthy();
    expect((getByLabelText('Value') as HTMLInputElement).value).toBe('30');
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('a catalogued test fixes its canonical unit and saves under the stable key', async () => {
    const { getByLabelText, getByRole, onAdded, container } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'ggt' } });
    // Canonical unit shown as a fixed chip, not an editable input.
    expect(container.querySelector('.bt-unit-chip')?.textContent).toBe('U/L');
    fireEvent.change(getByLabelText('Value'), { target: { value: '30' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(addLabValue).toHaveBeenCalledWith({ metricName: 'ggt', unit: 'U/L', value: 30, day: todayIso() }, 'erase-1');
    expect(trackProductEvent).toHaveBeenCalledWith('lab_row_added');
  });

  it('an "Other" test takes a free-form name and unit', async () => {
    const { getByLabelText, getByRole, onAdded } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'custom' } });
    fireEvent.change(getByLabelText('Test name'), { target: { value: 'Amylase' } });
    fireEvent.change(getByLabelText('Unit'), { target: { value: 'U/L' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '55' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(addLabValue).toHaveBeenCalledWith({ metricName: 'Amylase', unit: 'U/L', value: 55, day: todayIso() }, 'erase-1');
  });

  it('a duplicate (same test, same day) shows a notice instead of silently doing nothing', async () => {
    holding({ id: 's1', metricName: 'sodium', value: 138, unit: 'mmol/L', referenceLow: null, referenceHigh: null, recordedAt: `${todayIso()}T00:00:00.000Z`, createdAt: `${todayIso()}T08:00:00.000Z`, source: 'manual' });
    const { getByLabelText, getByRole, onAdded, findByText } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'sodium' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '140' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    expect(await findByText('That test already has 138 mmol/L for that date.')).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  // US-21 AC13 (2026-09-22): the notice was a dead end. It now names the value
  // already there and offers to replace it: a correction through the cell
  // editor's own door, never a second row.
  describe('a same-day duplicate', () => {
    const held = {
      id: 'held1', metricName: 'ferritin', value: 45, unit: 'µg/L', referenceLow: null, referenceHigh: null,
      recordedAt: `${todayIso()}T00:00:00.000Z`, source: 'manual', createdAt: `${todayIso()}T08:00:00.000Z`,
    };
    function duplicate(value: string) {
      holding(held);
      const onCorrect = vi.fn().mockResolvedValue('ok');
      const onAdded = vi.fn();
      const utils = render(<AddLabTest onAdded={onAdded} labValues={[held]} onCorrect={onCorrect} />);
      fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
      fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'ferritin' } });
      fireEvent.change(utils.getByLabelText('Value'), { target: { value } });
      fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
      return { ...utils, onCorrect, onAdded };
    }

    it('names the value there and offers Replace, which corrects it', async () => {
      const { findByRole, getByText, onCorrect, queryByLabelText } = duplicate('54');
      fireEvent.click(await findByRole('button', { name: 'Replace 45 µg/L with 54' }));
      expect(getByText('That test already has 45 µg/L for that date.')).toBeTruthy();
      await waitFor(() => expect(onCorrect).toHaveBeenCalledWith('held1', 54, 'erase-1'));
      await waitFor(() => expect(queryByLabelText('Test')).toBeNull()); // the form closes
      expect(addLabValue).toHaveBeenCalledTimes(1); // no second row was tried
    });

    // US-03 AC3 rule: the number typed is never rounded to decide it changed
    // nothing. 45.004 displays as 45, yet it is a different number.
    it('offers Replace for a change the display would round away', async () => {
      const { findByRole } = duplicate('45.004');
      expect(await findByRole('button', { name: 'Replace 45 µg/L with 45.004' })).toBeTruthy();
    });

    it('offers no Replace when the value typed is the value there', async () => {
      const { findByText, queryByRole, onCorrect } = duplicate('45');
      expect(await findByText('That test already has 45 µg/L for that date.')).toBeTruthy();
      expect(queryByRole('button', { name: /^Replace/ })).toBeNull();
      expect(onCorrect).not.toHaveBeenCalled();
    });

    it('a Replace the record refuses says why, as the cell editor does', async () => {
      const { findByRole, findByText, onCorrect, getByLabelText } = duplicate('54');
      onCorrect.mockResolvedValue('changed'); // corrected on another device meanwhile
      fireEvent.click(await findByRole('button', { name: 'Replace 45 µg/L with 54' }));
      expect(await findByText('This value changed on another device, so your edit was not saved.')).toBeTruthy();
      expect(getByLabelText('Test')).toBeTruthy(); // the form stays open
    });
  });

  // US-21 AC13: Replace names one saved value. Change the test's name or unit
  // and that value is no longer the one the form describes, so the offer goes:
  // it used to stay, and Replace corrected the first test in the old unit.
  describe('a same-day duplicate of an "Other" test', () => {
    const held = {
      id: 'held2', metricName: 'Feritin', value: 45, unit: 'ug/L', referenceLow: null, referenceHigh: null,
      recordedAt: `${todayIso()}T00:00:00.000Z`, source: 'manual', createdAt: `${todayIso()}T08:00:00.000Z`,
    };
    async function replaceOffered() {
      holding(held);
      const onCorrect = vi.fn().mockResolvedValue('ok');
      const utils = render(<AddLabTest onAdded={vi.fn()} labValues={[held]} onCorrect={onCorrect} />);
      fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
      fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'custom' } });
      fireEvent.change(utils.getByLabelText('Test name'), { target: { value: 'Feritin' } });
      fireEvent.change(utils.getByLabelText('Unit'), { target: { value: 'ug/L' } });
      fireEvent.change(utils.getByLabelText('Value'), { target: { value: '54' } });
      fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
      await utils.findByRole('button', { name: 'Replace 45 µg/L with 54' });
      return { ...utils, onCorrect };
    }

    it('a changed name withdraws Replace, and Save adds the test it names', async () => {
      const { getByLabelText, getByRole, queryByRole, onCorrect } = await replaceOffered();
      fireEvent.change(getByLabelText('Test name'), { target: { value: 'Folate' } });
      expect(queryByRole('button', { name: /^Replace/ })).toBeNull();
      fireEvent.click(getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(addLabValue).toHaveBeenLastCalledWith(expect.objectContaining({ metricName: 'Folate', value: 54 }), 'erase-1'));
      expect(onCorrect).not.toHaveBeenCalled();
    });

    it('a changed unit withdraws Replace: a value in another unit is never a correction', async () => {
      const { getByLabelText, getByRole, queryByRole, onCorrect } = await replaceOffered();
      fireEvent.change(getByLabelText('Unit'), { target: { value: 'ng/mL' } });
      expect(queryByRole('button', { name: /^Replace/ })).toBeNull();
      fireEvent.click(getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(addLabValue).toHaveBeenLastCalledWith(expect.objectContaining({ metricName: 'Feritin', unit: 'ng/mL' }), 'erase-1'));
      expect(onCorrect).not.toHaveBeenCalled();
    });
  });

  // Review R3 on PR 641: under "Other test", Ferritin typed in ng/mL is the catalogue's µg/L by
  // another name. The record offers to replace a held 45 µg/L, so Replace must really replace it.
  it('an "Other" test the catalogue knows, in a unit it treats as its own, replaces the held value', async () => {
    const there = {
      id: 'held3', metricName: 'ferritin', value: 45, unit: 'µg/L', referenceLow: null, referenceHigh: null,
      recordedAt: `${todayIso()}T00:00:00.000Z`, source: 'manual', createdAt: `${todayIso()}T08:00:00.000Z`,
    };
    holding(there);
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const utils = render(<AddLabTest onAdded={vi.fn()} labValues={[there]} onCorrect={onCorrect} />);
    fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
    fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'custom' } });
    fireEvent.change(utils.getByLabelText('Test name'), { target: { value: 'Ferritin' } });
    fireEvent.change(utils.getByLabelText('Unit'), { target: { value: 'ng/mL' } });
    fireEvent.change(utils.getByLabelText('Value'), { target: { value: '54' } });
    fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
    fireEvent.click(await utils.findByRole('button', { name: 'Replace 45 µg/L with 54' }));
    await waitFor(() => expect(onCorrect).toHaveBeenCalledWith('held3', 54, 'erase-1'));
  });

  // US-21 AC15 · a refusal reads as the upload summary does: a person never
  // sees the assistant's copy of it.
  describe('US-21 AC15 — a refused unit under "Other" shows the person’s wording', () => {
    async function saveOther(name: string, unit: string, value: string, refused: { key: string; unit: string; message: string; fault?: 'decimal' | 'scale' }) {
      // The refusal the record would give, in health-core's words (labUnitRefusalLine, tested in lab-value-labels.test.ts).
      addLabValue.mockResolvedValue({ ok: false, reason: 'unknown-unit', message: labUnitRefusalLine(refused.key, refused.unit, refused.fault), refused });
      const utils = openForm();
      fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'custom' } });
      fireEvent.change(utils.getByLabelText('Test name'), { target: { value: name } });
      fireEvent.change(utils.getByLabelText('Unit'), { target: { value: unit } });
      fireEvent.change(utils.getByLabelText('Value'), { target: { value } });
      fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
      return utils;
    }

    it('US-21 AC15 — Lymphocytes in % shows the % note, never the assistant’s instruction', async () => {
      const { findByText } = await saveOther('Lymphocytes', '%', '30', {
        key: 'lymphocytes', unit: '%',
        message: 'Lymphocytes is stored in ×10⁹/L; this record takes ×10⁹/L, not "%". A percentage is a share of the white count, not a count: this record keeps the absolute count (×10⁹/L or cells/µL), so look for that line on the same report. Do not work the count out from the percentage',
      });
      const notice = await findByText(/^Lymphocytes: unit not recognised \(%\)\. It was not saved\. This test takes ×10⁹\/L\. A percentage is a share/);
      expect(notice.textContent).toContain('A percentage is a share of the white count, not a count: this record keeps the absolute count (×10⁹/L or cells/µL), so look for that line on the same report.');
      expect(notice.textContent).not.toContain('Do not work the count out');
    });

    it('US-21 AC15 — a unit the test does not take names the units it does, with no em dash', async () => {
      const { findByText } = await saveOther('Ferritin', 'mg/dL', '80', {
        key: 'ferritin', unit: 'mg/dL', message: 'Ferritin is stored in µg/L; this record takes µg/L, ng/ml, not "mg/dL"',
      });
      expect(await findByText('Ferritin: unit not recognised (mg/dL). It was not saved. This test takes µg/L.')).toBeTruthy();
    });

    it('US-21 AC15 — a test outside the catalogue gets no list of units', async () => {
      const { findByText } = await saveOther('Foo Marker', 'zz', '1', { key: 'foo_marker', unit: 'zz', message: 'refused' });
      expect(await findByText('Foo Marker: unit not recognised (zz). It was not saved.')).toBeTruthy();
    });

    it('US-21 AC15 — a count per µL on a different scale from its range says so, never the assistant’s instruction', async () => {
      const { findByText } = await saveOther('Platelets', 'cells/uL', '260', {
        key: 'platelets', unit: 'cells/uL', fault: 'scale',
        message: 'Platelets in "cells/uL": the value and its printed range are on different scales, so the row was not stored. Do not re-send it in another unit; ask the person to check the report',
      });
      const notice = await findByText('Platelets: the value and its printed range are on different scales, so the row was not stored.');
      expect(notice.textContent).not.toContain('whole number');
      expect(notice.textContent).not.toContain('re-send');
    });

    it('US-21 AC15 — a decimal count per µL leads with the number, not the unit', async () => {
      const { findByText } = await saveOther('Neutrophils', 'cells/uL', '2.4', {
        key: 'neutrophils', unit: 'cells/uL', fault: 'decimal',
        message: 'Neutrophils in "cells/uL" was not stored. Counts of cells per µL are whole numbers on the same scale as their printed range, so this row is refused, never rescaled: check whether the report means thousands per µL (×10³/µL)',
      });
      const notice = await findByText(/^Neutrophils: the number was not saved\. Counts of cells per µL are whole numbers/);
      expect(notice.textContent).toContain('thousands per µL (×10³/µL).');
      expect(notice.textContent).not.toContain('unit not recognised');
      expect(notice.textContent).not.toContain('—');
    });
  });

  it('US-21 AC26 — a catalogued value past its plausible range shows why and saves nothing', async () => {
    const { getByLabelText, getByRole, onAdded, findByText } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'potassium' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '42' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    expect(await findByText('Potassium above 20 mmol/L is almost certainly a typing or unit mistake: check the number and its unit.')).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('Save is disabled until a test and a parseable value are entered', () => {
    const { getByLabelText, getByRole } = openForm();
    const save = getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(getByLabelText('Test'), { target: { value: 'ggt' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(getByLabelText('Value'), { target: { value: 'abc' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(getByLabelText('Value'), { target: { value: '30' } });
    expect(save.disabled).toBe(false);
  });

  it('US-21 AC2: "Choose a test…" after an Other test saves nothing; the name and unit it hides are not used', async () => {
    const { getByLabelText, getByRole, queryByLabelText, onAdded } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'custom' } });
    fireEvent.change(getByLabelText('Test name'), { target: { value: 'Amylase ' } });
    fireEvent.change(getByLabelText('Unit'), { target: { value: 'U/L' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '55' } });
    fireEvent.change(getByLabelText('Test'), { target: { value: '' } });
    expect(queryByLabelText('Test name')).toBeNull();
    const save = getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await Promise.resolve();
    expect(addLabValue).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    // Other again: what was typed is still there, and saves as before.
    fireEvent.change(getByLabelText('Test'), { target: { value: 'custom' } });
    expect((getByLabelText('Test name') as HTMLInputElement).value).toBe('Amylase ');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(addLabValue).toHaveBeenCalledWith({ metricName: 'Amylase', unit: 'U/L', value: 55, day: todayIso() }, 'erase-1');
  });

  it('US-21 AC2: a catalogue test picked after an Other test saves the catalogue test, not the typed name', async () => {
    const { getByLabelText, getByRole, onAdded } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'custom' } });
    fireEvent.change(getByLabelText('Test name'), { target: { value: 'Amylase' } });
    fireEvent.change(getByLabelText('Unit'), { target: { value: 'U/L' } });
    fireEvent.change(getByLabelText('Test'), { target: { value: 'ggt' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '30' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(addLabValue).toHaveBeenCalledWith({ metricName: 'ggt', unit: 'U/L', value: 30, day: todayIso() }, 'erase-1');
  });

  // US-02 AC7: a catalogued test has no input range, so "1,050" (1050 or
  // 1.05) is asked about and never saved; "1,05" is a decimal comma.
  it('asks about "1,050" and saves nothing until it is retyped', async () => {
    const { getByLabelText, getByRole, getByText, onAdded } = openForm();
    const save = getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
    fireEvent.change(getByLabelText('Test'), { target: { value: 'ferritin' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '1,050' } });
    expect(getByText('Did you mean 1050 or 1.05?')).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(addLabValue).not.toHaveBeenCalled();
    fireEvent.change(getByLabelText('Value'), { target: { value: '1,05' } });
    fireEvent.click(save);
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(addLabValue).toHaveBeenCalledWith(expect.objectContaining({ metricName: 'ferritin', value: 1.05 }), 'erase-1');
  });

  // Codex R2: no range checks grouped thousands here, so they are refused.
  it('refuses "1,234,567" and asks for the number without commas', () => {
    const { getByLabelText, getByRole, getByText } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'ferritin' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '1,234,567' } });
    expect(getByText('Type the number without commas.')).toBeTruthy();
    expect((getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('US-21 phase 2 — section shows the add button', () => {
  it('renders the section with the add button even when there are no lab values yet', () => {
    const { getByRole, getByText } = render(<AdditionalLabRows labValues={[]} onAdded={vi.fn()} />);
    expect(getByText('Additional lab results')).toBeTruthy();
    expect(getByRole('button', { name: /add a blood test/i })).toBeTruthy();
  });

  it('still renders nothing when read-only (no onAdded) and no lab values', () => {
    const { container } = render(<AdditionalLabRows labValues={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

// US-66 AC6: a core test's name typed under "Other" writes the core row, so the
// form must find that row on a held day and offer Replace as it does for a lab
// row (US-21 AC13), and say a refused number in the matrix's words. AC8: the
// core rows it reads are never listed as extra rows.
describe('US-66 AC6 — a core test typed under "Other"', () => {
  const si = reportedToCanonical('ldl', 116, 'mg/dL')!.valueSI;
  const core = { id: 'core1', metricType: 'ldl', value: si, recordedAt: `${todayIso()}T00:00:00.000Z`, status: 'active', source: 'manual', createdAt: `${todayIso()}T08:00:00.000Z` } as ApiMeasurement;
  // The record's core row (US-66 AC1), which the real lab add finds on a held day.
  const coreRow = { id: 'core1', metricName: 'ldl', core: true, value: si, unit: 'mmol/L', referenceLow: null, referenceHigh: null, recordedAt: core.recordedAt, source: 'manual', createdAt: core.createdAt };

  function typeLdl(value: string, coreValues: ApiMeasurement[] = [core]) {
    if (coreValues.length) holding(coreRow);
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const utils = render(<AddLabTest onAdded={vi.fn()} labValues={[]} coreValues={coreValues} onCorrect={onCorrect} />);
    fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
    fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'custom' } });
    fireEvent.change(utils.getByLabelText('Test name'), { target: { value: 'LDL-C' } });
    fireEvent.change(utils.getByLabelText('Unit'), { target: { value: 'mg/dL' } });
    fireEvent.change(utils.getByLabelText('Value'), { target: { value } });
    fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
    return { ...utils, onCorrect };
  }

  it('US-21 AC13 — a held core day names the core value in the unit typed and Replace corrects it in its stored unit', async () => {
    const { findByRole, getByText, onCorrect } = typeLdl('131');
    fireEvent.click(await findByRole('button', { name: 'Replace 116 mg/dL with 131' }));
    expect(getByText('That test already has 116 mg/dL for that date.')).toBeTruthy();
    await waitFor(() => expect(onCorrect).toHaveBeenCalledWith('core1', reportedToCanonical('ldl', 131, 'mg/dL')!.valueSI, 'erase-1'));
  });

  it('US-21 AC13 — the core value typed again offers no Replace', async () => {
    const { findByText, queryByRole } = typeLdl('116');
    expect(await findByText('That test already has 116 mg/dL for that date.')).toBeTruthy();
    expect(queryByRole('button', { name: /^Replace/ })).toBeNull();
  });

  it('an out-of-range core value shows the matrix range message, never "Could not save"', async () => {
    const { findByText, queryByText } = typeLdl('99999', []);
    const words = validateTypedValue('ldl', '99999', 'conventional').error!;
    expect(words).toMatch(/^Max .* mg\/dL$/);
    expect(await findByText(words)).toBeTruthy();
    expect(queryByText(/Could not save/)).toBeNull();
    expect(queryByText(/already has/)).toBeNull(); // an empty day is never called held
    expect(trackProductEvent).not.toHaveBeenCalled(); // the value never enters telemetry
  });

  it('an out-of-range Lp(a) in mg/L names its mg/L range, never the mg/dL one', async () => {
    const utils = render(<AddLabTest onAdded={vi.fn()} labValues={[]} coreValues={[]} onCorrect={vi.fn()} />);
    fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
    fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'custom' } });
    fireEvent.change(utils.getByLabelText('Test name'), { target: { value: 'Lp(a)' } });
    fireEvent.change(utils.getByLabelText('Unit'), { target: { value: 'mg/L' } });
    fireEvent.change(utils.getByLabelText('Value'), { target: { value: '5000' } });
    fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
    expect(await utils.findByText('Max 3000 mg/L')).toBeTruthy();
  });

  it('US-66 AC8 — the core rows the form reads are never listed as extra rows', () => {
    const { queryByText, getByRole } = render(<AdditionalLabRows labValues={[]} coreValues={[core]} onAdded={vi.fn()} />);
    expect(getByRole('button', { name: /add a blood test/i })).toBeTruthy();
    expect(queryByText(/ldl/i)).toBeNull();
  });
});

// US-25 AC25: a value page's "+ Add a value" adds to its own series, whatever the general add refuses.
describe('US-25 AC25: a value page adds to its own series', () => {
  it('adds to a series a lab import saved with no unit (INR)', async () => {
    holding({ id: 'i1', metricName: 'INR', value: 1.1, unit: '', recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', source: 'lab_import' });
    const onAdded = vi.fn();
    const { getByText, getByLabelText } = render(<AddLabTest onAdded={onAdded} labValues={[]} coreValues={[]} preset={{ metricName: 'INR', unit: '' }} />);
    fireEvent.click(getByText('+ Add a value'));
    fireEvent.change(getByLabelText(/value/i), { target: { value: '1.2' } });
    fireEvent.click(getByText(/^save$/i));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(addLabValue).toHaveBeenCalledWith({ metricName: 'INR', unit: '', value: 1.2, day: todayIso(), existingSeries: true }, 'erase-1');
  });

  it('adds to a kept-apart lab series named like a vital (Weight)', async () => {
    holding({ id: 'w1', metricName: 'Weight', value: 70, unit: 'kg', recordedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', source: 'lab_import' });
    const onAdded = vi.fn();
    const { getByText, getByLabelText } = render(<AddLabTest onAdded={onAdded} labValues={[]} coreValues={[]} preset={{ metricName: 'Weight', unit: 'kg' }} />);
    fireEvent.click(getByText('+ Add a value'));
    fireEvent.change(getByLabelText(/value/i), { target: { value: '71' } });
    fireEvent.click(getByText(/^save$/i));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });
});

describe('US-66 AC5: a value page for a kept-apart core-named row', () => {
  it('never adds a core value from the page of an old "Creatinine" lab row', async () => {
    const { getByText, getByLabelText, findByText } = render(<AddLabTest onAdded={() => {}} labValues={[]} coreValues={[]} preset={{ metricName: 'Creatinine', unit: 'µmol/L' }} />);
    fireEvent.click(getByText('+ Add a value'));
    fireEvent.change(getByLabelText(/value/i), { target: { value: '90' } });
    fireEvent.click(getByText(/^save$/i));
    expect(await findByText('Add this test from its row in Blood tests.')).toBeTruthy();
    expect(addLabValue).not.toHaveBeenCalled();
  });
});

// US-21 AC27 (A7): the form's mode is one named state. A Replace whose correction throws gives the
// button back, and a save's answer that lands after Cancel, or in a form opened since, changes nothing.
describe('US-21 AC27: a save never leaves the form stuck, and a late answer changes nothing', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const typeGgt = (utils: ReturnType<typeof openForm>, value = '30') => {
    fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'ggt' } });
    fireEvent.change(utils.getByLabelText('Value'), { target: { value } });
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('the transition table: each state x event names the state that follows', () => {
    const form = Symbol('this'), other = Symbol('other');
    const held = { id: 'h', slot: 's', value: 45, unit: 'µg/L', stored: 45 };
    const closed = (notice: string | null = null): AddMode => ({ kind: 'closed', notice });
    const open = (notice: string | null = null, h: typeof held | null = null): AddMode => ({ kind: 'open', form, openAt: 'e1', notice, held: h });
    const saving = (notice: string | null = null, h: typeof held | null = null): AddMode => ({ kind: 'saving', form, openAt: 'e1', notice, held: h });
    const rows: Array<[AddMode, AddEvent, AddMode]> = [
      [closed('old'), { type: 'open', form, openAt: 'e1' }, open()],
      [open('n'), { type: 'open', form: other, openAt: 'e2' }, open('n')],
      [open('n', held), { type: 'edit' }, open()],
      [saving('n', held), { type: 'edit' }, saving()],
      [closed('n'), { type: 'edit' }, closed('n')],
      [open(), { type: 'refuse', notice: 'r' }, open('r')],
      [saving(), { type: 'refuse', notice: 'r' }, saving()],
      [open('n', held), { type: 'save' }, saving()],
      [open('n', held), { type: 'replace' }, saving('n', held)],
      [saving(), { type: 'save' }, saving()],
      [closed(), { type: 'save' }, closed()],
      [saving(), { type: 'saved', form }, closed()],
      [saving(), { type: 'recordChanged', form }, closed(RECORD_CHANGED)],
      [saving(), { type: 'failed', form, notice: 'f', held }, open('f', held)],
      [saving('n', held), { type: 'failed', form, notice: 'f' }, open('f', held)], // a refused Replace keeps its offer
      [saving(), { type: 'failed', form: other, notice: 'f' }, saving()], // another opening's answer
      [saving(), { type: 'saved', form: other }, saving()],
      [open(), { type: 'saved', form }, open()],
      [closed(), { type: 'saved', form }, closed()], // after Cancel
      [closed(), { type: 'failed', form, notice: 'f' }, closed()],
      [closed(), { type: 'recordChanged', form }, closed()],
      [open('n'), { type: 'cancel' }, closed()],
      [saving('n'), { type: 'cancel' }, closed()],
      [closed('n'), { type: 'cancel' }, closed('n')],
    ];
    for (const [state, event, next] of rows) expect(addTransition(state, event)).toEqual(next);
  });

  it('a Replace whose correction throws says to try again and gives the button back', async () => {
    const there = {
      id: 'held1', metricName: 'ferritin', value: 45, unit: 'µg/L', referenceLow: null, referenceHigh: null,
      recordedAt: `${todayIso()}T00:00:00.000Z`, source: 'manual', createdAt: `${todayIso()}T08:00:00.000Z`,
    };
    holding(there);
    const onCorrect = vi.fn().mockRejectedValue(new Error('read failed'));
    const utils = render(<AddLabTest onAdded={vi.fn()} labValues={[there]} onCorrect={onCorrect} />);
    fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
    fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'ferritin' } });
    fireEvent.change(utils.getByLabelText('Value'), { target: { value: '54' } });
    fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
    fireEvent.click(await utils.findByRole('button', { name: 'Replace 45 µg/L with 54' }));
    expect(await utils.findByText('Could not save — please try again.')).toBeTruthy();
    expect((utils.getByRole('button', { name: /^(Replace|Save)/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a save that fails after Cancel puts no notice under the closed form', async () => {
    const answer = deferred<null>();
    addLabValue.mockReturnValue(answer.promise);
    const utils = openForm();
    typeGgt(utils);
    fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
    fireEvent.click(utils.getByRole('button', { name: 'Cancel' }));
    answer.resolve(null);
    await settle();
    expect(utils.queryByText('Could not save — please try again.')).toBeNull();
    expect(utils.container.querySelector('.alr-add-notice')).toBeNull();
  });

  it('a save that lands after Cancel and a reopen leaves the reopened form and its typing alone', async () => {
    const answer = deferred<ReturnType<typeof realAdd>>();
    addLabValue.mockReturnValueOnce(answer.promise);
    const utils = openForm();
    typeGgt(utils);
    fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
    fireEvent.click(utils.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
    typeGgt(utils, '31');
    answer.resolve(realAdd({ metricName: 'ggt', unit: 'U/L', value: 30, day: todayIso() }));
    await waitFor(() => expect(utils.onAdded).toHaveBeenCalledTimes(1)); // the first value did save: the page re-reads
    await settle();
    expect((utils.getByLabelText('Value') as HTMLInputElement).value).toBe('31');
    expect((utils.getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
