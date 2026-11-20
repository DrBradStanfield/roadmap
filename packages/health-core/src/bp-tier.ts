// The blood pressure tiers (health_roadmap_algorithm.md § Blood Pressure): one rule for the plan's tier
// cards (suggestions.ts) and the single-topic blood pressure widget (US-75). Normal, Elevated, Stage 1 and
// Stage 2 are the 2017 ACC/AHA categories; the crisis line, at or above 180 or 120, is the roadmap's own
// rule (the guideline's crisis algorithm is strictly above), with NHLBI's advice for it.
import { BP_THRESHOLDS } from './units';

export type BpTier = 'crisis' | 'stage2' | 'stage1' | 'elevated' | 'normal';

/** Each tier's name: the plan's card titles, and the algorithm table's Elevated row (a label only, no card). */
export const BP_TIER_LABEL: Readonly<Record<BpTier, string>> = {
  crisis: 'Hypertensive crisis', stage2: 'Stage 2 hypertension', stage1: 'Stage 1 hypertension', elevated: 'Elevated', normal: 'Normal',
};

/** Raised blood pressure: systolic ≥130 or diastolic ≥80. Either half counts
 *  on its own; the BP card checks separately that it has both to display. */
export function isBpRaised(systolic: number | undefined, diastolic: number | undefined): boolean {
  return (systolic !== undefined && systolic >= BP_THRESHOLDS.stage1Sys)
    || (diastolic !== undefined && diastolic >= BP_THRESHOLDS.stage1Dia);
}

/** A pair's tier, the higher half deciding: crisis at 180 or 120, stage 2 at 140 or 90, stage 1 at 130 or 80, elevated at a systolic of 120. */
export function bpTier(sys: number, dia: number): BpTier {
  if (sys >= BP_THRESHOLDS.crisisSys || dia >= BP_THRESHOLDS.crisisDia) return 'crisis';
  if (sys >= BP_THRESHOLDS.stage2Sys || dia >= BP_THRESHOLDS.stage2Dia) return 'stage2';
  if (isBpRaised(sys, dia)) return 'stage1';
  return sys >= BP_THRESHOLDS.elevatedSys ? 'elevated' : 'normal';
}
