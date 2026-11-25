// US-62 AC41: the screening form and its note read one age, the screening age (US-23 AC6c), so the note
// shows exactly when the form has no question, also at a birth-month boundary where the plan's age differs.
import { describe, expect, it } from 'vitest';
import type { PlanBasis } from '../components/InputPanel';
import { planForms } from './plan-forms';

const NONE_APPLY = 'No screening questions apply at your age and sex yet.';

/** A woman whose local age is 25 (cervical screening's first year); `screeningAge` reads the UTC month. */
function forms(age: number, screeningAge: number) {
  const planBasis: Partial<PlanBasis> = { age, screeningAge };
  return planForms({ hasLipidInput: false, hasWeightInput: false, medications: [], screenings: [], planBasis, sex: 'female', unitOverrides: {}, unitSystem: 'si' });
}

describe('US-62 AC41: the note follows the screening age', () => {
  it('local age 25, screening age 24 (the UTC month is still before the birth month): no question, the note', () => {
    const f = forms(25, 24);
    expect(f.screenings).toEqual([]);
    expect(f.screeningNote).toBe(NONE_APPLY);
  });

  it('local age 24, screening age 25 (the UTC month has reached the birth month): questions, no note', () => {
    const f = forms(24, 25);
    expect(f.screenings.length).toBeGreaterThan(0);
    expect(f.screeningNote).toBeNull();
  });
});
