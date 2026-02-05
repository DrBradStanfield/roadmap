import { describe, it, expect } from 'vitest';
import {
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  measurementsToInputs,
  diffInputsToMeasurements,
  diffProfileFields,
  medicationsToInputs,
  type ApiMeasurement,
  type ApiMedication,
} from './mappings';

describe('FIELD_TO_METRIC / METRIC_TO_FIELD', () => {
  it('are inverses of each other', () => {
    for (const [field, metric] of Object.entries(FIELD_TO_METRIC)) {
      expect(METRIC_TO_FIELD[metric]).toBe(field);
    }
  });

  it('cover all health metric types (no height — stored on profile)', () => {
    expect(Object.keys(FIELD_TO_METRIC)).toHaveLength(12);
    expect(Object.keys(METRIC_TO_FIELD)).toHaveLength(12);
  });
});

describe('FIELD_METRIC_MAP', () => {
  it('contains only numeric fields (no sex, birth_year, birth_month)', () => {
    expect(Object.keys(FIELD_METRIC_MAP)).toHaveLength(13);
    expect(FIELD_METRIC_MAP).not.toHaveProperty('sex');
    expect(FIELD_METRIC_MAP).not.toHaveProperty('birthYear');
    expect(FIELD_METRIC_MAP).not.toHaveProperty('birthMonth');
  });
});

describe('measurementsToInputs', () => {
  it('converts basic measurements', () => {
    const measurements: ApiMeasurement[] = [
      { id: '2', metricType: 'weight', value: 70, recordedAt: '', createdAt: '' },
    ];

    const inputs = measurementsToInputs(measurements);
    expect(inputs.weightKg).toBe(70);
  });

  it('converts profile data from profile parameter (including height)', () => {
    const measurements: ApiMeasurement[] = [];
    const profile = { sex: 1, birthYear: 1990, birthMonth: 5, unitSystem: 1, firstName: null, lastName: null, height: 175 };

    const inputs = measurementsToInputs(measurements, profile);
    expect(inputs.sex).toBe('male');
    expect(inputs.birthYear).toBe(1990);
    expect(inputs.birthMonth).toBe(5);
    expect(inputs.unitSystem).toBe('si');
    expect(inputs.heightCm).toBe(175);
  });

  it('converts female sex and conventional unit system from profile', () => {
    const inputs = measurementsToInputs([], { sex: 2, birthYear: null, birthMonth: null, unitSystem: 2, firstName: null, lastName: null, height: null });
    expect(inputs.sex).toBe('female');
    expect(inputs.unitSystem).toBe('conventional');
    expect(inputs.birthYear).toBeUndefined();
  });

  it('handles null profile fields', () => {
    const inputs = measurementsToInputs([], { sex: null, birthYear: null, birthMonth: null, unitSystem: null, firstName: null, lastName: null, height: null });
    expect(inputs.sex).toBeUndefined();
    expect(inputs.birthYear).toBeUndefined();
    expect(inputs.unitSystem).toBeUndefined();
    expect(inputs.heightCm).toBeUndefined();
  });

  it('merges measurements and profile data (height from profile)', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'weight', value: 70, recordedAt: '', createdAt: '' },
    ];
    const profile = { sex: 1, birthYear: 1990, birthMonth: null, unitSystem: null, firstName: null, lastName: null, height: 175 };

    const inputs = measurementsToInputs(measurements, profile);
    expect(inputs.weightKg).toBe(70);
    expect(inputs.heightCm).toBe(175);
    expect(inputs.sex).toBe('male');
    expect(inputs.birthYear).toBe(1990);
  });

  it('ignores unknown metric types', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'unknown_metric', value: 99, recordedAt: '', createdAt: '' },
    ];
    const inputs = measurementsToInputs(measurements);
    expect(Object.keys(inputs)).toHaveLength(0);
  });

  it('preserves unitSystem from profile even when no measurements exist', () => {
    // This is critical: unitSystem must be preserved from cloud data
    // even when filtering to only PREFILL_FIELDS. Without this, the
    // user's unit preference resets after data deletion + reload.
    const profile = { sex: null, birthYear: null, birthMonth: null, unitSystem: 2, firstName: null, lastName: null, height: null };
    const inputs = measurementsToInputs([], profile);
    expect(inputs.unitSystem).toBe('conventional');
  });

  it('converts all blood test metrics', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'hba1c', value: 39, recordedAt: '', createdAt: '' },
      { id: '2', metricType: 'ldl', value: 2.6, recordedAt: '', createdAt: '' },
      { id: '3', metricType: 'hdl', value: 1.3, recordedAt: '', createdAt: '' },
      { id: '4', metricType: 'triglycerides', value: 1.1, recordedAt: '', createdAt: '' },
      { id: '5', metricType: 'systolic_bp', value: 120, recordedAt: '', createdAt: '' },
      { id: '6', metricType: 'diastolic_bp', value: 80, recordedAt: '', createdAt: '' },
    ];

    const inputs = measurementsToInputs(measurements);
    expect(inputs.hba1c).toBe(39);
    expect(inputs.ldlC).toBe(2.6);
    expect(inputs.hdlC).toBe(1.3);
    expect(inputs.triglycerides).toBe(1.1);
    expect(inputs.systolicBp).toBe(120);
    expect(inputs.diastolicBp).toBe(80);
  });
});

