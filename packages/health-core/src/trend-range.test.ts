/**
 * US-62 AC8a (Brad 2026-11-09): a small trend line's vertical range is at least ±5% of
 * the latest value, so a tiny change draws nearly flat while a real change fills it.
 * The iPhone's twin (ValueRow.swift `Sparkline.range`) is tested on these same cases in
 * MyDataLayoutTests.testATrendsRangeIsAtLeastFivePercentEachWay_US62_AC8a.
 */
import { describe, expect, it } from 'vitest';
import { trendRange } from './recent-trend';

/** How much of the line's height the points' own change takes, 0 to 1. */
const fill = (points: number[]) => {
  const { low, high } = trendRange(points);
  return (Math.max(...points) - Math.min(...points)) / (high - low);
};

describe('trendRange (US-62 AC8a)', () => {
  it('draws a tiny change nearly flat: waist-to-height 0.57 to 0.58', () => {
    const { low, high } = trendRange([0.57, 0.58]);
    expect(high - low).toBeCloseTo(0.058, 9); // ±5% of 0.58
    expect((low + high) / 2).toBeCloseTo(0.575, 9); // about the points' middle
    expect(fill([0.57, 0.58])).toBeLessThan(0.2);
  });

  it('keeps a real change at full height: weight 100 to 85 kg', () => {
    expect(trendRange([100, 92, 85])).toEqual({ low: 85, high: 100 });
    expect(fill([100, 92, 85])).toBe(1);
  });

  it('reads ±5% from the latest point, not the first', () => {
    const { low, high } = trendRange([42, 41]);
    expect(high - low).toBeCloseTo(4.1, 9);
    expect(trendRange([41, 42]).high - trendRange([41, 42]).low).toBeCloseTo(4.2, 9);
  });

  it('draws equal points across the middle, and all zeros over a span of one', () => {
    expect(trendRange([5, 5, 5])).toEqual({ low: 4.75, high: 5.25 });
    expect(trendRange([0, 0])).toEqual({ low: -0.5, high: 0.5 });
  });
});
