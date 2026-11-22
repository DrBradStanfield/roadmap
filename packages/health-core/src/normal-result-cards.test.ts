/**
 * US-07 AC18 (Brad 2026-11-23): a normal HbA1c and a normal Lp(a) get no plan
 * card. The result row already says "normal"; the plan shows the HbA1c card
 * only in the prediabetes or diabetes range, and the Lp(a) card only when
 * borderline or elevated. The result itself stays in the plan's values.
 */
import { describe, it, expect } from 'vitest';
import { createEmptyFile, createMeasurement } from './roadmap-file';
import { computePlan, planPayload } from './plan';
import { STAT_CARD_EVIDENCE, SUGGESTION_EVIDENCE } from './evidence';
import { reportedToCanonical } from './units';

const NOW = new Date('2026-10-31T12:00:00.000Z');

function plan(metricType: 'hba1c' | 'lpa', value: number) {
  const file = createEmptyFile({ deviceId: 'normal_cards', now: NOW.toISOString() });
  Object.assign(file.profile, { sex: 'male', heightCm: 175, birthYear: 1975, birthMonth: 1, unitSystem: 'si' });
  file.measurements = [createMeasurement({
    id: 'm0', metricType, value, recordedAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z',
  })];
  const payload = planPayload(computePlan(file, NOW));
  return {
    cards: payload.suggestions.map((s) => s.id).filter((id) => id.startsWith(`${metricType}-`)),
    shown: payload.currentValues.some((v) => v.metric === metricType),
  };
}
const lpa = (value: number, unit: string) => reportedToCanonical('lpa', value, unit)!.valueSI;

describe('US-07 AC18: no card for a normal HbA1c or Lp(a) (Brad 2026-11-23)', () => {
  it.each([
    [36, []], [38.7, []], [38.8, ['hba1c-prediabetic']], [47.5, ['hba1c-prediabetic']], [48, ['hba1c-diabetic']],
  ])('HbA1c %s mmol/mol: cards %j, value still in the plan', (value, cards) => {
    expect(plan('hba1c', value)).toEqual({ cards, shown: true });
  });

  it.each([
    [30, 'nmol/L', []], [74.9, 'nmol/L', []], [75, 'nmol/L', ['lpa-borderline']], [125, 'nmol/L', ['lpa-elevated']],
    [12, 'mg/dL', []], [29.9, 'mg/dL', []], [30, 'mg/dL', ['lpa-borderline']], [50, 'mg/dL', ['lpa-elevated']],
    [299, 'mg/L', []], [500, 'mg/L', ['lpa-elevated']],
  ])('Lp(a) %s %s: cards %j, value still in the plan', (value, unit, cards) => {
    expect(plan('lpa', lpa(value, unit))).toEqual({ cards, shown: true });
  });

  it('the two cards are gone with their evidence; the cards that stay keep theirs', () => {
    expect(SUGGESTION_EVIDENCE['hba1c-normal']).toBeUndefined();
    expect(SUGGESTION_EVIDENCE['lpa-normal']).toBeUndefined();
    for (const id of ['hba1c-prediabetic', 'hba1c-diabetic', 'lpa-borderline', 'lpa-elevated']) {
      expect(SUGGESTION_EVIDENCE[id] ?? null, id).not.toBeNull();
    }
    expect(STAT_CARD_EVIDENCE['lpa'] ?? null, 'the Lp(a) result keeps its own evidence').not.toBeNull();
  });
});
