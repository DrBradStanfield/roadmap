import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAuthRedirectFlag, consumeEmailConfirmFlag, hasAuthenticatedFlag } from './storage';

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
