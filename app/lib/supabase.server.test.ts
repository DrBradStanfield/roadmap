import { describe, it, expect } from 'vitest';
import {
  toApiMeasurement, toApiProfile, toApiMedication, toApiScreening, deriveMedicationStatus,
  type DbMeasurement, type DbProfile, type DbMedication, type DbScreening,
} from './supabase.server';

describe('toApiMeasurement', () => {
  it('converts DB row to camelCase API format', () => {
    const dbRow: DbMeasurement = {
      id: 'abc-123',
      user_id: 'user-456',
      metric_type: 'weight',
      value: 84,
      recorded_at: '2025-01-15T10:00:00Z',
      created_at: '2025-01-15T10:00:01Z',
      source: 'manual',
      external_id: null,
    };

    const result = toApiMeasurement(dbRow);

    expect(result).toEqual({
      id: 'abc-123',
      metricType: 'weight',
      value: 84,
      recordedAt: '2025-01-15T10:00:00Z',
      createdAt: '2025-01-15T10:00:01Z',
      source: 'manual',
      externalId: null,
    });
  });

  it('excludes user_id from output', () => {
    const dbRow: DbMeasurement = {
      id: 'abc-123',
      user_id: 'user-456',
      metric_type: 'height',
      value: 184,
      recorded_at: '2025-01-15T10:00:00Z',
      created_at: '2025-01-15T10:00:01Z',
      source: 'manual',
      external_id: null,
    };

    const result = toApiMeasurement(dbRow);
    expect(result).not.toHaveProperty('user_id');
    expect(result).not.toHaveProperty('userId');
  });

  it('preserves decimal values', () => {
    const dbRow: DbMeasurement = {
      id: 'def-789',
      user_id: 'user-456',
      metric_type: 'ldl',
      value: 3.36,
      recorded_at: '2025-01-15T10:00:00Z',
      created_at: '2025-01-15T10:00:01Z',
      source: 'manual',
      external_id: null,
    };

    expect(toApiMeasurement(dbRow).value).toBe(3.36);
  });

  it('includes source and externalId for HealthKit measurements', () => {
    const dbRow: DbMeasurement = {
      id: 'hk-001',
      user_id: 'user-456',
      metric_type: 'weight',
      value: 75.5,
      recorded_at: '2025-03-01T08:00:00Z',
      created_at: '2025-03-01T08:00:01Z',
      source: 'apple_health',
      external_id: 'HK-SAMPLE-UUID-123',
    };

    const result = toApiMeasurement(dbRow);
    expect(result.source).toBe('apple_health');
    expect(result.externalId).toBe('HK-SAMPLE-UUID-123');
  });

  it('coerces string value from PostgREST to number', () => {
    const dbRow = {
      id: 'str-001',
      user_id: 'user-456',
      metric_type: 'weight',
      value: '80.5' as unknown as number, // PostgREST can return NUMERIC as string
      recorded_at: '2025-01-15T10:00:00Z',
      created_at: '2025-01-15T10:00:01Z',
      source: 'manual',
      external_id: null,
    } as DbMeasurement;

    const result = toApiMeasurement(dbRow);
    expect(result.value).toBe(80.5);
    expect(typeof result.value).toBe('number');
  });
});

describe('toApiProfile', () => {
  it('converts DB profile to camelCase API format', () => {
    const dbProfile: DbProfile = {
      id: 'user-123',
      shopify_customer_id: 'shop-456',
      email: 'test@example.com',
      sex: 1,
      birth_year: 1990,
      birth_month: 5,
      unit_system: 2,
      first_name: 'John',
      last_name: 'Doe',
      height: 180,
      welcome_email_sent: false,
      reminders_global_optout: false,
      unsubscribe_token: null,
      created_at: '2025-01-01T00:00:00Z',
    };

    expect(toApiProfile(dbProfile)).toEqual({
      sex: 1,
      birthYear: 1990,
      birthMonth: 5,
      unitSystem: 2,
      firstName: 'John',
      lastName: 'Doe',
      height: 180,
    });
  });

  it('handles null profile fields', () => {
    const dbProfile: DbProfile = {
      id: 'user-123',
      shopify_customer_id: 'shop-456',
      email: 'test@example.com',
      sex: null,
      birth_year: null,
      birth_month: null,
      unit_system: null,
      first_name: null,
      last_name: null,
      height: null,
      welcome_email_sent: false,
      reminders_global_optout: false,
      unsubscribe_token: null,
      created_at: '2025-01-01T00:00:00Z',
    };

    expect(toApiProfile(dbProfile)).toEqual({
      sex: null,
      birthYear: null,
      birthMonth: null,
      unitSystem: null,
      firstName: null,
      lastName: null,
      height: null,
    });
  });
});