describe('diffInputsToMeasurements', () => {
  it('returns empty array when nothing changed', () => {
    const data = { weightKg: 70 };
    expect(diffInputsToMeasurements(data, data)).toHaveLength(0);
  });

  it('detects changed numeric fields', () => {
    const prev = { weightKg: 70, waistCm: 80 };
    const curr = { weightKg: 72, waistCm: 80 };
    const changes = diffInputsToMeasurements(curr, prev);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ metricType: 'weight', value: 72 });
  });

  it('detects new fields', () => {
    const prev = { waistCm: 80 };
    const curr = { waistCm: 80, weightKg: 70 };
    const changes = diffInputsToMeasurements(curr, prev);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ metricType: 'weight', value: 70 });
  });

  it('does not include profile fields (sex, birthYear, height, etc)', () => {
    const prev = {};
    const curr = { sex: 'male' as const, birthYear: 1990, unitSystem: 'si' as const, heightCm: 175 };
    const changes = diffInputsToMeasurements(curr, prev);
    expect(changes).toHaveLength(0);
  });

  it('ignores undefined current values', () => {
    const prev = { weightKg: 70 };
    const curr = { weightKg: undefined };
    const changes = diffInputsToMeasurements(curr as any, prev);
    expect(changes).toHaveLength(0);
  });
});

describe('diffProfileFields', () => {
  it('returns null when nothing changed', () => {
    const data = { sex: 'male' as const, birthYear: 1990 };
    expect(diffProfileFields(data, data)).toBeNull();
  });

  it('detects sex change and encodes numerically', () => {
    const prev = { sex: 'male' as const };
    const curr = { sex: 'female' as const };
    expect(diffProfileFields(curr, prev)).toEqual({ sex: 2 });
  });

  it('detects unit system change', () => {
    const prev = { unitSystem: 'si' as const };
    const curr = { unitSystem: 'conventional' as const };
    expect(diffProfileFields(curr, prev)).toEqual({ unitSystem: 2 });
  });

  it('detects birth year/month changes', () => {
    const prev = { birthYear: 1990, birthMonth: 5 };
    const curr = { birthYear: 1991, birthMonth: 6 };
    expect(diffProfileFields(curr, prev)).toEqual({ birthYear: 1991, birthMonth: 6 });
  });

  it('returns only changed fields', () => {
    const prev = { sex: 'male' as const, birthYear: 1990, unitSystem: 'si' as const };
    const curr = { sex: 'male' as const, birthYear: 1991, unitSystem: 'si' as const };
    expect(diffProfileFields(curr, prev)).toEqual({ birthYear: 1991 });
  });

  it('detects height change (height is now a profile field)', () => {
    const prev = { heightCm: 175 };
    const curr = { heightCm: 180 };
    expect(diffProfileFields(curr, prev)).toEqual({ height: 180 });
  });

  it('does not include measurement fields (weight, waist, etc)', () => {
    const prev = { weightKg: 70 };
    const curr = { weightKg: 75 };
    expect(diffProfileFields(curr, prev)).toBeNull();
  });
});

describe('medicationsToInputs', () => {
  it('converts all medication keys', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'statin', value: 'tier_1', updatedAt: '' },
      { id: '2', medicationKey: 'ezetimibe', value: 'yes', updatedAt: '' },
      { id: '3', medicationKey: 'statin_increase', value: 'not_yet', updatedAt: '' },
      { id: '4', medicationKey: 'pcsk9i', value: 'no', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.statin).toBe('tier_1');
    expect(inputs.ezetimibe).toBe('yes');
    expect(inputs.statinIncrease).toBe('not_yet');
    expect(inputs.pcsk9i).toBe('no');
  });

  it('returns empty object for empty array', () => {
    const inputs = medicationsToInputs([]);
    expect(inputs).toEqual({});
  });

  it('ignores unknown medication keys', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'unknown', value: 'yes', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(Object.keys(inputs)).toHaveLength(0);
  });
});
