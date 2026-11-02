/**
 * US-05 AC2b: a US-unit input range must be the SI bound converted and rounded
 * inward (US-35 AC17), so every number the cell accepts is one the record's
 * schema accepts. The hand-written conventional ranges overshoot at these
 * ends: a typed value passes the cell (cellRange -> getDisplayRange), a new
 * matrix row is stored without a range check (placeMeasurement, D4b), and the
 * plan then strips the field as invalid.
 */
import { describe, expect, it } from 'vitest';
import { getDisplayRange, toCanonicalValue, type MetricType } from './units';
import { healthInputSchema } from './validation';

const CASES: Array<[MetricType, keyof typeof healthInputSchema.shape]> = [
  ['weight', 'weightKg'],
  ['waist', 'waistCm'],
  ['hba1c', 'hba1c'],
  ['ldl', 'ldlC'],
  ['creatinine', 'creatinine'],
];

describe('US-05 AC2b: US-unit input range ends convert inside the SI schema', () => {
  it.each(CASES)('%s: both conventional ends pass %s', (metric, field) => {
    const { min, max, minExclusive } = getDisplayRange(metric, 'conventional');
    // An exclusive floor (US-03 AC7) is refused by design; its ceiling still counts.
    for (const end of minExclusive ? [max] : [min, max]) {
      const si = toCanonicalValue(metric, end, 'conventional');
      // Before US-05 AC2b: 44 lb -> 19.958 kg, 79 in -> 200.66 cm, 20 % -> 195.10 mmol/mol,
      // 500 mg/dL -> 12.930 mmol/L, 0.1 / 30 mg/dL -> 8.84 / 2652 µmol/L.
      expect(healthInputSchema.shape[field].safeParse(si).success, `${metric} ${end} -> ${si}`).toBe(true);
    }
  });
});
