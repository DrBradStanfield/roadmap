// US-25 AC9: the app's on-device reminders (ios/architecture.md D7). What is
// due comes from health-core's computeReminderSchedule, the schedule the web
// pushes for its emails; this file pins the phone's notification days on top.
import { describe, expect, it } from 'vitest';
import { phoneReminders, PHONE_REMINDER_LIMIT } from './reminders';
import { newRecord } from './my-data';
import { computeReminderSchedule } from '../../packages/health-core/src/reminder-schedule';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';

/** A 60-year-old woman with a colonoscopy, a mammogram and lipids on file. */
function record(): RoadmapFile {
  const file = newRecord(NOW, 'phone', 'en-NZ', 'UTC');
  return {
    ...file,
    profile: { ...file.profile, sex: 'female', birthYear: 1966, birthMonth: 1 },
    screenings: {
      ...file.screenings,
      colorectalMethod: 'colonoscopy_10yr', colorectalLastDate: '2020-03',
      breastFrequency: 'biennial', breastLastDate: '2023-06',
    },
    measurements: [{
      id: 'm1', metricType: 'ldl', value: 3, recordedAt: '2026-01-15T00:00:00.000Z',
      createdAt: '2026-01-15T00:00:00.000Z', status: 'active',
    } as RoadmapFile['measurements'][number]],
  };
}

describe('phoneReminders (US-25 AC9)', () => {
  it('lists exactly health-core\'s schedule, soonest first', () => {
    const file = record();
    const out = phoneReminders(file, new Date(NOW));
    const fromCore = computeReminderSchedule(file, new Date(NOW));
    expect(out.upcoming).toHaveLength(fromCore.length);
    expect(new Set(out.upcoming.map((i) => `${i.category}@${i.dueAt}`)))
      .toEqual(new Set(fromCore.map((i) => `${i.category}@${i.dueAt}`)));
    const days = out.upcoming.map((i) => i.dueAt);
    expect(days).toEqual([...days].sort());
  });

  it('marks what is already due on the phone\'s own day, so the app compares no dates', () => {
    const out = phoneReminders(record(), new Date(NOW));
    expect(out.upcoming.find((i) => i.category === 'screening_breast')?.overdue).toBe(true);
    expect(out.upcoming.find((i) => i.category === 'blood_test_lipids')?.overdue).toBe(false);
  });

  it('notifies on the due day, then again each group cooldown while it stays due', () => {
    const out = phoneReminders(record(), new Date(NOW));
    const lipids = out.notifications.filter((n) => n.categories.includes('blood_test_lipids')).map((n) => n.fireDay);
    // Lipids last 2026-01-15, due 12 months on; blood tests repeat every 180 days.
    expect(lipids.slice(0, 2)).toEqual(['2027-01-15', '2027-07-14']);
  });

  it('never notifies for today or the past: an overdue item waits for its next cooldown step', () => {
    // The mammogram was due 2025-06-01, past; screening repeats every 90 days,
    // so its steps run 2025-08-30, 2025-11-28 ... 2026-08-25, then 2026-11-23.
    const out = phoneReminders(record(), new Date(NOW));
    const mammogram = out.notifications.filter((n) => n.categories.includes('screening_breast')).map((n) => n.fireDay);
    expect(mammogram.slice(0, 2)).toEqual(['2026-11-23', '2027-02-21']);
    expect(out.notifications.every((n) => n.fireDay > '2026-10-21')).toBe(true);
  });

  it('caps the batch, soonest first, with stable ids (iOS holds 64 pending)', () => {
    expect(PHONE_REMINDER_LIMIT).toBe(64);
    const all = phoneReminders(record(), new Date(NOW)).notifications;
    const out = phoneReminders(record(), new Date(NOW), 5);
    expect(out.notifications).toEqual(all.slice(0, 5));
    const days = out.notifications.map((n) => n.fireDay);
    expect(days).toEqual([...days].sort());
    expect(new Set(out.notifications.map((n) => n.id)).size).toBe(out.notifications.length);
    expect(out.notifications[0].id).toBe(`reminder.${out.notifications[0].fireDay}`);
    expect(phoneReminders(record(), new Date(NOW), 5).notifications).toEqual(out.notifications);
  });

  it('sends one notification a day, however many things fall due on it', () => {
    const file = record();
    // HbA1c on the lipids' day: both due 2027-01-15.
    file.measurements.push({ ...file.measurements[0], id: 'm2', metricType: 'hba1c', value: 40 });
    const out = phoneReminders(file, new Date(NOW));
    const days = out.notifications.map((n) => n.fireDay);
    expect(new Set(days).size).toBe(days.length);
    expect(out.notifications.find((n) => n.fireDay === '2027-01-15')?.categories).toEqual(['blood_test_hba1c', 'blood_test_lipids']);
  });

  it('honours the record\'s per-category preferences, as the web\'s schedule does', () => {
    const file = record();
    file.reminderPreferences = [{ category: 'screening_breast', enabled: false, updatedAt: NOW, lamport: 1 }];
    const out = phoneReminders(file, new Date(NOW));
    expect(out.upcoming.some((i) => i.category === 'screening_breast')).toBe(false);
    expect(out.notifications.some((n) => n.categories.includes('screening_breast'))).toBe(false);
  });

  it('reports the record\'s erase epoch, so the app can drop reminders made before an erase', () => {
    const file = record();
    expect(phoneReminders(file, new Date(NOW)).eraseEpoch).toBe(0);
    expect(phoneReminders({ ...file, meta: { ...file.meta, eraseEpoch: 3 } }, new Date(NOW)).eraseEpoch).toBe(3);
  });

  it('gives a known minor nothing, as the web does', () => {
    const file = record();
    file.profile = { ...file.profile, birthYear: 2015 };
    expect(phoneReminders(file, new Date(NOW))).toMatchObject({ upcoming: [], notifications: [] });
  });
});
