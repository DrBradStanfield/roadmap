import { describe, it, expect } from 'vitest';
import { baseIdOf, mergeFiles, rootIdOf, rowRootIds, stampFields } from './merge';
import { migrateFile } from './migrate';
import {
  createEmptyFile,
  stableStringify,
  type RoadmapFile,
  type FileMeasurement,
  type FileMedication,
  type FileSupplement,
  type FileReminderPreference,
  type FileLabValue,
  type FileDocument,
  type RoadmapProfile,
} from './roadmap-file';

const OPTS = { deviceId: 'dev_merge', now: '2026-06-08T12:00:00Z' };

function emptyFile(): RoadmapFile {
  return createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' });
}

function measurement(p: Partial<FileMeasurement> & { id: string; metricType: string; value: number }): FileMeasurement {
  return {
    recordedAt: '2026-05-01',
    createdAt: '2026-05-01T08:00:00Z',
    source: 'manual',
    status: 'active',
    correctsId: null,
    externalId: null,
    ...p,
  };
}

function activeMeasurements(file: RoadmapFile): FileMeasurement[] {
  return file.measurements.filter((m) => m.status === 'active');
}

describe('mergeFiles — meta + lamport', () => {
  it('bumps lamport to max(local, remote) + 1', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.lamport = 4;
    b.meta.lamport = 7;
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.meta.lamport).toBe(8);
    expect(merged.meta.lastDeviceId).toBe('dev_merge');
    expect(merged.meta.updatedAt).toBe(OPTS.now);
  });

  // The merged meta.updatedAt is the anchor migrate clamps every row clock to
  // on the next load. A device with a backwards wall clock would otherwise
  // write a file whose own rows post-date its meta — and rewrite them all.
  it('never rewinds meta.updatedAt behind either input', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.updatedAt = '2026-07-01T00:00:00Z';
    b.meta.updatedAt = '2026-06-20T00:00:00Z';
    expect(mergeFiles(a, b, OPTS).meta.updatedAt).toBe('2026-07-01T00:00:00Z');
    expect(mergeFiles(b, a, OPTS).meta.updatedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('keeps the earliest createdAt', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.createdAt = '2026-03-01T00:00:00Z';
    b.meta.createdAt = '2026-01-15T00:00:00Z';
    expect(mergeFiles(a, b, OPTS).meta.createdAt).toBe('2026-01-15T00:00:00Z');
  });

  it('two empties merge to an empty record', () => {
    const merged = mergeFiles(emptyFile(), emptyFile(), OPTS);
    expect(merged.measurements).toEqual([]);
    expect(merged.medications).toEqual([]);
    expect(merged.recommendationSnapshots).toEqual([]);
  });
});

describe('mergeFiles — measurements: same-day double entry (the headline case)', () => {
  it('keeps the newer same-day value active, demotes the older to entered-in-error (no loss)', () => {
    const a = emptyFile();
    const b = emptyFile();
    // Two devices each entered an LDL for the SAME day — different ids, same slot.
    a.measurements = [
      measurement({ id: 'm_A', metricType: 'ldl', value: 2.1, createdAt: '2026-05-01T08:00:00Z' }),
    ];
    b.measurements = [
      measurement({ id: 'm_B', metricType: 'ldl', value: 2.3, createdAt: '2026-05-01T09:30:00Z' }),
    ];
    const merged = mergeFiles(a, b, OPTS);

    // Both rows survive (nothing deleted)...
    expect(merged.measurements).toHaveLength(2);
    // ...but exactly one is active, and it's the newer one.
    const actives = activeMeasurements(merged);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe('m_B');
    expect(actives[0].value).toBe(2.3);
    // The older one is preserved as entered-in-error.
    const older = merged.measurements.find((m) => m.id === 'm_A')!;
    expect(older.status).toBe('entered-in-error');
  });

  it('treats date-only and datetime recordedAt on the same day as the same slot', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'm_A', metricType: 'ldl', value: 2.1, recordedAt: '2026-05-01' })];
    b.measurements = [
      measurement({ id: 'm_B', metricType: 'ldl', value: 2.3, recordedAt: '2026-05-01T23:59:00Z', createdAt: '2026-05-02T00:00:00Z' }),
    ];
    expect(activeMeasurements(mergeFiles(a, b, OPTS))).toHaveLength(1);
  });

  it('unions genuinely different slots (different day or different metric)', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [
      measurement({ id: 'm_A', metricType: 'ldl', value: 2.1, recordedAt: '2026-05-01' }),
    ];
    b.measurements = [
      measurement({ id: 'm_B', metricType: 'ldl', value: 2.3, recordedAt: '2026-06-01' }), // diff day
      measurement({ id: 'm_C', metricType: 'hba1c', value: 35, recordedAt: '2026-05-01' }), // diff metric
    ];
    const merged = mergeFiles(a, b, OPTS);
    expect(activeMeasurements(merged)).toHaveLength(3);
  });
});

describe('mergeFiles — corrections (correctsId chains)', () => {
  it('preserves a correction chain seen by only one device', () => {
    const a = emptyFile();
    const b = emptyFile();
    // Device A corrected an LDL: R1 -> entered-in-error, R2 active (corrects R1).
    a.measurements = [
      measurement({ id: 'R1', metricType: 'ldl', value: 2.1, status: 'entered-in-error', createdAt: '2026-05-01T08:00:00Z' }),
      measurement({ id: 'R2', metricType: 'ldl', value: 2.5, status: 'active', correctsId: 'R1', createdAt: '2026-05-02T08:00:00Z' }),
    ];
    // Device B still has the pre-correction view: R1 active.
    b.measurements = [
      measurement({ id: 'R1', metricType: 'ldl', value: 2.1, status: 'active', createdAt: '2026-05-01T08:00:00Z' }),
    ];
    const merged = mergeFiles(a, b, OPTS);

    // Monotonic status: R1 is entered-in-error even though device B had it active.
    const r1 = merged.measurements.find((m) => m.id === 'R1')!;
    expect(r1.status).toBe('entered-in-error');
    const actives = activeMeasurements(merged);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe('R2');
  });

  it('correction race: two devices correct the same original — exactly one active survives', () => {
    const a = emptyFile();
    const b = emptyFile();
    // Both devices independently corrected R1.
    a.measurements = [
      measurement({ id: 'R1', metricType: 'ldl', value: 2.1, status: 'entered-in-error', createdAt: '2026-05-01T08:00:00Z' }),
      measurement({ id: 'R2a', metricType: 'ldl', value: 2.4, status: 'active', correctsId: 'R1', createdAt: '2026-05-02T08:00:00Z' }),
    ];
    b.measurements = [
      measurement({ id: 'R1', metricType: 'ldl', value: 2.1, status: 'entered-in-error', createdAt: '2026-05-01T08:00:00Z' }),
      measurement({ id: 'R2b', metricType: 'ldl', value: 2.6, status: 'active', correctsId: 'R1', createdAt: '2026-05-03T08:00:00Z' }),
    ];
    const merged = mergeFiles(a, b, OPTS);

    expect(merged.measurements).toHaveLength(3); // R1, R2a, R2b all preserved
    const actives = activeMeasurements(merged);
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe('R2b'); // newer createdAt wins
    expect(merged.measurements.find((m) => m.id === 'R2a')!.status).toBe('entered-in-error');
  });

  it('status flips are monotonic regardless of merge direction', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 2.1, status: 'active' })];
    b.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 2.1, status: 'entered-in-error' })];
    expect(mergeFiles(a, b, OPTS).measurements[0].status).toBe('entered-in-error');
    expect(mergeFiles(b, a, OPTS).measurements[0].status).toBe('entered-in-error');
  });
});

describe('mergeFiles — labValues slot resolution (keyed by metricName)', () => {
  function labValue(p: Partial<FileLabValue> & { id: string; metricName: string; value: number }): FileLabValue {
    return {
      unit: 'ng/mL',
      referenceLow: null,
      referenceHigh: null,
      recordedAt: '2026-05-01',
      createdAt: '2026-05-01T08:00:00Z',
      source: 'lab_import',
      status: 'active',
      correctsId: null,
      ...p,
    };
  }
  it('resolves same-day same-name lab values to one active', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.labValues = [labValue({ id: 'l_A', metricName: 'ferritin', value: 100, createdAt: '2026-05-01T08:00:00Z' })];
    b.labValues = [labValue({ id: 'l_B', metricName: 'ferritin', value: 120, createdAt: '2026-05-01T10:00:00Z' })];
    const merged = mergeFiles(a, b, OPTS);
    const actives = merged.labValues.filter((l) => l.status === 'active');
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe('l_B');
  });

  it('slots spelling variants of one test together (US-03 AC3 / US-10)', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.labValues = [labValue({ id: 'l_A', metricName: 'vitamin d', value: 80, recordedAt: '2026-08-14', createdAt: '2026-08-14T08:00:00Z' })];
    b.labValues = [labValue({ id: 'l_B', metricName: 'vitamin_d', value: 88, recordedAt: '2026-08-14', createdAt: '2026-08-14T10:00:00Z' })];
    const merged = mergeFiles(a, b, OPTS);

    expect(merged.labValues.map((l) => l.id).sort()).toEqual(['l_A', 'l_B']);
    const actives = merged.labValues.filter((l) => l.status === 'active');
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe('l_B');
    expect(merged.labValues.find((l) => l.id === 'l_A')!.status).toBe('entered-in-error');
  });

  it('leaves spelling variants on different days both active', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.labValues = [labValue({ id: 'l_A', metricName: 'Vitamin D', value: 80, recordedAt: '2026-08-14' })];
    b.labValues = [labValue({ id: 'l_B', metricName: 'vitamin_d', value: 88, recordedAt: '2026-08-15' })];
    const merged = mergeFiles(a, b, OPTS);

    expect(merged.labValues.filter((l) => l.status === 'active')).toHaveLength(2);
  });
});

