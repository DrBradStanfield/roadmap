import { describe, it, expect } from 'vitest';
import {
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  measurementsToInputs,
  diffInputsToMeasurements,
  diffProfileFields,
  hasCloudData,
  medicationsToInputs,
  screeningsToInputs,
  computeFormStage,
  type ApiMeasurement,
  type ApiMedication,
  type ApiProfile,
  type ApiScreening,
} from './mappings';

describe('FIELD_TO_METRIC / METRIC_TO_FIELD', () => {
  it('are inverses of each other', () => {
    for (const [field, metric] of Object.entries(FIELD_TO_METRIC)) {
      expect(METRIC_TO_FIELD[metric]).toBe(field);
    }
  });

  it('cover all health metric types (no height — stored on profile)', () => {
    expect(Object.keys(FIELD_TO_METRIC)).toHaveLength(13);
    expect(Object.keys(METRIC_TO_FIELD)).toHaveLength(13);
  });
});

describe('FIELD_METRIC_MAP', () => {
  it('contains only numeric fields (no sex, birth_year, birth_month)', () => {
    expect(Object.keys(FIELD_METRIC_MAP)).toHaveLength(14);
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
  it('converts all medication keys with FHIR-compatible structure', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '' },
      { id: '2', medicationKey: 'ezetimibe', drugName: 'yes', doseValue: null, doseUnit: null, updatedAt: '' },
      { id: '3', medicationKey: 'statin_escalation', drugName: 'not_yet', doseValue: null, doseUnit: null, updatedAt: '' },
      { id: '4', medicationKey: 'pcsk9i', drugName: 'no', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.statin).toEqual({ drug: 'atorvastatin', dose: 20 });
    expect(inputs.ezetimibe).toBe('yes');
    expect(inputs.statinEscalation).toBe('not_yet');
    expect(inputs.pcsk9i).toBe('no');
  });

  it('handles statin special values (none, not_tolerated)', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'statin', drugName: 'not_tolerated', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.statin).toEqual({ drug: 'not_tolerated', dose: null });
  });

  it('returns empty object for empty array', () => {
    const inputs = medicationsToInputs([]);
    expect(inputs).toEqual({});
  });

  it('ignores unknown medication keys', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'unknown', drugName: 'yes', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(Object.keys(inputs)).toHaveLength(0);
  });

  it('converts FHIR-compliant ezetimibe (actual drug data) to yes', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'ezetimibe', drugName: 'ezetimibe', doseValue: 10, doseUnit: 'mg', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.ezetimibe).toBe('yes');
  });

  it('converts FHIR-compliant pcsk9i (actual drug data) to yes', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'pcsk9i', drugName: 'pcsk9i', doseValue: 140, doseUnit: 'mg', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.pcsk9i).toBe('yes');
  });

  it('preserves ezetimibe status values without dose', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'ezetimibe', drugName: 'not_tolerated', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.ezetimibe).toBe('not_tolerated');
  });

  // Weight & diabetes cascade medications
  it('converts glp1 medication with drug and dose', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'glp1', drugName: 'tirzepatide', doseValue: 5, doseUnit: 'mg', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.glp1).toEqual({ drug: 'tirzepatide', dose: 5 });
  });

  it('converts glp1 with decimal dose', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'glp1', drugName: 'semaglutide_injection', doseValue: 0.25, doseUnit: 'mg', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.glp1).toEqual({ drug: 'semaglutide_injection', dose: 0.25 });
  });

  it('converts glp1 not_tolerated status', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'glp1', drugName: 'not_tolerated', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.glp1).toEqual({ drug: 'not_tolerated', dose: null });
  });

  it('converts sglt2i medication with drug and dose', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'sglt2i', drugName: 'empagliflozin', doseValue: 10, doseUnit: 'mg', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.sglt2i).toEqual({ drug: 'empagliflozin', dose: 10 });
  });

  it('converts metformin formulation value', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'metformin', drugName: 'xr_1000', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.metformin).toBe('xr_1000');
  });

  it('converts all medication keys including weight/diabetes cascade', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '' },
      { id: '2', medicationKey: 'glp1', drugName: 'tirzepatide', doseValue: 2.5, doseUnit: 'mg', updatedAt: '' },
      { id: '3', medicationKey: 'sglt2i', drugName: 'dapagliflozin', doseValue: 10, doseUnit: 'mg', updatedAt: '' },
      { id: '4', medicationKey: 'metformin', drugName: 'ir_500', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.statin).toEqual({ drug: 'atorvastatin', dose: 20 });
    expect(inputs.glp1).toEqual({ drug: 'tirzepatide', dose: 2.5 });
    expect(inputs.sglt2i).toEqual({ drug: 'dapagliflozin', dose: 10 });
    expect(inputs.metformin).toBe('ir_500');
  });
});

