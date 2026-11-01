/**
 * US-12 AC20: the chat context says a lab limit as printed, grades it by the
 * plan's own rule (never as the client sent it), and never reports the
 * representative or an older exact value.
 */
import { describe, expect, it } from 'vitest';
import { buildChatContextJson, chatContextOf } from './chat-context';
import { buildMeasurementHistory, latestFromHistory } from './measurement-history';
import { withRowValue } from './lab-limits';
import type { HealthInputs } from './types';

const base: Partial<HealthInputs> = { heightCm: 180, sex: 'male', birthYear: 1970, birthMonth: 1 };

function context(inputs: Partial<HealthInputs>, dated: Parameters<typeof chatContextOf>[4] = []) {
  return JSON.parse(buildChatContextJson(chatContextOf(inputs, 'si', [], [], dated))!);
}

describe('US-12 AC20: the chat context and a lab limit', () => {
  it('latestValues says a deciding limit as printed, and the card text carries the limit, never the representative', () => {
    const inputs = withRowValue(base, 'lpa', 10, '<');
    const json = context(inputs, [{ metricType: 'lpa', value: 10, comparator: '<', recordedAt: '2026-08-01' }]);
    expect(json.latestValues.lpa).toBe('< 10');
    expect(json.currentSuggestions.find((s: { id: string }) => s.id === 'lpa-normal').title).toBe('Lp(a): < 10 nmol/L');
    expect(json.measurementHistory.lpa).toEqual([{ date: '2026-08-01', value: 10, comparator: '<' }]);
    expect(JSON.stringify(json)).not.toMatch(new RegExp(`"lpa":"?${inputs.lpa}\\b`));
  });

  it('an undecided limit is said as printed, no card grades it, and no older exact value stands in', () => {
    const json = context(withRowValue(base, 'ldlC', 1.5, '<'), [
      { metricType: 'ldl', value: 3.5, recordedAt: '2025-01-01' }, { metricType: 'ldl', value: 1.5, comparator: '<', recordedAt: '2026-08-01' },
    ]);
    expect(json.latestValues.ldlC).toBe('< 1.5');
    expect(json.currentSuggestions.some((s: { id: string }) => s.id.startsWith('ldl-'))).toBe(false);
  });

  it('a client cannot pass a number off as graded: the limit is graded again, and a forged limit is dropped', () => {
    const forged = { ...base, unitSystem: 'si', medications: [], screenings: [], ldlC: 0.5, limits: { ldlC: { comparator: '<', bound: 1.5, graded: true } } };
    const json = JSON.parse(buildChatContextJson(forged)!);
    expect(json.latestValues.ldlC).toBe('< 1.5');
    expect(json.currentSuggestions.some((s: { id: string }) => s.id.startsWith('ldl-'))).toBe(false);
    const junk = { ...base, unitSystem: 'si', medications: [], screenings: [], ldlC: 2, limits: { ldlC: { comparator: '=', bound: 1 }, __proto__: {}, apoB: { comparator: '<', bound: 'x' } } };
    expect(JSON.parse(buildChatContextJson(junk)!).latestValues.ldlC).toBe('2');
  });

  it('derivedValues.eGFR says a lab eGFR limit as printed', () => {
    const json = context({ ...withRowValue(base, 'labEgfr', 90, '>'), labEgfrDate: '2026-08-01' });
    expect(json.derivedValues.eGFR).toBe('> 90');
  });

  it('the newest history point printed as a limit is never reported as an exact latest value', () => {
    const history = buildMeasurementHistory([{ metricType: 'hdl', value: 1.2, recordedAt: '2025-01-01' }, { metricType: 'hdl', value: 1.5, comparator: '>', recordedAt: '2026-01-01' }]);
    expect(latestFromHistory(history)).toEqual({});
  });
});