describe('mergeFiles — current-state by logical clock (skew-proof LWW)', () => {
  function med(p: Partial<FileMedication> & { medicationKey: string; drugName: string; lamport: number; updatedAt: string }): FileMedication {
    return { id: `med_${p.medicationKey}`, doseValue: null, doseUnit: null, ...p };
  }

  it('different medication keys from two devices are both preserved', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.medications = [med({ medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg', lamport: 3, updatedAt: '2026-05-01T00:00:00Z' })];
    b.medications = [med({ medicationKey: 'metformin', drugName: 'ir_1000', lamport: 2, updatedAt: '2026-05-02T00:00:00Z' })];
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.medications.map((m) => m.medicationKey).sort()).toEqual(['metformin', 'statin']);
  });

  it('same key: higher lamport wins EVEN IF its wall-clock is older (clock skew)', () => {
    const a = emptyFile();
    const b = emptyFile();
    // Device A has a fast clock (later updatedAt) but is causally OLDER (lower lamport).
    a.medications = [med({ medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', lamport: 2, updatedAt: '2026-05-09T00:00:00Z' })];
    b.medications = [med({ medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg', lamport: 5, updatedAt: '2026-05-01T00:00:00Z' })];
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.medications).toHaveLength(1);
    expect(merged.medications[0].drugName).toBe('rosuvastatin'); // higher lamport wins despite older clock
  });

  it('falls back to updatedAt when lamports tie', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.medications = [med({ medicationKey: 'statin', drugName: 'atorvastatin', lamport: 5, updatedAt: '2026-05-09T00:00:00Z' })];
    b.medications = [med({ medicationKey: 'statin', drugName: 'rosuvastatin', lamport: 5, updatedAt: '2026-05-01T00:00:00Z' })];
    expect(mergeFiles(a, b, OPTS).medications[0].drugName).toBe('atorvastatin');
  });

  it('merges supplements by supplementKey and reminderPreferences by category', () => {
    const a = emptyFile();
    const b = emptyFile();
    const supp = (k: string, status: 'active' | 'stopped', lamport: number): FileSupplement => ({
      id: `s_${k}`, supplementKey: k, supplementName: k, doseValue: null, doseUnit: null, status, startedAt: '2026-01-01', updatedAt: '2026-05-01T00:00:00Z', lamport,
    });
    a.supplements = [supp('microvitamin', 'active', 1)];
    b.supplements = [supp('microvitamin', 'stopped', 4), supp('omega3', 'active', 2)];
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.supplements.find((s) => s.supplementKey === 'microvitamin')!.status).toBe('stopped');
    expect(merged.supplements).toHaveLength(2);

    const pref = (c: string, enabled: boolean, lamport: number): FileReminderPreference => ({ category: c, enabled, updatedAt: '2026-05-01T00:00:00Z', lamport });
    a.reminderPreferences = [pref('blood_test', true, 1)];
    b.reminderPreferences = [pref('blood_test', false, 3)];
    expect(mergeFiles(a, b, OPTS).reminderPreferences[0].enabled).toBe(false);
  });
});

describe('mergeFiles — singletons (profile, screenings)', () => {
  it('profile: higher lamport wins', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.profile = { sex: 'male', heightCm: 180, updatedAt: '2026-05-01T00:00:00Z', lamport: 2 };
    b.profile = { sex: 'male', heightCm: 181, updatedAt: '2026-04-01T00:00:00Z', lamport: 5 };
    expect(mergeFiles(a, b, OPTS).profile.heightCm).toBe(181);
  });

  it('screenings: higher lamport wins', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.screenings = { colorectalMethod: 'fit_annual', updatedAt: '2026-05-01T00:00:00Z', lamport: 1 };
    b.screenings = { colorectalMethod: 'colonoscopy_10yr', updatedAt: '2026-04-01T00:00:00Z', lamport: 9 };
    expect(mergeFiles(a, b, OPTS).screenings.colorectalMethod).toBe('colonoscopy_10yr');
  });
});

/** A field's clock, in the shape the file stores it. */
const at = (lamport: number, updatedAt: string) => ({ lamport, updatedAt });
const T0 = '2026-05-01T00:00:00Z'; // the copy both devices read
const T1 = '2026-05-02T09:00:00Z'; // B's write
const T2 = '2026-05-02T09:05:00Z'; // A's write, later, made without seeing B's

// US-10 AC6: the newest edit to ONE field used to carry its writer's copy of
// every other field, because the two singletons merged as whole objects.
describe('mergeFiles — profile and screenings merge field by field (US-10 AC6)', () => {
  it('B saves a height, then stale A saves a birth year: both survive, whichever side merges', () => {
    const a = emptyFile();
    const b = emptyFile();
    b.profile = {
      sex: 'male', heightCm: 180, birthYear: 1971, updatedAt: T1, lamport: 2,
      fieldStamps: { sex: at(1, T0), heightCm: at(2, T1), birthYear: at(1, T0) },
    };
    a.profile = {
      sex: 'male', heightCm: 178, birthYear: 1972, updatedAt: T2, lamport: 2,
      fieldStamps: { sex: at(1, T0), heightCm: at(1, T0), birthYear: at(2, T2) },
    };
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.profile).toMatchObject({ sex: 'male', heightCm: 180, birthYear: 1972 });
      // The object's own stamp is the newer of the two; each field keeps its winner's.
      expect(merged.profile).toMatchObject({ updatedAt: T2, lamport: 2 });
      expect(merged.profile.fieldStamps).toEqual({ sex: at(1, T0), heightCm: at(2, T1), birthYear: at(2, T2) });
    }
  });

  it('two devices answer different screening questions: both answers survive', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.screenings = { colorectalMethod: 'fit_annual', updatedAt: T1, lamport: 1, fieldStamps: { colorectalMethod: at(1, T1) } };
    b.screenings = { breastFrequency: 'biennial', updatedAt: T2, lamport: 1, fieldStamps: { breastFrequency: at(1, T2) } };
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.screenings).toMatchObject({ colorectalMethod: 'fit_annual', breastFrequency: 'biennial' });
    }
  });

  it('the same field changed on both: the newer stamp wins, by lamport first, then by time', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.profile = { heightCm: 181, updatedAt: T2, lamport: 2, fieldStamps: { heightCm: at(2, T2) } };
    b.profile = { heightCm: 182, updatedAt: T1, lamport: 3, fieldStamps: { heightCm: at(3, T1) } };
    expect(mergeFiles(a, b, OPTS).profile.heightCm).toBe(182);
    expect(mergeFiles(b, a, OPTS).profile.heightCm).toBe(182);

    b.profile = { heightCm: 182, updatedAt: T1, lamport: 2, fieldStamps: { heightCm: at(2, T1) } };
    expect(mergeFiles(a, b, OPTS).profile.heightCm).toBe(181);
    expect(mergeFiles(b, a, OPTS).profile.heightCm).toBe(181);
  });

  it('two copies from before field stamps merge field by field: the union, the newer value where both hold one', () => {
    // Before 2026-09-26 the newer object won whole, which made the result
    // depend on merge order once a stamped third copy met them.
    const cases: Array<[RoadmapFile['profile'], RoadmapFile['profile'], RoadmapFile['profile']]> = [
      // Higher lamport, even with the older time.
      [{ heightCm: 180, birthYear: 1971, updatedAt: T2, lamport: 2 }, { heightCm: 181, updatedAt: T1, lamport: 5 },
        { heightCm: 181, birthYear: 1971, updatedAt: T1, lamport: 5, fieldStamps: { heightCm: at(5, T1), birthYear: at(2, T2) } }],
      // Tied lamport: the later time.
      [{ heightCm: 180, birthYear: 1971, updatedAt: T2, lamport: 2 }, { heightCm: 181, updatedAt: T1, lamport: 2 },
        { heightCm: 180, birthYear: 1971, updatedAt: T2, lamport: 2, fieldStamps: { heightCm: at(2, T2), birthYear: at(2, T2) } }],
      // Tied stamps: the larger value, the tiebreak `stampIsNewer` always had.
      [{ heightCm: 180, updatedAt: T1, lamport: 2 }, { heightCm: 181, updatedAt: T1, lamport: 2 },
        { heightCm: 181, updatedAt: T1, lamport: 2, fieldStamps: { heightCm: at(2, T1) } }],
    ];
    for (const [pa, pb, expected] of cases) {
      const a = emptyFile();
      const b = emptyFile();
      a.profile = pa;
      b.profile = pb;
      a.screenings = { breastFrequency: 'annual', updatedAt: pa.updatedAt, lamport: pa.lamport };
      b.screenings = { colorectalMethod: 'fit_annual', updatedAt: pb.updatedAt, lamport: pb.lamport };
      for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
        expect(merged.profile).toStrictEqual(expected);
        expect(merged.screenings).toMatchObject({ breastFrequency: 'annual', colorectalMethod: 'fit_annual' });
      }
    }
  });

  it('a copy from before field stamps against a stamped one: every field of the old copy carries its object stamp', () => {
    const a = emptyFile(); // an older app's whole-profile write: it changed the birth year
    const b = emptyFile(); // this app changed the height, stamping that field alone
    a.profile = { sex: 'male', heightCm: 178, birthYear: 1972, updatedAt: T2, lamport: 2 };
    b.profile = {
      sex: 'male', heightCm: 180, birthYear: 1971, updatedAt: T1, lamport: 3,
      fieldStamps: { sex: at(1, T0), heightCm: at(3, T1), birthYear: at(1, T0) },
    };
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.profile).toMatchObject({ sex: 'male', heightCm: 180, birthYear: 1972, lamport: 3 });
    }

    // The residual, stated: an old copy stamped after the height was changed
    // takes the height too, as the whole-object merge always did.
    a.profile.lamport = 4;
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.profile).toMatchObject({ heightCm: 178, birthYear: 1972, lamport: 4 });
    }
  });

  it('a stamped copy an older app wrote over merges as that app\'s whole-object write', () => {
    // The older app changed the birth year in place, moved the object's stamp,
    // and left the field stamps as it found them. Read at face value they would
    // hand its edit the stale birthYear stamp, which ties with the other copy's
    // and loses on content.
    const a = emptyFile();
    const b = emptyFile();
    a.profile = {
      sex: 'male', heightCm: 178, birthYear: 1970, updatedAt: T2, lamport: 2,
      fieldStamps: { sex: at(1, T0), heightCm: at(1, T0), birthYear: at(1, T0) },
    };
    b.profile = {
      sex: 'male', heightCm: 180, birthYear: 1971, updatedAt: T1, lamport: 2,
      fieldStamps: { sex: at(1, T0), heightCm: at(2, T1), birthYear: at(1, T0) },
    };
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.profile).toMatchObject({ birthYear: 1970, heightCm: 178 });
      // Stamped at the older app's own stamp, so the next merge reads it the same way.
      expect(merged.profile.fieldStamps).toMatchObject({ birthYear: at(2, T2), heightCm: at(2, T2) });
    }
  });

  it('three devices converge whatever order they merge in, and a merge of a merge changes nothing', () => {
    const base = emptyFile();
    base.profile = { sex: 'female', heightCm: 165, birthYear: 1980, updatedAt: T0, lamport: 1 };
    const one = structuredClone(base);
    one.profile = stampFields(one.profile, { heightCm: 166 }, '2026-05-03T00:00:00Z');
    one.screenings = stampFields(one.screenings, { colorectalMethod: 'fit_annual' }, '2026-05-03T00:00:00Z');
    const two = structuredClone(base);
    two.profile = stampFields(two.profile, { birthYear: 1981, birthMonth: 4 }, '2026-05-04T00:00:00Z');
    two.screenings = stampFields(two.screenings, { colorectalMethod: 'colonoscopy_10yr', breastFrequency: 'annual' }, '2026-05-02T00:00:00Z');
    const three = structuredClone(base);
    three.profile = stampFields(stampFields(three.profile, { heightCm: 167 }, '2026-05-01T12:00:00Z'), { sex: 'male' }, '2026-05-05T00:00:00Z');

    const singletons = (f: RoadmapFile) => stableStringify({ profile: f.profile, screenings: f.screenings });
    const orders = [[one, two, three], [three, two, one], [two, three, one], [one, three, two]];
    const results = orders.map(([x, y, z]) => mergeFiles(mergeFiles(x, y, OPTS), z, OPTS));
    for (const result of results) expect(singletons(result)).toBe(singletons(results[0]));

    const merged = results[0];
    // Both heights sit at lamport 2; device one's was written later.
    expect(merged.profile).toMatchObject({ sex: 'male', heightCm: 166, birthYear: 1981, birthMonth: 4 });
    expect(merged.screenings).toMatchObject({ colorectalMethod: 'fit_annual', breastFrequency: 'annual' });
    for (const input of [one, two, three, merged]) {
      expect(singletons(mergeFiles(merged, input, OPTS))).toBe(singletons(merged));
    }
  });
});