describe('screeningsToInputs', () => {
  it('returns empty object for empty array', () => {
    expect(screeningsToInputs([])).toEqual({});
  });

  it('converts colorectal screening method and date', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'colorectal_method', value: 'colonoscopy_10yr', updatedAt: '' },
      { id: '2', screeningKey: 'colorectal_last_date', value: '2023-06', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.colorectalMethod).toBe('colonoscopy_10yr');
    expect(inputs.colorectalLastDate).toBe('2023-06');
  });

  it('converts colorectal follow-up fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'colorectal_result', value: 'abnormal', updatedAt: '' },
      { id: '2', screeningKey: 'colorectal_followup_status', value: 'completed', updatedAt: '' },
      { id: '3', screeningKey: 'colorectal_followup_date', value: '2024-01', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.colorectalResult).toBe('abnormal');
    expect(inputs.colorectalFollowupStatus).toBe('completed');
    expect(inputs.colorectalFollowupDate).toBe('2024-01');
  });

  it('converts breast screening fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'breast_frequency', value: 'annual', updatedAt: '' },
      { id: '2', screeningKey: 'breast_last_date', value: '2024-03', updatedAt: '' },
      { id: '3', screeningKey: 'breast_result', value: 'normal', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.breastFrequency).toBe('annual');
    expect(inputs.breastLastDate).toBe('2024-03');
    expect(inputs.breastResult).toBe('normal');
  });

  it('converts cervical screening fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'cervical_method', value: 'hpv_5yr', updatedAt: '' },
      { id: '2', screeningKey: 'cervical_last_date', value: '2022-09', updatedAt: '' },
      { id: '3', screeningKey: 'cervical_result', value: 'normal', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.cervicalMethod).toBe('hpv_5yr');
    expect(inputs.cervicalLastDate).toBe('2022-09');
    expect(inputs.cervicalResult).toBe('normal');
  });

  it('converts lung screening fields including pack years as number', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'lung_smoking_history', value: 'former', updatedAt: '' },
      { id: '2', screeningKey: 'lung_pack_years', value: '25', updatedAt: '' },
      { id: '3', screeningKey: 'lung_screening', value: 'ldct_annual', updatedAt: '' },
      { id: '4', screeningKey: 'lung_last_date', value: '2024-01', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.lungSmokingHistory).toBe('former');
    expect(inputs.lungPackYears).toBe(25);
    expect(inputs.lungScreening).toBe('ldct_annual');
    expect(inputs.lungLastDate).toBe('2024-01');
  });

  it('converts prostate screening fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'prostate_discussion', value: 'yes_screening', updatedAt: '' },
      { id: '2', screeningKey: 'prostate_psa_value', value: '1.2', updatedAt: '' },
      { id: '3', screeningKey: 'prostate_last_date', value: '2024-06', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.prostateDiscussion).toBe('yes_screening');
    expect(inputs.prostatePsaValue).toBe(1.2);
    expect(inputs.prostateLastDate).toBe('2024-06');
  });

  it('converts endometrial screening fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'endometrial_discussion', value: 'discussed', updatedAt: '' },
      { id: '2', screeningKey: 'endometrial_abnormal_bleeding', value: 'no', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.endometrialDiscussion).toBe('discussed');
    expect(inputs.endometrialAbnormalBleeding).toBe('no');
  });

  it('ignores unknown screening keys', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'unknown_key', value: 'test', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(Object.keys(inputs)).toHaveLength(0);
  });

  it('handles lung follow-up fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'lung_result', value: 'abnormal', updatedAt: '' },
      { id: '2', screeningKey: 'lung_followup_status', value: 'awaiting', updatedAt: '' },
      { id: '3', screeningKey: 'lung_followup_date', value: '2024-04', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.lungResult).toBe('abnormal');
    expect(inputs.lungFollowupStatus).toBe('awaiting');
    expect(inputs.lungFollowupDate).toBe('2024-04');
  });

  it('converts DEXA bone density screening fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'dexa_screening', value: 'dexa_scan', updatedAt: '' },
      { id: '2', screeningKey: 'dexa_last_date', value: '2024-06', updatedAt: '' },
      { id: '3', screeningKey: 'dexa_result', value: 'normal', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.dexaScreening).toBe('dexa_scan');
    expect(inputs.dexaLastDate).toBe('2024-06');
    expect(inputs.dexaResult).toBe('normal');
  });

  it('converts DEXA osteoporosis follow-up fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'dexa_screening', value: 'dexa_scan', updatedAt: '' },
      { id: '2', screeningKey: 'dexa_result', value: 'osteoporosis', updatedAt: '' },
      { id: '3', screeningKey: 'dexa_followup_status', value: 'scheduled', updatedAt: '' },
      { id: '4', screeningKey: 'dexa_followup_date', value: '2025-03', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.dexaResult).toBe('osteoporosis');
    expect(inputs.dexaFollowupStatus).toBe('scheduled');
    expect(inputs.dexaFollowupDate).toBe('2025-03');
  });

  it('converts breast/cervical follow-up fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'breast_followup_status', value: 'completed', updatedAt: '' },
      { id: '2', screeningKey: 'breast_followup_date', value: '2024-02', updatedAt: '' },
      { id: '3', screeningKey: 'cervical_followup_status', value: 'awaiting', updatedAt: '' },
      { id: '4', screeningKey: 'cervical_followup_date', value: '2024-05', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.breastFollowupStatus).toBe('completed');
    expect(inputs.breastFollowupDate).toBe('2024-02');
    expect(inputs.cervicalFollowupStatus).toBe('awaiting');
    expect(inputs.cervicalFollowupDate).toBe('2024-05');
  });
});

