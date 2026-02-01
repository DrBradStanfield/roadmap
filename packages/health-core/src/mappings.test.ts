import { describe, it, expect } from 'vitest';
import {
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  measurementsToInputs,
  diffInputsToMeasurements,
  type ApiMeasurement,
} from './mappings';

describe('FIELD_TO_METRIC / METRIC_TO_FIELD', () => {
  it('are inverses of each other', () => {
    for (const [field, metric] of Object.entries(FIELD_TO_METRIC)) {
      expect(METRIC_TO_FIELD[metric]).toBe(field);
    }
  });

  it('cover all 14 metric types', () => {
    expect(Object.keys(FIELD_TO_METRIC)).toHaveLength(14);
    expect(Object.keys(METRIC_TO_FIELD)).toHaveLength(14);
  });
});

describe('FIELD_METRIC_MAP', () => {
  it('contains only numeric fields (no sex, birth_year, birth_month)', () => {
    expect(Object.keys(FIELD_METRIC_MAP)).toHaveLength(10);
    expect(FIELD_METRIC_MAP).not.toHaveProperty('sex');
    expect(FIELD_METRIC_MAP).not.toHaveProperty('birthYear');
    expect(FIELD_METRIC_MAP).not.toHaveProperty('birthMonth');
  });
});

describe('measurementsToInputs', () => {
  it('converts basic measurements', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'height', value: 175, recordedAt: '', createdAt: '' },
      { id: '2', metricType: 'weight', value: 70, recordedAt: '', createdAt: '' },
    ];

    const inputs = measurementsToInputs(measurements);
    expect(inputs.heightCm).toBe(175);
    expect(inputs.weightKg).toBe(70);
  });

  it('converts sex from numeric', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'sex', value: 1, recordedAt: '', createdAt: '' },
    ];
    expect(measurementsToInputs(measurements).sex).toBe('male');

    const female: ApiMeasurement[] = [
      { id: '1', metricType: 'sex', value: 2, recordedAt: '', createdAt: '' },
    ];
    expect(measurementsToInputs(female).sex).toBe('female');
  });

  it('converts unit_system from numeric', () => {
    const si: ApiMeasurement[] = [
      { id: '1', metricType: 'unit_system', value: 1, recordedAt: '', createdAt: '' },
    ];
    expect(measurementsToInputs(si).unitSystem).toBe('si');

    const conv: ApiMeasurement[] = [
      { id: '1', metricType: 'unit_system', value: 2, recordedAt: '', createdAt: '' },
    ];
    expect(measurementsToInputs(conv).unitSystem).toBe('conventional');
  });

  it('ignores unknown metric types', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'unknown_metric', value: 99, recordedAt: '', createdAt: '' },
    ];
    const inputs = measurementsToInputs(measurements);
    expect(Object.keys(inputs)).toHaveLength(0);
  });

  it('converts all blood test metrics', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'hba1c', value: 39, recordedAt: '', createdAt: '' },
      { id: '2', metricType: 'ldl', value: 2.6, recordedAt: '', createdAt: '' },
      { id: '3', metricType: 'hdl', value: 1.3, recordedAt: '', createdAt: '' },
      { id: '4', metricType: 'triglycerides', value: 1.1, recordedAt: '', createdAt: '' },
      { id: '5', metricType: 'fasting_glucose', value: 5.0, recordedAt: '', createdAt: '' },
      { id: '6', metricType: 'systolic_bp', value: 120, recordedAt: '', createdAt: '' },
      { id: '7', metricType: 'diastolic_bp', value: 80, recordedAt: '', createdAt: '' },
    ];

    const inputs = measurementsToInputs(measurements);
    expect(inputs.hba1c).toBe(39);
    expect(inputs.ldlC).toBe(2.6);
    expect(inputs.hdlC).toBe(1.3);
    expect(inputs.triglycerides).toBe(1.1);
    expect(inputs.fastingGlucose).toBe(5.0);
    expect(inputs.systolicBp).toBe(120);
    expect(inputs.diastolicBp).toBe(80);
  });
});

describe('diffInputsToMeasurements', () => {
  it('returns empty array when nothing changed', () => {
    const data = { heightCm: 175, sex: 'male' as const };
    expect(diffInputsToMeasurements(data, data)).toHaveLength(0);
  });

  it('detects changed numeric fields', () => {
    const prev = { heightCm: 175, weightKg: 70 };
    const curr = { heightCm: 175, weightKg: 72 };
    const changes = diffInputsToMeasurements(curr, prev);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ metricType: 'weight', value: 72 });
  });

  it('detects new fields', () => {
    const prev = { heightCm: 175 };
    const curr = { heightCm: 175, weightKg: 70 };
    const changes = diffInputsToMeasurements(curr, prev);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ metricType: 'weight', value: 70 });
  });

  it('encodes unitSystem as numeric', () => {
    const prev = {};
    const curr = { unitSystem: 'si' as const };
    const changes = diffInputsToMeasurements(curr, prev);
    expect(changes).toEqual([{ metricType: 'unit_system', value: 1 }]);

    const curr2 = { unitSystem: 'conventional' as const };
    const changes2 = diffInputsToMeasurements(curr2, prev);
    expect(changes2).toEqual([{ metricType: 'unit_system', value: 2 }]);
  });

  it('encodes sex as numeric', () => {
    const prev = {};
    const curr = { sex: 'male' as const };
    const changes = diffInputsToMeasurements(curr, prev);
    expect(changes).toEqual([{ metricType: 'sex', value: 1 }]);

    const curr2 = { sex: 'female' as const };
    const changes2 = diffInputsToMeasurements(curr2, prev);
    expect(changes2).toEqual([{ metricType: 'sex', value: 2 }]);
  });

  it('ignores undefined current values', () => {
    const prev = { heightCm: 175 };
    const curr = { heightCm: undefined };
    const changes = diffInputsToMeasurements(curr as any, prev);
    expect(changes).toHaveLength(0);
  });
});
