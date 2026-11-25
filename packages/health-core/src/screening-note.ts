// The note Cancer screening shows where no screening question applies (US-62 AC41). The iPhone's
// approved words; its engine keeps its own copy (ios/engine/my-data-forms.ts buildForms) until it
// reads this one (lead W1-5b).
import type { FormSection } from './input-form';

/** The note, or null while any screening question applies. */
export function screeningNote(age: number | undefined, sex: string | undefined, screenings: readonly FormSection[]): string | null {
  return screenings.length > 0 ? null
    : age === undefined ? 'Screening questions appear once your sex, birth year and height are in About you.'
      // US-07 AC8: with no sex, the sexed questions wait for it; "at your age and sex" would be wrong.
      : sex === undefined ? 'Some screening questions depend on your sex. Add it in About you.'
        : 'No screening questions apply at your age and sex yet.';
}
