import { describe, it, expect } from 'vitest';
import { commaQuestion, parseLocalisedNumber } from './parseNumber';

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
    expect(parseLocalisedNumber('2,84')).toBe(2.84);
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

  // A comma and a dot together is still refused.
  it('returns undefined for a comma and a dot together', () => {
    expect(parseLocalisedNumber('1,234.56')).toBeUndefined();
    expect(parseLocalisedNumber('1.234,56')).toBeUndefined();
  });

  // Negative decimals in both locales
  it('parses negative decimals in both locales', () => {
    expect(parseLocalisedNumber('-0.5')).toBe(-0.5);
    expect(parseLocalisedNumber('-0,5')).toBe(-0.5);
  });
});

// US-02 AC7 (Brad 2026-10-27): "1,234" is US thousands (1234) or a European
// decimal comma (1.234). Only a range can pick one; without one it is refused.
describe('parseLocalisedNumber: an ambiguous comma (US-02 AC7)', () => {
  it('refuses 1-3 digits, a comma and exactly 3 digits when no range is given', () => {
    for (const s of ['1,234', '1,050', '250,000', '-1,234', ' 12,500 ']) {
      expect(parseLocalisedNumber(s)).toBeUndefined();
    }
  });

  it('uses the one reading inside the range', () => {
    expect(parseLocalisedNumber('1,234', { min: 0, max: 22.6 })).toBe(1.234);
    expect(parseLocalisedNumber('1,234', { min: 10, max: 2650 })).toBe(1234);
  });

  it('refuses when both readings, or neither, are inside the range', () => {
    expect(parseLocalisedNumber('1,234', { min: 0, max: 2000 })).toBeUndefined();
    expect(parseLocalisedNumber('1,234', { min: 20, max: 300 })).toBeUndefined();
  });

  it('leaves the unambiguous forms as they were', () => {
    expect(parseLocalisedNumber('1,2')).toBe(1.2);
    expect(parseLocalisedNumber('4,5')).toBe(4.5);
    expect(parseLocalisedNumber('0,85')).toBe(0.85);
    expect(parseLocalisedNumber('12,5')).toBe(12.5);
    expect(parseLocalisedNumber('0,123')).toBe(0.123); // a leading 0 is never a thousands group
    expect(parseLocalisedNumber('1234,567')).toBe(1234.567); // four digits before: a decimal
    expect(parseLocalisedNumber('1,2345')).toBe(1.2345);
    expect(parseLocalisedNumber('1234')).toBe(1234);
    expect(parseLocalisedNumber('1.234')).toBe(1.234);
  });

  it('reads two or more comma groups as thousands, whatever the range', () => {
    expect(parseLocalisedNumber('1,234,567')).toBe(1234567);
    expect(parseLocalisedNumber('12,345,678', { min: 0, max: 10 })).toBe(12345678);
    expect(parseLocalisedNumber('1,23,456')).toBeUndefined();
    expect(parseLocalisedNumber('1234,567,890')).toBeUndefined();
  });

  it('asks which reading was meant, in plain words', () => {
    expect(commaQuestion('1,234')).toBe('Did you mean 1234 or 1.234?');
    expect(commaQuestion('1,050')).toBe('Did you mean 1050 or 1.05?');
    expect(commaQuestion('1,2')).toBeNull();
    expect(commaQuestion('1234')).toBeNull();
  });
});
