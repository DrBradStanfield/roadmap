// US-25 AC12: the app's on-device reminders (ios/architecture.md D7). What is
// due comes from health-core's computeReminderSchedule, the schedule the web
// pushes for its emails; this file pins the phone's notification days on top.
import { describe, expect, it } from 'vitest';
import { NOTIFY_HOUR, phoneReminders, PHONE_REMINDER_LIMIT } from './reminders';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { remindersJson } from './entry';
import { newRecord } from './my-data';
import { computeReminderSchedule } from '../../packages/health-core/src/reminder-schedule';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { localDay } from '../../packages/health-core/src/merge';

// Phone wall-clock times, no zone: the engine reads the phone's own calendar and hour.
const NOW = '2026-10-21T08:00:00.000';

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

describe('phoneReminders (US-25 AC12)', () => {
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

  it('keeps a notification due today, on the phone\'s own day, so opening the app that morning does not drop it', () => {
    // A late-evening instant: in Pacific/Auckland its local day is a day past UTC's.
    const now = new Date('2026-10-21T13:00:00.000');
    const today = localDay(now);
    const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
    const file = record();
    file.measurements = [{ ...file.measurements[0], recordedAt: `${yearAgo}T00:00:00.000Z` }];
    const out = phoneReminders(file, now);
    expect(out.upcoming.find((i) => i.category === 'blood_test_lipids')).toMatchObject({ dueAt: today, overdue: true });
    expect(out.notifications[0]).toMatchObject({ fireDay: today, categories: ['blood_test_lipids'] });
    expect(out.notifications.every((n) => n.fireDay >= today)).toBe(true);
  });

  it('writes each date as the web\'s reminder emails do', () => {
    const out = phoneReminders(record(), new Date(NOW));
    expect(out.upcoming.find((i) => i.category === 'blood_test_lipids')?.dueText).toBe('Jan 2027');
  });

  it('never notifies for the past: an overdue item waits for its next cooldown step', () => {
    // The mammogram was due 2025-06-01, past; screening repeats every 90 days,
    // so its steps run 2025-08-30, 2025-11-28 ... 2026-08-25, then 2026-11-23.
    const out = phoneReminders(record(), new Date(NOW));
    const mammogram = out.notifications.filter((n) => n.categories.includes('screening_breast')).map((n) => n.fireDay);
    expect(mammogram.slice(0, 2)).toEqual(['2026-11-23', '2027-02-21']);
    expect(out.notifications.every((n) => n.fireDay >= '2026-10-21')).toBe(true);
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

// US-25 AC12 with US-17 AC15: the phone has the record, so its own list can say
// which reminders are follow-ups, and it fires a follow-up on the day it first
// sees it. The schedule the web pushes keeps the plain label; the follow-up
// words and the first-seen days are made and kept on the phone only.
describe('follow-up reminders on the phone (US-17 AC15)', () => {
  function abnormal(status?: 'not_organized' | 'scheduled' | 'completed', method = 'colonoscopy_10yr'): RoadmapFile {
    const file = record();
    file.screenings = {
      ...file.screenings, colorectalMethod: method, colorectalLastDate: '2026-09', colorectalResult: 'abnormal',
      colorectalFollowupStatus: status, colorectalFollowupDate: status === 'completed' ? '2026-10' : undefined,
    } as RoadmapFile['screenings'];
    return file;
  }
  const colonoscopy = (file: RoadmapFile, now = NOW) =>
    phoneReminders(file, new Date(now)).upcoming.find((i) => i.category === 'screening_colorectal');
  const fireDays = (out: ReturnType<typeof phoneReminders>) =>
    out.notifications.filter((n) => n.categories.includes('screening_colorectal')).map((n) => n.fireDay);

  it('names the card\'s follow-up in the app\'s list (drafts for Brad)', () => {
    expect(colonoscopy(abnormal())?.label).toBe('Follow-up to organize: repeat colonoscopy');
    expect(colonoscopy(abnormal('not_organized', 'fit_annual'))?.label).toBe('Follow-up to organize: colonoscopy');
    expect(colonoscopy(abnormal('scheduled'))?.label).toBe('Follow-up check-in: repeat colonoscopy');
    expect(colonoscopy(abnormal('completed'))?.label).toBe('Colonoscopy');
    expect(colonoscopy(record())?.label).toBe('Colonoscopy');
  });

  it('pushes the plain label to the web\'s schedule, with only the date moved', () => {
    expect(computeReminderSchedule(abnormal(), new Date(NOW)).find((i) => i.category === 'screening_colorectal'))
      .toEqual({ category: 'screening_colorectal', group: 'screening', label: 'Colonoscopy', dueAt: '2026-09-01' });
  });

  it('without first-seen days (an app before them) answers as before: repeats from the due day', () => {
    const out = phoneReminders(abnormal(), new Date('2026-11-05T08:00:00.000'));
    expect(out.firstSeen).toBeUndefined();
    expect(fireDays(out)[0]).toBe('2026-11-30'); // 2026-09-01 + 90 days
  });

  it('fires a follow-up to organize on the morning it is first seen, then every 90 days from it', () => {
    const first = phoneReminders(abnormal(), new Date('2026-11-05T08:00:00.000'), undefined, {});
    expect(first.firstSeen).toEqual({ 'screening_colorectal:organize': '2026-11-05' });
    expect(fireDays(first).slice(0, 2)).toEqual(['2026-11-05', '2027-02-03']);
    // Seen after 09:00: the next morning.
    expect(phoneReminders(abnormal(), new Date('2026-11-05T15:00:00.000'), undefined, {}).firstSeen)
      .toEqual({ 'screening_colorectal:organize': '2026-11-06' });
    // Kept and passed back, the days never move.
    for (const day of ['2026-11-06T08:00:00.000', '2026-11-07T20:00:00.000', '2027-01-10T08:00:00.000']) {
      const later = phoneReminders(abnormal(), new Date(day), undefined, first.firstSeen);
      expect(later.firstSeen).toEqual(first.firstSeen);
      expect(fireDays(later)).toContain('2027-02-03');
      expect(fireDays(later)[0] >= day.slice(0, 10)).toBe(true);
    }
  });

  it('a lost first-seen day (reinstall) fires once more, then holds', () => {
    const again = phoneReminders(abnormal(), new Date('2026-12-01T08:00:00.000'), undefined, {});
    expect(fireDays(again).slice(0, 2)).toEqual(['2026-12-01', '2027-03-01']);
    const next = phoneReminders(abnormal(), new Date('2026-12-02T08:00:00.000'), undefined, again.firstSeen);
    expect(fireDays(next).slice(0, 1)).toEqual(['2027-03-01']);
  });

  it('drops the entry once the item is no longer a follow-up', () => {
    const seen = { 'screening_colorectal:organize': '2026-11-05' };
    expect(phoneReminders(abnormal('completed'), new Date(NOW), undefined, seen).firstSeen).toEqual({});
    expect(phoneReminders(abnormal('scheduled'), new Date(NOW), undefined, seen).firstSeen)
      .toEqual({ 'screening_colorectal:checkin': '2026-10-21' });
  });

  it('keeps the check-in day across its morning: 23:00 the day before and 07:00 on the day', () => {
    const seen = phoneReminders(abnormal('scheduled'), new Date('2026-11-05T08:00:00.000'), undefined, {}).firstSeen;
    const eve = phoneReminders(abnormal('scheduled'), new Date('2026-11-30T23:00:00.000'), undefined, seen);
    const morning = phoneReminders(abnormal('scheduled'), new Date('2026-12-01T07:00:00.000'), undefined, seen);
    expect(fireDays(eve)[0]).toBe('2026-12-01');
    expect(fireDays(morning)).toEqual(fireDays(eve));
  });

  it('reads what the app keeps defensively: an unreadable entry counts as none kept', () => {
    const seen = (kept: string) => JSON.parse(remindersJson(JSON.stringify(abnormal()), '2026-11-05T08:00:00.000', 'phone', kept)).firstSeen;
    const fresh = { 'screening_colorectal:organize': '2026-11-05' };
    expect(seen('not json')).toEqual(fresh);
    expect(seen('[]')).toEqual(fresh);
    expect(seen('{"screening_colorectal:organize":"2026-99-99"}')).toEqual(fresh);
    expect(seen('{"screening_colorectal:organize":"2026-11-01"}')).toEqual({ 'screening_colorectal:organize': '2026-11-01' });
  });

  it('heals a kept first-seen day in the future (a clock that was set ahead) to this start day', () => {
    const ahead = { 'screening_colorectal:organize': '2027-01-01' };
    const out = phoneReminders(abnormal(), new Date('2026-11-05T08:00:00.000'), undefined, ahead);
    expect(out.firstSeen).toEqual({ 'screening_colorectal:organize': '2026-11-05' });
    expect(fireDays(out)[0]).toBe('2026-11-05');
    expect(phoneReminders(abnormal(), new Date('2026-11-05T15:00:00.000'), undefined, ahead).firstSeen)
      .toEqual({ 'screening_colorectal:organize': '2026-11-06' });
  });

  it('notifies at the same hour Swift schedules (ReminderScheduler.hour)', () => {
    const swift = readFileSync(join(__dirname, '../HealthRoadmap/Reminders/ReminderScheduler.swift'), 'utf8');
    expect(Number(swift.match(/static let hour = (\d+)/)?.[1])).toBe(NOTIFY_HOUR);
  });

  it('puts no words in the notifications: the lock screen\'s text is Swift\'s generic one', () => {
    expect(JSON.stringify(phoneReminders(abnormal(), new Date(NOW), undefined, {}).notifications)).not.toContain('ollow-up');
  });
});

describe('a raised PSA\'s repeat on the phone (US-06 AC21, screening Change 4)', () => {
  /** A 60-year-old man whose newest PSA is `value`, from 10 Apr 2026. */
  function psa(value: number, discussion?: string): RoadmapFile {
    const file = record();
    return {
      ...file,
      profile: { ...file.profile, sex: 'male' },
      screenings: { ...file.screenings, ...(discussion ? { prostateDiscussion: discussion } : {}) } as RoadmapFile['screenings'],
      measurements: [...file.measurements, {
        id: 'psa1', metricType: 'psa', value, recordedAt: '2026-04-10T00:00:00.000Z',
        createdAt: '2026-04-10T00:00:00.000Z', status: 'active',
      } as RoadmapFile['measurements'][number]],
    };
  }
  const prostate = (file: RoadmapFile) =>
    phoneReminders(file, new Date(NOW)).upcoming.find((i) => i.category === 'screening_prostate');

  it('names the 4.0-or-above case "Repeat PSA (your last result)" in the app\'s list, whatever the answer', () => {
    for (const d of [undefined, 'elected_not_to', 'will_screen']) {
      expect(prostate(psa(4.5, d)), String(d)).toMatchObject({ label: 'Repeat PSA (your last result)', dueAt: '2026-07-01' });
    }
  });

  it('a newer "< 5" after 4.5 keeps the item, under the plain label (AC21 item 6, review F4)', () => {
    for (const d of [undefined, 'elected_not_to', 'will_screen']) {
      const file = psa(4.5, d);
      file.measurements = [...file.measurements, { ...file.measurements.at(-1)!, id: 'psa2', value: 5, comparator: '<',
        recordedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z' } as RoadmapFile['measurements'][number]];
      expect(prostate(file), String(d)).toMatchObject({ label: 'PSA test', dueAt: '2026-09-01' });
    }
  });

  it('first-seen: a repeat already due notifies the morning the app first sees it, raised or vague newest (AC21 item 6, re-check R1)', () => {
    const vague = psa(4.5, 'elected_not_to');
    vague.measurements = [...vague.measurements, { ...vague.measurements.at(-1)!, id: 'psa2', value: 5, comparator: '<',
      recordedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z' } as RoadmapFile['measurements'][number]];
    const cases: Array<[string, RoadmapFile, string, string, string]> = [
      ['raised', psa(4.5, 'elected_not_to'), '2026-07-02', '2026-07-03', '2026-09-30'],
      ['vague', vague, '2026-09-02', '2026-09-03', '2026-12-01'],
    ];
    for (const [name, file, day, nextDay, step] of cases) {
      const days = (seen: Record<string, string>, at: string) => {
        const out = phoneReminders(file, new Date(`${at}T08:00:00.000`), undefined, seen);
        return { firstSeen: out.firstSeen, days: out.notifications.filter((n) => n.categories.includes('screening_prostate')).map((n) => n.fireDay) };
      };
      const first = days({}, day);
      expect(first.firstSeen, name).toEqual({ 'screening_prostate:repeat': day });
      expect(first.days.slice(0, 2), name).toEqual([day, step]);
      // The next launch keeps the entry and the same days.
      const next = days(first.firstSeen!, nextDay);
      expect(next.firstSeen, name).toEqual(first.firstSeen);
      expect(next.days[0], name).toBe(step);
    }
  });

  it('below 4.0 the list keeps the plain label; one who declined has no item', () => {
    expect(prostate(psa(3.0, 'will_screen'))).toMatchObject({ label: 'PSA test', dueAt: '2027-04-01' });
    expect(prostate(psa(3.0, 'elected_not_to'))).toBeUndefined();
  });

  it('outside the prostate ages a raised or vague PSA leaves no item, notification or first-seen entry (AC21, owner\'s check)', () => {
    // A woman of 60 and a man of 40 (below 45) fall outside; the prostate row has no upper age, so a man of 90 keeps it.
    const people: Array<[string, Partial<RoadmapFile['profile']>, boolean]> = [
      ['woman', { sex: 'female' }, false], ['man 40', { birthYear: 1986 }, false], ['man 90', { birthYear: 1936 }, true],
    ];
    for (const [who, profile, kept] of people) {
      for (const vague of [false, true]) {
        const file = psa(4.5, 'elected_not_to');
        file.profile = { ...file.profile, ...profile };
        if (vague) file.measurements = [...file.measurements, { ...file.measurements.at(-1)!, id: 'psa2', value: 5, comparator: '<',
          recordedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z' } as RoadmapFile['measurements'][number]];
        const name = `${who}${vague ? ', vague' : ''}`;
        const out = phoneReminders(file, new Date(NOW), undefined, {});
        const item = out.upcoming.find((i) => i.category === 'screening_prostate');
        const notified = out.notifications.some((n) => n.categories.includes('screening_prostate'));
        const seen = Object.keys(out.firstSeen!).filter((k) => k.startsWith('screening_prostate:'));
        if (kept) {
          expect(item, name).toMatchObject({ label: vague ? 'PSA test' : 'Repeat PSA (your last result)' });
          expect(notified, name).toBe(true);
          expect(seen, name).toEqual(['screening_prostate:repeat']);
        } else {
          expect(item, name).toBeUndefined();
          expect(notified, name).toBe(false);
          expect(seen, name).toEqual([]);
        }
      }
    }
  });

  it('pushes the plain label to the web\'s schedule', () => {
    expect(computeReminderSchedule(psa(4.5, 'elected_not_to'), new Date(NOW)).find((i) => i.category === 'screening_prostate'))
      .toEqual({ category: 'screening_prostate', group: 'screening', label: 'PSA test', dueAt: '2026-07-01' });
  });
});
