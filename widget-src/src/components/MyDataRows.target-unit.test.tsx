// @vitest-environment jsdom
/**
 * H83 (US-62 AC8, AC9): the Waist row's "target · date" line carries the unit its value page
 * prints. The page read "Target: <89 cm" while the row read "Target <89". In centimetres and,
 * for a US reader, in inches.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { rowTarget } from '@roadmap/health-core/row-target';
import type { UnitSystem } from '@roadmap/health-core/units';
import { MetricRows, coreRow, type RowContext } from './MyDataRows';

afterEach(cleanup);

const plan = { age: 51, heightCm: 178 };
const ctx = (unit: UnitSystem): RowContext => ({ grading: { sex: 'male' }, plan, unitOf: () => unit });
const waist = [{ id: 'w1', metricType: 'waist', value: 86, recordedAt: '2026-10-12T00:00:00.000Z', createdAt: '2026-10-12T00:00:00.000Z' }];

const meta = (unit: UnitSystem) => {
  const view = render(<MetricRows rows={[coreRow('waist', waist as never, ctx(unit))]} onOpen={() => {}}/>);
  return view.container.querySelector('.md-row-meta')!.textContent;
};

describe('H83: the Waist row says its target with the unit its page prints', () => {
  it.each([
    ['si', 'Target <89 cm · Oct 2026', 'Target: <89 cm'],
    ['conventional', 'Target <34.7 in · Oct 2026', 'Target: <34.7 in'],
  ] as const)('%s', (unit, row, page) => {
    expect(meta(unit)).toBe(row);
    // The value page's line, the same number and unit (ValuePage prints rowTarget's full).
    expect(rowTarget('waist', unit, ctx(unit).grading, plan)?.full).toBe(page);
  });
});
