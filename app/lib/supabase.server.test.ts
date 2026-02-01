import { describe, it, expect } from 'vitest';
import { toApiMeasurement, type DbMeasurement } from './supabase.server';

describe('toApiMeasurement', () => {
  it('converts DB row to camelCase API format', () => {
    const dbRow: DbMeasurement = {
      id: 'abc-123',
      user_id: 'user-456',
      metric_type: 'weight',
      value: 84,
      recorded_at: '2025-01-15T10:00:00Z',
      created_at: '2025-01-15T10:00:01Z',
    };

    const result = toApiMeasurement(dbRow);

    expect(result).toEqual({
      id: 'abc-123',
      metricType: 'weight',
      value: 84,
      recordedAt: '2025-01-15T10:00:00Z',
      createdAt: '2025-01-15T10:00:01Z',
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
    };

    expect(toApiMeasurement(dbRow).value).toBe(3.36);
  });
});
