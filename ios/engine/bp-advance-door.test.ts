// US-02 AC12: the iPhone's blood pressure sheet reads health-core's systolic auto-advance rule
// through this optional door, never a Swift copy.
import { describe, expect, it } from 'vitest';
import { bpSysAdvance as rule } from '../../packages/health-core/src/bp-advance';
import { bpSysAdvance as door } from './entry';

describe('bpSysAdvance door (US-02 AC12)', () => {
  it("answers health-core's word for each systolic and diastolic as typed", () => {
    const cases: Array<[string, string, string]> = [
      ['120', '', 'advance'], ['250', '', 'advance'], ['251', '', 'stay'], ['75', '', 'defer'], ['60', '', 'defer'],
      ['59', '', 'stay'], ['12', '', 'stay'], ['', '', 'stay'], ['abc', '', 'stay'], ['120', '80', 'stay'], ['75', '8', 'stay'],
    ];
    for (const [s, d, word] of cases) {
      expect(door(s, d), `${s}/${d}`).toBe(word);
      expect(door(s, d), `${s}/${d}`).toBe(rule(s, d));
    }
  });

  it('refuses a call that is not two texts', () => {
    expect(() => (door as unknown as (...a: unknown[]) => string)('120')).toThrow('diastolic is not the contract');
  });
});
