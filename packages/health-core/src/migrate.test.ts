import { describe, it, expect } from 'vitest';
import { migrateFile, SchemaTooNewError } from './migrate';
import { mergeFiles } from './merge';
import { CURRENT_SCHEMA_VERSION, createEmptyFile, createMeasurement, stableStringify, type FileMeasurement } from './roadmap-file';

const OPTS = { deviceId: 'dev_x', now: '2026-06-08T00:00:00Z' };

describe('migrateFile', () => {
  it('returns a fresh empty file for null / non-object input', () => {
    for (const bad of [null, undefined, 42, 'nope', []]) {
      const f = migrateFile(bad, OPTS);
      expect(f.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(f.measurements).toEqual([]);
      expect(f.meta.lastDeviceId).toBe('dev_x');
    }
  });

  it('fills in missing arrays/objects without crashing on a partial file', () => {
    const f = migrateFile({ schemaVersion: 1, profile: { sex: 'male' } }, OPTS);
    expect(f.profile.sex).toBe('male');
    expect(f.profile.updatedAt).toBeTypeOf('string');
    expect(Array.isArray(f.measurements)).toBe(true);
    expect(Array.isArray(f.medications)).toBe(true);
    expect(f.screenings.updatedAt).toBeTypeOf('string');
  });

  it('passes a well-formed v1 file through intact', () => {
    const input = {
      schemaVersion: 1,
      meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z', lastDeviceId: 'dev_orig', lamport: 9 },
      profile: { sex: 'female', heightCm: 165, updatedAt: '2026-05-01T00:00:00Z', lamport: 4 },
      measurements: [{ id: 'm1', metricType: 'ldl', value: 2.1, recordedAt: '2026-05-01', createdAt: '2026-05-01T08:00:00Z', source: 'manual', status: 'active', correctsId: null, externalId: null }],
      medications: [], medicationHistory: [], supplements: [], supplementHistory: [],
      screenings: { updatedAt: '2026-05-01T00:00:00Z', lamport: 0 },
      labValues: [], documents: [], reminderPreferences: [], recommendationSnapshots: [],
    };
    const f = migrateFile(input, OPTS);
    expect(f.meta.lamport).toBe(9);
    expect(f.meta.lastDeviceId).toBe('dev_orig'); // existing meta preserved, not overwritten
    expect(f.measurements).toHaveLength(1);
    expect(f.profile.heightCm).toBe(165);
  });

  it('preserves unknown fields (forward-compat rule 1)', () => {
    const f = migrateFile({ schemaVersion: 1, brandNewSection: [1, 2, 3] }, OPTS) as any;
    expect(f.brandNewSection).toEqual([1, 2, 3]);
  });

  it('throws SchemaTooNewError when the file is from a newer app', () => {
    expect(() => migrateFile({ schemaVersion: 99 }, OPTS)).toThrow(SchemaTooNewError);
    try {
      migrateFile({ schemaVersion: 99 }, OPTS);
    } catch (e) {
      expect((e as SchemaTooNewError).fileVersion).toBe(99);
      expect((e as SchemaTooNewError).appVersion).toBe(CURRENT_SCHEMA_VERSION);
    }
  });

  it('treats a missing schemaVersion as the current version', () => {
    expect(migrateFile({ profile: {} }, OPTS).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('migrateFile — sloppy second writer (US-29; invariants for US-10/US-11)', () => {
  const MEAS: FileMeasurement = {
    id: 'm1', metricType: 'ldl', value: 2.1, recordedAt: '2026-05-01',
    createdAt: '2026-05-01T08:00:00Z', source: 'manual', status: 'active',
    correctsId: null, externalId: null,
  };
  const META = {
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    lastDeviceId: 'dev_a', lamport: 5,
  };
  function rawFile(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      meta: META,
      profile: { sex: 'male', updatedAt: '2026-06-01T00:00:00Z', lamport: 2 },
      measurements: [], medications: [], medicationHistory: [],
      supplements: [], supplementHistory: [],
      screenings: { updatedAt: '2026-06-01T00:00:00Z', lamport: 0 },
      labValues: [], documents: [], reminderPreferences: [], recommendationSnapshots: [],
      ...over,
    };
  }

  // Defect 2: meta.eraseEpoch is honoured unvalidated. A negative epoch (a
  // sloppy hand edit) makes localEpoch !== remoteEpoch, and every comparison
  // against it loses — so the merge takes the WHOLESALE branch and silently
  // discards this file's rows in favour of the peer.
  it('sanitises an out-of-range meta.eraseEpoch instead of letting it wipe the file', () => {
    const f = migrateFile(rawFile({ meta: { ...META, eraseEpoch: -1 }, measurements: [MEAS] }), OPTS);
    expect(f.meta.eraseEpoch).toBe(0);
    const peer = migrateFile(rawFile(), OPTS);
    expect(mergeFiles(f, peer, OPTS).measurements).toHaveLength(1);
    expect(mergeFiles(peer, f, OPTS).measurements).toHaveLength(1);

    // 1e400 parses out of JSON as Infinity; it must not win an erase forever.
    const inf = migrateFile(rawFile({ meta: { ...META, eraseEpoch: Infinity } }), OPTS);
    expect(Number.isSafeInteger(inf.meta.eraseEpoch!)).toBe(true);
  });

  // Defect 2 (cont.): a saturated meta.lamport breaks the file clock forever —
  // max(local, remote) + 1 stops advancing, so nothing can order writes again.
  it('clamps meta.lamport to a value the +1 increment can still advance', () => {
    const f = migrateFile(rawFile({ meta: { ...META, lamport: 1e308 } }), OPTS);
    expect(Number.isSafeInteger(f.meta.lamport)).toBe(true);
    expect(f.meta.lamport + 1).toBeGreaterThan(f.meta.lamport);
    expect(migrateFile(rawFile({ meta: { ...META, lamport: -3 } }), OPTS).meta.lamport).toBe(0);
    expect(migrateFile(rawFile({ meta: { ...META, lamport: 1.5 } }), OPTS).meta.lamport).toBe(1);
  });

  // Defect 3: a writer-supplied huge lamport + future updatedAt on an LWW row
  // wins EVERY future conflict, so the user's own edits silently revert — a
  // medication statement they can never correct.
  it('clamps a row lamport/updatedAt so the user can still overwrite the value', () => {
    const frozen = {
      id: 'med_statin', medicationKey: 'statin', drugName: 'agent_wrote_this',
      doseValue: null, doseUnit: null, updatedAt: '2099-01-01T00:00:00Z', lamport: 1e308,
    };
    const f = migrateFile(rawFile({ medications: [frozen] }), OPTS);
    expect(f.medications[0].updatedAt).toBe(META.updatedAt);

    const row = f.medications[0];
    const edited = { ...row, drugName: 'rosuvastatin', lamport: (row.lamport ?? 0) + 1, updatedAt: '2026-06-02T00:00:00Z' };
    const merged = mergeFiles({ ...f, medications: [edited] }, f, OPTS);
    expect(merged.medications[0].drugName).toBe('rosuvastatin');
  });

  // Defect 4: a future createdAt beats every later genuine entry in the slot,
  // flipping the user's own fresh value to 'entered-in-error'.
  it('clamps a future createdAt so a genuine later entry still wins its slot', () => {
    const forged = { ...MEAS, id: 'agent', value: 9.9, createdAt: '2099-01-01T00:00:00Z' };
    const f = migrateFile(rawFile({ measurements: [forged] }), OPTS);
    expect(f.measurements[0].createdAt).toBe(META.updatedAt);

    const mine = { ...MEAS, id: 'mine', value: 2.1, createdAt: '2026-06-02T09:00:00Z' };
    const merged = mergeFiles({ ...f, measurements: [...f.measurements, mine] }, f, OPTS);
    const actives = merged.measurements.filter((m) => m.status === 'active');
    expect(actives).toHaveLength(1);
    expect(actives[0].id).toBe('mine');
  });

  // Adversarial review (2026-09-01): the anchor was any string. `updatedAt: ""`
  // sorts below every timestamp, so EVERY row's clock was clamped to "" — slot
  // order collapsed to id tie-breaks and every LWW record froze together.
  it('ignores garbage meta timestamps instead of clamping every row to them', () => {
    const rows = [
      { ...MEAS, id: 'a', createdAt: '2026-05-01T08:00:00Z' },
      { ...MEAS, id: 'b', createdAt: '2026-05-02T08:00:00Z' },
    ];
    const med = { id: 'm', medicationKey: 'statin', drugName: 'x', doseValue: null, doseUnit: null, updatedAt: '2026-05-01T00:00:00Z', lamport: 4 };
    const f = migrateFile(
      rawFile({ meta: { ...META, createdAt: '', updatedAt: '' }, measurements: rows, medications: [med] }),
      OPTS,
    );
    expect(f.measurements.map((m) => m.createdAt)).toEqual([
      '2026-05-01T08:00:00Z',
      '2026-05-02T08:00:00Z',
    ]);
    expect(f.medications[0].updatedAt).toBe('2026-05-01T00:00:00Z');
  });

  // Adversarial review (2026-09-01): a null entry in an array passed straight
  // through the load, then made EVERY save throw in the merge — including the
  // localStorage mirror the failure path falls back to, so persistence died
  // with no remedy the user could reach.
  it('drops non-object array entries so a file with nulls still loads AND saves', () => {
    const f = migrateFile(
      rawFile({
        measurements: [null, MEAS, 'nope'],
        documents: [null, { id: 'd1', title: 't', type: 'other', date: null, fileRef: '', contentHash: '', mimeType: '', extractedText: '', addedAt: '2026-05-01T00:00:00Z' }],
        medications: [null],
      }),
      OPTS,
    );
    expect(f.measurements.map((m) => m.id)).toEqual(['m1']);
    expect(f.documents.map((d) => d.id)).toEqual(['d1']);
    expect(f.medications).toEqual([]);
    expect(() => mergeFiles(f, migrateFile(rawFile(), OPTS), OPTS)).not.toThrow();
  });

  // No mass rewrites: a file the real code paths produced must survive a
  // migrate + self-merge byte-identical outside meta (which merge re-stamps).
  it('leaves a legitimate file untouched through migrate + self-merge', () => {
    const d1 = createEmptyFile({ deviceId: 'dev1', now: '2026-05-01T00:00:00Z' });
    d1.measurements = [
      createMeasurement({ id: 'a1', metricType: 'ldl', value: 2.2, recordedAt: '2026-05-01', createdAt: '2026-05-01T08:00:00Z' }),
    ];
    d1.medications = [{ id: 'med_1', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg', updatedAt: '2026-05-01T08:00:00Z', lamport: 1 }];
    d1.profile = { sex: 'male', heightCm: 180, updatedAt: '2026-05-01T08:00:00Z', lamport: 2 };
    let cloud = mergeFiles(d1, createEmptyFile({ deviceId: 'dev1', now: '2026-04-01T00:00:00Z' }), { deviceId: 'dev1', now: '2026-05-01T10:00:00Z' });

    const d2 = createEmptyFile({ deviceId: 'dev2', now: '2026-05-02T00:00:00Z' });
    d2.measurements = [
      createMeasurement({ id: 'b1', metricType: 'hba1c', value: 35, recordedAt: '2026-05-02', createdAt: '2026-05-02T08:00:00Z' }),
    ];
    cloud = mergeFiles(d2, cloud, { deviceId: 'dev2', now: '2026-05-02T10:00:00Z' });

    const onDisk = JSON.parse(JSON.stringify(cloud));
    const roundTripped = mergeFiles(migrateFile(onDisk, OPTS), migrateFile(onDisk, OPTS), OPTS);
    expect(stableStringify({ ...roundTripped, meta: null })).toBe(stableStringify({ ...cloud, meta: null }));
  });

  const medRow = (over: Record<string, unknown>) => ({
    id: 'med_statin', medicationKey: 'statin', drugName: 'x',
    doseValue: null, doseUnit: null, lamport: 3, ...over,
  });

  // Adversarial review (2026-09-01): sanitizeStamp only inspected a STRING
  // updatedAt, so an agent writing epoch millis (a number) passed through. In
  // stampIsNewer's tied-lamport branch, `number > string` and `string > number`
  // are both false — neither row is newer either way round, so the survivor was
  // whichever side was passed as `remote`: mergeFiles(a, b) !== mergeFiles(b, a).
  it('coerces a non-string row updatedAt so the merge stays symmetric', () => {
    const numeric = migrateFile(rawFile({ medications: [medRow({ drugName: 'agent', updatedAt: 1780000000000 })] }), OPTS);
    const iso = migrateFile(rawFile({ medications: [medRow({ drugName: 'mine', updatedAt: '2026-05-01T00:00:00Z' })] }), OPTS);
    expect(numeric.medications[0].updatedAt).toBe('');

    expect(mergeFiles(numeric, iso, OPTS).medications).toEqual(mergeFiles(iso, numeric, OPTS).medications);
    // "" sorts below every ISO string, so the well-formed row wins the tie.
    expect(mergeFiles(numeric, iso, OPTS).medications[0].drugName).toBe('mine');
  });

  it('keeps two coerced stamps ordered, and leaves an absent updatedAt absent', () => {
    // Both stamps coerced to "": the stableStringify tie-break in stampIsNewer
    // still names one winner, so the merge stays symmetric.
    const a = migrateFile(rawFile({ medications: [medRow({ drugName: 'a', updatedAt: 1 })] }), OPTS);
    const b = migrateFile(rawFile({ medications: [medRow({ drugName: 'b', updatedAt: null })] }), OPTS);
    expect(b.medications[0].updatedAt).toBe('');
    expect(mergeFiles(a, b, OPTS).medications).toEqual(mergeFiles(b, a, OPTS).medications);

    // Absent is not the same as garbage — present-beats-absent still decides.
    const absent = migrateFile(rawFile({ medications: [{ id: 'm', medicationKey: 'statin', drugName: 'x', doseValue: null, doseUnit: null, lamport: 1 }] }), OPTS);
    expect('updatedAt' in absent.medications[0]).toBe(false);
  });
});
