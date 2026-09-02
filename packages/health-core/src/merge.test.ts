import { describe, it, expect } from 'vitest';
import { mergeFiles } from './merge';
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

describe('mergeFiles — append-only logs & snapshots', () => {
  it('unions medicationHistory and documents by id', () => {
    const a = emptyFile();
    const b = emptyFile();
    const histRow = (id: string): FileMedication => ({ id, medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '2026-05-01T00:00:00Z', lamport: 1 });
    a.medicationHistory = [histRow('h1'), histRow('h2')];
    b.medicationHistory = [histRow('h2'), histRow('h3')];
    expect(mergeFiles(a, b, OPTS).medicationHistory.map((h) => h.id)).toEqual(['h1', 'h2', 'h3']);

    const doc = (id: string): FileDocument => ({ id, title: id, type: 'lab_report' as any, date: '2026-05-01', fileRef: `documents/${id}.pdf`, contentHash: `sha256-${id}`, mimeType: 'application/pdf', extractedText: '', addedAt: '2026-05-01T00:00:00Z' });
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
