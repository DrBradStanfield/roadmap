import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAuthRedirectFlag, consumeEmailConfirmFlag, hasAuthenticatedFlag, loadFromLocalStorage } from './storage';

describe('safe storage accessors', () => {
  let originalSessionStorage: Storage;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalSessionStorage = globalThis.sessionStorage;
    originalLocalStorage = globalThis.localStorage;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', { value: originalSessionStorage, writable: true });
    Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, writable: true });
  });

  describe('getAuthRedirectFlag', () => {
    it('returns true when flag is set', () => {
      const mockStorage = { getItem: vi.fn().mockReturnValue('1') } as unknown as Storage;
      Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, writable: true });
      expect(getAuthRedirectFlag()).toBe(true);
    });

    it('returns false when flag is not set', () => {
      const mockStorage = { getItem: vi.fn().mockReturnValue(null) } as unknown as Storage;
      Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, writable: true });
      expect(getAuthRedirectFlag()).toBe(false);
    });

    it('returns false when storage throws SecurityError', () => {
      const mockStorage = {
        getItem: vi.fn().mockImplementation(() => { throw new DOMException('The operation is insecure.', 'SecurityError'); }),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, writable: true });
      expect(getAuthRedirectFlag()).toBe(false);
    });
  });

  describe('consumeEmailConfirmFlag', () => {
    it('returns and clears the flag value', () => {
      const mockStorage = {
        getItem: vi.fn().mockReturnValue('sent'),
        removeItem: vi.fn(),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, writable: true });

      expect(consumeEmailConfirmFlag()).toBe('sent');
      expect(mockStorage.removeItem).toHaveBeenCalledWith('health_roadmap_email_confirm');
    });

    it('returns null when flag is not set', () => {
      const mockStorage = {
        getItem: vi.fn().mockReturnValue(null),
        removeItem: vi.fn(),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, writable: true });

      expect(consumeEmailConfirmFlag()).toBeNull();
      expect(mockStorage.removeItem).not.toHaveBeenCalled();
    });

    it('returns null when storage throws SecurityError', () => {
      const mockStorage = {
        getItem: vi.fn().mockImplementation(() => { throw new DOMException('The operation is insecure.', 'SecurityError'); }),
        removeItem: vi.fn(),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'sessionStorage', { value: mockStorage, writable: true });

      expect(consumeEmailConfirmFlag()).toBeNull();
    });
  });

  describe('loadFromLocalStorage coerces measurement values to numbers', () => {
    it('converts string measurement values from stale cache to numbers', () => {
      // Simulate stale localStorage with PostgREST NUMERIC string values
      const staleData = {
        inputs: { heightCm: 180, sex: 'male' },
        previousMeasurements: [
          { id: '1', metricType: 'weight', value: '85.5' as unknown as number, recordedAt: '2026-01-01', createdAt: '2026-01-01' },
          { id: '2', metricType: 'ldl', value: '2.8' as unknown as number, recordedAt: '2026-01-01', createdAt: '2026-01-01' },
          { id: '3', metricType: 'psa', value: '1.2' as unknown as number, recordedAt: '2026-01-01', createdAt: '2026-01-01' },
        ],
        savedAt: new Date().toISOString(),
      };
      const mockStorage = {
        getItem: vi.fn().mockReturnValue(JSON.stringify(staleData)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });

      const loaded = loadFromLocalStorage();
      expect(loaded).not.toBeNull();
      for (const m of loaded!.previousMeasurements) {
        expect(typeof m.value).toBe('number');
        expect(m.value).not.toBeNaN();
      }
      expect(loaded!.previousMeasurements[0].value).toBe(85.5);
      expect(loaded!.previousMeasurements[2].value).toBe(1.2);
    });

    it('handles already-numeric values without issue', () => {
      const data = {
        inputs: {},
        previousMeasurements: [
          { id: '1', metricType: 'weight', value: 70, recordedAt: '2026-01-01', createdAt: '2026-01-01' },
        ],
        savedAt: new Date().toISOString(),
      };
      const mockStorage = {
        getItem: vi.fn().mockReturnValue(JSON.stringify(data)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });

      const loaded = loadFromLocalStorage();
      expect(loaded!.previousMeasurements[0].value).toBe(70);
    });
  });

  describe('loadFromLocalStorage handles missing optional fields', () => {
    it('returns data with undefined medications/screenings without crashing', () => {
      // Guest users may have cached data without medications/screenings arrays
      const guestData = {
        inputs: { heightCm: 180, sex: 'male' },
        savedAt: new Date().toISOString(),
        // Note: no medications, no screenings, no previousMeasurements, no reminderPreferences
      };
      const mockStorage = {
        getItem: vi.fn().mockReturnValue(JSON.stringify(guestData)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });

      const loaded = loadFromLocalStorage();
      expect(loaded).not.toBeNull();
      expect(loaded!.inputs.heightCm).toBe(180);
      // loadFromLocalStorage defaults missing arrays to [] (not undefined)
      expect(loaded!.medications).toEqual([]);
      expect(loaded!.screenings).toEqual([]);
      expect(loaded!.reminderPreferences).toEqual([]);
      expect(loaded!.previousMeasurements).toEqual([]);
    });
  });

  describe('loadFromLocalStorage strips invalid/corrupted values', () => {
    function mockWithInputs(inputs: Record<string, unknown>, extras?: Record<string, unknown>) {
      const data = {
        inputs,
        savedAt: new Date().toISOString(),
        ...extras,
      };
      const mockStorage = {
        getItem: vi.fn().mockReturnValue(JSON.stringify(data)),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
    }

    it('strips NaN and Infinity from numeric fields', () => {
      mockWithInputs({
        sex: 'male',
        heightCm: 180,
        weightKg: NaN,
        hba1c: Infinity,
        ldlC: -Infinity,
      });
      const loaded = loadFromLocalStorage()!;
      expect(loaded.inputs.heightCm).toBe(180);
      expect(loaded.inputs.sex).toBe('male');
      expect(loaded.inputs.weightKg).toBeUndefined();
      expect(loaded.inputs.hba1c).toBeUndefined();
      expect(loaded.inputs.ldlC).toBeUndefined();
    });

    it('strips out-of-range values', () => {
      mockWithInputs({
        heightCm: 180,
        sex: 'male',
        weightKg: -50,       // below min (20)
        waistCm: 999999,     // above max (200)
        birthYear: 1800,     // below min (1900)
        birthMonth: 13,      // above max (12)
        diastolicBp: 300,    // above max (150)
      });
      const loaded = loadFromLocalStorage()!;
      expect(loaded.inputs.heightCm).toBe(180);
      expect(loaded.inputs.weightKg).toBeUndefined();
      expect(loaded.inputs.waistCm).toBeUndefined();
      expect(loaded.inputs.birthYear).toBeUndefined();
      expect(loaded.inputs.birthMonth).toBeUndefined();
      expect(loaded.inputs.diastolicBp).toBeUndefined();
    });

    it('preserves valid values alongside invalid ones', () => {
      mockWithInputs({
        sex: 'male',
        heightCm: 175,
        weightKg: 80,
        hba1c: NaN,          // invalid — stripped
        ldlC: 3.5,           // valid — kept
        systolicBp: 120,     // valid — kept
      });
      const loaded = loadFromLocalStorage()!;
      expect(loaded.inputs.heightCm).toBe(175);
      expect(loaded.inputs.weightKg).toBe(80);
      expect(loaded.inputs.hba1c).toBeUndefined();
      expect(loaded.inputs.ldlC).toBe(3.5);
      expect(loaded.inputs.systolicBp).toBe(120);
    });

    it('passes through unknown fields like unitSystem', () => {
      mockWithInputs({
        heightCm: 180,
        sex: 'male',
        unitSystem: 'conventional',
      });
      const loaded = loadFromLocalStorage()!;
      expect(loaded.inputs.unitSystem).toBe('conventional');
    });

    it('filters null and empty-string previousMeasurement values', () => {
      // Number(null) and Number("") both coerce to 0, which would pass
      // Number.isFinite — guard against this to avoid clinically wrong 0 values.
      mockWithInputs(
        { heightCm: 180, sex: 'male' },
        {
          previousMeasurements: [
            { id: '1', metricType: 'weight', value: 80, recordedAt: '2026-01-01', createdAt: '2026-01-01' },
            { id: '2', metricType: 'ldl', value: null, recordedAt: '2026-01-01', createdAt: '2026-01-01' },
            { id: '3', metricType: 'hdl', value: '', recordedAt: '2026-01-01', createdAt: '2026-01-01' },
          ],
        },
      );
      const loaded = loadFromLocalStorage()!;
      expect(loaded.previousMeasurements).toHaveLength(1);
      expect(loaded.previousMeasurements[0].value).toBe(80);
    });

    it('filters non-finite previousMeasurement values', () => {
      // NaN/Infinity don't survive JSON.stringify (become null), but string
      // values like "NaN" or "not_a_number" from corrupted data do.
      // Number("NaN") → NaN, Number("abc") → NaN — both non-finite.
      mockWithInputs(
        { heightCm: 180, sex: 'male' },
        {
          previousMeasurements: [
            { id: '1', metricType: 'weight', value: 80, recordedAt: '2026-01-01', createdAt: '2026-01-01' },
            { id: '2', metricType: 'ldl', value: 'not_a_number', recordedAt: '2026-01-01', createdAt: '2026-01-01' },
            { id: '3', metricType: 'hdl', value: 'NaN', recordedAt: '2026-01-01', createdAt: '2026-01-01' },
          ],
        },
      );
      const loaded = loadFromLocalStorage()!;
      expect(loaded.previousMeasurements).toHaveLength(1);
      expect(loaded.previousMeasurements[0].value).toBe(80);
    });
  });

  describe('hasAuthenticatedFlag', () => {
    it('returns true when flag is set', () => {
      const mockStorage = { getItem: vi.fn().mockReturnValue('1') } as unknown as Storage;
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
      expect(hasAuthenticatedFlag()).toBe(true);
    });

    it('returns false when flag is not set', () => {
      const mockStorage = { getItem: vi.fn().mockReturnValue(null) } as unknown as Storage;
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
      expect(hasAuthenticatedFlag()).toBe(false);
    });

    it('returns false when storage throws SecurityError', () => {
      const mockStorage = {
        getItem: vi.fn().mockImplementation(() => { throw new DOMException('The operation is insecure.', 'SecurityError'); }),
      } as unknown as Storage;
      Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });
      expect(hasAuthenticatedFlag()).toBe(false);
    });
  });
});
