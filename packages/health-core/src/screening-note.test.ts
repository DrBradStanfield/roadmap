// US-62 AC41: Cancer screening's note where no screening question applies, the iPhone's words.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { screeningForm } from './input-form';
import { screeningNote } from './screening-note';

const NO_AGE = 'Screening questions appear once your sex, birth year and height are in About you.';
const NO_SEX = 'Some screening questions depend on your sex. Add it in About you.';
const NONE_APPLY = 'No screening questions apply at your age and sex yet.';

describe('US-62 AC41: the screening note', () => {
  it.each([
    ['no age', undefined, 'female', NO_AGE],
    ['no sex', 30, undefined, NO_SEX],
    ['nothing applies at 20', 20, 'male', NONE_APPLY],
  ] as const)('%s: the note', (_, age, sex, note) => {
    const screenings = screeningForm(age, sex, {});
    expect(screenings).toEqual([]);
    expect(screeningNote(age, sex, screenings)).toBe(note);
  });

  it('no note while a screening question applies', () => {
    const screenings = screeningForm(55, 'female', {});
    expect(screenings.length).toBeGreaterThan(0);
    expect(screeningNote(55, 'female', screenings)).toBeNull();
  });

  it("the iPhone engine's copy holds the same words (lead W1-5b: until it reads this one)", () => {
    const engine = readFileSync(new URL('../../../ios/engine/my-data-forms.ts', import.meta.url), 'utf8');
    for (const note of [NO_AGE, NO_SEX, NONE_APPLY]) expect(engine).toContain(`'${note}'`);
  });
});
