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
import { render, fireEvent, cleanup } from '@testing-library/react';

afterEach(cleanup);
import type { ApiLabValue } from '../lib/api-types';

vi.mock('../lib/api', () => ({ trackProductEvent: vi.fn() }));

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
