import { describe, expect, it } from 'vitest';
import { migrateFile } from './migrate';
import { createEmptyFile } from './roadmap-file';
import { computeReminderSchedule, computeNextDueDates } from './reminder-schedule';
import { computeDueReminders, MEDICATION_REVIEW_STALE_MONTHS } from './reminders';

const opts = { deviceId: 'synthetic', now: '2026-06-15T12:00:00Z' };
const now = new Date(opts.now);
const valid = { id: 'valid', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: null, doseUnit: null, updatedAt: '2025-01-15T03:00:00+02:00', future: { keep: true } };
function migrated(neighbor: unknown, includeValid = true) {
  const raw = { ...createEmptyFile(opts), profile: { sex: 'male', birthYear: 1966, updatedAt: opts.now }, medications: [...(includeValid ? [valid] : []), neighbor] };
  const bytes = JSON.stringify(raw);
  return { raw, bytes, file: migrateFile(JSON.parse(bytes), opts) };
}

// US-17 schedule contract / US-23 AC1, AC6: malformed neighbors must not
// suppress the known review date; unknown review-time policy is unchanged.
describe('medication review dates at the migrated-file boundary', () => {
  for (const updatedAt of ['', '0000-00-00', '2024-02-30T00:00:00Z', '2024-13-01', '!not-a-date', undefined, null, 42]) {
    it(`retains the valid 12-month review alongside ${String(updatedAt)}`, () => {
      const { raw, bytes, file } = migrated({ ...valid, id: 'unknown', medicationKey: 'glp1', updatedAt });
      const before = JSON.stringify(file);
      expect(computeReminderSchedule(file, now)).toEqual([
        { category: 'medication_review', group: 'medication_review', label: 'Medication review', dueAt: '2026-01-15' },
      ]);
      expect(file.medications[0]).toEqual(valid);
      expect(JSON.stringify(file)).toBe(before);
      expect(JSON.stringify(raw)).toBe(bytes);
    });

    it(`unknown-only ${String(updatedAt)} keeps only the annual floor without inventing a review date`, () => {
      const { file } = migrated({ ...valid, updatedAt }, false);
      const before = JSON.stringify(file);
      expect(computeReminderSchedule(file, now)).toEqual([
        { category: 'annual_checkin', group: 'annual', label: 'Annual health check-in', dueAt: '2027-06-15' },
      ]);
      expect(JSON.stringify(file)).toBe(before);
    });
  }

  it('selects the oldest valid active day, keeps v1 parity and the 12-month interval', () => {
    const meds = [
      { ...valid, updatedAt: '2026-01-15T00:00:00Z' }, valid,
      { ...valid, medicationKey: 'glp1', drugName: 'none', updatedAt: '2020-01-01T00:00:00Z' },
    ];
    expect(MEDICATION_REVIEW_STALE_MONTHS).toBe(12);
    const v2 = computeNextDueDates({ sex: 'male', age: 60 }, undefined, {}, meds);
    expect(v2).toEqual([{ category: 'medication_review', group: 'medication_review', label: 'Medication review', dueAt: '2026-01-15' }]);
    expect(computeDueReminders({ sex: 'male', age: 60 }, undefined, {}, meds, now).reminders.map((r) => r.category)).toContain('medication_review');
  });

  it('retains the annual floor alongside a valid review beyond its horizon', () => {
    const { file } = migrated({ ...valid, id: 'unknown', updatedAt: '' });
    file.medications[0].updatedAt = '2026-07-15T00:00:00Z';
    expect(computeReminderSchedule(file, now)).toEqual([
      { category: 'medication_review', group: 'medication_review', label: 'Medication review', dueAt: '2027-07-15' },
      { category: 'annual_checkin', group: 'annual', label: 'Annual health check-in', dueAt: '2027-06-15' },
    ]);
  });
});
