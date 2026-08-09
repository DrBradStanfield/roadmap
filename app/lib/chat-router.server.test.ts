import { describe, it, expect } from 'vitest';
import { sanitizeRawHandles, RouterOutput } from './chat-router.server';

describe('sanitizeRawHandles', () => {
  it('soft-truncates >3 handles so a 4th match cannot void the first three (W33 router_error defect)', () => {
    const four = ['cardiovascular-disease', 'hypertension-in-adults', 'statins', 'ldl-cholesterol'];
    const out = sanitizeRawHandles(four);
    expect(out).toEqual(four.slice(0, 3));
    expect(() => RouterOutput.parse({ handles: out })).not.toThrow();
  });

  it('keeps ≤3 handles unchanged', () => {
    const three = ['a-b', 'c-d', 'e-f'];
    expect(sanitizeRawHandles(three)).toEqual(three);
    expect(sanitizeRawHandles([])).toEqual([]);
  });

  it('drops non-strings and empties, trims and lowercases', () => {
    expect(sanitizeRawHandles(['  STATINS ', 42, '', null, 'ldl-cholesterol'])).toEqual([
      'statins',
      'ldl-cholesterol',
    ]);
  });

  it('passes non-arrays through untouched (schema parse still rejects them)', () => {
    expect(sanitizeRawHandles(undefined)).toBeUndefined();
    expect(sanitizeRawHandles('statins')).toBe('statins');
  });
});
