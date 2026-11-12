/**
 * The colonoscopy schedule after an abnormal colorectal result (screening Change 2b, Brad 2026-11-12,
 * US-07 AC1j). Once the follow-up colonoscopy is done, the next is due at the follow-up time the
 * colonoscopy report gave (whole years, 1 to 10, once), counted from the colonoscopy date, or 3 years
 * after it with none given (Dr Brad's recommendation). The schedule is derived, never written:
 * colorectalMethod stays as the person answered it, on every method. Completed with no usable date:
 * a card asks for it, and no reminder until it is added. Breast, cervical, lung and DEXA keep the
 * shared follow-up path in suggestions.ts and reminder-schedule.ts.
 * The words are frozen: docs/drafts/screening-change-2b-words-2026-11-12.md.
 */
import { getPostFollowupDueDate, type ScreeningInputs, type Suggestion } from './types';
import { opensFollowup, ruleOf } from './screening-rules';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A due month as every screening card prints it: "Jul 2029". */
export const monthLabel = (d: Date): string => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

const CARDS = {
  addDate: { title: 'Add your colonoscopy date', description: "You've marked your colonoscopy as done. Add the month it was done to see when your next colonoscopy is due." },
  dueDefault: { title: 'Colorectal screening up to date', description: "Following your colonoscopy, your next colonoscopy is due {due}. Dr Brad suggests repeating it every 3 years if your report didn't give a follow-up time." },
  dueAdvised: { title: 'Colorectal screening up to date', description: 'Following your colonoscopy, your next colonoscopy is due {due}, as your report advised.' },
  overdue: { title: 'Colonoscopy overdue', description: 'Following your colonoscopy, your next colonoscopy was due {due}. Please book it with your doctor.' },
} as const;

/** A stored follow-up time: a whole number of years, 1 to 10, else undefined (dropped). */
export function followupIntervalYears(value: string): number | undefined {
  const max = ruleOf('colorectal').followupInterval!.maxYears;
  const n = /^\d{1,2}$/.test(value.trim()) ? Number(value) : NaN;
  return n >= 1 && n <= max ? n : undefined;
}

/** Whether an abnormal result's colonoscopy is done: the person is on the colonoscopy schedule. */
export const onColonoscopySchedule = (s: ScreeningInputs): boolean =>
  opensFollowup(ruleOf('colorectal'), s.colorectalResult) && s.colorectalFollowupStatus === 'completed';

/** The next colonoscopy's due month, or null with no usable colonoscopy date (or off the schedule). */
export const nextColonoscopyDue = (s: ScreeningInputs): Date | null => getPostFollowupDueDate('colorectal',
  s.colorectalMethod, s.colorectalResult, s.colorectalFollowupStatus, s.colorectalFollowupDate, s.colorectalFollowupIntervalYears);

/** The schedule's card, for a person on it: ask for the date, overdue, or up to date (with the report's time or the 3-year default). */
export function colonoscopyCard(s: ScreeningInputs, now: Date): Suggestion {
  const due = nextColonoscopyDue(s);
  const card = (c: { title: string; description: string }, priority: Suggestion['priority']): Suggestion => ({
    id: 'screening-colorectal-followup', category: 'screening', priority,
    title: c.title, description: due ? c.description.replace('{due}', monthLabel(due)) : c.description,
  });
  if (!due) return card(CARDS.addDate, 'attention');
  if (now > due) return card(CARDS.overdue, 'attention');
  return card(s.colorectalFollowupIntervalYears ? CARDS.dueAdvised : CARDS.dueDefault, 'info');
}