// US-10 AC6: the merge read an unstamped or stale copy's clock for fields it
// did not hold, and forgot or kept that absence differently depending on which
// copies met first. Found by Codex and a fuzz of three-copy merge orders.
describe('mergeFiles — the per-field merge gives one answer in any order (US-10 AC6)', () => {
  const profileOf = (profile: Record<string, unknown>): RoadmapFile => {
    const file = emptyFile();
    file.profile = profile as unknown as RoadmapProfile;
    return file;
  };
  const orders = (a: RoadmapFile, b: RoadmapFile, c: RoadmapFile) => [
    mergeFiles(mergeFiles(a, b, OPTS), c, OPTS),
    mergeFiles(mergeFiles(a, c, OPTS), b, OPTS),
    mergeFiles(a, mergeFiles(b, c, OPTS), OPTS),
    mergeFiles(mergeFiles(c, b, OPTS), a, OPTS),
  ].map((merged) => stableStringify(merged.profile));

  it('Codex\'s case: an unstamped copy\'s clock never reaches a field it does not hold', () => {
    const a = profileOf({ heightCm: 180, updatedAt: T0, lamport: 2 });
    const b = profileOf({ heightCm: 181, updatedAt: T1, lamport: 3, fieldStamps: { heightCm: at(3, T1) } });
    const c = profileOf({ birthYear: 1970, updatedAt: T0, lamport: 1, fieldStamps: { birthYear: at(1, T0) } });
    const results = orders(a, b, c);
    for (const result of results) expect(result).toBe(results[0]);
    expect(mergeFiles(mergeFiles(a, c, OPTS), b, OPTS).profile).toMatchObject({ heightCm: 181, birthYear: 1970 });
  });

  it('two unstamped copies tied on both clocks, then a stamped third: one answer', () => {
    const a = profileOf({ heightCm: 180, birthYear: 1970, updatedAt: T1, lamport: 2 });
    const b = profileOf({ heightCm: 181, updatedAt: T1, lamport: 2 });
    const c = profileOf({ sex: 'male', updatedAt: T0, lamport: 1, fieldStamps: { sex: at(1, T0) } });
    const results = orders(a, b, c);
    for (const result of results) expect(result).toBe(results[0]);
    // The tied height falls to the larger value; the birth year only one holds.
    expect(mergeFiles(mergeFiles(a, b, OPTS), c, OPTS).profile).toMatchObject({ heightCm: 181, birthYear: 1970, sex: 'male' });
  });
});

// US-10 AC6, US-29: null is how a field is cleared (agent-access rule 13), and
// the app writes one for a blank numeric screening answer.
describe('mergeFiles — a cleared field is a write like any other (US-10 AC6)', () => {
  const cleared = null as unknown as number;
  it('a later null beats an older value, a later value beats an older null, and a cleared field survives a re-merge', () => {
    const base = emptyFile();
    base.profile = stampFields(base.profile, { heightCm: 178 }, T0);
    base.screenings = stampFields(base.screenings, { lungPackYears: 20 }, T0);
    const clearer = structuredClone(base);
    clearer.profile = stampFields(clearer.profile, { heightCm: cleared }, T1);
    clearer.screenings = stampFields(clearer.screenings, { lungPackYears: cleared }, T1);
    for (const merged of [mergeFiles(clearer, base, OPTS), mergeFiles(base, clearer, OPTS)]) {
      expect(merged.profile.heightCm).toBeNull();
      expect(merged.screenings.lungPackYears).toBeNull();
      // Survives a re-merge with the older value, read back off disk.
      const again = mergeFiles(JSON.parse(JSON.stringify(merged)) as RoadmapFile, base, OPTS);
      expect(again.profile.heightCm).toBeNull();
      expect(again.screenings.lungPackYears).toBeNull();
    }

    const refill = structuredClone(clearer);
    refill.profile = stampFields(refill.profile, { heightCm: 180 }, T2);
    for (const merged of [mergeFiles(refill, clearer, OPTS), mergeFiles(clearer, refill, OPTS)]) {
      expect(merged.profile.heightCm).toBe(180);
    }
  });
});

// US-10 AC6: the empty record `createEmptyFile` makes for a MISSING file stamps
// its profile and screenings now. A tab or device that made a removed file
// again merged that empty object over its own copy, and where the copy's
// lamport was 0 or absent the fresh stamp won and emptied it.
describe('mergeFiles — a profile or screenings that holds no field never wins (US-10 AC6)', () => {
  const LATER = '2026-06-08T12:00:00Z';
  const blank = () => createEmptyFile({ deviceId: 'dev_new', now: LATER });

  it('a copy with no lamport, or lamport 0, survives the empty record made for a missing file', () => {
    const legacy = emptyFile();
    legacy.profile = { sex: 'male', heightCm: 178, updatedAt: T0 };
    legacy.screenings = { colorectalMethod: 'colonoscopy_10yr', updatedAt: T0, lamport: 0 };
    for (const merged of [mergeFiles(legacy, blank(), OPTS), mergeFiles(blank(), legacy, OPTS)]) {
      // Unchanged, stamp included; each field now records the stamp it carried.
      expect(merged.profile).toStrictEqual({
        ...legacy.profile, lamport: 0, fieldStamps: { sex: at(0, T0), heightCm: at(0, T0) },
      });
      expect(merged.screenings).toStrictEqual({ ...legacy.screenings, fieldStamps: { colorectalMethod: at(0, T0) } });
    }
  });

  it('a stamped copy comes back unchanged, its own stamp and field stamps included', () => {
    const stamped = emptyFile();
    stamped.profile = stampFields<RoadmapProfile>({ sex: 'female', updatedAt: T0, lamport: 0 }, { heightCm: 165 }, T1);
    stamped.screenings = stampFields(stamped.screenings, { breastFrequency: 'annual' }, T1);
    const empty = blank();
    empty.profile.lamport = 9; // an empty object's clock says nothing, however high
    for (const merged of [mergeFiles(stamped, empty, OPTS), mergeFiles(empty, stamped, OPTS)]) {
      expect(merged.profile).toStrictEqual(stamped.profile);
      expect(merged.screenings).toStrictEqual(stamped.screenings);
    }
  });

  it('two that hold no field keep the older stamp, so a fresh empty record changes nothing', () => {
    const old = emptyFile();
    for (const merged of [mergeFiles(old, blank(), OPTS), mergeFiles(blank(), old, OPTS)]) {
      expect(merged.profile).toStrictEqual(old.profile);
      expect(merged.screenings).toStrictEqual(old.screenings);
    }
  });

  it('a field cleared by a stamped write still speaks: its stamp beats the older value', () => {
    const cleared = emptyFile();
    cleared.profile = JSON.parse(JSON.stringify(
      stampFields({ heightCm: 178, updatedAt: T0, lamport: 1 }, { heightCm: undefined }, T2),
    ));
    expect(Object.keys(cleared.profile).sort()).toEqual(['fieldStamps', 'lamport', 'updatedAt']);
    const other = emptyFile();
    other.profile = { heightCm: 178, updatedAt: T1, lamport: 1 };
    for (const merged of [mergeFiles(cleared, other, OPTS), mergeFiles(other, cleared, OPTS)]) {
      expect(merged.profile).not.toHaveProperty('heightCm');
    }
  });
});

describe('stampFields — a write stamps only the fields it changes (US-10 AC6)', () => {
  it('stamps the fields written one past the object, and keeps every other field\'s clock', () => {
    const before: RoadmapProfile = { sex: 'male', heightCm: 178, updatedAt: T0, lamport: 1 };
    const after = stampFields(before, { heightCm: 180 }, T1);
    expect(after).toEqual({
      sex: 'male', heightCm: 180, updatedAt: T1, lamport: 2,
      fieldStamps: { sex: at(1, T0), heightCm: at(2, T1) },
    });
    expect(before).not.toHaveProperty('fieldStamps'); // a new object; the one given is untouched

    expect(stampFields(after, { sex: 'female' }, T2).fieldStamps).toEqual({ sex: at(3, T2), heightCm: at(2, T1) });
  });

  it('the headline case end to end: two writes to one old profile both survive the merge', () => {
    const a = emptyFile();
    a.profile = { sex: 'male', heightCm: 178, birthYear: 1971, updatedAt: T0, lamport: 1 };
    const b = structuredClone(a);
    b.profile = stampFields(b.profile, { heightCm: 180 }, T1);
    a.profile = stampFields(a.profile, { birthYear: 1972 }, T2);
    expect(mergeFiles(a, b, OPTS).profile).toMatchObject({ heightCm: 180, birthYear: 1972 });
  });

  it('a field this copy never had loses to one another device set, though this copy was written later', () => {
    const a = emptyFile();
    a.screenings = stampFields(a.screenings, { breastFrequency: 'annual' }, T2);
    const b = emptyFile();
    b.screenings = stampFields(b.screenings, { colorectalMethod: 'fit_annual' }, T1);
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.screenings).toMatchObject({ colorectalMethod: 'fit_annual', breastFrequency: 'annual' });
    }
  });

  it('re-stamps a copy an older app wrote over at that app\'s stamp before writing', () => {
    const stale = {
      heightCm: 178, birthYear: 1970, updatedAt: T1, lamport: 3,
      fieldStamps: { heightCm: at(2, T0), birthYear: at(2, T0) },
    };
    expect(stampFields(stale, { heightCm: 180 }, T2).fieldStamps).toEqual({ heightCm: at(4, T2), birthYear: at(3, T1) });
  });
});

