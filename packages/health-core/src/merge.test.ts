import { describe, it, expect } from 'vitest';
import { baseIdOf, mergeFiles, stampFields } from './merge';
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

// US-10 AC6: the newest edit to ONE field used to carry its writer's copy of
// every other field, because the two singletons merged as whole objects.
describe('mergeFiles — profile and screenings merge field by field (US-10 AC6)', () => {
  const T0 = '2026-05-01T00:00:00Z'; // the copy both devices read
  const T1 = '2026-05-02T09:00:00Z'; // B's write
  const T2 = '2026-05-02T09:05:00Z'; // A's write, later, made without seeing B's

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

  it('two copies from before field stamps merge exactly as they always did: the whole newer object', () => {
    const cases: Array<[RoadmapFile['profile'], RoadmapFile['profile'], 'a' | 'b']> = [
      // Higher lamport, even with the older time.
      [{ heightCm: 180, birthYear: 1971, updatedAt: T2, lamport: 2 }, { heightCm: 181, updatedAt: T1, lamport: 5 }, 'b'],
      // Tied lamport: the later time.
      [{ heightCm: 180, birthYear: 1971, updatedAt: T2, lamport: 2 }, { heightCm: 181, updatedAt: T1, lamport: 2 }, 'a'],
      // Tied stamps: the larger content, the tiebreak `stampIsNewer` always had.
      [{ heightCm: 180, updatedAt: T1, lamport: 2 }, { heightCm: 181, updatedAt: T1, lamport: 2 }, 'b'],
    ];
    for (const [pa, pb, winner] of cases) {
      const a = emptyFile();
      const b = emptyFile();
      a.profile = pa;
      b.profile = pb;
      // Content chosen so the tied case picks the same side as the profile.
      a.screenings = { breastFrequency: 'annual', updatedAt: pa.updatedAt, lamport: pa.lamport };
      b.screenings = { colorectalMethod: 'fit_annual', updatedAt: pb.updatedAt, lamport: pb.lamport };
      const won = winner === 'a' ? a : b;
      for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
        expect(merged.profile).toStrictEqual(won.profile);
        expect(merged.screenings).toStrictEqual(won.screenings);
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

describe('stampFields — a write stamps only the fields it changes (US-10 AC6)', () => {
  const T0 = '2026-05-01T00:00:00Z';
  const T1 = '2026-05-02T09:00:00Z';
  const T2 = '2026-05-02T09:05:00Z';

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

describe('mergeFiles — keepNewerThan (the on-device fallback, US-09 AC13)', () => {
  const SINCE = '2026-05-10T00:00:00Z';
  const FALLBACK = { ...OPTS, keepNewerThan: SINCE };

  /** The cloud copy a device that fell back comes back to: erased once already. */
  function erasedCloud(): RoadmapFile {
    const cloud = emptyFile();
    cloud.meta.eraseEpoch = 1;
    return cloud;
  }

  it('US-09 AC13: keeps the fallback session\'s own rows and drops the stale ones, epoch stays the winner\'s', () => {
    const device = emptyFile(); // epoch 0 — the empty file the fallback started on
    device.measurements = [
      measurement({ id: 'during', metricType: 'weight', value: 80, recordedAt: '2026-05-11', createdAt: '2026-05-11T09:00:00Z' }),
      measurement({ id: 'before', metricType: 'weight', value: 95, recordedAt: '2026-05-01', createdAt: '2026-05-01T09:00:00Z' }),
    ];
    const merged = mergeFiles(device, erasedCloud(), FALLBACK);
    expect(merged.measurements.map((m) => m.id)).toEqual(['during']);
    expect(merged.meta.eraseEpoch).toBe(1);
  });

  it('US-09 AC13: carries the session\'s lab values, supplements and documents too', () => {
    const device = emptyFile();
    device.labValues = [
      { id: 'lv1', metricName: 'ferritin', value: 90, unit: 'ng/mL', referenceLow: null, referenceHigh: null, recordedAt: '2026-05-11', createdAt: '2026-05-11T09:00:00Z', source: 'manual', status: 'active', correctsId: null },
    ];
    device.supplements = [
      { id: 's1', supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: null, doseUnit: null, status: 'active', startedAt: '2026-05-11', updatedAt: '2026-05-11T09:00:00Z', lamport: 1 },
    ];
    device.documents = [
      { id: 'd1', title: 'Labs', type: 'pathology_report', date: '2026-05-11', fileRef: '', contentHash: '', mimeType: '', extractedText: 'x', addedAt: '2026-05-11T09:00:00Z' },
    ];
    const merged = mergeFiles(device, erasedCloud(), FALLBACK);
    expect(merged.labValues.map((r) => r.id)).toEqual(['lv1']);
    expect(merged.supplements.map((r) => r.id)).toEqual(['s1']);
    expect(merged.documents.map((r) => r.id)).toEqual(['d1']);
  });

  it('US-09 AC13: when the device erased and the cloud is stale, the gate is untouched', () => {
    const device = emptyFile();
    device.meta.eraseEpoch = 2;
    const stale = emptyFile();
    stale.meta.eraseEpoch = 1;
    stale.measurements = [measurement({ id: 'cloud1', metricType: 'weight', value: 95, createdAt: '2026-05-11T09:00:00Z' })];
    const merged = mergeFiles(device, stale, FALLBACK);
    expect(merged.measurements).toEqual([]);
    expect(merged.meta.eraseEpoch).toBe(2);
  });

  it('US-09 AC13: a row stamped at exactly the fallback instant is kept', () => {
    const device = emptyFile();
    device.measurements = [measurement({ id: 'onTheDot', metricType: 'weight', value: 80, createdAt: SINCE })];
    expect(mergeFiles(device, erasedCloud(), FALLBACK).measurements.map((m) => m.id)).toEqual(['onTheDot']);
  });

  it('US-09 AC13: the merged clock never sits behind a row it just kept', () => {
    const device = emptyFile();
    device.measurements = [measurement({ id: 'late', metricType: 'weight', value: 80, createdAt: '2027-01-01T00:00:00Z' })];
    const merged = mergeFiles(device, erasedCloud(), FALLBACK);
    // migrate.ts clamps any row that post-dates meta.updatedAt back to it — a
    // meta behind the kept row would rewrite it on the next load.
    expect(merged.meta.updatedAt >= '2027-01-01T00:00:00Z').toBe(true);
  });

  it('US-09 AC13: a stale device profile never rides back in with the kept rows', () => {
    const device = emptyFile();
    // A device copy that predates the erase, with a clock and a clock count that
    // would win an ordinary last-write-wins contest.
    device.profile = { updatedAt: '2030-01-01T00:00:00Z', lamport: 99, heightCm: 150 };
    device.screenings = { updatedAt: '2030-01-01T00:00:00Z', lamport: 99 };
    device.measurements = [measurement({ id: 'during', metricType: 'weight', value: 80, createdAt: '2026-05-11T09:00:00Z' })];
    const cloud = erasedCloud();
    cloud.profile = { updatedAt: '2026-05-09T00:00:00Z', lamport: 1, heightCm: 180 };
    const merged = mergeFiles(device, cloud, FALLBACK);
    expect(merged.profile).toEqual(cloud.profile);
    expect(merged.screenings).toEqual(cloud.screenings);
    expect(merged.measurements.map((m) => m.id)).toEqual(['during']); // the rows still travel
  });

  it('US-09 AC14: field stamps carry no singleton past an erase, with the option or without it', () => {
    const device = emptyFile();
    // Field-stamped edits made during the fallback, on the pre-erase copy.
    device.profile = stampFields<RoadmapProfile>({ updatedAt: '2026-05-01T00:00:00Z', lamport: 3, heightCm: 150 }, { birthYear: 1970 }, '2026-05-11T09:00:00Z');
    device.screenings = stampFields(device.screenings, { colorectalMethod: 'fit_annual' }, '2026-05-11T09:00:00Z');
    device.measurements = [measurement({ id: 'during', metricType: 'weight', value: 80, createdAt: '2026-05-11T09:00:00Z' })];
    const cloud = erasedCloud();
    cloud.profile = stampFields(cloud.profile, { heightCm: 180 }, '2026-05-09T00:00:00Z');

    const kept = mergeFiles(device, cloud, FALLBACK);
    expect(kept.profile).toEqual(cloud.profile);
    expect(kept.screenings).toEqual(cloud.screenings);
    expect(kept.measurements.map((m) => m.id)).toEqual(['during']); // the rows still travel

    const gated = mergeFiles(device, cloud, OPTS);
    expect(gated.profile).toEqual(cloud.profile);
    expect(gated.screenings).toEqual(cloud.screenings);
    expect(gated.measurements).toEqual([]);
  });

  it('US-09 AC13: without the option the epoch gate is exactly what it was', () => {
    const device = emptyFile();
    device.measurements = [measurement({ id: 'during', metricType: 'weight', value: 80, createdAt: '2026-05-11T09:00:00Z' })];
    const merged = mergeFiles(device, erasedCloud(), OPTS);
    expect(merged.measurements).toEqual([]);
    expect(merged.meta.eraseEpoch).toBe(1);
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
