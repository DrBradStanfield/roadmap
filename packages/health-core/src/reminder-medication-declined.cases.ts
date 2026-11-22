/**
 * US-23 AC17 (Brad 2026-11-23: "yes"): a medicine the person declined ("No")
 * or could not tolerate ("Not tolerated") comes up in the existing 12-month
 * "Medication review". Shared by the UTC and Pacific/Auckland test files, so
 * the UTC-month rule (AC6b) holds in both.
 */
import { describe, expect, it } from 'vitest';
import { computeReminderSchedule, SCHEDULE_LABELS } from './reminder-schedule';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

// 12:00 UTC is already the next day in Auckland, so a local getter would show.
const NOW = new Date('2026-11-23T12:00:00Z');
const FLOOR = { category: 'annual_checkin', group: 'annual', label: 'Annual health check-in', dueAt: '2027-11-23' };
const review = (dueAt: string) => ({ category: 'medication_review', group: 'medication_review', label: 'Medication review', dueAt });

type Med = [medicationKey: string, drugName: string, updatedAt: string];
function fileWith(meds: Med[], optOut = false): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'medreview_test', now: '2025-01-01T00:00:00Z' });
  return {
    ...f,
    profile: { ...f.profile, birthYear: 1970 },
    medications: meds.map(([medicationKey, drugName, updatedAt], i) => ({
      id: `m${i}`, medicationKey, drugName, doseValue: null, doseUnit: null, updatedAt, lamport: i + 1,
    })),
    reminderPreferences: optOut ? [{ category: 'medication_review', enabled: false, updatedAt: '2025-01-01T00:00:00Z', lamport: 1 }] : [],
  };
}
const schedule = (meds: Med[], optOut = false) => computeReminderSchedule(fileWith(meds, optOut), NOW);

export function declinedMedicationReviewCases(zone: string): void {
  describe(`US-23 AC17: a declined medicine is reviewed 12 months after the answer (${zone})`, () => {
    it('"No" on metformin answered 13 months ago: a Medication review due at the answer + 12 months', () => {
      expect(schedule([['metformin', 'no', '2025-10-23T12:00:00Z']])).toEqual([review('2026-10-23')]);
    });

    it('"No" on metformin answered 2 months ago: due in 10 months', () => {
      expect(schedule([['metformin', 'no', '2026-09-23T12:00:00Z']])).toEqual([review('2027-09-23')]);
    });

    it.each([['metformin', 'none'], ['glp1', 'none'], ['ezetimibe', 'not_yet'], ['pcsk9i', 'not_yet'], ['bempedoic_acid', 'not_yet']])(
      '"Haven\'t tried yet" (%s %s) decides nothing: no review, only the annual floor', (key, value) => {
        expect(schedule([[key, value, '2025-10-23T12:00:00Z']])).toEqual([FLOOR]);
      });

    it.each([
      ['ezetimibe', 'no'], ['pcsk9i', 'no'], ['glp1', 'no'], ['sglt2i', 'no'],
      ['statin', 'not_tolerated'], ['ezetimibe', 'not_tolerated'], ['pcsk9i', 'not_tolerated'], ['bempedoic_acid', 'not_tolerated'],
      ['glp1', 'not_tolerated'], ['sglt2i', 'not_tolerated'], ['metformin', 'not_tolerated'],
    ])('%s "%s" behaves as metformin "No"', (key, value) => {
      expect(schedule([[key, value, '2025-10-23T12:00:00Z']])).toEqual([review('2026-10-23')]);
    });

    it('a taker plus a later decline: the existing review date is unchanged', () => {
      const taker: Med = ['statin', 'atorvastatin', '2025-06-01T12:00:00Z'];
      expect(schedule([taker])).toEqual([review('2026-06-01')]);
      expect(schedule([taker, ['metformin', 'no', '2026-01-10T12:00:00Z']])).toEqual([review('2026-06-01')]);
    });

    it('several declines give ONE review, 12 months after the oldest answer', () => {
      expect(schedule([['metformin', 'no', '2026-01-10T12:00:00Z'], ['ezetimibe', 'no', '2025-03-05T12:00:00Z']]))
        .toEqual([review('2026-03-05')]);
    });

    it('"Medication review reminders" turned off: no review item', () => {
      expect(schedule([['metformin', 'no', '2025-10-23T12:00:00Z']], true)).toEqual([FLOOR]);
    });

    it('an escalation answer is still no medicine (US-06 AC11): "Not tolerated" there schedules no review', () => {
      expect(schedule([['statin_escalation', 'not_tolerated', '2025-10-23T12:00:00Z']])).toEqual([FLOOR]);
    });

    it('privacy: the stored row is a taker\'s in shape: the same four keys, the one allow-listed label', () => {
      const [declined] = schedule([['metformin', 'no', '2025-10-23T12:00:00Z']]);
      const [taken] = schedule([['metformin', 'xr_1000', '2025-10-23T12:00:00Z']]);
      expect(declined).toEqual(taken);
      expect(Object.keys(declined).sort()).toEqual(['category', 'dueAt', 'group', 'label']);
      expect(SCHEDULE_LABELS.medication_review).toEqual([declined.label]);
    });
  });
}