describe('mergeFiles — append-only logs & snapshots', () => {
  it('unions medicationHistory and documents by id', () => {
    const a = emptyFile();
    const b = emptyFile();
    const histRow = (id: string): FileMedication => ({ id, medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '2026-05-01T00:00:00Z', lamport: 1 });
    a.medicationHistory = [histRow('h1'), histRow('h2')];
    b.medicationHistory = [histRow('h2'), histRow('h3')];
    expect(mergeFiles(a, b, OPTS).medicationHistory.map((h) => h.id)).toEqual(['h1', 'h2', 'h3']);

    const doc = (id: string): FileDocument => ({ id, title: id, type: 'pathology_report' as any, date: '2026-05-01', fileRef: `documents/${id}.pdf`, contentHash: `sha256-${id}`, mimeType: 'application/pdf', extractedText: '', addedAt: '2026-05-01T00:00:00Z' });
    a.documents = [doc('d1')];
    b.documents = [doc('d1'), doc('d2')];
    expect(mergeFiles(a, b, OPTS).documents.map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('dedups recommendationSnapshots by date, keeping the richer one', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.recommendationSnapshots = [{ date: '2026-06-01', suggestions: [{ id: 's1' } as any] }];
    b.recommendationSnapshots = [
      { date: '2026-06-01', suggestions: [{ id: 's1' } as any, { id: 's2' } as any] }, // richer
      { date: '2026-06-08', suggestions: [] },
    ];
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.recommendationSnapshots).toHaveLength(2);
    expect(merged.recommendationSnapshots.find((s) => s.date === '2026-06-01')!.suggestions).toHaveLength(2);
  });
});

describe('mergeFiles — determinism, symmetry & convergence', () => {
  function richFile(seed: string): RoadmapFile {
    const f = emptyFile();
    f.meta.lamport = seed === 'a' ? 3 : 6;
    f.measurements = [
      measurement({ id: `${seed}_m1`, metricType: 'ldl', value: 2.0, recordedAt: '2026-05-01' }),
      measurement({ id: `${seed}_m2`, metricType: 'hba1c', value: 35, recordedAt: '2026-05-02' }),
    ];
    f.medications = [{ id: `med_${seed}`, medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg', updatedAt: `2026-05-0${seed === 'a' ? 1 : 2}T00:00:00Z`, lamport: seed === 'a' ? 1 : 2 }];
    return f;
  }

  it('merge is symmetric: merge(a,b) === merge(b,a) for schema-v1 fields', () => {
    const a = richFile('a');
    const b = richFile('b');
    const ab = mergeFiles(a, b, OPTS);
    const ba = mergeFiles(b, a, OPTS);
    expect(stableStringify(ab)).toBe(stableStringify(ba));
  });

  it('two simulated devices converge with no dup/loss', () => {
    // Shared cloud file starts empty.
    let cloud = emptyFile();

    // Device 1 saves an LDL (read cloud, merge, write).
    const d1Local = emptyFile();
    d1Local.measurements = [measurement({ id: 'd1_ldl', metricType: 'ldl', value: 2.2, recordedAt: '2026-05-01' })];
    cloud = mergeFiles(d1Local, cloud, { deviceId: 'dev1', now: '2026-05-01T10:00:00Z' });

    // Device 2 (was offline with empty) saves an HbA1c + a medication, then syncs.
    const d2Local = emptyFile();
    d2Local.measurements = [measurement({ id: 'd2_hba1c', metricType: 'hba1c', value: 36, recordedAt: '2026-05-03' })];
    d2Local.medications = [{ id: 'med_d2', medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg', updatedAt: '2026-05-03T00:00:00Z', lamport: 1 }];
    cloud = mergeFiles(d2Local, cloud, { deviceId: 'dev2', now: '2026-05-03T10:00:00Z' });

    // Device 1 syncs again — pulls cloud, merges with its local.
    const d1Final = mergeFiles(d1Local, cloud, { deviceId: 'dev1', now: '2026-05-04T10:00:00Z' });

    // Both the cloud and device 1 see the full set, with no duplicates.
    for (const f of [cloud, d1Final]) {
      const actives = activeMeasurements(f);
      expect(actives.map((m) => m.id).sort()).toEqual(['d1_ldl', 'd2_hba1c']);
      expect(f.medications).toHaveLength(1);
      expect(f.medications[0].drugName).toBe('rosuvastatin');
    }
  });

  it('preserves unknown top-level fields (forward-compat, H7)', () => {
    const a = emptyFile();
    const b = emptyFile();
    (a as any).futureField = { hello: 'world' };
    const merged = mergeFiles(a, b, OPTS) as any;
    expect(merged.futureField).toEqual({ hello: 'world' });
  });
});

describe('mergeFiles — eraseEpoch ("Delete All My Data")', () => {
  it('a higher local epoch wins wholesale — the other side cannot resurrect data', () => {
    const erased = emptyFile();
    erased.meta.eraseEpoch = 1;
    const stale = emptyFile();
    stale.measurements = [measurement({ id: 'm1', metricType: 'weight', value: 95 })];
    const merged = mergeFiles(erased, stale, OPTS);
    expect(merged.measurements).toEqual([]);
    expect(merged.meta.eraseEpoch).toBe(1);
  });

  it('a higher remote epoch wins wholesale (symmetric)', () => {
    const stale = emptyFile();
    stale.measurements = [measurement({ id: 'm1', metricType: 'weight', value: 95 })];
    const erased = emptyFile();
    erased.meta.eraseEpoch = 2;
    const merged = mergeFiles(stale, erased, OPTS);
    expect(merged.measurements).toEqual([]);
    expect(merged.meta.eraseEpoch).toBe(2);
  });

  it('data entered AFTER an erase survives a merge against a pre-erase copy', () => {
    const postErase = emptyFile();
    postErase.meta.eraseEpoch = 1;
    postErase.measurements = [measurement({ id: 'new1', metricType: 'weight', value: 80 })];
    const preErase = emptyFile(); // epoch absent → 0
    preErase.measurements = [measurement({ id: 'old1', metricType: 'weight', value: 95 })];
    const merged = mergeFiles(postErase, preErase, OPTS);
    expect(merged.measurements.map((m) => m.id)).toEqual(['new1']);
    expect(merged.meta.eraseEpoch).toBe(1);
  });

  it('equal epochs merge normally (union semantics intact)', () => {
    const a = emptyFile();
    a.meta.eraseEpoch = 1;
    a.measurements = [measurement({ id: 'a1', metricType: 'weight', value: 80, recordedAt: '2026-05-01' })];
    const b = emptyFile();
    b.meta.eraseEpoch = 1;
    b.measurements = [measurement({ id: 'b1', metricType: 'ldl', value: 2.2, recordedAt: '2026-05-02' })];
    const merged = mergeFiles(a, b, OPTS);
    expect(activeMeasurements(merged).length).toBe(2);
    expect(merged.meta.eraseEpoch).toBe(1);
  });

  it('absent epochs read as 0 and merge normally (back-compat)', () => {
    const a = emptyFile();
    a.measurements = [measurement({ id: 'a1', metricType: 'weight', value: 80 })];
    const merged = mergeFiles(a, emptyFile(), OPTS);
    expect(activeMeasurements(merged).length).toBe(1);
    expect(merged.meta.eraseEpoch).toBe(0);
  });

  it('erase-epoch winner is bumped by lamport like any merge', () => {
    const erased = emptyFile();
    erased.meta.eraseEpoch = 1;
    erased.meta.lamport = 3;
    const stale = emptyFile();
    stale.meta.lamport = 9;
    const merged = mergeFiles(erased, stale, OPTS);
    expect(merged.meta.lamport).toBe(10);
    expect(merged.meta.lastDeviceId).toBe('dev_merge');
  });
});

describe('reminderOptIn (optional singleton)', () => {
  const sub = (lamport: number, status: 'active' | 'cancelled') => ({
    status,
    token: `tok_${lamport}`,
    email: 'user@example.com',
    provider: 'google-drive' as const,
    updatedAt: '2026-06-10T00:00:00Z',
    lamport,
  });

  it('present beats absent in both directions', () => {
    const withSub = emptyFile();
    withSub.reminderOptIn = sub(1, 'active');
    expect(mergeFiles(withSub, emptyFile(), OPTS).reminderOptIn?.token).toBe('tok_1');
    expect(mergeFiles(emptyFile(), withSub, OPTS).reminderOptIn?.token).toBe('tok_1');
  });

  it('a cancel on one device wins over an older active on another (LWW)', () => {
    const cancelled = emptyFile();
    cancelled.reminderOptIn = sub(5, 'cancelled');
    const active = emptyFile();
    active.reminderOptIn = sub(2, 'active');
    expect(mergeFiles(active, cancelled, OPTS).reminderOptIn?.status).toBe('cancelled');
    expect(mergeFiles(cancelled, active, OPTS).reminderOptIn?.status).toBe('cancelled');
  });

  it('absent on both sides stays absent', () => {
    expect(mergeFiles(emptyFile(), emptyFile(), OPTS).reminderOptIn).toBeUndefined();
  });
});

describe('document tombstones', () => {
  const doc = (id: string, deleted?: boolean) => ({
    id, title: 't', type: 'other' as const, date: null, fileRef: '', contentHash: '',
    mimeType: '', extractedText: '', addedAt: '2026-06-10T00:00:00Z', ...(deleted ? { deleted: true } : {}),
  });

  it('a delete seen by one side is never undone by the other', () => {
    const a = emptyFile();
    a.documents = [doc('d1', true)];
    const b = emptyFile();
    b.documents = [doc('d1')];
    expect(mergeFiles(a, b, OPTS).documents[0].deleted).toBe(true);
    expect(mergeFiles(b, a, OPTS).documents[0].deleted).toBe(true);
  });

  it('undeleted rows still union normally', () => {
    const a = emptyFile();
    a.documents = [doc('d1')];
    const b = emptyFile();
    b.documents = [doc('d2')];
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.documents.map(d => d.id)).toEqual(['d1', 'd2']);
    expect(merged.documents.some(d => d.deleted)).toBe(false);
  });
});

describe('mergeFiles — sloppy second writer (US-29; convergence per US-10)', () => {
  // Defect 1: a second writer (a hand edit, or an AI agent with filesystem
  // tools) reuses an existing row id with DIFFERENT content. Union-by-id kept
  // the FIRST-SEEN copy, so the surviving value depended on merge direction —
  // an in-place edit of an immutable clinical row, with no correction trail.
  it('keeps both rows when an id is reused with different content, and stays symmetric', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 2.1 })];
    b.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 9.9 })];

    const ab = mergeFiles(a, b, OPTS);
    const ba = mergeFiles(b, a, OPTS);
    expect(stableStringify(ab)).toBe(stableStringify(ba));

    // Nothing destroyed: both values survive under distinct ids...
    expect(ab.measurements.map((m) => m.value).sort()).toEqual([2.1, 9.9]);
    expect(new Set(ab.measurements.map((m) => m.id)).size).toBe(2);
    // ...and the slot rule still holds.
    expect(activeMeasurements(ab)).toHaveLength(1);
  });

  // Defect 1 (cont.): quarantining must be idempotent — re-merging the result
  // against the copy that still holds the reused id must not grow the row set.
  it('re-merging a quarantined result against the original converges', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 2.1 })];
    b.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 9.9 })];
    const once = mergeFiles(a, b, OPTS);
    const twice = mergeFiles(once, b, OPTS);
    expect(stableStringify(twice.measurements)).toBe(stableStringify(once.measurements));
    expect(stableStringify(mergeFiles(b, once, OPTS).measurements)).toBe(
      stableStringify(once.measurements),
    );
  });

  // The quarantine must NOT fire on the legitimate cross-device case: same id,
  // same content, different status is one row seen twice, not two rows.
  it('same id + same content stays ONE row with the monotonic status', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 2.1, status: 'active' })];
    b.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 2.1, status: 'entered-in-error' })];
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.measurements).toHaveLength(1);
    expect(merged.measurements[0].status).toBe('entered-in-error');
  });

  // Adversarial review (2026-09-01): a writer that mimics the quarantine suffix
  // (`<id>#dup-<hash>#dup-<hash>`) used to have only ONE suffix stripped, so it
  // regrouped under the real quarantined row's id and collided with it in the
  // output map — one of the two contents was silently dropped, and which one
  // depended on merge direction.
  it('a doubled #dup- suffix regroups under the ORIGINAL id, keeping every content', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 2.1 })];
    b.measurements = [measurement({ id: 'X', metricType: 'ldl', value: 9.9 })];
    const once = mergeFiles(a, b, OPTS);
    const quarantined = once.measurements.find((m) => m.id.includes('#dup-'))!;

    // A sloppy writer copies the quarantined row, edits it, and layers a second
    // suffix on the id it copied.
    const c = emptyFile();
    c.measurements = [
      { ...quarantined, id: `${quarantined.id}#dup-deadbeef`, value: 5.5, recordedAt: '2026-05-02', status: 'active' },
    ];

    const ac = mergeFiles(once, c, OPTS);
    const ca = mergeFiles(c, once, OPTS);
    expect(stableStringify(ac.measurements)).toBe(stableStringify(ca.measurements));
    expect(ac.measurements.map((m) => m.value).sort()).toEqual([2.1, 5.5, 9.9]);
    expect(new Set(ac.measurements.map((m) => m.id)).size).toBe(3);
  });

  // Demote-both guard (US-10): whatever the merge direction, a slot converges
  // to the SAME single active row — never zero, never two.
  it('two devices merging in opposite orders converge to one active row per slot', () => {
    const a = emptyFile();
    const b = emptyFile();
    // Both devices saw the original X and corrected it — each with its own row.
    a.measurements = [
      measurement({ id: 'X', metricType: 'ldl', value: 2.1, status: 'entered-in-error', createdAt: '2026-05-01T08:00:00Z' }),
      measurement({ id: 'Ya', metricType: 'ldl', value: 2.4, correctsId: 'X', createdAt: '2026-05-02T08:00:00Z' }),
    ];
    b.measurements = [
      measurement({ id: 'X', metricType: 'ldl', value: 2.1, status: 'entered-in-error', createdAt: '2026-05-01T08:00:00Z' }),
      measurement({ id: 'Yb', metricType: 'ldl', value: 2.6, correctsId: 'X', createdAt: '2026-05-03T08:00:00Z' }),
    ];
    const ab = activeMeasurements(mergeFiles(a, b, OPTS));
    const ba = activeMeasurements(mergeFiles(b, a, OPTS));
    expect(ab).toHaveLength(1);
    expect(ba).toHaveLength(1);
    expect(ab[0].id).toBe(ba[0].id);
  });
});

