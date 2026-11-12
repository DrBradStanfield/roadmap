// The iOS app's on-device reminders (US-25 AC12, ios/architecture.md D7).
// What is due, and when, is health-core's computeReminderSchedule: the same
// schedule the web pushes for its reminder emails, with the record's own
// per-category preferences and the annual floor. This file adds only the
// phone's notification days, so Swift schedules and never decides.
import { computeReminderSchedule, followupKinds, type FollowupKind, type ReminderScheduleItem } from '../../packages/health-core/src/reminder-schedule';
import { GROUP_COOLDOWNS, formatReminderDate } from '../../packages/health-core/src/reminders';
import { localDay } from '../../packages/health-core/src/merge';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

/** iOS keeps at most 64 pending notifications per app. */
export const PHONE_REMINDER_LIMIT = 64;

/** US-17 AC15: the app's own list names a follow-up as its plan card does (DRAFT
 *  words for Brad). Made here from the record on the phone, never sent anywhere. */
const FOLLOWUP_LABEL: Record<FollowupKind, (name: string) => string> = {
  organize: (name) => `Follow-up to organize: ${name}`,
  checkin: (name) => `Follow-up check-in: ${name}`,
  repeat: (name) => name, // "Repeat PSA (your last result)" (US-06 AC21, Brad 2026-11-12)
};

/** The hour a notification shows on its day: ReminderScheduler.hour in Swift (a test pins the two). */
export const NOTIFY_HOUR = 9;

/** How far ahead the phone schedules. Every launch refills, so two years is plenty. */
const HORIZON_DAYS = 730;

/** One notification for the phone to schedule, at a fixed hour of its local `fireDay`.
 *  One a day: its words are generic, so two on one day would be the same banner twice. */
export interface PhoneNotification {
  /** `reminder.<day>`: stable, so a refill replaces rather than doubles. */
  id: string;
  fireDay: string;
  /** What falls due that day, for the app's own use; never shown on the lock screen. */
  categories: Array<ReminderScheduleItem['category']>;
}

export interface PhoneReminders {
  /** The record's erase epoch: an erase moves it, and the phone then drops every reminder. */
  eraseEpoch: number;
  /** What is due, soonest first: the in-app list. Labels and dates stay inside the app.
   *  `overdue`: due today or earlier, on the phone's own calendar day. `dueText`:
   *  "Mar 2027", as the web's reminder emails write it. */
  upcoming: Array<ReminderScheduleItem & { overdue: boolean; dueText: string }>;
  /** The soonest notifications, at most `limit` (iOS's 64 by default). */
  notifications: PhoneNotification[];
  /** Only when the app sent first-seen days: the day each current follow-up item
   *  (`<category>:<organize|checkin|repeat>`) was first seen, for the app to keep and send
   *  back. An item that is no longer a follow-up is left out, so its entry clears. */
  firstSeen?: Record<string, string>;
}

/**
 * The phone's reminders for a record at `now`. Each item notifies on its due
 * day, then again every cooldown of its group (the email cron's GROUP_COOLDOWNS:
 * screenings 90 days, blood tests 180, reviews 365) for as long as it stays due.
 * The phone keeps no "last sent", so the repeats are counted from the due day:
 * the same record gives the same days on every refill, and an item already
 * overdue waits for its next step instead of firing on every launch. Today is
 * kept, on the phone's own calendar: a refresh that morning must not drop the
 * reminder, and iOS never fires a one-off trigger whose hour has passed.
 */
export function phoneReminders(
  file: RoadmapFile,
  now: Date,
  limit = PHONE_REMINDER_LIMIT,
  seenBefore?: Record<string, string>,
): PhoneReminders {
  const today = localDay(now);
  const followups = followupKinds(file, now);
  // A follow-up's due day is already past (US-17 AC15), so counting from it would
  // wait up to 90 days. With the app's first-seen days it fires the first morning
  // the phone sees it (this one, or tomorrow's after the hour), then every step
  // from there. A lost entry fires once more and is kept from then on; a kept day
  // after this start (a clock that was set ahead) heals to it.
  const firstSeen: Record<string, string> = {};
  const startOf = (item: ReminderScheduleItem): string => {
    const followup = followups[item.category];
    if (!followup || !seenBefore) return item.dueAt;
    const key = `${item.category}:${followup.kind}`;
    const slot = now.getHours() < NOTIFY_HOUR ? today : addDays(today, 1);
    const kept = seenBefore[key];
    const seen = firstSeen[key] = kept && kept <= slot ? kept : slot;
    return seen > item.dueAt ? seen : item.dueAt;
  };
  const upcoming = computeReminderSchedule(file, now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.category.localeCompare(b.category))
    .map((item) => {
      const followup = followups[item.category];
      const label = followup ? FOLLOWUP_LABEL[followup.kind](followup.name) : item.label;
      return { ...item, label, overdue: item.dueAt <= today, dueText: formatReminderDate(item.dueAt) };
    });
  const horizon = addDays(today, HORIZON_DAYS);
  const byDay = new Map<string, PhoneNotification>();
  for (const item of upcoming) {
    const step = GROUP_COOLDOWNS[item.group];
    for (let day = startOf(item); day <= horizon; day = addDays(day, step)) {
      if (day < today) continue;
      const notification = byDay.get(day) ?? { id: `reminder.${day}`, fireDay: day, categories: [] };
      notification.categories.push(item.category);
      byDay.set(day, notification);
    }
  }
  const notifications = [...byDay.values()].sort((a, b) => a.fireDay.localeCompare(b.fireDay));
  for (const n of notifications) n.categories.sort();
  return {
    eraseEpoch: file.meta.eraseEpoch ?? 0,
    upcoming,
    notifications: notifications.slice(0, limit),
    ...(seenBefore && { firstSeen }),
  };
}

/** A calendar day plus whole days, in UTC so no zone shift moves it. */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
