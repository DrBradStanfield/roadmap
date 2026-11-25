// US-60 AC3, AC4: one copy of the "Reduce alcohol intake" Dismiss question's words (lead M10).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alcoholQuestionMessage, alcoholQuestionTitle, stillDrinkLine } from './alcohol-question-words';

const KEPT = 'Your answer is kept in your record, so your plan follows it on every device.';
const STAYS = 'This stays on your plan because the advice applies to anyone who drinks.';

describe('US-60 AC3, AC4: the alcohol question\'s words', () => {
  it('asks a drinker whether they still drink', () => {
    expect(alcoholQuestionTitle(false)).toBe('Do you drink alcohol?');
    expect(alcoholQuestionTitle(true)).toBe('Do you still drink alcohol?');
  });

  it('names About you only where the page has its Alcohol row', () => {
    expect(alcoholQuestionMessage(false, true)).toBe(`${KEPT} You can change it in About you.`);
    expect(alcoholQuestionMessage(false, false)).toBe(KEPT);
    expect(alcoholQuestionMessage(false)).toBe(KEPT);
    expect(stillDrinkLine(true)).toBe(`${STAYS} You can change your answer in About you.`);
    expect(stillDrinkLine(false)).toBe(STAYS);
  });

  it('asks a drinker to say if it changed, with or without the row', () => {
    expect(alcoholQuestionMessage(true, true)).toBe('Tell us if this has changed.');
    expect(alcoholQuestionMessage(true, false)).toBe('Tell us if this has changed.');
  });

  it("the iPhone app's Swift copy holds the same titles and drinker line (lead M10b: until it reads this one)", () => {
    const swift = readFileSync(new URL('../../../ios/HealthRoadmap/Plan/PlanCardView.swift', import.meta.url), 'utf8');
    for (const words of [alcoholQuestionTitle(false), alcoholQuestionTitle(true), alcoholQuestionMessage(true)]) {
      expect(swift).toContain(`"${words}"`);
    }
  });
});
