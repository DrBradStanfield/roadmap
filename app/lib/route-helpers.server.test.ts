import { describe, it, expect } from 'vitest';
import { getCustomerId, isValidUuid } from './route-helpers.server';

describe('getCustomerId', () => {
  function makeRequest(params: string): Request {
    return new Request(`https://example.com/api/measurements?${params}`);
  }

  it('extracts numeric customer ID', () => {
    expect(getCustomerId(makeRequest('logged_in_customer_id=12345'))).toBe('12345');
  });

  it('returns null when parameter is missing', () => {
    expect(getCustomerId(makeRequest(''))).toBeNull();
  });

  it('rejects non-numeric customer ID', () => {
    expect(getCustomerId(makeRequest('logged_in_customer_id=abc'))).toBeNull();
  });

  it('rejects customer ID with special characters', () => {
    expect(getCustomerId(makeRequest('logged_in_customer_id=123%3B+DROP+TABLE'))).toBeNull();
  });

  it('rejects empty customer ID', () => {
    expect(getCustomerId(makeRequest('logged_in_customer_id='))).toBeNull();
  });

  it('rejects customer ID with spaces', () => {
    expect(getCustomerId(makeRequest('logged_in_customer_id=123+456'))).toBeNull();
  });
});

describe('isValidUuid', () => {
  it('accepts valid UUID v4', () => {
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidUuid('')).toBe(false);
  });

  it('rejects non-UUID string', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false);
  });

  it('rejects UUID with uppercase (tokens are lowercase hex)', () => {
    expect(isValidUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(false);
  });

  it('rejects very long string', () => {
    expect(isValidUuid('a'.repeat(1000))).toBe(false);
  });

  it('rejects SQL injection attempt', () => {
    expect(isValidUuid("'; DROP TABLE profiles; --")).toBe(false);
  });
});
