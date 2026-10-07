import { describe, it, expect } from 'vitest';
import { migrateFile, SchemaTooNewError } from './migrate';
import { mergeFiles } from './merge';
import { CURRENT_SCHEMA_VERSION, createEmptyFile, createMeasurement, stableStringify, type FileLabValue, type FileMeasurement } from './roadmap-file';

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

  // US-10 AC6: the per-field clocks on the two singletons are writer-supplied
  // stamps like any other, and a future one would freeze its field the same way.
  it('sanitises the field stamps on profile and screenings, and adds none to a file without them', () => {
    const f = migrateFile(rawFile({
      profile: {
        sex: 'male', heightCm: 180, updatedAt: '2026-06-01T00:00:00Z', lamport: 2,
        fieldStamps: {
          heightCm: { lamport: 2, updatedAt: '2099-01-01T00:00:00Z', note: 'not a clock' },
          sex: 'not a stamp',
          birthYear: { lamport: 1e308, updatedAt: 42 },
          unitSystem: {}, // no clock at all: the lowest stamp there is
          birthMonth: { lamport: 1 },
        },
      },
      screenings: { updatedAt: '2026-06-01T00:00:00Z', lamport: 0, fieldStamps: 'not a map' },
    }), OPTS);
    expect(f.profile.fieldStamps).toEqual({
      heightCm: { lamport: 2, updatedAt: META.updatedAt },
      birthYear: { lamport: 1e12, updatedAt: '' },
      unitSystem: { lamport: 0, updatedAt: '' },
      birthMonth: { lamport: 1, updatedAt: '' },
    });
    expect(f.screenings).not.toHaveProperty('fieldStamps');
    expect(migrateFile(rawFile(), OPTS).profile).not.toHaveProperty('fieldStamps');
  });

  // US-10 AC6 (adversarial review, 2026-09-25): a profile or screenings with
  // no `updatedAt`, or a mistyped one, took the migration's own time, so an
  // agent's unstamped write beat a real edit made before it was read. It is an
  // unknown time, the bottom, as `sanitizeStamp` reads a mistyped row stamp.
  it('reads a missing or mistyped profile or screenings updatedAt as the bottom, not as now', () => {
    for (const updatedAt of [undefined, 1718000000000, null]) {
      const f = migrateFile(rawFile({
        profile: { sex: 'female', lamport: 2, ...(updatedAt === undefined ? null : { updatedAt }) },
        screenings: { colorectalMethod: 'fit_annual', lamport: 0, ...(updatedAt === undefined ? null : { updatedAt }) },
      }), OPTS);
      expect(f.profile.updatedAt).toBe('');
      expect(f.screenings.updatedAt).toBe('');
      const edited = migrateFile(rawFile({ profile: { sex: 'male', lamport: 2, updatedAt: '2026-05-01T00:00:00Z' } }), OPTS);
      expect(mergeFiles(f, edited, OPTS).profile.sex).toBe('male');
      expect(mergeFiles(edited, f, OPTS).profile.sex).toBe('male');
    }
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

// ---------------------------------------------------------------------------
// US-21 phase 3 — legacy rows reach SI by CORRECTION, never by mutation
// ---------------------------------------------------------------------------
// Rows written before phase 3 hold the unit their lab printed. A row is never
// edited in place (the FHIR rule), so load appends a deterministic correction
// row — same id and same content on every device, so merge folds the copies
// into one — and flips the printed row to `entered-in-error`.
describe('US-21 phase 3 — legacy lab rows are corrected into SI at load', () => {
  const labRow = (over: Partial<FileLabValue> & { id: string }): FileLabValue => ({
    metricName: 'vitamin_d', value: 32, unit: 'ng/mL', referenceLow: 30, referenceHigh: 100,
    recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', source: 'lab_import',
    status: 'active', correctsId: null, ...over,
  });
  const fileWith = (rows: FileLabValue[]) => ({
    schemaVersion: 1,
    meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', lastDeviceId: 'dev_a', lamport: 3 },
    labValues: rows,
  });

  it('US-21 phase 3 — a legacy row gets a #si child; the printed row is flipped, never rewritten', () => {
    const out = migrateFile(fileWith([labRow({ id: 'l1' })]), OPTS);
    expect(out.labValues).toHaveLength(2);
    const [printed, si] = out.labValues;
    expect(printed).toMatchObject({ id: 'l1', value: 32, unit: 'ng/mL', status: 'entered-in-error' });
    expect(si).toMatchObject({
      id: 'l1#si', metricName: 'vitamin_d', value: 79.872, unit: 'nmol/L',
      status: 'active', correctsId: 'l1', recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z',
    });
    expect(si.referenceLow).toBeCloseTo(74.88, 6);
    expect(si.referenceHigh).toBeCloseTo(249.6, 6);
  });

  it('US-21 phase 3 — converting twice is converting once: the second load is a no-op', () => {
    const once = migrateFile(fileWith([labRow({ id: 'l1' })]), OPTS);
    const twice = migrateFile(JSON.parse(JSON.stringify(once)), OPTS);
    expect(stableStringify(twice.labValues)).toBe(stableStringify(once.labValues));
    expect(migrateFile(JSON.parse(JSON.stringify(twice)), OPTS).labValues).toHaveLength(2);
  });

  it('US-21 phase 3 — a row already in the canonical unit, a superseded row and an unknown unit are all left alone', () => {
    const rows = [
      labRow({ id: 'canonical', value: 80, unit: 'nmol/L' }),
      labRow({ id: 'spelling', metricName: 'ferritin', value: 210, unit: 'ug/L' }),
      labRow({ id: 'superseded', status: 'entered-in-error' }),
      labRow({ id: 'unknown', metricName: 'ferritin', value: 210, unit: 'pmol/L' }),
      labRow({ id: 'uncatalogued', metricName: 'lipase', value: 44, unit: 'U/mL' }),
      // mg/dL under the bare molecule name is ambiguous, so it is refused at
      // the write and left exactly as it is at load (US-21 phase 3).
      labRow({ id: 'ambiguous', metricName: 'urea', value: 14, unit: 'mg/dL' }),
    ];
    const out = migrateFile(fileWith(rows), OPTS);
    expect(stableStringify(out.labValues)).toBe(stableStringify(rows));
  });

  it('US-21 AC14 — a legacy gm/dL row converts at ×10 on load, once; Units/L and 10^3/cmm rows are factor 1 and left alone', () => {
    const hb = labRow({ id: 'hb', metricName: 'Hemoglobin', value: 14.2, unit: 'gm/dL', referenceLow: 13.5, referenceHigh: 17.5 });
    const out = migrateFile(fileWith([hb]), OPTS);
    expect(out.labValues).toHaveLength(2);
    expect(out.labValues[0]).toMatchObject({ id: 'hb', value: 14.2, unit: 'gm/dL', status: 'entered-in-error' });
    expect(out.labValues[1]).toMatchObject({
      id: 'hb#si', metricName: 'Hemoglobin', value: 142, unit: 'g/L', referenceLow: 135, referenceHigh: 175,
      status: 'active', correctsId: 'hb', recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z',
    });
    // The second load is a no-op.
    const twice = migrateFile(JSON.parse(JSON.stringify(out)), OPTS);
    expect(stableStringify(twice.labValues)).toBe(stableStringify(out.labValues));
    // Same-scale spellings hold the right number already: no correction row.
    const sameScale = [
      labRow({ id: 'alt', metricName: 'ALT', value: 25, unit: 'Units/L', referenceLow: 7, referenceHigh: 56 }),
      labRow({ id: 'wbc', metricName: 'WBC', value: 6.2, unit: '10^3/cmm', referenceLow: 4, referenceHigh: 11 }),
    ];
    expect(stableStringify(migrateFile(fileWith(sameScale), OPTS).labValues)).toBe(stableStringify(sameScale));
  });

  it('US-21 AC15 — a legacy whole count per µL converts at ×0.001 on load, once; a decimal one is left as it is', () => {
    const neut = labRow({ id: 'n1', metricName: 'Neutrophils', value: 2400, unit: 'cells/uL', referenceLow: 1500, referenceHigh: 8000 });
    const out = migrateFile(fileWith([neut]), OPTS);
    expect(out.labValues).toHaveLength(2);
    expect(out.labValues[0]).toMatchObject({ id: 'n1', value: 2400, unit: 'cells/uL', status: 'entered-in-error' });
    expect(out.labValues[1]).toMatchObject({
      id: 'n1#si', metricName: 'Neutrophils', value: 2.4, unit: '×10⁹/L', referenceLow: 1.5, referenceHigh: 8,
      status: 'active', correctsId: 'n1', recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z',
    });
    // The second load is a no-op: the #si row is already canonical.
    const twice = migrateFile(JSON.parse(JSON.stringify(out)), OPTS);
    expect(stableStringify(twice.labValues)).toBe(stableStringify(out.labValues));
    // A decimal per µL is refused at the write, so the load leaves it exactly as it is.
    const decimal = [
      labRow({ id: 'w1', metricName: 'WBC', value: 6.2, unit: 'cells/cmm', referenceLow: 4, referenceHigh: 11 }),
      // So is a whole count whose range was printed in thousands.
      labRow({ id: 'n2', metricName: 'Neutrophils', value: 2400, unit: 'cells/uL', referenceLow: 1.5, referenceHigh: 8 }),
      // And one a hundredfold off its own printed range.
      labRow({ id: 'p1', metricName: 'Platelets', value: 250000, unit: 'cells/µL', referenceLow: 150, referenceHigh: 400 }),
    ];
    expect(stableStringify(migrateFile(fileWith(decimal), OPTS).labValues)).toBe(stableStringify(decimal));
  });

  it('US-21 phase 3 — a v1 copy merged with a migrated copy converges: no #dup ids, one active row per slot', () => {
    const v1 = migrateFile(fileWith([labRow({ id: 'l1' })]), OPTS);
    const other = migrateFile(fileWith([labRow({ id: 'l1' })]), { ...OPTS, deviceId: 'dev_b' });
    const merged = mergeFiles(v1, other, { deviceId: 'dev_a', now: '2026-08-02T00:00:00Z' });
    expect(merged.labValues.map((l) => l.id).sort()).toEqual(['l1', 'l1#si']);
    expect(merged.labValues.filter((l) => l.status === 'active').map((l) => l.id)).toEqual(['l1#si']);
    // And migrating the merge output changes nothing at all.
    expect(stableStringify(migrateFile(JSON.parse(JSON.stringify(merged)), OPTS).labValues)).toBe(stableStringify(merged.labValues));
  });
});