describe('toApiMedication', () => {
  it('converts DB medication to camelCase API format', () => {
    const dbMed: DbMedication = {
      id: 'med-1',
      user_id: 'user-123',
      medication_key: 'statin',
      drug_name: 'atorvastatin',
      dose_value: 20,
      dose_unit: 'mg',
      status: 'active',
      started_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-06-01T00:00:00Z',
      created_at: '2025-01-01T00:00:00Z',
    };

    expect(toApiMedication(dbMed)).toEqual({
      id: 'med-1',
      medicationKey: 'statin',
      drugName: 'atorvastatin',
      doseValue: 20,
      doseUnit: 'mg',
      status: 'active',
      startedAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-06-01T00:00:00Z',
    });
  });

  it('excludes user_id from output', () => {
    const dbMed: DbMedication = {
      id: 'med-2',
      user_id: 'user-123',
      medication_key: 'ezetimibe',
      drug_name: 'not_yet',
      dose_value: null,
      dose_unit: null,
      status: 'intended',
      started_at: null,
      updated_at: '2025-06-01T00:00:00Z',
      created_at: '2025-06-01T00:00:00Z',
    };

    const result = toApiMedication(dbMed);
    expect(result).not.toHaveProperty('user_id');
    expect(result).not.toHaveProperty('userId');
  });

  it('handles null dose fields for status-only medications', () => {
    const dbMed: DbMedication = {
      id: 'med-3',
      user_id: 'user-123',
      medication_key: 'statin',
      drug_name: 'not_tolerated',
      dose_value: null,
      dose_unit: null,
      status: 'stopped',
      started_at: null,
      updated_at: '2025-06-01T00:00:00Z',
      created_at: '2025-06-01T00:00:00Z',
    };

    const result = toApiMedication(dbMed);
    expect(result.doseValue).toBeNull();
    expect(result.doseUnit).toBeNull();
    expect(result.startedAt).toBeNull();
  });

  it('preserves decimal dose values (GLP-1 doses like 2.5mg)', () => {
    const dbMed: DbMedication = {
      id: 'med-4',
      user_id: 'user-123',
      medication_key: 'glp1',
      drug_name: 'semaglutide_injection',
      dose_value: 0.25,
      dose_unit: 'mg',
      status: 'active',
      started_at: null,
      updated_at: '2025-06-01T00:00:00Z',
      created_at: '2025-06-01T00:00:00Z',
    };

    expect(toApiMedication(dbMed).doseValue).toBe(0.25);
  });
});

describe('toApiScreening', () => {
  it('converts DB screening to camelCase API format', () => {
    const dbScr: DbScreening = {
      id: 'scr-1',
      user_id: 'user-123',
      screening_key: 'colorectal_method',
      value: 'colonoscopy_10yr',
      updated_at: '2025-06-01T00:00:00Z',
      created_at: '2025-01-01T00:00:00Z',
    };

    expect(toApiScreening(dbScr)).toEqual({
      id: 'scr-1',
      screeningKey: 'colorectal_method',
      value: 'colonoscopy_10yr',
      updatedAt: '2025-06-01T00:00:00Z',
    });
  });

  it('excludes user_id and created_at from output', () => {
    const dbScr: DbScreening = {
      id: 'scr-2',
      user_id: 'user-123',
      screening_key: 'breast_frequency',
      value: 'annual',
      updated_at: '2025-06-01T00:00:00Z',
      created_at: '2025-01-01T00:00:00Z',
    };

    const result = toApiScreening(dbScr);
    expect(result).not.toHaveProperty('user_id');
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('created_at');
    expect(result).not.toHaveProperty('createdAt');
  });
});

describe('deriveMedicationStatus', () => {
  it('derives not-taken from none', () => {
    expect(deriveMedicationStatus('none')).toBe('not-taken');
  });

  it('derives stopped from not_tolerated', () => {
    expect(deriveMedicationStatus('not_tolerated')).toBe('stopped');
  });

  it('derives intended from not_yet', () => {
    expect(deriveMedicationStatus('not_yet')).toBe('intended');
  });

  it('derives active from actual drug names', () => {
    expect(deriveMedicationStatus('atorvastatin')).toBe('active');
    expect(deriveMedicationStatus('rosuvastatin')).toBe('active');
    expect(deriveMedicationStatus('ezetimibe')).toBe('active');
    expect(deriveMedicationStatus('tirzepatide')).toBe('active');
    expect(deriveMedicationStatus('empagliflozin')).toBe('active');
    expect(deriveMedicationStatus('ir_500')).toBe('active');
  });

  it('derives active from yes (legacy compat)', () => {
    expect(deriveMedicationStatus('yes')).toBe('active');
  });
});
