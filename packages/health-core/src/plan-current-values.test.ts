/**
 * US-29/US-30, US-07 AC5: get_plan's `currentValues` prints a lipid value on
 * the same side of its "<X" line as the plan's cards grade it.
 *
 * `currentValues` rounded with formatDisplayValue while the cards use
 * formatGradedValue, so one JSON said LDL "54" mg/dL in currentValues and
 * "55 mg/dL; below 55" in med-statin for the same 1.40 mmol/L row.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import { computePlan, planPayload } from './plan';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function planWith(rows: Array<{ metricType: string; value: number }>, unitSystem: 'si' | 'conventional') {
  const file = createEmptyFile({ deviceId: 'plan_current_values', now: NOW.toISOString() });
  Object.assign(file.profile, { sex: 'male', heightCm: 180, dateOfBirth: '1970-01-01', unitSystem });
  file.measurements = rows.map((r, i) => createMeasurement({
    id: `m${i}`, ...r, recordedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
  }));
  return planPayload(computePlan(file, NOW));
}

const valueOf = (payload: ReturnType<typeof planWith>, metric: string) =>
  payload.currentValues.find((v) => v.metric === metric)?.value;

describe('US-29/US-30 get_plan: currentValues agree with the cards (US-07 AC5)', () => {
  it('LDL 1.40 mmol/L in mg/dL prints 55, as med-statin does, not 54', () => {
    const payload = planWith([{ metricType: 'ldl', value: 1.4 }], 'conventional');
    expect(valueOf(payload, 'ldl')).toBe('55');
    const statin = payload.suggestions.find((s) => s.id === 'med-statin');
    expect(statin?.description).toContain('55 mg/dL');
  });

  it('LDL just under the line in mg/dL prints below 55', () => {
    // 54 mg/dL is 1.3964 mmol/L: below the 1.4 line, and it prints so.
    const payload = planWith([{ metricType: 'ldl', value: 1.3964 }], 'conventional');
    expect(Number(valueOf(payload, 'ldl'))).toBeLessThan(55);
  });

  it('ApoB just under 0.5 g/L in mg/dL prints below 50, not a rounded 50', () => {
    const payload = planWith([{ metricType: 'apob', value: 0.4996 }], 'conventional');
    expect(valueOf(payload, 'apob')).toBe('49.9');
  });

  it('a metric with no line keeps its plain display value', () => {
    const payload = planWith([{ metricType: 'hdl', value: 1.4 }], 'conventional');
    expect(valueOf(payload, 'hdl')).toBe('54');
  });
});
