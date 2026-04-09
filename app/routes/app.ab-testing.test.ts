import { describe, it, expect } from 'vitest';
import { normalCDF, calculateSignificance } from '../lib/ab-stats';

describe('normalCDF', () => {
  it('returns 0.5 for x=0', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.8413 for x=1', () => {
    expect(normalCDF(1)).toBeCloseTo(0.8413, 3);
  });

  it('returns ~0.9772 for x=2', () => {
    expect(normalCDF(2)).toBeCloseTo(0.9772, 3);
  });

  it('returns ~0.1587 for x=-1 (symmetric)', () => {
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 3);
  });

  it('approaches 1 for large positive x', () => {
    expect(normalCDF(5)).toBeGreaterThan(0.999);
  });

  it('approaches 0 for large negative x', () => {
    expect(normalCDF(-5)).toBeLessThan(0.001);
  });
});

describe('calculateSignificance', () => {
  it('returns "Not enough data" when either variant has < 100 impressions', () => {
    const result = calculateSignificance(50, 5, 200, 20);
    expect(result.confidence).toBe('Not enough data');
    expect(result.pValue).toBe(1);
  });

  it('returns "Not significant" for similar conversion rates', () => {
    // 5% vs 5.1% with 1000 impressions each — noise
    const result = calculateSignificance(1000, 50, 1000, 51);
    expect(result.confidence).toBe('Not significant');
    expect(result.pValue).toBeGreaterThan(0.05);
  });

  it('returns significant for meaningfully different conversion rates', () => {
    // 5% vs 10% with 300 impressions each — p ≈ 0.02
    const result = calculateSignificance(300, 15, 300, 30);
    expect(result.confidence).toBe('Significant (95%)');
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.pValue).toBeGreaterThan(0.01);
  });

  it('returns "Highly significant" for very different rates', () => {
    // 5% vs 10% with 2000 impressions each
    const result = calculateSignificance(2000, 100, 2000, 200);
    expect(result.confidence).toBe('Highly significant (99%)');
    expect(result.pValue).toBeLessThan(0.01);
  });

  it('calculates relative improvement correctly', () => {
    // A: 10%, B: 12% → +20% improvement
    const result = calculateSignificance(1000, 100, 1000, 120);
    expect(result.relativeImprovement).toBeCloseTo(20, 0);
  });

  it('handles zero conversions in both variants', () => {
    const result = calculateSignificance(1000, 0, 1000, 0);
    expect(result.confidence).toBe('No variance');
    expect(result.relativeImprovement).toBe(0);
  });

  it('handles zero conversions in variant A (no division by zero)', () => {
    const result = calculateSignificance(1000, 0, 1000, 50);
    expect(result.relativeImprovement).toBe(0); // can't compute % improvement from 0
    expect(result.pValue).toBeLessThan(0.05);
  });
});
