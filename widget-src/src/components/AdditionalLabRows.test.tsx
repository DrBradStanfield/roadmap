// @vitest-environment jsdom
/**
 * US-21 AC1 — additional lab rows must render in the SAME matrix layout as
 * the core blood-test table: date columns (oldest → newest), one row per
 * test with its name + unit chip in the sticky name cell, values in date
 * cells, newest column pinned.
 *
 * Bug (Brad, live, 2026-08-14): phase 1 shipped horizontal per-series value
 * strips instead — visually disconnected from the matrix directly above.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

afterEach(cleanup);
import type { ApiLabValue } from '../lib/api-types';
import type { CorrectFn } from '../lib/matrix-save';

vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));

import { AdditionalLabRows } from './AdditionalLabRows';

function row(overrides: Partial<ApiLabValue>): ApiLabValue {
  return {
    id: 'id-' + Math.random(),
    metricName: 'sodium',
    value: 140,
    unit: 'mmol/L',
    referenceLow: null,
    referenceHigh: null,
    recordedAt: '2026-05-12T00:00:00.000Z',
    source: 'lab_import',
    createdAt: '2026-05-12T00:00:00.000Z',
    ...overrides,
  };
}

const ROWS: ApiLabValue[] = [
  row({ metricName: 'sodium', value: 141, recordedAt: '2026-05-12T00:00:00.000Z' }),
  row({ metricName: 'sodium', value: 139, recordedAt: '2026-01-10T00:00:00.000Z' }),
  row({ metricName: 'potassium', value: 4.7, recordedAt: '2026-05-12T00:00:00.000Z' }),
];

function renderExpandedRenal() {
  const utils = render(<AdditionalLabRows labValues={ROWS} />);
  fireEvent.click(utils.getByRole('button', { name: /Renal/ }));
  return utils;
}

describe('US-21 AC1 — expanded group renders as a blood-test-style matrix', () => {
  it('uses the matrix scroller with one date column per distinct date, oldest first', () => {
    const { container } = renderExpandedRenal();
    const scroller = container.querySelector('.bt-timeline-scroll');
    expect(scroller, 'expanded group must use the bt matrix scroller').toBeTruthy();
    const dateCells = Array.from(container.querySelectorAll('.bt-header-row .bt-cell-date'));
    expect(dateCells.map(c => c.textContent)).toEqual(["10 Jan'26", "12 May'26"]);
  });

  it('renders each test as a matrix row: name + unit chip in the name cell, values in date cells', () => {
    const { container } = renderExpandedRenal();
    const rows = Array.from(container.querySelectorAll('.bt-row')).filter(
      r => !r.classList.contains('bt-header-row'),
    );
    expect(rows).toHaveLength(2); // Potassium, Sodium (alphabetical)
    const [potassium, sodium] = rows;
    expect(potassium.querySelector('.bt-cell-name')?.textContent).toContain('Potassium');
    expect(potassium.querySelector('.bt-cell-name')?.textContent).toContain('mmol/L');
    const sodiumValues = Array.from(sodium.querySelectorAll('.bt-cell-value')).map(c => c.textContent?.trim());
    expect(sodiumValues).toEqual(['139', '141']);
  });

  it('holds an empty (space, not collapsed) cell where a test has no value on a column date', () => {
    const { container } = renderExpandedRenal();
    const rows = Array.from(container.querySelectorAll('.bt-row')).filter(
      r => !r.classList.contains('bt-header-row'),
    );
    const potassiumCells = Array.from(rows[0].querySelectorAll('.bt-cell-value'));
    expect(potassiumCells).toHaveLength(2);
    // 10 Jan column has no potassium — empty placeholder holds the space so
    // theme `div:empty { display:none }` can't collapse it (known gotcha).
    expect(potassiumCells[0].classList.contains('bt-cell-empty')).toBe(true);
    expect(potassiumCells[0].textContent?.length).toBeGreaterThan(0);
    expect(potassiumCells[1].textContent?.trim()).toBe('4.7');
  });

  it('pins the newest column, matching the core matrix highlight', () => {
    const { container } = renderExpandedRenal();
    const headerCells = Array.from(container.querySelectorAll('.bt-header-row .bt-cell-date'));
    expect(headerCells[0].classList.contains('bt-cell-pinned')).toBe(false);
    expect(headerCells[1].classList.contains('bt-cell-pinned')).toBe(true);
  });
});

/**
 * US-21 AC5 (2026-09-22): a mistyped "add a blood test" value could not be
 * corrected; the lab cells were read-only. They now open the same editor as
 * the core matrix.
 */
describe('US-21 AC5 — a lab value opens the core editor', () => {
  it('a changed number is a correction, in the unit the value is stored in', async () => {
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const { container, getByRole } = render(<AdditionalLabRows labValues={ROWS} onCorrect={onCorrect} />);
    fireEvent.click(getByRole('button', { name: /Renal/ }));
    const sodium141 = Array.from(container.querySelectorAll('.bt-cell-clickable')).find((c) => c.textContent === '141') as HTMLElement;
    fireEvent.click(sodium141);
    const input = container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    expect(input.value).toBe('141');
    fireEvent.change(input, { target: { value: '142' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(onCorrect).toHaveBeenCalledWith(ROWS[0].id, 142));
  });

  it('stays read-only for a caller that passes no handler', () => {
    const { container } = renderExpandedRenal();
    expect(container.querySelector('.bt-cell-clickable')).toBeNull();
  });
});

/**
 * Codex R2 (2026-09-24): closing a group unmounted its matrix, and the
 * editor's click-away save (150 ms after the blur) died with it.
 */
describe('US-21 AC5 — closing a group never drops a correction', () => {
  function editSodium(onCorrect: CorrectFn) {
    const view = render(<AdditionalLabRows labValues={ROWS} onCorrect={onCorrect} />);
    const header = view.getByRole('button', { name: /Renal/ });
    fireEvent.click(header);
    fireEvent.click(Array.from(view.container.querySelectorAll('.bt-cell-clickable')).find((c) => c.textContent === '141') as HTMLElement);
    const input = view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '142' } });
    return { view, header };
  }

  it('a tap on the header that leaves the focus in the editor, as a phone does, still saves it', async () => {
    const onCorrect = vi.fn().mockResolvedValue('ok');
    const { header } = editSodium(onCorrect);
    fireEvent.click(header); // closes the group; nothing moved the focus
    await vi.waitFor(() => expect(onCorrect).toHaveBeenCalledWith(ROWS[0].id, 142));
  });

  it('a correction that fails as its group closes is there, with its reason, when the group opens again', async () => {
    const onCorrect = vi.fn().mockResolvedValue('error');
    const { view, header } = editSodium(onCorrect);
    fireEvent.click(header);
    await vi.waitFor(() => expect(onCorrect).toHaveBeenCalledTimes(1));
    fireEvent.click(header);
    await vi.waitFor(() => expect(view.getByText('Could not save. Check your connection and try again.')).toBeTruthy());
    expect((view.container.querySelector('.bt-cell-correcting input') as HTMLInputElement).value).toBe('142');
  });
});
