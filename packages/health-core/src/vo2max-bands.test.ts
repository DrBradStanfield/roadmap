// US-56 AC8: VO2 max fitness bands, FRIEND 2022 Table 3 (treadmill, RER >= 1.0),
// Kaminsky et al., Mayo Clin Proc 2022;97(2):285-293, doi:10.1016/j.mayocp.2021.08.020.
// Each cut-point below is copied from the journal's Table 3, read 2026-10-26.
import { describe, expect, it } from 'vitest';
import { APPLE_LOW_FROM_60, FRIEND_2022_TREADMILL } from './vo2max-bands';

// [ages, P20, P50, P80], Table 3 treadmill rows 20, 50 and 80.
const MEN: Array<[string, number, number, number]> = [
  ['20-29', 35.2, 46.5, 54.5],
  ['30-39', 29.8, 39.7, 50.0],
  ['40-49', 26.7, 35.3, 45.2],
  ['50-59', 22.2, 29.2, 38.3],
  ['60-69', 18.5, 24.6, 32.0],
  ['70-79', 15.9, 20.6, 25.9],
  ['80-89', 14.8, 17.6, 21.4],
];
const WOMEN: Array<[string, number, number, number]> = [
  ['20-29', 27.2, 36.6, 44.8],
  ['30-39', 21.9, 28.3, 37.0],
  ['40-49', 19.7, 25.7, 33.0],
  ['50-59', 18.5, 22.9, 28.4],
  ['60-69', 15.4, 19.6, 24.3],
  ['70-79', 14.0, 17.2, 20.8],
  ['80-89', 12.6, 15.4, 18.4],
];

describe('FRIEND 2022 treadmill cut-points (US-56 AC8)', () => {
  it.each([['male', MEN], ['female', WOMEN]] as const)('%s: every age band and cut-point matches Table 3', (sex, rows) => {
    expect(FRIEND_2022_TREADMILL[sex].map(r => [`${r.fromAge}-${r.toAge}`, r.p20, r.p50, r.p80])).toEqual(rows);
  });
});

// Brad 2026-10-27: from 60, Low uses Apple's Low Cardio Fitness alert line. Apple's white paper (May 2021):
// "absolute VO2 max thresholds of 18 and 15 ml/kg/min are used for males and females".
describe("Apple's Low line from age 60 (US-56 AC8)", () => {
  it('is 18 for men and 15 for women', () => {
    expect(APPLE_LOW_FROM_60).toEqual({ male: 18, female: 15 });
  });
});