// Adversarial review (2026-09-01): the row-immutability guarantee the header
// claims was real only for measurements/labValues. The append-only LOGS
// (medicationHistory, supplementHistory) and documents still resolved a reused
// id first-seen — an in-place edit of an immutable row, and asymmetric. They
// get the same (base id, content) union; documents keep the tombstone OR.
describe('mergeFiles — append-only logs and documents quarantine a reused id (US-29)', () => {
  const med = (over: Partial<FileMedication>): FileMedication => ({
    id: 'H1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40,
    doseUnit: 'mg', updatedAt: '2026-05-01T00:00:00Z', lamport: 1, ...over,
  });
  const supp = (over: Partial<FileSupplement>): FileSupplement => ({
    id: 'S1', supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: 1,
    doseUnit: 'g', status: 'active', startedAt: '2026-05-01',
    updatedAt: '2026-05-01T00:00:00Z', lamport: 1, ...over,
  });
  const doc = (over: Partial<FileDocument>): FileDocument => ({
    id: 'D1', title: 'orig', type: 'other', date: null, fileRef: '', contentHash: '',
    mimeType: '', extractedText: 'A', addedAt: '2026-05-01T00:00:00Z', ...over,
  });

  it('medicationHistory keeps both contents and stays symmetric', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.medicationHistory = [med({})];
    b.medicationHistory = [med({ drugName: 'HAND_EDITED', doseValue: 80 })];
    const ab = mergeFiles(a, b, OPTS);
    const ba = mergeFiles(b, a, OPTS);
    expect(stableStringify(ab.medicationHistory)).toBe(stableStringify(ba.medicationHistory));
    expect(ab.medicationHistory.map((r) => r.drugName).sort()).toEqual(['HAND_EDITED', 'atorvastatin']);
    expect(new Set(ab.medicationHistory.map((r) => r.id)).size).toBe(2);
  });

  it('supplementHistory keeps both contents and stays symmetric', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.supplementHistory = [supp({})];
    b.supplementHistory = [supp({ doseValue: 3 })];
    const ab = mergeFiles(a, b, OPTS);
    const ba = mergeFiles(b, a, OPTS);
    expect(stableStringify(ab.supplementHistory)).toBe(stableStringify(ba.supplementHistory));
    expect(ab.supplementHistory.map((r) => r.doseValue).sort()).toEqual([1, 3]);
    expect(new Set(ab.supplementHistory.map((r) => r.id)).size).toBe(2);
  });

  it('documents keep both contents and stay symmetric', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.documents = [doc({})];
    b.documents = [doc({ title: 'edited', extractedText: 'B' })];
    const ab = mergeFiles(a, b, OPTS);
    const ba = mergeFiles(b, a, OPTS);
    expect(stableStringify(ab.documents)).toBe(stableStringify(ba.documents));
    expect(ab.documents.map((d) => d.title).sort()).toEqual(['edited', 'orig']);
    expect(new Set(ab.documents.map((d) => d.id)).size).toBe(2);
  });

  // The tombstone is OR-ed across copies of the SAME content, exactly as
  // before — `deleted` is excluded from the signature, so a deleted and an
  // undeleted copy are one row, not two.
  it('a document delete survives the quarantine and never resurrects', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.documents = [doc({ deleted: true }), doc({ id: 'D2', title: 'other' })];
    b.documents = [doc({}), doc({ id: 'D2', title: 'other', deleted: true })];
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.documents).toHaveLength(2);
      expect(merged.documents.every((d) => d.deleted)).toBe(true);
    }
  });

  // Same content on both sides is still ONE row — the quarantine must not fire
  // on the ordinary cross-device case.
  it('same id + same content stays one row in every log', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.medicationHistory = [med({})];
    b.medicationHistory = [med({})];
    a.supplementHistory = [supp({})];
    b.supplementHistory = [supp({})];
    a.documents = [doc({})];
    b.documents = [doc({})];
    const merged = mergeFiles(a, b, OPTS);
    expect(merged.medicationHistory).toHaveLength(1);
    expect(merged.supplementHistory).toHaveLength(1);
    expect(merged.documents).toHaveLength(1);
    expect(merged.medicationHistory[0].id).toBe('H1');
    expect(merged.documents[0].id).toBe('D1');
  });
});

