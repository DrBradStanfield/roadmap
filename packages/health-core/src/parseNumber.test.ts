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

  // US-12 AC8: plain decimals only. Number() also reads hex, binary, octal
  // and exponents, so "0x10" was 16 and "1e3" was 1000.
  it('US-12 AC8: refuses hex, binary, octal and exponent forms', () => {
    for (const s of ['0x10', '0b1', '0o7', '1e3', '1E-2', '-Infinity']) {
      expect(parseLocalisedNumber(s)).toBeUndefined();
    }
    expect(parseLocalisedNumber('+5')).toBe(5);
    expect(parseLocalisedNumber('5.')).toBe(5);
    expect(parseLocalisedNumber('.5')).toBe(0.5);
    expect(parseLocalisedNumber(',5')).toBe(0.5);
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
