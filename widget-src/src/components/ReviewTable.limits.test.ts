// US-12 AC20 (orchestrator, 2026-11-02): a limit's number in the upload review
// rounds away from its band in whatever unit the row shows, as every other
// surface does, so the shown limit stays true; an exact value rounds as before.
import { describe, it, expect } from 'vitest';
import type { Comparator } from '@roadmap/health-core';
import { buildMatrixModel } from './ReviewTable';
import type { FileResult } from './ReviewTable';

const DATE = { day: '01', month: '06', year: '2024' };
const HDL_60_MGDL = 60 / 38.67; // 1.55159… mmol/L

function upload(comparator?: Comparator): FileResult[] {
  return [{
    fileName: 'labs.pdf', reportDate: '2024-06-01', additionalValues: [],
    values: [{ metric: 'hdl', valueSI: HDL_60_MGDL, displayValue: 60, displayUnit: 'mg/dL', confidence: 'high', ...(comparator ? { comparator } : {}) }],
  }];
}

const shown = (comparator: Comparator | undefined, unit: 'si' | 'conventional') => {
  const cell = buildMatrixModel(upload(comparator), { 0: DATE }, [], [], unit).cells.get('hdl|2024-06-01');
  return cell?.state === 'editable' ? cell.initialDisplay : undefined;
};

describe('US-12 AC20: a limit in the upload review, after a unit switch', () => {
  it('"> 60" mg/dL reads "1.55" in mmol/L, rounded down, so "> 1.55" stays true', () => {
    expect(shown('>', 'si')).toBe('1.55');
  });
  it('"< 60" mg/dL reads "1.56" in mmol/L, rounded up', () => {
    expect(shown('<', 'si')).toBe('1.56');
  });
  it('the printed unit shows the bound as printed', () => {
    expect(shown('>', 'conventional')).toBe('60');
  });
  it('an exact value rounds to the display step, as before', () => {
    expect(shown(undefined, 'si')).toBe('1.6');
  });
});
