import { describe, it, expect } from 'vitest';
import { labValueSchema, bulkLabValueSchema } from './validation';

describe('labValueSchema', () => {
  it('accepts valid lab value', () => {
    const result = labValueSchema.safeParse({
      metricName: 'sodium',
      value: 139,
      unit: 'mmol/L',
      referenceLow: 135,
      referenceHigh: 145,
      recordedAt: '2024-03-15T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts lab value without reference ranges', () => {
    const result = labValueSchema.safeParse({
      metricName: 'ferritin',
      value: 85,
      unit: 'ng/mL',
      recordedAt: '2024-03-15T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts null reference ranges', () => {
    const result = labValueSchema.safeParse({
      metricName: 'tsh',
      value: 2.1,
      unit: 'mIU/L',
      referenceLow: null,
      referenceHigh: null,
      recordedAt: '2024-06-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty metric name', () => {
    const result = labValueSchema.safeParse({
      metricName: '',
      value: 100,
      unit: 'mg/dL',
      recordedAt: '2024-03-15T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty unit', () => {
    const result = labValueSchema.safeParse({
      metricName: 'sodium',
      value: 139,
      unit: '',
      recordedAt: '2024-03-15T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing recordedAt', () => {
    const result = labValueSchema.safeParse({
      metricName: 'sodium',
      value: 139,
      unit: 'mmol/L',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-datetime recordedAt', () => {
    const result = labValueSchema.safeParse({
      metricName: 'sodium',
      value: 139,
      unit: 'mmol/L',
      recordedAt: '2024-03-15',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional source field', () => {
    const result = labValueSchema.safeParse({
      metricName: 'potassium',
      value: 4.5,
      unit: 'mmol/L',
      recordedAt: '2024-03-15T00:00:00.000Z',
      source: 'lab_import',
    });
    expect(result.success).toBe(true);
  });

  it('rejects metric name exceeding 100 chars', () => {
    const result = labValueSchema.safeParse({
      metricName: 'a'.repeat(101),
      value: 100,
      unit: 'mg/dL',
      recordedAt: '2024-03-15T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('bulkLabValueSchema', () => {
  it('accepts array of valid lab values', () => {
    const result = bulkLabValueSchema.safeParse({
      bulkLabValues: [
        { metricName: 'sodium', value: 139, unit: 'mmol/L', recordedAt: '2024-03-15T00:00:00.000Z' },
        { metricName: 'potassium', value: 4.5, unit: 'mmol/L', recordedAt: '2024-03-15T00:00:00.000Z' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty array', () => {
    const result = bulkLabValueSchema.safeParse({ bulkLabValues: [] });
    expect(result.success).toBe(false);
  });

  it('rejects array exceeding 200 items', () => {
    const items = Array.from({ length: 201 }, (_, i) => ({
      metricName: `metric_${i}`,
      value: i,
      unit: 'mg/dL',
      recordedAt: '2024-03-15T00:00:00.000Z',
    }));
    const result = bulkLabValueSchema.safeParse({ bulkLabValues: items });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 200 items', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      metricName: `metric_${i}`,
      value: i,
      unit: 'mg/dL',
      recordedAt: '2024-03-15T00:00:00.000Z',
    }));
    const result = bulkLabValueSchema.safeParse({ bulkLabValues: items });
    expect(result.success).toBe(true);
  });
});
