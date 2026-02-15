import { describe, it, expect } from 'vitest';
import { toApiMeasurement, toApiProfile, type DbMeasurement, type DbProfile } from './supabase.server';

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
