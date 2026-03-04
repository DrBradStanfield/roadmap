import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAuthRedirectFlag, consumeEmailConfirmFlag, hasAuthenticatedFlag, loadFromLocalStorage, saveToLocalStorage } from './storage';

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
