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
import { chainKeys, opensFollowup, ruleOf } from './screening-rules';

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

/** A date's month (YYYY-MM from YYYY-MM or YYYY-MM-DD), or '' when it names none. */
const monthOf = (d: string | undefined): string => (/^\d{4}-\d{2}/.test(d ?? '') ? d!.slice(0, 7) : '');

/**
 * Whether a new abnormal last screening starts the follow-up again (Brad 2026-11-12, US-07 AC1j): "The new
 * abnormal result starts the follow-up again." The result is abnormal and the last screening's month is later
 * than the follow-up's. The same month, or a follow-up with no date, never.
 */
const reopens = (result: string | undefined, lastDate: string | undefined, followupDate: string | undefined): boolean =>
  opensFollowup(ruleOf('colorectal'), result) && !!monthOf(followupDate) && monthOf(lastDate) > monthOf(followupDate);

/** The colorectal result the form shows: blank while a stored abnormal result's last screening is newer than its
 *  follow-up, so the form asks it again for that screening. The only place that decides it; the plan, cards and
 *  reminders read the stored answers as they are. */
export const shownColorectalResult = (s: ScreeningInputs): string =>
  reopens(s.colorectalResult, s.colorectalLastDate, s.colorectalFollowupDate) ? '' : (s.colorectalResult ?? '');

/** The follow-up answers the colorectal result write clears when it starts the follow-up again: status, date and
 *  time. screeningWrites writes them always, so the stamped nulls win a merge. A date write never clears. */
export function reopenClears(s: ScreeningInputs, key: string, value: string): string[] {
  const r = ruleOf('colorectal');
  return key === r.result!.key && reopens(value, s.colorectalLastDate, s.colorectalFollowupDate) ? chainKeys(r).slice(1) : [];
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
