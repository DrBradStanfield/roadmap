// US-54 AC6: onboarding's height and weight unit switches are for entry only. A typed
// value is converted once, by health-core's factors through this door, to the units the
// engine's edit reads; the record's units never change.
import { describe, expect, it } from 'vitest';
import { applyEditJson, convertJson, newRecordJson } from './entry';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
type Converted = { value: number; text: string; feetInches: { feet: number; inches: number } | null };
const convert = (metric: string, value: number, from: string, to: string): Converted => JSON.parse(convertJson(metric, value, from, to));

function apply(record: string, edit: object): RoadmapFile {
  const outcome = JSON.parse(applyEditJson(record, JSON.stringify(edit), NOW, 'phone', '{}'));
  if (!outcome.ok) throw new Error(outcome.message);
  return JSON.parse(outcome.record);
}

describe('convertJson (US-54 AC6)', () => {
  it('gives a weight in the other units, unrounded for the edit and as the record shows it', () => {
    const lb = convert('weight', 70, 'si', 'conventional');
    expect(lb.value).toBeCloseTo(154.32, 2);
    expect(lb.text).toBe('154');
    expect(lb.feetInches).toBeNull();
    expect(convert('weight', 154.3, 'conventional', 'si').text).toBe('70.0');
  });

  it('re-shows a recorded weight in either unit and back unchanged (Codex 70 kg, adversary 70.5 kg)', () => {
    for (const [kg, lb] of [['70.0', '154'], ['70.5', '155']]) {
      expect(convert('weight', Number(kg), 'si', 'conventional').text).toBe(lb);
      // Back to kg the box re-reads the record, so it is the record's own text, not lb converted.
      expect(convert('weight', Number(kg), 'si', 'si').text).toBe(kg);
    }
  });

  it('gives a height as centimetres, inches and feet and inches', () => {
    expect(convert('height', 170, 'si', 'conventional').feetInches).toEqual({ feet: 5, inches: 7 });
    expect(convert('height', 182.5, 'si', 'si').feetInches).toEqual({ feet: 6, inches: 0 });
    expect(convert('height', 67, 'conventional', 'si').text).toBe('170');
    expect(convert('height', 72, 'conventional', 'si').text).toBe('183');
  });

  it('refuses an unknown metric, units or value', () => {
    expect(() => convertJson('shoe', 1, 'si', 'si')).toThrow();
    // An inherited key is no metric (adversary R-N5): `in` would let it through.
    expect(() => convertJson('constructor', 1, 'si', 'si')).toThrow('convertJson: unknown metric');
    expect(() => convertJson('weight', 1, 'si', 'imperial')).toThrow();
    expect(() => convertJson('weight', Number.NaN, 'si', 'conventional')).toThrow();
  });

  it('saves a weight typed in lb on a metric record as the right kilograms, the record still metric', () => {
    const record = newRecordJson(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const kg = convert('weight', 220, 'conventional', 'si').value;
    const file = apply(record, { kind: 'add', metric: 'weight', value: kg, day: '2026-10-20' });
    expect(file.measurements[0].value).toBeCloseTo(99.79, 2);
    expect(file.profile.unitSystem).toBe('si');
  });

  it('saves a height typed in cm on a US record, and one in feet and inches on a metric record', () => {
    const us = newRecordJson(NOW, 'phone', 'en-US', 'America/New_York');
    const inches = convert('height', 178, 'si', 'conventional').value;
    const fromCm = apply(us, { kind: 'profile', height: inches });
    expect(fromCm.profile.heightCm).toBeCloseTo(178, 6);
    expect(fromCm.profile.unitSystem).toBe('conventional');

    const metric = newRecordJson(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
    const fromFeet = apply(metric, { kind: 'profile', heightFeet: 5, heightInches: 10 });
    expect(fromFeet.profile.heightCm).toBeCloseTo(177.8, 1);
    expect(fromFeet.profile.unitSystem).toBe('si');
  });
});
