/**
 * US-10 AC8: last-write-wins picks the newest edit by clock time; the lamport
 * counter only breaks a tie in time. Before, the counter decided, so a device
 * offline for a while won with an older edit and silently put back the value
 * a newer edit had replaced.
 */
import { describe, it, expect } from 'vitest';
import { mergeFiles, stampFields } from './merge';
import { setReminderOptIn, upsertMedication } from './state-edits';
import {
  createEmptyFile,
  stableStringify,
  type FileMedication,
  type FileReminderOptIn,
  type RoadmapFile,
  type RoadmapProfile,
} from './roadmap-file';

const OPTS = { deviceId: 'dev_merge', now: '2026-06-08T12:00:00Z' };
const T1 = '2026-05-02T09:00:00Z';
const T2 = '2026-05-03T09:00:00Z';
const at = (lamport: number, updatedAt: string) => ({ lamport, updatedAt });

function file(): RoadmapFile {
  return createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' });
}

function med(drugName: string, lamport: number, updatedAt: string): FileMedication {
  return { id: 'med_statin', medicationKey: 'statin', drugName, doseValue: null, doseUnit: null, lamport, updatedAt };
}

/** Both merge orders, so every case also checks the merge is symmetric. */
function bothWays(a: RoadmapFile, b: RoadmapFile): RoadmapFile[] {
  return [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)];
}

describe('US-10 AC8: the newer edit by clock time wins; a higher counter does not', () => {
  it('a medication edited at t2 with a lower counter beats one edited at t1 with a higher counter', () => {
    const a = file(); // device A: offline a while, edited later
    const b = file(); // device B: synced often, edited earlier
    a.medications = [med('rosuvastatin', 1, T2)];
    b.medications = [med('atorvastatin', 7, T1)];
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe('rosuvastatin');
  });

  it('a supplement, a reminder preference and the reminders opt-in follow the same rule', () => {
    const a = file();
    const b = file();
    const supp = (status: 'active' | 'stopped', lamport: number, updatedAt: string) => ({
      id: 's_mv', supplementKey: 'microvitamin', supplementName: 'MicroVitamin', doseValue: null, doseUnit: null,
      status, startedAt: '2026-01-01', updatedAt, lamport,
    });
    a.supplements = [supp('stopped', 0, T2)];
    b.supplements = [supp('active', 9, T1)];
    a.reminderPreferences = [{ category: 'blood_test', enabled: false, updatedAt: T2, lamport: 0 }];
    b.reminderPreferences = [{ category: 'blood_test', enabled: true, updatedAt: T1, lamport: 4 }];
    const optIn = (status: string, lamport: number, updatedAt: string) =>
      ({ status, updatedAt, lamport } as unknown as FileReminderOptIn);
    a.reminderOptIn = optIn('unsubscribed', 1, T2);
    b.reminderOptIn = optIn('subscribed', 6, T1);
    for (const merged of bothWays(a, b)) {
      expect(merged.supplements[0].status).toBe('stopped');
      expect(merged.reminderPreferences[0].enabled).toBe(false);
      expect((merged.reminderOptIn as unknown as { status: string }).status).toBe('unsubscribed');
    }
  });

  it('a profile field and a screening answer stamped later win over ones with a higher counter', () => {
    const a = file();
    const b = file();
    a.profile = { heightCm: 181, updatedAt: T2, lamport: 2, fieldStamps: { heightCm: at(2, T2) } };
    b.profile = { heightCm: 182, updatedAt: T1, lamport: 8, fieldStamps: { heightCm: at(8, T1) } };
    a.screenings = { colorectalMethod: 'fit_annual', updatedAt: T2, lamport: 1, fieldStamps: { colorectalMethod: at(1, T2) } };
    b.screenings = { colorectalMethod: 'colonoscopy_10yr', updatedAt: T1, lamport: 9, fieldStamps: { colorectalMethod: at(9, T1) } };
    for (const merged of bothWays(a, b)) {
      expect(merged.profile.heightCm).toBe(181);
      expect(merged.profile.fieldStamps).toEqual({ heightCm: at(2, T2) });
      expect(merged.screenings.colorectalMethod).toBe('fit_annual');
    }
  });

  it('time is read as an instant, not as a string: an offset spelling of a later time wins', () => {
    const a = file();
    const b = file();
    // 2026-05-02T10:00+12:00 is 2026-05-01T22:00Z. Against 22:30Z the same
    // day it is the larger string but the earlier instant, so it loses.
    a.medications = [med('rosuvastatin', 9, '2026-05-02T10:00:00+12:00')];
    b.medications = [med('atorvastatin', 1, '2026-05-01T22:30:00Z')];
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe('atorvastatin');

    b.medications = [med('atorvastatin', 1, '2026-05-01T21:30:00Z')];
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe('rosuvastatin');
  });
});

