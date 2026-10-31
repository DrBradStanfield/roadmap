import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  hasUnsavedProfileEdits,
  FIELD_TO_METRIC,
  METRIC_TO_FIELD,
  FIELD_METRIC_MAP,
  PREFILL_FIELDS,
  measurementsToInputs,
  diffInputsToMeasurements,
  diffProfileFields,
  hasCloudData,
  medicationsToInputs,
  screeningsToInputs,
  computeFormStage,
  opensFullForm,
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

  it('PREFILL_FIELDS never overlap METRIC_TO_FIELD values (store prefill pass + byok spread order both assume it) [US-07 AC4]', () => {
    const metricFields = new Set(Object.values(METRIC_TO_FIELD));
    expect(PREFILL_FIELDS.filter((f) => metricFields.has(f))).toEqual([]);
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

  it('converts bempedoic_acid Nexletol', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'bempedoic_acid', drugName: 'bempedoic_acid', doseValue: 180, doseUnit: 'mg', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.bempedoicAcid).toBe('bempedoic_acid');
  });

  it('converts bempedoic_acid Nexlizet combo', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'bempedoic_acid', drugName: 'bempedoic_acid_ezetimibe', doseValue: 180, doseUnit: 'mg', updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.bempedoicAcid).toBe('bempedoic_acid_ezetimibe');
  });

  it('converts bempedoic_acid not_tolerated', () => {
    const meds: ApiMedication[] = [
      { id: '1', medicationKey: 'bempedoic_acid', drugName: 'not_tolerated', doseValue: null, doseUnit: null, updatedAt: '' },
    ];
    const inputs = medicationsToInputs(meds);
    expect(inputs.bempedoicAcid).toBe('not_tolerated');
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

describe('medicationsToInputs: a drug name that is not a string (US-06 AC5, US-15 AC11)', () => {
  const KEYS = ['statin', 'ezetimibe', 'statin_escalation', 'pcsk9i', 'bempedoic_acid', 'glp1', 'glp1_escalation', 'sglt2i', 'metformin'];
  it.each(KEYS)('%s: a null, numeric or object name is unanswered, as if no row were recorded', (medicationKey) => {
    for (const drugName of [null, 42, { nested: 'x' }]) {
      const row = { id: '1', medicationKey, drugName: drugName as unknown as string, doseValue: 20, doseUnit: 'mg', updatedAt: '' };
      expect(medicationsToInputs([row]), JSON.stringify(drugName)).toEqual({});
    }
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
      { id: '1', screeningKey: 'cervical_method', value: 'hpv_every_5yr', updatedAt: '' },
      { id: '2', screeningKey: 'cervical_last_date', value: '2022-09', updatedAt: '' },
      { id: '3', screeningKey: 'cervical_result', value: 'normal', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.cervicalMethod).toBe('hpv_every_5yr');
    expect(inputs.cervicalLastDate).toBe('2022-09');
    expect(inputs.cervicalResult).toBe('normal');
  });

  it('converts lung screening fields including pack years as number', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'lung_smoking_history', value: 'former_smoker', updatedAt: '' },
      { id: '2', screeningKey: 'lung_pack_years', value: '25', updatedAt: '' },
      { id: '3', screeningKey: 'lung_screening', value: 'annual_ldct', updatedAt: '' },
      { id: '4', screeningKey: 'lung_last_date', value: '2024-01', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.lungSmokingHistory).toBe('former_smoker');
    expect(inputs.lungPackYears).toBe(25);
    expect(inputs.lungScreening).toBe('annual_ldct');
    expect(inputs.lungLastDate).toBe('2024-01');
  });

  it('converts prostate screening fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'prostate_discussion', value: 'will_screen', updatedAt: '' },
      { id: '2', screeningKey: 'prostate_psa_value', value: '1.2', updatedAt: '' },
      { id: '3', screeningKey: 'prostate_last_date', value: '2024-06', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.prostateDiscussion).toBe('will_screen');
    expect(inputs.prostatePsaValue).toBe(1.2);
    expect(inputs.prostateLastDate).toBe('2024-06');
  });

  // US-12 AC8: parseFloat read a decimal comma as its integer part, so a PSA
  // of "4,5" became 4 and missed the >4.0 suggestion.
  it('US-12 AC8: reads decimal-comma pack years and PSA as decimals', () => {
    const inputs = screeningsToInputs([
      { screeningKey: 'lung_pack_years', value: '22,5' },
      { screeningKey: 'prostate_psa_value', value: '4,5' },
    ]);
    expect(inputs.lungPackYears).toBe(22.5);
    expect(inputs.prostatePsaValue).toBe(4.5);
  });

  // US-02 AC7: a stored string is read against the answer's input range, as
  // typed text is. Pack-years "150,500" (0-200) fits only as 150.5, a decimal
  // reading, which is never chosen; PSA "1,234" (0-10000) could be either. The
  // plan reads neither and the rows are left as stored.
  it('US-02 AC7: reads "1,234"-shaped answers by their range', () => {
    const rows = [
      { screeningKey: 'lung_pack_years', value: '150,500' },
      { screeningKey: 'prostate_psa_value', value: '1,234' },
    ];
    const inputs = screeningsToInputs(rows);
    expect(inputs.lungPackYears).toBeUndefined();
    expect(inputs.prostatePsaValue).toBeUndefined();
    expect(rows[1].value).toBe('1,234');
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

  it('ignores invalid enum values for screening fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'colorectal_method', value: 'invalid_method', updatedAt: '' },
      { id: '2', screeningKey: 'breast_frequency', value: 'weekly', updatedAt: '' },
      { id: '3', screeningKey: 'colorectal_result', value: 'bad_value', updatedAt: '' },
      { id: '4', screeningKey: 'dexa_result', value: 'broken', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.colorectalMethod).toBeUndefined();
    expect(inputs.breastFrequency).toBeUndefined();
    expect(inputs.colorectalResult).toBeUndefined();
    expect(inputs.dexaResult).toBeUndefined();
  });

  it('accepts valid enum values alongside invalid ones', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'colorectal_method', value: 'fit_annual', updatedAt: '' },
      { id: '2', screeningKey: 'breast_frequency', value: 'invalid', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.colorectalMethod).toBe('fit_annual');
    expect(inputs.breastFrequency).toBeUndefined();
  });

  it('handles lung follow-up fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'lung_result', value: 'abnormal', updatedAt: '' },
      { id: '2', screeningKey: 'lung_followup_status', value: 'scheduled', updatedAt: '' },
      { id: '3', screeningKey: 'lung_followup_date', value: '2024-04', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.lungResult).toBe('abnormal');
    expect(inputs.lungFollowupStatus).toBe('scheduled');
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

  it('US-06/US-15 AC11: drops a date that is not a real calendar date, so the widget plan and the chat agree', () => {
    const row = (value: string): ApiScreening[] => [{ id: '1', screeningKey: 'colorectal_last_date', value, updatedAt: '' }];
    for (const bad of ['2020-99', '2020-00', '2023-02-29', '2024-02-30', '2024-06-31', 'not-a-date', '2024-6']) {
      expect(screeningsToInputs(row(bad)).colorectalLastDate, bad).toBeUndefined();
    }
    for (const good of ['2024-02-29', '2000-02-29', '2024-06', '2024-12-31']) {
      expect(screeningsToInputs(row(good)).colorectalLastDate, good).toBe(good);
    }
    // A cleared date stays cleared: the form writes '' to clear it.
    expect(screeningsToInputs(row('')).colorectalLastDate).toBeFalsy();
  });

  // A "last done" date cannot be after the current month: the form offers
  // only past months, and a future one read "up to date" for years. A
  // follow-up date may be future: the form asks when a follow-up is scheduled.
  // "Current month" is the month at UTC+14 (screeningDate), so each case pins
  // the clock and names its months outright; no expectation reads the local
  // clock, which failed at every month end in UTC (the cloud loops).
  afterEach(() => { vi.useRealTimers(); });
  const pin = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); };
  const CLOCKS: Array<[string, string, string]> = [
    // [now, this month at UTC+14, next month]
    ['2026-06-15T12:00:00Z', '2026-06', '2026-07'],
    ['2026-09-30T09:59:00Z', '2026-09', '2026-10'], // 23:59 on 30 Sep at UTC+14
    ['2026-09-30T12:00:00Z', '2026-10', '2026-11'], // already 1 Oct at UTC+14
    ['2026-12-31T12:00:00Z', '2027-01', '2027-02'], // the year turns at UTC+14
  ];
  const LAST: Array<[string, keyof ReturnType<typeof screeningsToInputs>]> = [
    ['colorectal_last_date', 'colorectalLastDate'], ['breast_last_date', 'breastLastDate'],
    ['cervical_last_date', 'cervicalLastDate'], ['lung_last_date', 'lungLastDate'],
    ['prostate_last_date', 'prostateLastDate'], ['dexa_last_date', 'dexaLastDate'],
  ];
  const FOLLOWUP: Array<[string, keyof ReturnType<typeof screeningsToInputs>]> = [
    ['colorectal_followup_date', 'colorectalFollowupDate'], ['breast_followup_date', 'breastFollowupDate'],
    ['cervical_followup_date', 'cervicalFollowupDate'], ['lung_followup_date', 'lungFollowupDate'],
    ['dexa_followup_date', 'dexaFollowupDate'],
  ];
  const one = (screeningKey: string, value: string) => screeningsToInputs([{ screeningKey, value }]);

  it.each(LAST)('US-06/US-15 AC11: %s drops a date after the current month and keeps this month', (key, field) => {
    for (const [now, thisMonth, nextMonth] of CLOCKS) {
      pin(now);
      for (const future of [nextMonth, `${nextMonth}-01`, '2028-06', '9999-01']) expect(one(key, future)[field], `${now} ${future}`).toBeUndefined();
      expect(one(key, thisMonth)[field], now).toBe(thisMonth);
      expect(one(key, '2020-01')[field], now).toBe('2020-01');
    }
  });

  it.each(FOLLOWUP)('US-06/US-15 AC11: %s keeps a future date (a scheduled follow-up) and a past one', (key, field) => {
    for (const [now, , nextMonth] of CLOCKS) {
      pin(now);
      expect(one(key, '2028-06')[field], now).toBe('2028-06');
      expect(one(key, nextMonth)[field], now).toBe(nextMonth);
      expect(one(key, '2020-01')[field], now).toBe('2020-01');
      expect(one(key, '2020-99')[field], now).toBeUndefined();
    }
  });

  it('covers every date key: six "last done", five follow-up', async () => {
    const { SCREENING_KEYS } = await import('./validation');
    const dates = SCREENING_KEYS.filter(k => k.endsWith('_date')).sort();
    expect([...LAST, ...FOLLOWUP].map(([k]) => k).sort()).toEqual(dates);
  });

  it('converts breast/cervical follow-up fields', () => {
    const screenings: ApiScreening[] = [
      { id: '1', screeningKey: 'breast_followup_status', value: 'completed', updatedAt: '' },
      { id: '2', screeningKey: 'breast_followup_date', value: '2024-02', updatedAt: '' },
      { id: '3', screeningKey: 'cervical_followup_status', value: 'not_organized', updatedAt: '' },
      { id: '4', screeningKey: 'cervical_followup_date', value: '2024-05', updatedAt: '' },
    ];
    const inputs = screeningsToInputs(screenings);
    expect(inputs.breastFollowupStatus).toBe('completed');
    expect(inputs.breastFollowupDate).toBe('2024-02');
    expect(inputs.cervicalFollowupStatus).toBe('not_organized');
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

// US-01 AC1/AC3, US-15 AC10, US-62 AC13: the form is the onboarding. The
// stage is the first answer the record lacks: 1 height and weight, 2 sex,
// 3 birth month and year, 4 none (the rest of the form, the chat, the embed).
describe('computeFormStage', () => {
  const adult = { birthMonth: 6, birthYear: 1985 };
  const saved = (metricType: string, value: number) => ({ metricType, value });

  it('asks height and weight first, whatever else is known', () => {
    expect(computeFormStage({})).toBe(1);
    expect(computeFormStage({ sex: 'male', ...adult })).toBe(1);
    expect(computeFormStage({ heightCm: 170 })).toBe(1);
    expect(computeFormStage({ weightKg: 70 })).toBe(1);
  });

  it('asks sex once height and weight are in', () => {
    expect(computeFormStage({ heightCm: 170, weightKg: 70 })).toBe(2);
    expect(computeFormStage({ heightCm: 170, weightKg: 70, ...adult })).toBe(2);
  });

  it('asks the birth month and year once sex is in', () => {
    expect(computeFormStage({ heightCm: 170, weightKg: 70, sex: 'female' })).toBe(3);
    expect(computeFormStage({ heightCm: 170, weightKg: 70, sex: 'female', birthMonth: 6 })).toBe(3);
  });

  it('a birth year alone answers step 3, as the plan (January) and the iPhone read it', () => {
    expect(computeFormStage({ heightCm: 170, weightKg: 70, sex: 'female', birthYear: 1985 })).toBe(4);
    expect(computeFormStage({ heightCm: 170, weightKg: 70, sex: 'female', birthYear: 1899 })).toBe(3);
  });

  it('is done with all four', () => {
    expect(computeFormStage({ heightCm: 170, weightKg: 70, sex: 'female', ...adult })).toBe(4);
  });

  it('does NOT advance on a half-typed height, weight or birth year', () => {
    expect(computeFormStage({ heightCm: 18, weightKg: 70 })).toBe(1);
    expect(computeFormStage({ heightCm: 180, weightKg: 7 })).toBe(1);
    expect(computeFormStage({ heightCm: 1800, weightKg: 70 })).toBe(1);
    expect(computeFormStage({ heightCm: 180, weightKg: 750 })).toBe(1);
    expect(computeFormStage({ heightCm: 180, weightKg: 75, sex: 'male', birthMonth: 6, birthYear: 198 })).toBe(3);
  });

  it('a birth month in the future is not an answer', () => {
    const next = new Date();
    next.setMonth(next.getMonth() + 2);
    expect(computeFormStage({
      heightCm: 180, weightKg: 75, sex: 'male', birthMonth: next.getMonth() + 1, birthYear: next.getFullYear(),
    })).toBe(3);
  });

  it('a sex that is neither male nor female is no sex', () => {
    expect(computeFormStage({ heightCm: 180, weightKg: 75, sex: 'other' as never, ...adult })).toBe(2);
  });

  it('US-15 AC10: a saved weight fills an empty weight field, so a returning user resumes at sex', () => {
    expect(computeFormStage({ heightCm: 180 }, [saved('weight', 82)])).toBe(2);
    expect(computeFormStage({ heightCm: 180, sex: 'male', ...adult }, [saved('weight', 82)])).toBe(4);
  });

  it('US-15 AC10: a typed weight wins over the saved one, so a half-typed weight holds stage 1', () => {
    expect(computeFormStage({ heightCm: 180, sex: 'male', weightKg: 7 }, [saved('weight', 82)])).toBe(1);
  });

  it('a saved blood test no longer skips the questions: the stage stays the first missing answer', () => {
    expect(computeFormStage({}, [saved('ldl', 3.1)])).toBe(1);
    expect(computeFormStage({ heightCm: 180, sex: 'male' }, [saved('weight', 82), saved('ldl', 3.1)])).toBe(3);
  });
});

describe('opensFullForm (US-01 AC3)', () => {
  const saved = (metricType: string, value: number) => ({ metricType, value });
  it('opens the whole form once the onboarding is done', () => {
    expect(opensFullForm(4, [])).toBe(true);
    expect(opensFullForm(3, [])).toBe(false);
    expect(opensFullForm(3, [saved('weight', 82)])).toBe(false); // the onboarding's own answer
  });
  it('opens it at once for a record holding more than the four answers, at any stage', () => {
    expect(opensFullForm(1, [saved('hba1c', 39)])).toBe(true);
    expect(opensFullForm(2, [saved('weight', 82), saved('waist', 90)])).toBe(true);
    expect(opensFullForm(3, [saved('systolic_bp', 120)])).toBe(true);
    expect(opensFullForm(3, [], true)).toBe(true); // a medication, screening, supplement, lab test or document
  });
});

describe('US-34 — hasUnsavedProfileEdits (the mid-typing guard)', () => {
  it('says nothing is unsaved when the form matches what was saved', () => {
    const saved = { heightCm: 178, sex: 'male' as const, birthYear: 1985, birthMonth: 4 };
    expect(hasUnsavedProfileEdits({ ...saved }, saved)).toBe(false);
  });

  it('sees a half-typed birth year the remote change must not overwrite', () => {
    const saved = { heightCm: 178, birthYear: 1985 };
    expect(hasUnsavedProfileEdits({ heightCm: 178, birthYear: 198 }, saved)).toBe(true);
  });

  it('sees every demographics field, and ignores a measurement', () => {
    expect(hasUnsavedProfileEdits({ heightCm: 180 }, { heightCm: 178 })).toBe(true);
    expect(hasUnsavedProfileEdits({ sex: 'female' }, { sex: 'male' })).toBe(true);
    expect(hasUnsavedProfileEdits({ birthMonth: 5 }, { birthMonth: 4 })).toBe(true);
    // Weight is a longitudinal row with its own save path — a remote change
    // arriving while one is typed is not a keystroke the reload would eat.
    expect(hasUnsavedProfileEdits({ weightKg: 81 }, { weightKg: 80 })).toBe(false);
  });
});
