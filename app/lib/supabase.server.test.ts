import { describe, it, expect } from 'vitest';
import {
  toApiMeasurement, toApiProfile, toApiMedication, toApiScreening,
  aggregateABCounts,
  aggregateChatMessages,
  aggregateReminderOptins,
  type DbMeasurement, type DbProfile, type DbMedication, type DbScreening,
  type ABCountRow,
  type ChatMessageRow,
  type ReminderOptinRow,
} from './supabase.server';
import type { ABVariant } from './supabase.server';

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
      // FHIR replaces fields default to 'active' / null for pre-correction rows.
      status: 'active',
      correctsId: null,
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

describe('aggregateABCounts', () => {
  const variants: ABVariant[] = [
    { id: 'a', value: 'foo', weight: 50 },
    { id: 'b', value: 'bar', weight: 50 },
  ];

  it('aggregates RPC rows into per-variant impression and conversion counts', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: 1307 },
      { variant_id: 'a', event_type: 'conversion', count: 35 },
      { variant_id: 'b', event_type: 'impression', count: 1615 },
      { variant_id: 'b', event_type: 'conversion', count: 26 },
    ];
    expect(aggregateABCounts(variants, rows)).toEqual([
      { variantId: 'a', impressions: 1307, conversions: 35 },
      { variantId: 'b', impressions: 1615, conversions: 26 },
    ]);
  });

  it('handles BIGINT counts returned as strings from Postgres', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: '1307' },
      { variant_id: 'a', event_type: 'conversion', count: '35' },
    ];
    const result = aggregateABCounts(variants, rows);
    expect(result[0]).toEqual({ variantId: 'a', impressions: 1307, conversions: 35 });
  });

  it('returns zero counts for variants with no events (e.g. newly added)', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: 500 },
    ];
    expect(aggregateABCounts(variants, rows)).toEqual([
      { variantId: 'a', impressions: 500, conversions: 0 },
      { variantId: 'b', impressions: 0, conversions: 0 },
    ]);
  });

  it('ignores rows for variant IDs not in the test (stale data safety)', () => {
    const rows: ABCountRow[] = [
      { variant_id: 'a', event_type: 'impression', count: 100 },
      { variant_id: 'c', event_type: 'impression', count: 999 },
    ];
    const result = aggregateABCounts(variants, rows);
    expect(result.find(r => r.variantId === 'a')!.impressions).toBe(100);
    expect(result).toHaveLength(2);
    expect(result.find(r => r.variantId === 'c')).toBeUndefined();
  });

  it('handles null rows from RPC (empty result set)', () => {
    expect(aggregateABCounts(variants, null)).toEqual([
      { variantId: 'a', impressions: 0, conversions: 0 },
      { variantId: 'b', impressions: 0, conversions: 0 },
    ]);
  });
});

describe('aggregateChatMessages', () => {
  const row = (
    role: string,
    user_id: string,
    is_fallback: boolean | null = false,
  ): ChatMessageRow => ({ role, user_id, is_fallback, created_at: '2026-06-14T00:00:00Z' });

  it('counts user messages and distinct chatters', () => {
    const result = aggregateChatMessages([
      row('user', 'u1'),
      row('assistant', 'u1'),
      row('user', 'u1'),
      row('user', 'u2'),
      row('assistant', 'u2'),
    ]);
    expect(result.userMessages).toBe(3);
    expect(result.activeChatters).toBe(2);
  });

  it('computes fallback rate over assistant messages only', () => {
    const result = aggregateChatMessages([
      row('user', 'u1'),
      row('assistant', 'u1', true),
      row('assistant', 'u1', false),
      row('assistant', 'u1', false),
      row('assistant', 'u1', false),
    ]);
    expect(result.fallbacks).toBe(1);
    // 1 fallback / 4 assistant messages — user messages do not dilute the rate.
    expect(result.fallbackRate).toBeCloseTo(0.25);
  });

  it('returns zero fallback rate when there are no assistant messages', () => {
    const result = aggregateChatMessages([row('user', 'u1')]);
    expect(result.fallbackRate).toBe(0);
    expect(result.fallbacks).toBe(0);
  });

  it('treats null is_fallback as non-fallback', () => {
    const result = aggregateChatMessages([row('assistant', 'u1', null)]);
    expect(result.fallbacks).toBe(0);
  });

  it('handles null rows', () => {
    expect(aggregateChatMessages(null)).toEqual({
      userMessages: 0,
      activeChatters: 0,
      fallbacks: 0,
      fallbackRate: 0,
    });
  });
});

describe('aggregateReminderOptins', () => {
  const today = '2026-06-14';

  it('groups opt-ins by provider, sorted by count desc', () => {
    const rows: ReminderOptinRow[] = [
      { provider: 'google-drive', last_sent: {}, schedule: [] },
      { provider: 'dropbox', last_sent: {}, schedule: [] },
      { provider: 'google-drive', last_sent: {}, schedule: [] },
    ];
    const result = aggregateReminderOptins(rows, today);
    expect(result.byProvider).toEqual([
      { provider: 'google-drive', count: 2 },
      { provider: 'dropbox', count: 1 },
    ]);
  });

  it('counts opt-ins that have received at least one email', () => {
    const rows: ReminderOptinRow[] = [
      { provider: 'github', last_sent: { blood_test_lipids: '2026-06-01' }, schedule: [] },
      { provider: 'github', last_sent: {}, schedule: [] },
      { provider: 'github', last_sent: null, schedule: [] },
    ];
    expect(aggregateReminderOptins(rows, today).withSends).toBe(1);
  });

  it('counts opt-ins due within 7 days (inclusive of overdue)', () => {
    const rows: ReminderOptinRow[] = [
      { provider: 'github', last_sent: {}, schedule: [{ dueAt: '2026-06-10' }] }, // overdue
      { provider: 'github', last_sent: {}, schedule: [{ dueAt: '2026-06-20' }] }, // within 7d
      { provider: 'github', last_sent: {}, schedule: [{ dueAt: '2026-07-01' }] }, // far future
      { provider: 'github', last_sent: {}, schedule: [] },                         // none
    ];
    expect(aggregateReminderOptins(rows, today).dueSoon).toBe(2);
  });

  it('labels missing provider as "unknown"', () => {
    const result = aggregateReminderOptins(
      [{ provider: null, last_sent: {}, schedule: [] }],
      today,
    );
    expect(result.byProvider).toEqual([{ provider: 'unknown', count: 1 }]);
  });

  it('handles null rows', () => {
    expect(aggregateReminderOptins(null, today)).toEqual({
      byProvider: [],
      withSends: 0,
      dueSoon: 0,
    });
  });
});
