/**
 * The next PSA test, by level (US-06 AC21; screening Change 4, D15 and D21, Brad 2026-11-12),
 * from the newest usable PSA (US-06 AC14): 24 months below 2.5 ng/mL and 12 months from 2.5
 * for men who will screen (ACS); 3 months at 4.0 or above for every man in the prostate
 * ages, whatever he answered, until a newer PSA below 4.0 is saved (Dr Brad's suggestion).
 * The plan's cards and the reminder schedule both read it here.
 */
import { bandDecides, formatGradedOrLimit } from './lab-limits';
import { PSA_THRESHOLDS } from './units';
import { getScreeningNextDueDate, type ScreeningInputs, type Suggestion } from './types';

/** Below this, a man who will screen is retested every 2 years (ACS); from it, every year. */
export const PSA_BIENNIAL_BELOW = 2.5;
/** At 4.0 or above: every 3 months, whatever the screening answer. */
export const PSA_RAISED_MONTHS = 3;
const PSA_BIENNIAL_MONTHS = 24;

/** The iPhone's own Reminders list names the 4.0-or-above reminder so (never emailed). */
export const PSA_REPEAT_NAME = 'Repeat PSA (your last result)';

/** Raised: 4.0 or above, or a limit that decides so (`prostatePsaValue` holds its representative). */
export const psaRaised = (s: ScreeningInputs): boolean =>
  s.prostatePsaValue !== undefined && s.prostatePsaValue >= PSA_THRESHOLDS.normal;

/** Below 2.5: a value, or a limit only when it decides ("< 1.0" does, "< 3" does not). */
function belowBiennialLine(s: ScreeningInputs): boolean {
  const limit = s.prostatePsaLimit;
  if (limit) return (limit.comparator === '<' || limit.comparator === '<=') && bandDecides([PSA_BIENNIAL_BELOW], limit.comparator, limit.bound);
  return s.prostatePsaValue !== undefined && s.prostatePsaValue < PSA_BIENNIAL_BELOW;
}

/**
 * When the next PSA is due: null with no last PSA date, or for a man who does not
 * screen while his newest PSA is below 4.0. A date with no value is 12 months, as before.
 */
export function psaNextDue(s: ScreeningInputs): Date | null {
  if (psaRaised(s)) return getScreeningNextDueDate(s.prostateLastDate, PSA_RAISED_MONTHS);
  if (s.prostateDiscussion !== 'will_screen') return null;
  return getScreeningNextDueDate(s.prostateLastDate, belowBiennialLine(s) ? PSA_BIENNIAL_MONTHS : 'will_screen');
}

const REPEAT_DECLINED = 'You chose not to have routine prostate screening, and that choice stands. ';
const REPEAT_TEXT = 'Your last PSA was 4.0 or higher, so checking it again is about that result, not screening. Dr Brad suggests repeating it every 3 months while it stays at 4.0 or higher. Discuss with your doctor.';

/**
 * The cards a raised PSA adds: "Repeat PSA test" for a man who does not screen, once
 * 3 months have passed since that PSA (in place of "PSA test overdue"; with no answer
 * recorded, its first sentence is left out), then "Elevated PSA".
 */
export function raisedPsaCards(s: ScreeningInputs, now: Date): Suggestion[] {
  const cards: Suggestion[] = [];
  const due = psaNextDue(s);
  if (s.prostateDiscussion !== 'will_screen' && due && now > due) {
    cards.push({
      id: 'screening-prostate-repeat', category: 'screening', priority: 'attention', title: 'Repeat PSA test',
      description: `${s.prostateDiscussion === 'elected_not_to' ? REPEAT_DECLINED : ''}${REPEAT_TEXT}`,
    });
  }
  // A limit prints as printed (US-12 AC20): "> 100.0 ng/mL".
  const limit = s.prostatePsaLimit;
  const shown = `${formatGradedOrLimit('psa', limit ? limit.bound : s.prostatePsaValue!, 'si', limit?.comparator)} ng/mL`;
  cards.push({
    id: 'screening-prostate-elevated', category: 'screening', priority: 'attention', title: 'Elevated PSA',
    description: `Your PSA of ${shown} is 4.0 or higher, the level many doctors use to decide on further tests. A raised PSA can have several causes, including an enlarged prostate, infection or prostate cancer. Dr Brad suggests repeating the test every 3 months while it stays at 4.0 or higher. Discuss with your doctor.`,
  });
  return cards;
}
