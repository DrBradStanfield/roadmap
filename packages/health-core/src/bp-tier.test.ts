// US-75 AC4: the blood pressure tiers, one rule for the plan's cards and the widget.
import { describe, expect, it } from 'vitest';
import { BP_TIER_LABEL, bpTier } from './bp-tier';
import { calculateHealthResults } from './calculations';

describe('bpTier (algorithm § Blood Pressure)', () => {
  it('grades each boundary: the higher half decides', () => {
    const cases: Array<[number, number, string]> = [
      [119, 79, 'normal'], [120, 79, 'elevated'], [129, 79, 'elevated'],
      [130, 79, 'stage1'], [110, 80, 'stage1'], [139, 89, 'stage1'],
      [140, 70, 'stage2'], [110, 90, 'stage2'], [179, 119, 'stage2'],
      [180, 70, 'crisis'], [110, 120, 'crisis'],
    ];
    for (const [sys, dia, tier] of cases) expect([sys, dia, bpTier(sys, dia)]).toEqual([sys, dia, tier]);
  });

  it('the plan\'s tier card is the tier\'s, titled by the same label; Normal and Elevated have none', () => {
    for (const [sys, dia] of [[118, 76], [125, 78], [134, 82], [150, 95], [185, 100]]) {
      const tier = bpTier(sys, dia);
      const card = calculateHealthResults({ heightCm: 175, systolicBp: sys, diastolicBp: dia }).suggestions
        .find((s) => ['bp-crisis', 'bp-stage2', 'bp-stage1'].includes(s.id));
      const expected = { crisis: 'bp-crisis', stage2: 'bp-stage2', stage1: 'bp-stage1' }[tier as 'crisis'];
      expect(card?.id).toBe(expected);
      if (card) expect(card.title).toBe(BP_TIER_LABEL[tier]);
    }
  });
});
