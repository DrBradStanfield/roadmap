import { describe, it, expect } from 'vitest';
import { scrubSensitiveData, scrubUrl, scrubBreadcrumbData } from './sentry-scrub';

describe('scrubSensitiveData', () => {
  describe('health measurement fields', () => {
    it('scrubs camelCase measurement fields', () => {
      const input = { weightKg: 85.5, heightCm: 175, hba1c: 42, ldlC: 3.2 };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        weightKg: '[Filtered]',
        heightCm: '[Filtered]',
        hba1c: '[Filtered]',
        ldlC: '[Filtered]',
      });
    });

    it('scrubs snake_case database fields', () => {
      const input = { systolic_bp: 130, diastolic_bp: 80, total_cholesterol: 5.2 };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        systolic_bp: '[Filtered]',
        diastolic_bp: '[Filtered]',
        total_cholesterol: '[Filtered]',
      });
    });

    it('scrubs metric type identifiers', () => {
      const input = { metricType: 'weight', metric_type: 'ldl' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        metricType: '[Filtered]',
        metric_type: '[Filtered]',
      });
    });

    it('scrubs calculated results', () => {
      const input = { bmi: 24.5, egfr: 90, idealBodyWeight: 70, nonHdlCholesterol: 3.8 };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        bmi: '[Filtered]',
        egfr: '[Filtered]',
        idealBodyWeight: '[Filtered]',
        nonHdlCholesterol: '[Filtered]',
      });
    });
  });

  describe('medication fields', () => {
    it('scrubs medication fields via exact match', () => {
      const input = { drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        drugName: '[Filtered]',
        doseValue: '[Filtered]',
        doseUnit: '[Filtered]',
      });
    });

    it('scrubs medication-related fields via substring match', () => {
      const input = { medicationKey: 'statin', statinDrug: 'atorvastatin', glp1Dose: 2.5 };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        medicationKey: '[Filtered]',
        statinDrug: '[Filtered]',
        glp1Dose: '[Filtered]',
      });
    });
  });

  describe('screening fields', () => {
    it('scrubs screening fields via substring match', () => {
      const input = { screeningKey: 'colorectal_method', colorectalScreeningDate: '2025-01' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        screeningKey: '[Filtered]',
        colorectalScreeningDate: '[Filtered]',
      });
    });

    it('scrubs followup fields', () => {
      const input = { followupDate: '2025-06', breastFollowupStatus: 'pending' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        followupDate: '[Filtered]',
        breastFollowupStatus: '[Filtered]',
      });
    });
  });

  describe('demographics and identifiers', () => {
    it('scrubs PII fields', () => {
      const input = { firstName: 'John', lastName: 'Doe', email: 'john@example.com', birthYear: 1990 };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        firstName: '[Filtered]',
        lastName: '[Filtered]',
        email: '[Filtered]',
        birthYear: '[Filtered]',
      });
    });

    it('scrubs identifier fields', () => {
      const input = { userId: 'uuid-123', shopify_customer_id: '456', unsubscribe_token: 'abc' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual({
        userId: '[Filtered]',
        shopify_customer_id: '[Filtered]',
        unsubscribe_token: '[Filtered]',
      });
    });
  });

  describe('preserves non-sensitive data', () => {
    it('preserves general fields', () => {
      const input = { success: true, status: 500, error: 'Server error', method: 'POST' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual(input);
    });

    it('preserves error types and messages', () => {
      const input = { type: 'TypeError', message: 'Cannot read properties', code: 'PGRST301' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual(input);
    });

    it('preserves Sentry tags', () => {
      const input = { feature: 'welcome_email', environment: 'production', release: 'abc123' };
      const result = scrubSensitiveData(input);
      expect(result).toEqual(input);
    });
  });

  describe('nested and recursive handling', () => {
    it('recursively scrubs nested objects', () => {
      const input = {
        request: {
          body: { profile: { firstName: 'John' }, url: '/api/measurements' },
        },
      };
      const result = scrubSensitiveData(input) as any;
      expect(result.request.body.profile.firstName).toBe('[Filtered]');
      expect(result.request.body.url).toBe('/api/measurements');
    });

    it('scrubs arrays of objects', () => {
      const input = {
        data: [
          { metricType: 'weight', recordedAt: '2025-01-01' },
          { metricType: 'ldl', recordedAt: '2025-01-02' },
        ],
      };
      const result = scrubSensitiveData(input) as any;
      expect(result.data[0].metricType).toBe('[Filtered]');
      expect(result.data[0].recordedAt).toBe('2025-01-01');
      expect(result.data[1].metricType).toBe('[Filtered]');
    });

    it('scrubs a medication API request body (parent key matches substring)', () => {
      const body = {
        medication: {
          medicationKey: 'statin',
          drugName: 'atorvastatin',
          doseValue: 40,
          doseUnit: 'mg',
        },
      };
      const result = scrubSensitiveData(body) as any;
      // "medication" matches substring pattern → entire value replaced
      expect(result.medication).toBe('[Filtered]');
    });

    it('scrubs Sentry extra context with userId', () => {
      const extra = {
        userId: '550e8400-e29b-41d4-a716-446655440000',
        componentStack: '<HealthTool> in div',
      };
      const result = scrubSensitiveData(extra) as any;
      expect(result.userId).toBe('[Filtered]');
      expect(result.componentStack).toBe('<HealthTool> in div');
    });
  });

  describe('edge cases', () => {
    it('handles null', () => {
      expect(scrubSensitiveData(null)).toBe(null);
    });

    it('handles undefined', () => {
      expect(scrubSensitiveData(undefined)).toBe(undefined);
    });

    it('handles primitives', () => {
      expect(scrubSensitiveData('hello')).toBe('hello');
      expect(scrubSensitiveData(42)).toBe(42);
      expect(scrubSensitiveData(true)).toBe(true);
    });

    it('handles empty objects and arrays', () => {
      expect(scrubSensitiveData({})).toEqual({});
      expect(scrubSensitiveData([])).toEqual([]);
    });

    it('respects max depth', () => {
      const deep: any = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
      const result = scrubSensitiveData(deep, 3) as any;
      expect(result.a.b.c).toBe('[Filtered]');
    });
  });
});