describe('hasCloudData', () => {
  const nullProfile: ApiProfile = {
    sex: null, birthYear: null, birthMonth: null,
    unitSystem: null, firstName: null, lastName: null, height: null,
  };

  // --- Bug 1 regression test ---
  // Before fix: code checked `!!profile` which is always truthy for auto-created
  // profile rows with all NULL fields, so sync never ran for new users.
  it('returns false for auto-created profile with all null fields (Bug 1)', () => {
    expect(hasCloudData(nullProfile, [], [], [])).toBe(false);
  });

  it('returns false when profile is null', () => {
    expect(hasCloudData(null, [], [], [])).toBe(false);
  });

  it('returns false when profile is undefined', () => {
    expect(hasCloudData(undefined, [], [], [])).toBe(false);
  });

  it('returns false with empty arrays and no profile', () => {
    expect(hasCloudData(null, [])).toBe(false);
  });

  // Profile with actual data
  it('returns true when profile has sex', () => {
    expect(hasCloudData({ ...nullProfile, sex: 1 }, [], [], [])).toBe(true);
  });

  it('returns true when profile has birthYear', () => {
    expect(hasCloudData({ ...nullProfile, birthYear: 1990 }, [], [], [])).toBe(true);
  });

  it('returns true when profile has height', () => {
    expect(hasCloudData({ ...nullProfile, height: 175 }, [], [], [])).toBe(true);
  });

  it('returns true when profile has unitSystem', () => {
    expect(hasCloudData({ ...nullProfile, unitSystem: 1 }, [], [], [])).toBe(true);
  });

  // firstName/lastName alone should NOT count (auto-synced from Shopify, not user health data)
  it('returns false when profile only has firstName/lastName', () => {
    expect(hasCloudData({ ...nullProfile, firstName: 'John', lastName: 'Doe' }, [], [], [])).toBe(false);
  });

  // Measurements
  it('returns true when measurements exist', () => {
    const measurements: ApiMeasurement[] = [
      { id: '1', metricType: 'weight', value: 70, recordedAt: '', createdAt: '' },
    ];
    expect(hasCloudData(nullProfile, measurements, [], [])).toBe(true);
  });

  // Medications
  it('returns true when medications exist', () => {
    const medications: ApiMedication[] = [
      { id: '1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '' },
    ];
    expect(hasCloudData(nullProfile, [], medications, [])).toBe(true);
  });

  // Screenings
  it('returns true when screenings exist', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'colorectal_method', value: 'colonoscopy_10yr', updatedAt: '' },
    ];
    expect(hasCloudData(nullProfile, [], [], screenings)).toBe(true);
  });

  // Combined — any single source of data is sufficient
  it('returns true when only medications exist (profile empty, no measurements)', () => {
    const medications: ApiMedication[] = [
      { id: '1', medicationKey: 'ezetimibe', drugName: 'not_yet', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    expect(hasCloudData(nullProfile, [], medications, [])).toBe(true);
  });
});

