/**
 * The profile fields a connector may change (US-34). Display preferences —
 * `unitSystem`, `unitOverrides`, `lpaUnit` (US-05 AC2), `reportEmailCaptured`
 * — are deliberately out of reach: they are how the app draws the screen, not
 * what the record says about the person, and nobody asks an assistant to
 * change them.
 */
export const PROFILE_FIELDS = ['sex', 'birthYear', 'birthMonth', 'heightCm'] as const;
