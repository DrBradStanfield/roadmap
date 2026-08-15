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
vi.mock('../lib/api', () => ({
  bulkSaveLabValues: (...args: unknown[]) => bulkSaveLabValues(...args),
  trackProductEvent: (...args: unknown[]) => trackProductEvent(...args),
}));

import { AddLabTest } from './AddLabTest';
import { AdditionalLabRows } from './AdditionalLabRows';

beforeEach(() => {
  bulkSaveLabValues.mockReset().mockResolvedValue({ saved: [{ id: 'x' }], skippedDuplicates: 0, errorCount: 0 });
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
    bulkSaveLabValues.mockResolvedValue({ saved: [], skippedDuplicates: 1, errorCount: 0 });
    const { getByLabelText, getByRole, onAdded, findByText } = openForm();
    fireEvent.change(getByLabelText('Test'), { target: { value: 'sodium' } });
    fireEvent.change(getByLabelText('Value'), { target: { value: '140' } });
    fireEvent.click(getByRole('button', { name: /^save$/i }));
    expect(await findByText(/already has a value for that date/i)).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalled();
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