describe('US-10 AC8: on a tie in time, the counter decides, then the old final tie-break', () => {
  it('equal times: the higher counter wins', () => {
    const a = file();
    const b = file();
    a.medications = [med('rosuvastatin', 2, T1)];
    b.medications = [med('atorvastatin', 5, T1)];
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe('atorvastatin');
    a.profile = { heightCm: 181, updatedAt: T1, lamport: 2, fieldStamps: { heightCm: at(2, T1) } };
    b.profile = { heightCm: 182, updatedAt: T1, lamport: 3, fieldStamps: { heightCm: at(3, T1) } };
    for (const merged of bothWays(a, b)) expect(merged.profile.heightCm).toBe(182);
  });

  it('two spellings of one instant are a tie in time, so the counter decides', () => {
    const a = file();
    const b = file();
    a.medications = [med('rosuvastatin', 2, '2026-05-02T21:00:00+12:00')]; // = T1
    b.medications = [med('atorvastatin', 5, T1)];
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe('atorvastatin');
    a.medications = [med('rosuvastatin', 6, '2026-05-02T21:00:00+12:00')];
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe('rosuvastatin');
  });

  it('equal time and counter: the existing content tie-break, the same on both sides', () => {
    const a = file();
    const b = file();
    a.medications = [med('rosuvastatin', 3, T1)];
    b.medications = [med('atorvastatin', 3, T1)];
    const expected = stableStringify(a.medications[0]) > stableStringify(b.medications[0]) ? 'rosuvastatin' : 'atorvastatin';
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe(expected);
    // Profile fields: the larger serialised value (50 beats 5), as before.
    a.profile = { v: 5, updatedAt: T1, lamport: 2, fieldStamps: { v: at(2, T1) } } as unknown as RoadmapProfile;
    b.profile = { v: 50, updatedAt: T1, lamport: 2, fieldStamps: { v: at(2, T1) } } as unknown as RoadmapProfile;
    for (const merged of bothWays(a, b)) expect((merged.profile as unknown as { v: number }).v).toBe(50);
  });

  it('an unknown time ("" after migrate, or one that does not parse) loses to any known time', () => {
    const a = file();
    const b = file();
    a.medications = [med('rosuvastatin', 9, '')];
    b.medications = [med('atorvastatin', 0, T1)];
    for (const merged of bothWays(a, b)) expect(merged.medications[0].drugName).toBe('atorvastatin');
  });
});

describe('US-10 AC8: current-state lists stay a join — commutative, associative, idempotent', () => {
  it('holds over thousands of seeded triples with mixed times, spellings and counters', () => {
    let seed = 20261022;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    // Few times, two spellings of one instant, an unknown time, small counters: ties are common.
    const TIMES = [T1, '2026-05-02T21:00:00+12:00', T2, '', '2026-05-02T09:00:00.000Z'];
    const KEYS = ['statin', 'metformin'];
    const DRUGS = ['a', 'b', 'c'];
    const copy = (): RoadmapFile => {
      const f = file();
      f.medications = KEYS.filter(() => rand() < 0.7).map((key) => ({
        id: `med_${key}`, medicationKey: key, drugName: pick(DRUGS), doseValue: null, doseUnit: null,
        lamport: Math.floor(rand() * 3), updatedAt: pick(TIMES),
      }));
      return f;
    };
    const merge = (x: RoadmapFile, y: RoadmapFile) => mergeFiles(x, y, OPTS);
    const key = (f: RoadmapFile) => stableStringify(f.medications);

    const failures: string[] = [];
    for (let run = 0; run < 3000; run++) {
      const [a, b, c] = [copy(), copy(), copy()];
      const ab = merge(a, b);
      const checks: Array<[string, string, string]> = [
        ['commutative', key(ab), key(merge(b, a))],
        ['associative (ab)c = a(bc)', key(merge(ab, c)), key(merge(a, merge(b, c)))],
        ['associative (ab)c = (ac)b', key(merge(ab, c)), key(merge(merge(a, c), b))],
        ['idempotent', key(merge(ab, ab)), key(ab)],
        ['absorbs', key(merge(ab, b)), key(ab)],
      ];
      for (const [law, x, y] of checks) {
        if (x !== y && failures.length < 3) failures.push(`${law}: ${JSON.stringify([a.medications, b.medications, c.medications])}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('US-10 AC8: a stamp from a clock running ahead does not win forever', () => {
  // A device whose clock read 2099 wrote these. The merge is pure (no `now`),
  // so it cannot tell that stamp from a genuine later edit; the guard is the
  // writer's: an edit stamps no earlier than the clock it replaces, and its
  // counter goes past it, so the next edit made after seeing the stamp wins.
  const FUTURE = '2099-01-01T00:00:00Z';
  const NOW = '2026-06-08T12:00:00Z';

  it('a profile field: the next edit, stamped at a real now, beats the future stamp it replaced', () => {
    const skewed = file();
    skewed.profile = stampFields(skewed.profile, { heightCm: 170 }, FUTURE);
    const seen = mergeFiles(file(), skewed, OPTS); // this device takes the skewed copy in
    const edited = { ...seen, profile: stampFields(seen.profile, { heightCm: 180 }, NOW) };
    for (const merged of bothWays(edited, skewed)) expect(merged.profile.heightCm).toBe(180);
  });

  it('a medication: the next edit beats the future stamp it replaced', () => {
    const skewed = file();
    skewed.medications = [med('atorvastatin', 0, FUTURE)];
    const edited = upsertMedication(skewed, { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' }, NOW).file;
    for (const merged of bothWays(edited, skewed)) expect(merged.medications[0].drugName).toBe('rosuvastatin');
  });

  it('the reminders opt-in: the next edit beats the future stamp it replaced', () => {
    const skewed = file();
    skewed.reminderOptIn = { status: 'subscribed', updatedAt: FUTURE, lamport: 3 } as unknown as FileReminderOptIn;
    const edited = setReminderOptIn(skewed, { status: 'unsubscribed' } as unknown as Omit<FileReminderOptIn, 'updatedAt' | 'lamport'>, NOW);
    for (const merged of bothWays(edited, skewed)) {
      expect((merged.reminderOptIn as unknown as { status: string }).status).toBe('unsubscribed');
    }
  });

  it('an edit made without seeing the future stamp still loses to it: the merge is pure, the residual stated', () => {
    const skewed = file();
    skewed.medications = [med('atorvastatin', 0, FUTURE)];
    const other = upsertMedication(file(), { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' }, NOW).file;
    for (const merged of bothWays(other, skewed)) expect(merged.medications[0].drugName).toBe('atorvastatin');
  });
});
