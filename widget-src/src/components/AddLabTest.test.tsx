// @vitest-environment jsdom
/**
 * US-21 phase 2 (AC2/AC4) — "+ Add a blood test" beneath the additional-lab
 * groups. Catalogue-driven: picking a known test fixes its canonical unit
 * (AC3 — one unit per row) and saves under the STABLE catalogue key so
 * manual and upload-extracted values land in the same row (AC4).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';

afterEach(cleanup);

const bulkSaveLabValues = vi.fn();
const trackProductEvent = vi.fn();
vi.mock('../lib/roadmap-data', () => ({
  bulkSaveLabValues: (...args: unknown[]) => bulkSaveLabValues(...args),
}));
vi.mock('../lib/server-api', () => ({
  trackProductEvent: (...args: unknown[]) => trackProductEvent(...args),
}));

import { AddLabTest } from './AddLabTest';
import { AdditionalLabRows } from './AdditionalLabRows';

beforeEach(() => {
  bulkSaveLabValues.mockReset().mockResolvedValue({ saved: [{ id: 'x' }], skippedDuplicates: 0, errorCount: 0, refused: [] });
  trackProductEvent.mockReset();
});

function openForm() {
  const onAdded = vi.fn();
  const utils = render(<AddLabTest onAdded={onAdded} />);
  fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
  return { ...utils, onAdded };
}

const today = new Date();
const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

describe('US-21 phase 2 — AddLabTest', () => {
  it('starts as a single "+ Add a blood test" button (no form)', () => {
    const { queryByLabelText, getByRole } = render(<AddLabTest onAdded={vi.fn()} />);
    expect(getByRole('button', { name: /add a blood test/i })).toBeTruthy();
    expect(queryByLabelText('Test')).toBeNull();
  });

  it('a catalogued test fixes its canonical unit and saves under the stable key', async () => {
    const { getByLabelText, getByRole, onAdded, container } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'ggt' } });
    // Canonical unit shown as a fixed chip, not an editable input.
    expect(container.querySelector('.bt-unit-chip')?.textContent).toBe('U/L');
    fireEvent.change(getByLabelText('Value'), { target: { value: '30' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(bulkSaveLabValues).toHaveBeenCalledWith([{
      metricName: 'ggt',
      value: 30,
      unit: 'U/L',
      recordedAt: `${todayIso}T00:00:00.000Z`,
      source: 'manual',
    }]);
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
    expect(bulkSaveLabValues).toHaveBeenCalledWith([
      expect.objectContaining({ metricName: 'Amylase', value: 55, unit: 'U/L', source: 'manual' }),
    ]);
  });

  it('a duplicate (same test, same day) shows a notice instead of silently doing nothing', async () => {
    bulkSaveLabValues.mockResolvedValue({ saved: [], skippedDuplicates: 1, errorCount: 0, refused: [] });
    const { getByLabelText, getByRole, onAdded, findByText } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'sodium' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '140' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    expect(await findByText(/already has a value for that date/i)).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  // US-21 AC13 (2026-09-22): the notice was a dead end. It now names the value
  // already there and offers to replace it: a correction through the cell
  // editor's own door, never a second row.
  describe('a same-day duplicate', () => {
    const held = {
      id: 'held1', metricName: 'ferritin', value: 45, unit: 'µg/L', referenceLow: null, referenceHigh: null,
      recordedAt: `${todayIso}T00:00:00.000Z`, source: 'manual', createdAt: `${todayIso}T08:00:00.000Z`,
    };
    function duplicate(value: string) {
      bulkSaveLabValues.mockResolvedValue({ saved: [], skippedDuplicates: 1, errorCount: 0, refused: [] });
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
      await waitFor(() => expect(onCorrect).toHaveBeenCalledWith('held1', 54));
      await waitFor(() => expect(queryByLabelText('Test')).toBeNull()); // the form closes
      expect(bulkSaveLabValues).toHaveBeenCalledTimes(1); // no second row was tried
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
      recordedAt: `${todayIso}T00:00:00.000Z`, source: 'manual', createdAt: `${todayIso}T08:00:00.000Z`,
    };
    async function replaceOffered() {
      bulkSaveLabValues.mockResolvedValue({ saved: [], skippedDuplicates: 1, errorCount: 0, refused: [] });
      const onCorrect = vi.fn().mockResolvedValue('ok');
      const utils = render(<AddLabTest onAdded={vi.fn()} labValues={[held]} onCorrect={onCorrect} />);
      fireEvent.click(utils.getByRole('button', { name: /add a blood test/i }));
      fireEvent.change(utils.getByLabelText('Test'), { target: { value: 'custom' } });
      fireEvent.change(utils.getByLabelText('Test name'), { target: { value: 'Feritin' } });
      fireEvent.change(utils.getByLabelText('Unit'), { target: { value: 'ug/L' } });
      fireEvent.change(utils.getByLabelText('Value'), { target: { value: '54' } });
      fireEvent.click(utils.getByRole('button', { name: /^save$/i }));
      await utils.findByRole('button', { name: 'Replace 45 µg/L with 54' });
      bulkSaveLabValues.mockResolvedValue({ saved: [{ id: 'new' }], skippedDuplicates: 0, errorCount: 0, refused: [] });
      return { ...utils, onCorrect };
    }

    it('a changed name withdraws Replace, and Save adds the test it names', async () => {
      const { getByLabelText, getByRole, queryByRole, onCorrect } = await replaceOffered();
      fireEvent.change(getByLabelText('Test name'), { target: { value: 'Folate' } });
      expect(queryByRole('button', { name: /^Replace/ })).toBeNull();
      fireEvent.click(getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(bulkSaveLabValues).toHaveBeenLastCalledWith([expect.objectContaining({ metricName: 'Folate', value: 54 })]));
      expect(onCorrect).not.toHaveBeenCalled();
    });

    it('a changed unit withdraws Replace: a value in another unit is never a correction', async () => {
      const { getByLabelText, getByRole, queryByRole, onCorrect } = await replaceOffered();
      fireEvent.change(getByLabelText('Unit'), { target: { value: 'ng/mL' } });
      expect(queryByRole('button', { name: /^Replace/ })).toBeNull();
      fireEvent.click(getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(bulkSaveLabValues).toHaveBeenLastCalledWith([expect.objectContaining({ metricName: 'Feritin', unit: 'ng/mL' })]));
      expect(onCorrect).not.toHaveBeenCalled();
    });
  });

  // US-21 AC15 · a refusal reads as the upload summary does: a person never
  // sees the assistant's copy of it.
  describe('US-21 AC15 — a refused unit under "Other" shows the person’s wording', () => {
    async function saveOther(name: string, unit: string, value: string, refused: { key: string; unit: string; message: string }) {
      bulkSaveLabValues.mockResolvedValue({ saved: [], skippedDuplicates: 0, errorCount: 0, refused: [refused] });
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

    it('US-21 AC15 — a decimal count per µL leads with the number, not the unit', async () => {
      const { findByText } = await saveOther('Neutrophils', 'cells/uL', '2.4', {
        key: 'neutrophils', unit: 'cells/uL',
        message: 'Neutrophils in "cells/uL" was not stored. Counts of cells per µL are whole numbers on the same scale as their printed range, so this row is refused, never rescaled: check whether the report means thousands per µL (×10³/µL)',
      });
      const notice = await findByText(/^Neutrophils: the number was not saved\. Counts of cells per µL are whole numbers/);
      expect(notice.textContent).toContain('thousands per µL (×10³/µL).');
      expect(notice.textContent).not.toContain('unit not recognised');
      expect(notice.textContent).not.toContain('—');
    });
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
