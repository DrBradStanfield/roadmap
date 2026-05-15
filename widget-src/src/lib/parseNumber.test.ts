import { describe, it, expect } from 'vitest';
import { parseLocalisedNumber } from './parseNumber';

describe('parseLocalisedNumber', () => {
  // Period (US/UK/AU locales)
  it('parses period decimals', () => {
    expect(parseLocalisedNumber('0.5')).toBe(0.5);
    expect(parseLocalisedNumber('130.0')).toBe(130);
    expect(parseLocalisedNumber('2.844')).toBe(2.844);
  });

  // Comma (German, French, Italian, Spanish locales)
  it('parses comma decimals', () => {
    expect(parseLocalisedNumber('0,5')).toBe(0.5);
    expect(parseLocalisedNumber('130,0')).toBe(130);
    expect(parseLocalisedNumber('2,844')).toBe(2.844);
  });

  // Integers
  it('parses integers', () => {
    expect(parseLocalisedNumber('130')).toBe(130);
    expect(parseLocalisedNumber('0')).toBe(0);
    expect(parseLocalisedNumber('-50')).toBe(-50);
  });

  // Whitespace handling
  it('trims surrounding whitespace', () => {
    expect(parseLocalisedNumber('  0.5  ')).toBe(0.5);
    expect(parseLocalisedNumber('\t130,5\n')).toBe(130.5);
  });

  // Empty / invalid
  it('returns undefined for empty input', () => {
    expect(parseLocalisedNumber('')).toBeUndefined();
    expect(parseLocalisedNumber('   ')).toBeUndefined();
  });

  it('returns undefined for a bare minus sign', () => {
    // User typing a negative value; the minus alone isn't a valid number
    expect(parseLocalisedNumber('-')).toBeUndefined();
  });

  it('returns undefined for non-numeric input', () => {
    expect(parseLocalisedNumber('abc')).toBeUndefined();
    expect(parseLocalisedNumber('0.5x')).toBeUndefined();
    expect(parseLocalisedNumber('--')).toBeUndefined();
  });

  it('returns undefined for Infinity / NaN', () => {
    expect(parseLocalisedNumber('Infinity')).toBeUndefined();
    expect(parseLocalisedNumber('NaN')).toBeUndefined();
  });

  // Multiple separators — we just replace all commas with periods. With
  // multiple periods this becomes invalid, returning undefined. We don't
  // try to interpret thousands separators because lab values never need them.
  it('returns undefined for multi-separator input (no thousands interpretation)', () => {
    expect(parseLocalisedNumber('1,234.56')).toBeUndefined();
    expect(parseLocalisedNumber('1,234,567')).toBeUndefined();
  });

  // Negative decimals in both locales
  it('parses negative decimals in both locales', () => {
    expect(parseLocalisedNumber('-0.5')).toBe(-0.5);
    expect(parseLocalisedNumber('-0,5')).toBe(-0.5);
  });
});