describe('computeFormStage', () => {
  it('returns 1 when no inputs', () => {
    expect(computeFormStage({})).toBe(1);
  });

  it('returns 1 when only sex is set', () => {
    expect(computeFormStage({ sex: 'male' })).toBe(1);
  });

  it('returns 1 when only height is set', () => {
    expect(computeFormStage({ heightCm: 170 })).toBe(1);
  });

  it('returns 2 when sex AND height are set', () => {
    expect(computeFormStage({ sex: 'female', heightCm: 165 })).toBe(2);
  });

  it('returns 2 when sex + height set but only birthMonth (no birthYear)', () => {
    expect(computeFormStage({ sex: 'male', heightCm: 175, birthMonth: 6 })).toBe(2);
  });

  it('returns 3 when birthMonth AND birthYear are set', () => {
    expect(computeFormStage({ sex: 'male', heightCm: 175, birthMonth: 6, birthYear: 1985 })).toBe(3);
  });

  it('returns 4 when weightKg is set', () => {
    expect(computeFormStage({
      sex: 'female', heightCm: 160, birthMonth: 3, birthYear: 1990, weightKg: 65,
    })).toBe(4);
  });

  it('returns 4 for returning user with all data', () => {
    expect(computeFormStage({
      sex: 'male', heightCm: 180, birthMonth: 1, birthYear: 1980,
      weightKg: 85, waistCm: 90, hba1c: 39, ldlC: 2.5,
    })).toBe(4);
  });

  it('returns 4 even if intermediate fields missing (short-circuit)', () => {
    expect(computeFormStage({ weightKg: 70 })).toBe(4);
  });

  it('returns 3 even if sex/height missing (short-circuit)', () => {
    expect(computeFormStage({ birthMonth: 5, birthYear: 1990 })).toBe(3);
  });

  it('returns 2 when birthYear is partial (< 1900) — prevents premature collapse', () => {
    expect(computeFormStage({ sex: 'male', heightCm: 175, birthMonth: 6, birthYear: 1 })).toBe(2);
    expect(computeFormStage({ sex: 'male', heightCm: 175, birthMonth: 6, birthYear: 19 })).toBe(2);
    expect(computeFormStage({ sex: 'male', heightCm: 175, birthMonth: 6, birthYear: 198 })).toBe(2);
    expect(computeFormStage({ sex: 'male', heightCm: 175, birthMonth: 6, birthYear: 1980 })).toBe(3);
  });
});
