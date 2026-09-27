// @vitest-environment jsdom
/**
 * US-07 AC5: the LDL and non-HDL tiles call a value optimal only below the
 * plan's targets (1.4 and 1.6 mmol/L). From there up to Borderline they say
 * "Above optimal" in amber, as ApoB's Borderline is amber at its 0.5 target.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { calculateHealthResults, toCanonicalValue, type HealthInputs, type UnitSystem } from '@roadmap/health-core';

vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: vi.fn(), sendGuestReport: vi.fn(), getReportEmailCaptured: () => false, markReportEmailCaptured: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: vi.fn() }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { ResultsPanel } from './ResultsPanel';

afterEach(cleanup);

/** The lipid tiles for these lab values. */
function lipidTiles(values: Partial<HealthInputs>, unitSystem: UnitSystem = 'si') {
  const results = calculateHealthResults({ heightCm: 175, sex: 'male', ...values });
  const view = render(<ResultsPanel results={results} isValid unitSystem={unitSystem} />);
  return Array.from(view.container.querySelectorAll('.stat-card'))
    .filter((c) => /LDL|Non-HDL|ApoB/.test(c.querySelector('.stat-label')?.textContent ?? ''));
}

/** The lipid tile's label and status class for these lab values. */
function lipidTile(values: Partial<HealthInputs>) {
  const status = lipidTiles(values)[0]?.querySelector('.stat-status');
  return { label: status?.textContent, className: status?.className.replace('stat-status ', '') };
}

describe('US-07 AC5: LDL and non-HDL tiles', () => {
  it.each([
    [1.39, 'Optimal', 'status-normal'],
    [1.4, 'Above optimal', 'status-info'],
    [3.2, 'Above optimal', 'status-info'],
    [3.37, 'Borderline', 'status-info'],
    [4.2, 'High', 'status-attention'],
  ])('LDL %s: %s', (ldlC, label, className) => {
    expect(lipidTile({ ldlC })).toEqual({ label, className });
  });

  // Non-HDL is graded unrounded (US-07 AC5): 1.56 is below the 1.6 target and
  // 4.14 is at the 4.1376 Borderline line, though both show one decimal place.
  it.each([
    [3.0, 1.5, 'Optimal', 'status-normal'], // non-HDL 1.5
    [3.76, 2.2, 'Optimal', 'status-normal'], // non-HDL 1.56
    [3.2, 1.6, 'Above optimal', 'status-info'], // non-HDL 1.6
    [5.63, 1.5, 'Above optimal', 'status-info'], // non-HDL 4.13
    [5.64, 1.5, 'Borderline', 'status-info'], // non-HDL 4.14
    [5.7, 1.5, 'Borderline', 'status-info'], // non-HDL 4.2
  ])('total %s, HDL %s: %s', (totalCholesterol, hdlC, label, className) => {
    expect(lipidTile({ totalCholesterol, hdlC })).toEqual({ label, className });
  });

  // One tile, for the plan's marker: ApoB, else non-HDL, else LDL
  it.each([
    [{ apoB: 0.6, totalCholesterol: 5.0, hdlC: 1.2, ldlC: 3.0 }, 'ApoB', '0.60 g/L'],
    [{ totalCholesterol: 5.0, hdlC: 1.2, ldlC: 3.0 }, 'Non-HDL Cholesterol', '3.8 mmol/L'],
    [{ totalCholesterol: 5.0, ldlC: 3.0 }, 'LDL Cholesterol', '3.0 mmol/L'],
  ])('%o shows the %s tile', (values, label, value) => {
    const tiles = lipidTiles(values);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].querySelector('.stat-label')?.textContent).toBe(label);
    expect(tiles[0].querySelector('.stat-value')?.textContent).toBe(value);
  });

  it('ApoB keeps its tiers: Borderline from its 0.5 target', () => {
    expect(lipidTile({ apoB: 0.49 })).toEqual({ label: 'Optimal', className: 'status-normal' });
    expect(lipidTile({ apoB: 0.5 })).toEqual({ label: 'Borderline', className: 'status-info' });
  });
});

// US-07 AC5: the tile's value reads on the side of the optimal line its status
// grades it, though it was entered in the other unit or off the display grid.
describe('US-07 AC5: the tile value agrees with its status', () => {
  const tile = (values: Partial<HealthInputs>, unitSystem: UnitSystem) => {
    const card = lipidTiles(values, unitSystem)[0];
    return [card.querySelector('.stat-value')?.textContent, card.querySelector('.stat-status')?.textContent];
  };

  it.each([
    ['non-HDL 1.56 (3.76, 2.20)', { totalCholesterol: 3.76, hdlC: 2.2 }, 'si', ['1.56 mmol/L', 'Optimal']],
    ['LDL 1.40 mmol/L in mg/dL', { ldlC: 1.4 }, 'conventional', ['55 mg/dL', 'Above optimal']],
    ['LDL 54 mg/dL in mmol/L', { ldlC: toCanonicalValue('ldl', 54, 'conventional') }, 'si', ['1.39 mmol/L', 'Optimal']],
  ] as const)('%s', (_name, values, unitSystem, expected) => {
    expect(tile(values, unitSystem)).toEqual(expected);
  });
});