describe('scrubUrl', () => {
  it('scrubs token from query string', () => {
    const url = 'https://example.com/api/reminders?token=abc123';
    const result = scrubUrl(url);
    expect(result).toContain('token=');
    expect(result).not.toContain('abc123');
  });

  it('scrubs logged_in_customer_id', () => {
    const url = 'https://example.com/api/measurements?logged_in_customer_id=12345';
    const result = scrubUrl(url);
    expect(result).not.toContain('12345');
  });

  it('scrubs email parameter', () => {
    const url = 'https://example.com/page?email=john@test.com';
    const result = scrubUrl(url);
    expect(result).not.toContain('john@test.com');
  });

  it('preserves URLs without sensitive params', () => {
    const url = 'https://example.com/api/measurements?metric_type=weight&limit=50';
    expect(scrubUrl(url)).toBe(url);
  });

  it('handles relative URLs', () => {
    const url = '/api/reminders?token=abc123';
    const result = scrubUrl(url);
    expect(result).toContain('/api/reminders');
    expect(result).not.toContain('abc123');
  });

  it('handles malformed URLs gracefully', () => {
    expect(scrubUrl('not-a-url')).toBe('not-a-url');
  });

  it('handles URLs without query params', () => {
    const url = 'https://example.com/api/measurements';
    expect(scrubUrl(url)).toBe(url);
  });
});

describe('scrubBreadcrumbData', () => {
  it('removes body from fetch breadcrumb', () => {
    const data = {
      url: '/api/measurements',
      method: 'POST',
      status_code: 200,
      body: '{"metricType":"weight","value":85}',
    };
    const result = scrubBreadcrumbData(data)!;
    expect(result.body).toBeUndefined();
    expect(result.method).toBe('POST');
    expect(result.status_code).toBe(200);
    expect(result.url).toBe('/api/measurements');
  });

  it('removes request_body and size fields', () => {
    const data = {
      url: '/api/measurements',
      request_body: '{"profile":{"sex":1}}',
      request_body_size: 25,
      response_body_size: 100,
    };
    const result = scrubBreadcrumbData(data)!;
    expect(result.request_body).toBeUndefined();
    expect(result.request_body_size).toBeUndefined();
    expect(result.response_body_size).toBeUndefined();
  });

  it('scrubs sensitive query params from URL', () => {
    const data = {
      url: 'https://example.com/api/reminders?token=secret123',
      method: 'GET',
    };
    const result = scrubBreadcrumbData(data)!;
    expect(result.url).not.toContain('secret123');
    expect(result.method).toBe('GET');
  });

  it('returns undefined for undefined input', () => {
    expect(scrubBreadcrumbData(undefined)).toBeUndefined();
  });

  it('does not mutate original data', () => {
    const data = { url: '/api/measurements', body: 'test' };
    const original = { ...data };
    scrubBreadcrumbData(data);
    expect(data).toEqual(original);
  });
});