describe('mergeFiles — erasedAt keeps rows written after the erase (US-09 AC20)', () => {
  const ERASED_AT = '2026-05-10T00:00:00Z';
  const AFTER = '2026-05-11T09:00:00Z';
  const BEFORE = '2026-05-01T09:00:00Z';

  /** A file erased at ERASED_AT, one epoch above the stale copies below. */
  function erased(epoch = 1): RoadmapFile {
    const file = emptyFile();
    file.meta.eraseEpoch = epoch;
    file.meta.erasedAt = ERASED_AT;
    return file;
  }

  /** A copy that never saw the erase: one row from before it, one from after. */
  function stale(): RoadmapFile {
    const file = emptyFile();
    file.measurements = [
      measurement({ id: 'after', metricType: 'weight', value: 80, recordedAt: '2026-05-11', createdAt: AFTER }),
      measurement({ id: 'before', metricType: 'weight', value: 95, recordedAt: '2026-05-01', createdAt: BEFORE }),
    ];
    file.labValues = [
      { id: 'lvAfter', metricName: 'ferritin', value: 90, unit: 'ng/mL', referenceLow: null, referenceHigh: null, recordedAt: '2026-05-11', createdAt: AFTER, source: 'manual', status: 'active', correctsId: null },
      { id: 'lvBefore', metricName: 'ferritin', value: 70, unit: 'ng/mL', referenceLow: null, referenceHigh: null, recordedAt: '2026-05-01', createdAt: BEFORE, source: 'manual', status: 'active', correctsId: null },
    ];
    file.documents = [
      { id: 'dAfter', title: 'Labs', type: 'pathology_report', date: '2026-05-11', fileRef: '', contentHash: '', mimeType: '', extractedText: 'x', addedAt: AFTER },
      { id: 'dBefore', title: 'Old', type: 'pathology_report', date: '2026-05-01', fileRef: '', contentHash: '', mimeType: '', extractedText: 'y', addedAt: BEFORE },
    ];
    return file;
  }

  it('US-09 AC20: a losing LOCAL copy keeps its post-erase rows and drops the pre-erase ones', () => {
    const merged = mergeFiles(stale(), erased(), OPTS);
    expect(merged.measurements.map((m) => m.id)).toEqual(['after']);
    expect(merged.labValues.map((r) => r.id)).toEqual(['lvAfter']);
    expect(merged.documents.map((r) => r.id)).toEqual(['dAfter']);
    expect(merged.meta.eraseEpoch).toBe(1);
    expect(merged.meta.erasedAt).toBe(ERASED_AT);
  });

  it('US-09 AC20: a losing REMOTE copy keeps its post-erase rows too (either side of the gate)', () => {
    const merged = mergeFiles(erased(), stale(), OPTS);
    expect(merged.measurements.map((m) => m.id)).toEqual(['after']);
    expect(merged.labValues.map((r) => r.id)).toEqual(['lvAfter']);
    expect(merged.documents.map((r) => r.id)).toEqual(['dAfter']);
    expect(merged.meta.erasedAt).toBe(ERASED_AT);
  });

  it('US-09 AC20: the merge is symmetric across the gate', () => {
    const a = stableStringify({ ...mergeFiles(stale(), erased(), OPTS) });
    const b = stableStringify({ ...mergeFiles(erased(), stale(), OPTS) });
    expect(a).toBe(b);
  });

  it('US-09 AC20: a row created at exactly the erase instant is kept', () => {
    const device = emptyFile();
    device.measurements = [measurement({ id: 'onTheDot', metricType: 'weight', value: 80, createdAt: ERASED_AT })];
    expect(mergeFiles(device, erased(), OPTS).measurements.map((m) => m.id)).toEqual(['onTheDot']);
  });

  it('US-09 AC20: a winner from before erasedAt existed still drops every losing row (legacy)', () => {
    const legacy = erased();
    delete legacy.meta.erasedAt;
    expect(mergeFiles(stale(), legacy, OPTS).measurements).toEqual([]);
    expect(mergeFiles(legacy, stale(), OPTS).measurements).toEqual([]);
    expect(mergeFiles(legacy, stale(), OPTS).meta.erasedAt).toBeUndefined();
  });

  // Review fix (N3): a stamp with no zone designator is UTC, as a date-only
  // stamp already is, never this machine's local time.
  it('US-09 AC20: a stamp with no zone reads as UTC', () => {
    const device = emptyFile();
    device.measurements = [
      measurement({ id: 'early', metricType: 'weight', value: 90, recordedAt: '2026-05-09', createdAt: '2026-05-09T23:59:59' }),
      measurement({ id: 'late', metricType: 'weight', value: 80, recordedAt: '2026-05-10', createdAt: '2026-05-10T00:00:00.000' }),
    ];
    const tz = process.env.TZ;
    try {
      for (const zone of ['Pacific/Auckland', 'America/New_York']) {
        process.env.TZ = zone; // Node re-reads it on the next Date call
        expect(mergeFiles(device, erased(), OPTS).measurements.map((m) => m.id)).toEqual(['late']);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('US-09 AC20: equal epochs keep the later erasedAt, and the one present when only one has it', () => {
    const a = erased();
    const b = erased();
    b.meta.erasedAt = '2026-05-12T00:00:00Z';
    expect(mergeFiles(a, b, OPTS).meta.erasedAt).toBe('2026-05-12T00:00:00Z');
    expect(mergeFiles(b, a, OPTS).meta.erasedAt).toBe('2026-05-12T00:00:00Z');
    delete a.meta.erasedAt;
    expect(mergeFiles(a, b, OPTS).meta.erasedAt).toBe('2026-05-12T00:00:00Z');
    expect(mergeFiles(b, a, OPTS).meta.erasedAt).toBe('2026-05-12T00:00:00Z');
    delete b.meta.erasedAt;
    expect('erasedAt' in mergeFiles(a, b, OPTS).meta).toBe(false);
  });

  it('US-09 AC20: a later erase wins over an earlier one, and its erasedAt with it', () => {
    const older = erased(1);
    older.measurements = [measurement({ id: 'between', metricType: 'weight', value: 80, recordedAt: '2026-05-11', createdAt: AFTER })];
    const newer = erased(2);
    newer.meta.erasedAt = '2026-05-20T00:00:00Z';
    const merged = mergeFiles(older, newer, OPTS);
    expect(merged.measurements).toEqual([]); // written after the first erase, before the second
    expect(merged.meta).toMatchObject({ eraseEpoch: 2, erasedAt: '2026-05-20T00:00:00Z' });
  });

  it('US-09 AC20: entered-in-error stays sticky across the gate', () => {
    const cloud = erased();
    cloud.measurements = [measurement({ id: 'x', metricType: 'weight', value: 80, recordedAt: '2026-05-11', createdAt: AFTER })];
    const device = emptyFile();
    device.measurements = [
      measurement({ id: 'x', metricType: 'weight', value: 80, recordedAt: '2026-05-11', createdAt: AFTER, status: 'entered-in-error' }),
      measurement({ id: 'x2', metricType: 'weight', value: 81, recordedAt: '2026-05-11', createdAt: '2026-05-11T10:00:00Z', correctsId: 'x' }),
    ];
    for (const merged of [mergeFiles(device, cloud, OPTS), mergeFiles(cloud, device, OPTS)]) {
      expect(merged.measurements.find((m) => m.id === 'x')!.status).toBe('entered-in-error');
      expect(activeMeasurements(merged).map((m) => m.id)).toEqual(['x2']);
    }
  });

  it('US-09 AC20: a kept row meets the slot rule — one active row per (metric, day)', () => {
    const cloud = erased();
    cloud.measurements = [measurement({ id: 'cloudDay', metricType: 'weight', value: 79, recordedAt: '2026-05-11', createdAt: '2026-05-11T08:00:00Z' })];
    const merged = mergeFiles(stale(), cloud, OPTS);
    const day = merged.measurements.filter((m) => m.recordedAt === '2026-05-11');
    expect(day.map((m) => m.id).sort()).toEqual(['after', 'cloudDay']);
    expect(day.filter((m) => m.status === 'active').map((m) => m.id)).toEqual(['after']); // newest createdAt
  });

  it('US-09 AC20: no stale singleton rides in with the kept rows', () => {
    const device = stale();
    device.profile = { updatedAt: '2030-01-01T00:00:00Z', lamport: 99, heightCm: 150 };
    const cloud = erased();
    const merged = mergeFiles(device, cloud, OPTS);
    expect(merged.profile.heightCm).toBeUndefined();
    expect(merged.measurements.map((m) => m.id)).toEqual(['after']);
  });

  // Review fixes (Codex R1, adversary R1): stamps compare as instants, not
  // strings, so an offset or a different precision cannot reorder them.
  it('US-09 AC20: a +13:00 row before the erase goes and a -04:00 row after it stays', () => {
    const device = emptyFile();
    device.measurements = [
      // 2026-05-09T20:00Z, before the erase; as a string it sorts after it
      measurement({ id: 'plus13', metricType: 'weight', value: 90, recordedAt: '2026-05-09', createdAt: '2026-05-10T09:00:00+13:00' }),
      // 2026-05-10T01:00Z, after the erase; as a string it sorts before it
      measurement({ id: 'minus4', metricType: 'weight', value: 80, recordedAt: '2026-05-10', createdAt: '2026-05-09T21:00:00-04:00' }),
    ];
    for (const merged of [mergeFiles(device, erased(), OPTS), mergeFiles(erased(), device, OPTS)]) {
      expect(merged.measurements.map((m) => m.id)).toEqual(['minus4']);
    }
  });

  it('US-09 AC20: fractional precision does not reorder a row against the erase', () => {
    const cloud = erased();
    cloud.meta.erasedAt = '2026-05-10T00:00:00.500Z';
    const device = emptyFile();
    device.measurements = [
      measurement({ id: 'early', metricType: 'weight', value: 90, recordedAt: '2026-05-09', createdAt: '2026-05-10T00:00:00Z' }),
      measurement({ id: 'same', metricType: 'weight', value: 80, recordedAt: '2026-05-10', createdAt: '2026-05-10T00:00:00.5000Z' }),
      measurement({ id: 'late', metricType: 'weight', value: 81, recordedAt: '2026-05-11', createdAt: '2026-05-10T00:00:01Z' }),
    ];
    expect(mergeFiles(device, cloud, OPTS).measurements.map((m) => m.id).sort()).toEqual(['late', 'same']);
  });

  it('US-09 AC20: equal epochs keep the later erase as an instant, across offsets', () => {
    const a = erased();
    a.meta.erasedAt = '2026-05-12T10:00:00+13:00'; // 2026-05-11T21:00Z
    const b = erased();
    b.meta.erasedAt = '2026-05-11T22:00:00Z';
    expect(mergeFiles(a, b, OPTS).meta.erasedAt).toBe('2026-05-11T22:00:00Z');
    expect(mergeFiles(b, a, OPTS).meta.erasedAt).toBe('2026-05-11T22:00:00Z');
  });

  // Review fix (adversary R2): an updatedAt stamp is no proof of creation. A
  // stale copy re-stamps a pre-erase row when it stops a supplement or a
  // statin cascade rewrites a medication, so those arrays never cross.
  it('US-09 AC20: a pre-erase supplement or medication re-stamped after the erase does not return', () => {
    const device = stale();
    const supplement = { id: 's1', supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: null, doseUnit: null, status: 'stopped' as const, startedAt: '2026-05-01', updatedAt: AFTER, lamport: 2 };
    device.supplements = [supplement];
    device.supplementHistory = [{ ...supplement, id: 'sh1', changeType: 'stopped' }];
    device.medications = [{ id: 'med_statin', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg', updatedAt: AFTER, lamport: 3 }];
    for (const merged of [mergeFiles(device, erased(), OPTS), mergeFiles(erased(), device, OPTS)]) {
      expect(merged.supplements).toEqual([]);
      expect(merged.supplementHistory).toEqual([]);
      expect(merged.medications).toEqual([]);
      expect(merged.measurements.map((m) => m.id)).toEqual(['after']); // a post-erase measurement still survives
    }
  });

  // Review fix (adversary R5): the kept-rows path keeps the header's clock
  // contract, lamport = max(local, remote) + 1.
  it('US-09 AC20: the kept-rows merge advances lamport past both copies', () => {
    const device = stale();
    device.meta.lamport = 50;
    const cloud = erased();
    cloud.meta.lamport = 3;
    expect(mergeFiles(device, cloud, OPTS).meta.lamport).toBe(51);
    expect(mergeFiles(cloud, device, OPTS).meta.lamport).toBe(51);
  });
});

describe('mergeFiles — erasedRows: an erase decides by the rows it listed (US-09 AC23)', () => {
  const STAMP = { updatedAt: '2026-05-01T09:00:00Z', lamport: 1 };
  const lab = (id: string, recordedAt = '2026-05-01'): FileLabValue => ({
    id, metricName: 'ferritin', value: 90, unit: 'µg/L', referenceLow: null, referenceHigh: null,
    recordedAt, createdAt: `${recordedAt}T09:00:00Z`, source: 'manual', status: 'active', correctsId: null,
  });
  const doc = (id: string): FileDocument => ({
    id, title: 'Labs', type: 'pathology_report', date: '2026-05-01', fileRef: '', contentHash: '', mimeType: '', extractedText: 'x', addedAt: '2026-05-01T09:00:00Z',
  });
  const med = (id: string, medicationKey = 'statin'): FileMedication => ({ id, medicationKey, drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', ...STAMP });
  const supp = (id: string, supplementKey = 'omega3'): FileSupplement => ({
    id, supplementKey, supplementName: 'Omega-3', doseValue: null, doseUnit: null, status: 'active', startedAt: '2026-05-01', ...STAMP,
  });

  /** One row in every array that carries ids, each under `${prefix}<array>`. */
  function everyArray(prefix: string, file = emptyFile()): RoadmapFile {
    file.measurements.push(measurement({ id: `${prefix}m`, metricType: 'weight', value: 80, recordedAt: prefix === 'old' ? '2026-04-01' : '2026-05-01' }));
    file.labValues.push(lab(`${prefix}l`, prefix === 'old' ? '2026-04-01' : '2026-05-01'));
    file.documents.push({ ...doc(`${prefix}d`), addedAt: prefix === 'old' ? '2026-04-01T09:00:00Z' : '2026-05-01T09:00:00Z' });
    file.medications.push(med(`${prefix}med`, `${prefix}-statin`));
    file.medicationHistory.push({ ...med(`${prefix}mh`), changeType: 'started' });
    file.supplements.push(supp(`${prefix}s`, `${prefix}-omega3`));
    file.supplementHistory.push({ ...supp(`${prefix}sh`), changeType: 'started' });
    return file;
  }
  const ARRAYS = ['measurements', 'labValues', 'documents', 'medications', 'medicationHistory', 'supplements', 'supplementHistory'] as const;
  const idsIn = (file: RoadmapFile) => ARRAYS.flatMap((key) => (file[key] as Array<{ id: string }>).map((r) => r.id)).sort();

  /** A file erased at `epoch` that listed `ids`, claiming every erase from `fromEpoch` on. */
  function listed(ids: string[], epoch = 1, fromEpoch = epoch): RoadmapFile {
    const file = emptyFile();
    file.schemaVersion = 2;
    file.meta.eraseEpoch = epoch;
    file.erasedRows = { fromEpoch, ids };
    return file;
  }
  /** The ids `everyArray(prefix)` writes. */
  const rowsOf = (prefix: string) => idsIn(everyArray(prefix));

  it('US-09 AC23: a listed row goes, on both sides of the gate and at equal epochs', () => {
    const stale = everyArray('old'); // epoch 0, never heard of the erase
    const erased = listed(rowsOf('old'));
    for (const merged of [mergeFiles(stale, erased, OPTS), mergeFiles(erased, stale, OPTS)]) {
      expect(idsIn(merged)).toEqual([]);
      expect(merged.meta.eraseEpoch).toBe(1);
    }
    // Equal epochs: a copy at the erase's epoch that still holds a listed row.
    const same = everyArray('old', emptyFile());
    same.meta.eraseEpoch = 1;
    for (const merged of [mergeFiles(same, erased, OPTS), mergeFiles(erased, same, OPTS)]) expect(idsIn(merged)).toEqual([]);
  });

  it('US-09 AC23: a row no erase listed survives the gate, in every array, from either side', () => {
    const stale = everyArray('new', everyArray('old')); // typed before AND after the erase, neither seen by it
    const erased = listed(rowsOf('old'));
    for (const merged of [mergeFiles(stale, erased, OPTS), mergeFiles(erased, stale, OPTS)]) {
      expect(idsIn(merged)).toEqual(rowsOf('new'));
      expect(merged.erasedRows).toEqual({ fromEpoch: 1, ids: rowsOf('old') });
      expect(merged.meta.eraseEpoch).toBe(1);
      expect(merged.schemaVersion).toBe(2);
    }
  });

  it('US-09 AC23: a quarantined copy and a unit conversion of a listed row go with it', () => {
    const stale = emptyFile();
    stale.labValues = [
      { ...lab('x'), status: 'entered-in-error' },
      { ...lab('x#si'), correctsId: 'x' },
      { ...lab('x#dup-0badf00d'), value: 91 },
      { ...lab('x#dup-0badf00d#si'), value: 9.1 },
      lab('y', '2026-05-02'),
    ];
    const erased = listed(['x']);
    for (const merged of [mergeFiles(stale, erased, OPTS), mergeFiles(erased, stale, OPTS)]) {
      expect(merged.labValues.map((r) => r.id)).toEqual(['y']);
    }
    expect(rootIdOf('x#si#dup-0badf00d')).toBe('x');
    expect(rootIdOf('x#dup-0badf00d#si')).toBe('x');
    expect(rootIdOf('xsi')).toBe('xsi');
  });

  it('US-09 AC23: the legacy rule decides when fromEpoch leaves a gap: only erasedAt\'s created rows cross', () => {
    // Epoch 3, listing only from 3: the erase at 2 listed nothing, and the
    // copy at 0 missed it.
    const erased = listed(rowsOf('old'), 3, 3);
    erased.meta.erasedAt = '2026-04-15T00:00:00Z';
    const stale = everyArray('new', everyArray('old'));
    for (const merged of [mergeFiles(stale, erased, OPTS), mergeFiles(erased, stale, OPTS)]) {
      // Created after erasedAt: the new measurement, lab value and document. The
      // medications and supplements carry no creation time, so they go.
      expect(idsIn(merged)).toEqual(['newd', 'newl', 'newm']);
    }
    // A copy at 2 missed only listed erases, so every unlisted row crosses.
    stale.meta.eraseEpoch = 2;
    expect(idsIn(mergeFiles(stale, erased, OPTS))).toEqual(rowsOf('new'));
  });

  it('US-09 AC23: the legacy rule decides when the winner has no list, and its listed rows still go', () => {
    const legacy = emptyFile();
    legacy.meta.eraseEpoch = 2;
    legacy.meta.erasedAt = '2026-04-15T00:00:00Z';
    const listing = everyArray('new', everyArray('old'));
    listing.schemaVersion = 2;
    listing.meta.eraseEpoch = 1;
    listing.erasedRows = { fromEpoch: 1, ids: ['oldm'] };
    for (const merged of [mergeFiles(listing, legacy, OPTS), mergeFiles(legacy, listing, OPTS)]) {
      // AC20's window over created rows; the old lab value and document
      // predate erasedAt and go; the listed weight goes whatever its clock.
      expect(idsIn(merged)).toEqual(['newd', 'newl', 'newm']);
      // The ids stay; a winner with no list claims nothing.
      expect(merged.erasedRows).toEqual({ fromEpoch: 3, ids: ['oldm'] });
      expect(merged.meta.eraseEpoch).toBe(2);
    }
    // No erasedAt either: none of the losing copy crosses.
    delete legacy.meta.erasedAt;
    expect(idsIn(mergeFiles(listing, legacy, OPTS))).toEqual([]);
  });

  it('US-09 AC23: a malformed list is dropped on read, and the legacy rule decides', () => {
    const erased = migrateFile({ ...listed(rowsOf('old')), erasedRows: { fromEpoch: 1, ids: ['oldm', 7] } }, OPTS);
    expect(erased.erasedRows).toBeUndefined();
    expect(idsIn(mergeFiles(everyArray('new', everyArray('old')), erased, OPTS))).toEqual([]);
  });

  it('US-09 AC23: ids union; at equal epochs an absent list claims nothing, and of two the larger fromEpoch stands', () => {
    const a = listed(['b-row', 'a-row'], 2, 1);
    const b = listed(['c-row', 'a-row'], 2, 2);
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.erasedRows).toEqual({ fromEpoch: 2, ids: ['a-row', 'b-row', 'c-row'] });
    }
    // The absent side may be its own erase at this epoch that listed nothing,
    // so the merged list keeps the ids and claims no erase at all.
    const absent = emptyFile();
    absent.meta.eraseEpoch = 2;
    for (const merged of [mergeFiles(a, absent, OPTS), mergeFiles(absent, a, OPTS)]) {
      expect(merged.erasedRows).toEqual({ fromEpoch: 3, ids: ['a-row', 'b-row'] });
      expect(merged.schemaVersion).toBe(2);
    }
    // Across the gate the winner's fromEpoch stands, and the loser's ids join.
    const older = listed(['z-row'], 1, 1);
    const newer = listed(['a-row'], 3, 2);
    for (const merged of [mergeFiles(older, newer, OPTS), mergeFiles(newer, older, OPTS)]) {
      expect(merged.erasedRows).toEqual({ fromEpoch: 2, ids: ['a-row', 'z-row'] });
    }
    // Neither has one: none appears, and the version stays where it was.
    const plain = mergeFiles(emptyFile(), emptyFile(), OPTS);
    expect('erasedRows' in plain).toBe(false);
    expect(plain.schemaVersion).toBe(1);
  });

  it('US-09 AC23: an old-app erase and a listing erase at one epoch still keep a stale copy\'s pre-erase row out (adversary R1)', () => {
    // The cloud: erased by an old bundle at epoch 1 on 1 September, no list.
    const drive = emptyFile();
    drive.meta.eraseEpoch = 1;
    drive.meta.erasedAt = '2026-09-01T00:00:00.001Z';
    // A laptop that never took that erase in: epoch 0, an August LDL.
    const laptop = emptyFile();
    laptop.measurements = [measurement({ id: 'pre-erase-ldl', metricType: 'ldl', value: 3, recordedAt: '2026-08-01', createdAt: '2026-08-01T00:00:00Z' })];
    // This browser: a guest copy erased by the new app at epoch 1, then lifted into the cloud.
    const guest = listed(['guest-row']);
    guest.meta.erasedAt = '2026-10-19T00:00:00.001Z';
    const lifted = mergeFiles(guest, drive, OPTS);
    expect(lifted.erasedRows).toEqual({ fromEpoch: 2, ids: ['guest-row'] });
    for (const merged of [mergeFiles(laptop, lifted, OPTS), mergeFiles(lifted, laptop, OPTS)]) {
      expect(merged.measurements.map((r) => r.id)).toEqual([]);
    }
  });

  it('US-09 AC23: at one epoch, a listing erase takes the unlisted erase\'s erasedAt, so a stale copy keeps a row typed between them (adversary re-check R2)', () => {
    // The cloud: erased by an old app at epoch 1 on 1 September, no list.
    const drive = emptyFile();
    drive.meta.eraseEpoch = 1;
    drive.meta.erasedAt = '2026-09-01T00:00:00.001Z';
    // A guest copy erased by the new app at epoch 1 on 21 October, listing its rows.
    const guest = listed(['guest-row']);
    guest.meta.erasedAt = '2026-10-21T00:00:00.001Z';
    // A laptop at epoch 0: an LDL from before the cloud erase, an HDL typed after it.
    const laptop = emptyFile();
    laptop.measurements = [
      measurement({ id: 'pre', metricType: 'ldl', value: 3, recordedAt: '2026-08-01', createdAt: '2026-08-01T00:00:00Z' }),
      measurement({ id: 'mid', metricType: 'hdl', value: 1.4, recordedAt: '2026-09-15', createdAt: '2026-09-15T00:00:00Z' }),
    ];
    for (const lifted of [mergeFiles(guest, drive, OPTS), mergeFiles(drive, guest, OPTS)]) {
      expect(lifted.meta.erasedAt).toBe('2026-09-01T00:00:00.001Z');
      for (const merged of [mergeFiles(laptop, lifted, OPTS), mergeFiles(lifted, laptop, OPTS)]) {
        expect(merged.measurements.map((r) => r.id)).toEqual(['mid']);
      }
      // The lifted list claims nothing (fromEpoch 2 at epoch 1), so meeting a
      // stale copy of the guest file again keeps the unlisted erase's time.
      for (const again of [mergeFiles(lifted, guest, OPTS), mergeFiles(guest, lifted, OPTS)]) {
        expect(again.meta.erasedAt).toBe('2026-09-01T00:00:00.001Z');
        expect(mergeFiles(laptop, again, OPTS).measurements.map((r) => r.id)).toEqual(['mid']);
      }
    }
    // Both listing, or neither: the later erase time, as before.
    const other = listed(['other-row']);
    other.meta.erasedAt = '2026-09-01T00:00:00.001Z';
    for (const merged of [mergeFiles(guest, other, OPTS), mergeFiles(other, guest, OPTS)]) {
      expect(merged.meta.erasedAt).toBe('2026-10-21T00:00:00.001Z');
    }
    const plain = emptyFile();
    plain.meta.eraseEpoch = 1;
    plain.meta.erasedAt = '2026-10-21T00:00:00.001Z';
    for (const merged of [mergeFiles(drive, plain, OPTS), mergeFiles(plain, drive, OPTS)]) {
      expect(merged.meta.erasedAt).toBe('2026-10-21T00:00:00.001Z');
    }
  });

  it('US-09 AC23: a guest erase listing a copied-down row removes it from a cloud connected later, keeps the cloud\'s unseen rows, and resets its profile (Codex re-check R1, adversary re-check R1)', () => {
    // The cloud: r1 was copied down to this browser on a provider switch; r2 came later.
    const drive = emptyFile();
    drive.measurements = [
      measurement({ id: 'r1', metricType: 'ldl', value: 3, recordedAt: '2026-09-01', createdAt: '2026-09-01T00:00:00Z' }),
      measurement({ id: 'r2', metricType: 'hdl', value: 1.4, recordedAt: '2026-10-10', createdAt: '2026-10-10T00:00:00Z' }),
    ];
    drive.profile = { updatedAt: '2026-10-10T00:00:00Z', lamport: 5, heightCm: 180 };
    drive.screenings = { colorectalMethod: 'fit_annual', updatedAt: '2026-10-10T00:00:00Z', lamport: 5 };
    // The guest erase, with no cloud connected, listed what this browser held: r1.
    const guest = listed(['r1']);
    guest.meta.erasedAt = '2026-10-21T00:00:00.001Z';
    for (const merged of [mergeFiles(guest, drive, OPTS), mergeFiles(drive, guest, OPTS)]) {
      expect(merged.measurements.map((r) => r.id)).toEqual(['r2']);
      expect(merged.profile.heightCm).toBeUndefined();
      expect(merged.screenings.colorectalMethod).toBeUndefined();
    }
  });

  it('US-09 AC23: a losing row whose id is not a string is skipped, not thrown on (adversary R4)', () => {
    const stale = everyArray('new');
    stale.measurements.push({ ...measurement({ id: 'x', metricType: 'ldl', value: 3 }), id: 7 as unknown as string });
    const erased = listed([]);
    for (const merged of [mergeFiles(stale, erased, OPTS), mergeFiles(erased, stale, OPTS)]) {
      expect(idsIn(merged)).toEqual(rowsOf('new'));
    }
  });

  it('US-09 AC23: the merge is symmetric and deterministic across the gate', () => {
    const stale = everyArray('new', everyArray('old'));
    stale.meta.lamport = 7;
    const erased = listed(rowsOf('old'));
    erased.meta.lamport = 3;
    expect(stableStringify(mergeFiles(stale, erased, OPTS))).toBe(stableStringify(mergeFiles(erased, stale, OPTS)));
    expect(mergeFiles(stale, erased, OPTS).meta.lamport).toBe(8);
  });

  it('US-09 AC23: no stale singleton or reminder setting rides in with the kept rows, and the clock covers them', () => {
    const stale = everyArray('new');
    stale.profile = { updatedAt: '2030-01-01T00:00:00Z', lamport: 99, heightCm: 150 };
    stale.reminderPreferences = [{ category: 'lipids', enabled: false, ...STAMP }];
    stale.measurements.push(measurement({ id: 'late', metricType: 'ldl', value: 2, createdAt: '2027-01-01T00:00:00Z' }));
    const erased = listed([]);
    const merged = mergeFiles(stale, erased, OPTS);
    expect(merged.profile.heightCm).toBeUndefined();
    expect(merged.reminderPreferences).toEqual([]);
    expect(merged.measurements.map((m) => m.id).sort()).toEqual(['late', 'newm']);
    expect(merged.meta.updatedAt >= '2027-01-01T00:00:00Z').toBe(true);
  });

  it('US-09 AC23: rowRootIds names every row an erase made now would list', () => {
    const file = everyArray('old');
    file.labValues.push({ ...lab('oldl#si'), correctsId: 'oldl' });
    expect([...new Set(rowRootIds(file))].sort()).toEqual(rowsOf('old'));
  });
});

// US-21 phase 3 — migrate.ts writes the converted row under `<id>#si`, and it
// groups on its OWN id: stripped here, the conversion would collapse into its
// parent's group and one of the two contents would be quarantined instead.
describe('baseIdOf strips the quarantine suffix and nothing else', () => {
  it('leaves the #si conversion id alone', () => {
    expect(baseIdOf('row-1#si')).toBe('row-1#si');
    expect(baseIdOf('row-1#dup-deadbeef')).toBe('row-1');
    expect(baseIdOf('row-1#si#dup-deadbeef')).toBe('row-1#si');
  });
});

// US-34 AC3: the widget announces a remote change by what a person would see,
// which leaves out every record's own clock. The same key sort, told which
// keys to drop, at every depth; with none it is the merge tiebreak unchanged.
describe('stableStringify with keys to drop', () => {
  const value = { b: 1, a: { lamport: 2, rows: [{ updatedAt: 't', y: 1 }] } };

  it('drops the named keys at every depth, arrays included', () => {
    expect(stableStringify(value, new Set(['lamport', 'updatedAt']))).toBe('{"a":{"rows":[{"y":1}]},"b":1}');
  });

  it('keeps every key when told of none', () => {
    expect(stableStringify(value)).toBe('{"a":{"lamport":2,"rows":[{"updatedAt":"t","y":1}]},"b":1}');
  });
});

// US-05 AC2: the Lp(a) unit the user chose is a profile preference. It merges
// as any profile field does, with no code of its own.
describe('US-05 AC2 — profile.lpaUnit merges as an ordinary profile field', () => {
  it('two devices choose different units: the later stamp wins, whichever side merges', () => {
    const phone = emptyFile();
    phone.profile = { sex: 'female', updatedAt: T0, lamport: 1 };
    const laptop = structuredClone(phone);
    laptop.profile = stampFields(laptop.profile, { lpaUnit: 'nmol/L' }, T1);
    phone.profile = stampFields(phone.profile, { lpaUnit: 'mg/L' }, T2);
    for (const merged of [mergeFiles(phone, laptop, OPTS), mergeFiles(laptop, phone, OPTS)]) {
      expect(merged.profile).toMatchObject({ sex: 'female', lpaUnit: 'mg/L' });
    }
    // A later choice on the other device wins back.
    laptop.profile = stampFields(mergeFiles(phone, laptop, OPTS).profile, { lpaUnit: 'mg/dL' }, '2026-05-03T00:00:00Z');
    expect(mergeFiles(phone, laptop, OPTS).profile.lpaUnit).toBe('mg/dL');
  });

  it('a unit chosen on one device survives another device’s later write to a different field', () => {
    const a = emptyFile();
    a.profile = { heightCm: 170, updatedAt: T0, lamport: 1 };
    const b = structuredClone(a);
    a.profile = stampFields(a.profile, { lpaUnit: 'mg/dL' }, T1);
    b.profile = stampFields(b.profile, { heightCm: 171 }, T2);
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.profile).toMatchObject({ heightCm: 171, lpaUnit: 'mg/dL' });
    }
  });

  it('a file written before the field reads it as absent, with no migration', () => {
    const old = emptyFile();
    old.profile = { sex: 'male', unitSystem: 'conventional', updatedAt: T0, lamport: 1 };
    const read = migrateFile(JSON.parse(JSON.stringify(old)), { deviceId: 'dev_new', now: T1 });
    expect(read.profile.lpaUnit).toBeUndefined();
    expect(mergeFiles(read, emptyFile(), OPTS).profile.lpaUnit).toBeUndefined();
  });
});
