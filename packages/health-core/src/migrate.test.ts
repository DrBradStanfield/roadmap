import { describe, it, expect, vi } from 'vitest';
import { migrateFile, SchemaTooNewError } from './migrate';
import { mergeFiles, stampInstant } from './merge';
import { ROADMAP_DOC } from './roadmap-doc';
import { labSlotKey } from './lab-catalog';
import { BASE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION, createEmptyFile, createMeasurement, stableStringify, type FileLabValue, type FileMeasurement } from './roadmap-file';

const OPTS = { deviceId: 'dev_x', now: '2026-06-08T00:00:00Z' };

/** Row stamps that are not a time (US-23 AC6a): garbage, impossible dates, a
 *  real day with a broken time, offset or trailing junk, mistyped values. */
const INVALID_STAMPS: unknown[] = [
  'not-a-date', 'zzzz', '2026-02-30', '2026-02-30T00:00:00Z', '', null, 1780000000000,
  '2099-01-01T99:00:00Z', '2026-05-01 junk', '2026-05-01Tjunk', '2026-05-01T10:60:00Z',
  '2026-05-01T10:00:00+99:00', '2026-05-01T10:00:00+13', '2026-05-01T10:00:00Zjunk',
  '2025-01-15 03:00:00+99', '2025-01-15  03:00:00Z', '2025-01-15 junk+00',
  // A space-separated time with no zone: the merge would read it in the machine's zone.
  '2025-01-15 03:00:00', '2025-01-15 03:00',
];
/** Every shape a real writer emits, all before the fixtures' anchor: toISOString,
 *  a date-only day, offsets (+13:00, compact +0530), fractional seconds,
 *  lowercase t/z, a zone-less time, which the merge reads as UTC, and
 *  Postgres's text style (a space for the T, an hour-only offset). */
const VALID_STAMPS = [
  '2026-05-01T10:00:00.000Z', '2026-05-01', '2026-05-01T10:00:00+13:00', '2026-05-01T10:00:00-08:00',
  '2026-05-01T10:00:00+0530', '2026-05-01T10:00:00.123456Z', '2026-05-01t10:00:00z',
  '2026-05-01T10:00:00', '2026-05-01T10:00Z',
  // Postgres text style, which files imported from v1 may hold.
  '2025-01-15 03:00:00+00', '2025-01-15 03:00:00.123+13', '2025-01-15 03:00:00+05:30', '2025-01-15 03:00:00Z',
];

describe('migrateFile', () => {
  it('returns a fresh empty file for null / non-object input', () => {
    for (const bad of [null, undefined, 42, 'nope', []]) {
      const f = migrateFile(bad, OPTS);
      expect(f.schemaVersion).toBe(BASE_SCHEMA_VERSION);
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

  // US-09 AC23: version 2 means "carries an erase list"; nothing else moves.
  it('treats a missing schemaVersion as the version of a file no erase has listed rows in', () => {
    expect(migrateFile({ profile: {} }, OPTS).schemaVersion).toBe(BASE_SCHEMA_VERSION);
  });
});

describe('migrateFile — the erase list (US-09 AC23)', () => {
  const row = (id: string, recordedAt = '2026-05-01') => createMeasurement({ id, metricType: 'weight', value: 80, recordedAt, createdAt: `${recordedAt}T08:00:00Z` });
  const lab = (id: string, unit = 'mg/dL'): FileLabValue => ({
    id, metricName: 'glucose', value: 90, unit, referenceLow: null, referenceHigh: null,
    recordedAt: '2026-05-01', createdAt: '2026-05-01T08:00:00Z', source: 'manual', status: 'active', correctsId: null,
  });
  const STAMP = { updatedAt: '2026-05-01T08:00:00Z', lamport: 1 };
  /** A raw file at erase epoch 1 that listed `ids`, holding one row per array under `x`, plus `keep`. */
  function raw(erasedRows: unknown): Record<string, unknown> {
    const file = createEmptyFile({ deviceId: 'dev_y', now: '2026-05-02T00:00:00Z' }) as unknown as Record<string, unknown>;
    (file.meta as Record<string, unknown>).eraseEpoch = 1;
    file.measurements = [row('xm'), row('keep', '2026-05-02')];
    file.labValues = [lab('xl')]; // converted on load to `xl#si`, which goes too
    file.documents = [{ id: 'xd', title: 'Labs', type: 'pathology_report', date: null, fileRef: '', contentHash: '', mimeType: '', extractedText: '', addedAt: '2026-05-01T08:00:00Z' }];
    file.medications = [{ id: 'xmed', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', ...STAMP }];
    file.medicationHistory = [{ id: 'xmh', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', changeType: 'started', ...STAMP }];
    const supplement = { supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: null, doseUnit: null, status: 'active', startedAt: '2026-05-01', ...STAMP };
    file.supplements = [{ id: 'xs', ...supplement }];
    file.supplementHistory = [{ id: 'xsh', ...supplement, changeType: 'started' }];
    return { ...file, erasedRows };
  }
  const LIST = { fromEpoch: 1, ids: ['xd', 'xl', 'xm', 'xmed', 'xmh', 'xs', 'xsh'] };

  it('US-09 AC23: drops every listed row on load, a conversion included, and stamps the file version 2', () => {
    const f = migrateFile(raw(LIST), OPTS);
    expect(f.measurements.map((m) => m.id)).toEqual(['keep']);
    for (const key of ['labValues', 'documents', 'medications', 'medicationHistory', 'supplements', 'supplementHistory'] as const) {
      expect(f[key], key).toEqual([]);
    }
    expect(f.erasedRows).toEqual(LIST);
    expect(f.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    // Through the document spec too: what read_record and the CLI read.
    expect(ROADMAP_DOC.migrate(raw(LIST), OPTS).measurements.map((m) => m.id)).toEqual(['keep']);
  });

  it('US-09 AC23: a malformed list is dropped whole and lists nothing; the file keeps its version', () => {
    for (const bad of [
      'x', [], { ids: ['xm'] }, { fromEpoch: 1 }, { fromEpoch: 1, ids: 'xm' }, { fromEpoch: 1, ids: ['xm', 7] },
      { fromEpoch: 0, ids: ['xm'] }, { fromEpoch: 3, ids: ['xm'] }, { fromEpoch: 1.5, ids: ['xm'] }, { fromEpoch: '1', ids: ['xm'] },
    ]) {
      const f = migrateFile(raw(bad), OPTS);
      expect('erasedRows' in f, JSON.stringify(bad)).toBe(false);
      expect(f.measurements.map((m) => m.id).sort(), JSON.stringify(bad)).toEqual(['keep', 'xm']);
      expect(f.schemaVersion).toBe(BASE_SCHEMA_VERSION);
    }
    // fromEpoch may be eraseEpoch + 1, which claims nothing.
    expect(migrateFile(raw({ fromEpoch: 2, ids: ['xm'] }), OPTS).erasedRows).toEqual({ fromEpoch: 2, ids: ['xm'] });
    // A version-2 file whose list went stays at 2: an older reader still refuses it.
    expect(migrateFile({ ...raw('x'), schemaVersion: 2 }, OPTS).schemaVersion).toBe(2);
  });

  it('US-09 AC23: a version-1 reader refuses a listed file, so it can neither shrink the list nor erase unlisted', async () => {
    vi.resetModules();
    vi.doMock('./roadmap-file', async (original) => ({ ...(await original<typeof import('./roadmap-file')>()), CURRENT_SCHEMA_VERSION: 1 }));
    try {
      const old = await import('./migrate');
      const listed = JSON.parse(JSON.stringify(migrateFile(raw(LIST), OPTS)));
      expect(() => old.migrateFile(listed, OPTS)).toThrow(old.SchemaTooNewError);
      // A file never erased under the list stays readable to it.
      expect(old.migrateFile(JSON.parse(JSON.stringify(migrateFile(raw(undefined), OPTS))), OPTS).measurements).toHaveLength(2);
    } finally {
      vi.doUnmock('./roadmap-file');
      vi.resetModules();
    }
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

  // US-09 AC20: erasedAt round-trips; one that is not a timestamp is dropped,
  // which reads as an erase from before erasedAt existed — the gate then
  // drops every losing row, the side that never resurrects erased data.
  it('US-09 AC20: keeps a well-formed meta.erasedAt, in UTC, and drops a malformed one', () => {
    const erasedAt = (at: unknown) => migrateFile(rawFile({ meta: { ...META, eraseEpoch: 1, erasedAt: at } }), OPTS).meta.erasedAt;
    expect(erasedAt('2026-05-10T00:00:00Z')).toBe('2026-05-10T00:00:00.000Z');
    expect(erasedAt('2026-05-10T13:00+13:00')).toBe('2026-05-10T00:00:00.000Z');
    // Strict (Codex R2): a prefix, an impossible date, trailing junk, no zone.
    for (const bad of [5, null, '', 'yesterday', {}, '2026-05-10T', '2026-13-40T00:00:00Z', '2026-05-10T12:00:00Zjunk', '2026-05-10T12:00:00']) {
      const meta = migrateFile(rawFile({ meta: { ...META, eraseEpoch: 1, erasedAt: bad } }), OPTS).meta;
      expect('erasedAt' in meta, String(bad)).toBe(false);
    }
    expect('erasedAt' in migrateFile(rawFile(), OPTS).meta).toBe(false);
  });

  // Codex re-check R3: Date.parse rolls an impossible day over (02-30 is
  // March 2), so the calendar date is checked on its own.
  it('US-09 AC20: drops an erasedAt on a day the calendar does not have, keeps a leap day', () => {
    const erasedAt = (at: unknown) => migrateFile(rawFile({ meta: { ...META, eraseEpoch: 1, erasedAt: at } }), OPTS).meta.erasedAt;
    expect(erasedAt('2026-02-29T00:00:00Z')).toBeUndefined();
    expect(erasedAt('2026-04-31T00:00:00Z')).toBeUndefined();
    expect(erasedAt('2026-02-30T00:00:00Z')).toBeUndefined();
    expect(erasedAt('2028-02-29T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  // US-09 AC20: immutable clocks keep their original instant for the erase gate.
  it('US-09 AC20: an offset row before the erase still goes without rewriting createdAt', () => {
    const ctx = { deviceId: 'dev_x', now: '2026-05-10T01:00:00Z' };
    const before = { ...MEAS, id: 'plus13', createdAt: '2026-05-10T09:00:00+13:00' }; // 2026-05-09T20:00Z
    const stale = ROADMAP_DOC.migrate(rawFile({ meta: { ...META, updatedAt: '2026-05-10T01:00:00Z' }, measurements: [before] }), ctx);
    expect(stale.measurements[0].createdAt).toBe('2026-05-10T09:00:00+13:00'); // not clamped
    const erased = ROADMAP_DOC.migrate(rawFile({ meta: { ...META, updatedAt: '2026-05-10T00:00:00Z', eraseEpoch: 1, erasedAt: '2026-05-10T00:00:00Z' } }), ctx);
    expect(mergeFiles(stale, erased, ctx).measurements).toEqual([]);
    expect(mergeFiles(erased, stale, ctx).measurements).toEqual([]);
    // A row past the file clock also keeps its immutable identity.
    const ahead = { ...MEAS, id: 'ahead', createdAt: '2026-05-10T02:00:00Z' };
    expect(migrateFile(rawFile({ meta: { ...META, updatedAt: '2026-05-10T14:00:00+13:00' }, measurements: [ahead] }), ctx).measurements[0].createdAt)
      .toBe(ahead.createdAt);
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

  // US-10 AC2: future immutable clocks must not split a deletion's identity.
  // Residual: a forged future createdAt can still win its slot; migration may
  // not rewrite content identity to solve that separate writer-policy problem.
  it('preserves a future createdAt so its deletion still absorbs either merge order', () => {
    const forged = { ...MEAS, id: 'agent', value: 9.9, createdAt: '2099-01-01T00:00:00Z' };
    const f = migrateFile(rawFile({ measurements: [forged] }), OPTS);
    expect(f.measurements[0].createdAt).toBe(forged.createdAt);
    const deleted = { ...forged, status: 'entered-in-error' as const };
    const g = migrateFile(rawFile({ meta: { ...META, updatedAt: '2099-02-01T00:00:00Z' }, measurements: [deleted] }), OPTS);
    expect(mergeFiles(f, g, OPTS).measurements).toEqual([deleted]);
    expect(mergeFiles(g, f, OPTS).measurements).toEqual([deleted]);
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

  // US-23 AC6a (Codex R4, 2026-10-21): the future-clamp compared before it
  // validated, and a string that is not a time compares as a string. So
  // 'not-a-date' (which sorts after any ISO stamp) read as future and took the
  // anchor, a real date the reminder schedule then used as a review date. A
  // stamp that is not a time is an unknown time, the bottom. Codex R1: the
  // whole stamp is checked, not only its day, so a real day with a broken time
  // or offset, or trailing junk, is not a time either.
  it('reads a row updatedAt that is not a complete stamp as the bottom, never the anchor', () => {
    for (const updatedAt of INVALID_STAMPS) {
      const f = migrateFile(rawFile({ medications: [medRow({ updatedAt })] }), OPTS);
      expect(f.medications[0].updatedAt, String(updatedAt)).toBe('');
    }
    for (const updatedAt of VALID_STAMPS) {
      const f = migrateFile(rawFile({ medications: [medRow({ updatedAt })] }), OPTS);
      expect(f.medications[0].updatedAt).toBe(updatedAt);
    }
    const future = migrateFile(rawFile({ medications: [medRow({ updatedAt: '2099-01-01T00:00:00Z' })] }), OPTS);
    expect(future.medications[0].updatedAt).toBe(META.updatedAt);
  });

  // US-23 AC6a (Codex re-check, 2026-10-21): a zone-less time after a
  // lowercase t was parsed in the machine's zone, so in Auckland
  // 2026-06-02t00:00:00 fell before an 18:00Z anchor the day before and
  // escaped the clamp it gets in UTC. It reads as UTC, like an uppercase T.
  it('reads a zone-less lowercase-t stamp as UTC in every zone', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
        process.env.TZ = zone; // a forks child re-reads it on the next Date call
        expect(stampInstant('2026-05-01t10:00:00'), zone).toBe(Date.parse('2026-05-01T10:00:00Z'));
        const f = migrateFile(rawFile({
          meta: { ...META, updatedAt: '2026-06-01T18:00:00Z' },
          medications: [medRow({ updatedAt: '2026-06-02t00:00:00' })],
        }), OPTS);
        expect(f.medications[0].updatedAt, zone).toBe('2026-06-01T18:00:00Z');
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
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
      labRow({ id: 'uncatalogued', metricName: 'plateletcrit', value: 44, unit: 'U/mL' }),
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

  it('US-21 AC16 — a legacy cells/mm³ row converts at ×0.001 on load, once; 10^n/mm³ rows and a decimal count are left alone', () => {
    const plt = labRow({ id: 'p1', metricName: 'Platelets', value: 250000, unit: 'cells/mm³', referenceLow: 150000, referenceHigh: 400000 });
    const out = migrateFile(fileWith([plt]), OPTS);
    expect(out.labValues).toHaveLength(2);
    expect(out.labValues[0]).toMatchObject({ id: 'p1', value: 250000, unit: 'cells/mm³', status: 'entered-in-error' });
    expect(out.labValues[1]).toMatchObject({
      id: 'p1#si', metricName: 'Platelets', value: 250, unit: '×10⁹/L', referenceLow: 150, referenceHigh: 400,
      status: 'active', correctsId: 'p1', recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z',
    });
    // The second load is a no-op: the #si row is already canonical.
    const twice = migrateFile(JSON.parse(JSON.stringify(out)), OPTS);
    expect(stableStringify(twice.labValues)).toBe(stableStringify(out.labValues));
    // Factor 1 holds the right number already, and a decimal per mm³ is refused: no correction row.
    const leftAlone = [
      labRow({ id: 'r1', metricName: 'RBC', value: 4.8, unit: '10^6/mm³', referenceLow: 4.5, referenceHigh: 5.9 }),
      labRow({ id: 'w1', metricName: 'WBC', value: 6.2, unit: '10^3/mm3', referenceLow: 4, referenceHigh: 11 }),
      labRow({ id: 'w2', metricName: 'WBC', value: 6.2, unit: 'cells/mm3', referenceLow: 4, referenceHigh: 11 }),
    ];
    expect(stableStringify(migrateFile(fileWith(leftAlone), OPTS).labValues)).toBe(stableStringify(leftAlone));
  });

  it('US-21 AC22 — legacy cells/mcL and reticulocyte x10(12)/L or 10¹²/L rows convert on load, once', () => {
    const rows = [
      labRow({ id: 'w1', metricName: 'WBC', value: 6200, unit: 'cells/mcL', referenceLow: 4000, referenceHigh: 11000 }),
      labRow({ id: 'r1', metricName: 'Reticulocytes', value: 0.05, unit: 'x10(12)/L', referenceLow: 0.02, referenceHigh: 0.1 }),
      labRow({ id: 'r2', metricName: 'Reticulocytes', value: 0.05, unit: '10¹²/L', referenceLow: 0.02, referenceHigh: 0.1, recordedAt: '2026-07-15' }),
    ];
    const out = migrateFile(fileWith(rows), OPTS);
    expect(out.labValues).toHaveLength(6);
    for (const id of ['w1', 'r1', 'r2']) expect(out.labValues.find((l) => l.id === id)).toMatchObject({ status: 'entered-in-error' });
    expect(out.labValues.find((l) => l.id === 'w1#si')).toMatchObject({
      value: 6.2, unit: '×10⁹/L', referenceLow: 4, referenceHigh: 11, status: 'active', correctsId: 'w1',
    });
    for (const id of ['r1', 'r2']) {
      expect(out.labValues.find((l) => l.id === `${id}#si`), id).toMatchObject({
        value: 50, unit: '×10⁹/L', referenceLow: 20, referenceHigh: 100, status: 'active', correctsId: id,
      });
    }
    // The second load is a no-op: the #si rows are already canonical.
    const twice = migrateFile(JSON.parse(JSON.stringify(out)), OPTS);
    expect(stableStringify(twice.labValues)).toBe(stableStringify(out.labValues));
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

// ---------------------------------------------------------------------------
// US-21 AC17 — what a load does to rows written before the new entries existed.
// ---------------------------------------------------------------------------
// Until AC17 these tests were uncatalogued and kept their printed unit. Now
// each is catalogued, so a legacy row in a spelling that converts is corrected
// once through AC9's #si path, and its slot is the catalogue key.
describe('US-21 AC17 — legacy rows of the newly catalogued tests, at load and merge', () => {
  const labRow = (over: Partial<FileLabValue> & { id: string; metricName: string; value: number; unit: string }): FileLabValue => ({
    referenceLow: null, referenceHigh: null, recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z',
    source: 'lab_import', status: 'active', correctsId: null, ...over,
  });
  const fileWith = (rows: FileLabValue[]) => ({
    schemaVersion: 1,
    meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', lastDeviceId: 'dev_a', lamport: 3 },
    labValues: rows,
  });
  const actives = (rows: FileLabValue[]) => rows.filter((r) => r.status === 'active').map((r) => r.id).sort();

  it('US-21 AC17 — fasting_glucose in mg/dL, free_testosterone in pg/mL and insulin in pmol/L each convert once; the second load is a no-op', () => {
    const rows = [
      labRow({ id: 'g1', metricName: 'fasting_glucose', value: 90, unit: 'mg/dL', referenceLow: 70, referenceHigh: 99 }),
      labRow({ id: 't1', metricName: 'free_testosterone', value: 100, unit: 'pg/mL' }),
      labRow({ id: 'i1', metricName: 'Insulin', value: 60, unit: 'pmol/L' }),
    ];
    const once = migrateFile(fileWith(rows), OPTS);
    expect(once.labValues).toHaveLength(6);
    for (const id of ['g1', 't1', 'i1']) {
      expect(once.labValues.find((r) => r.id === id)!.status, id).toBe('entered-in-error');
    }
    expect(once.labValues.find((r) => r.id === 'g1#si')).toMatchObject({
      metricName: 'fasting_glucose', value: 4.9959, unit: 'mmol/L', referenceLow: 3.8857, referenceHigh: 5.49549,
      status: 'active', correctsId: 'g1', recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z',
    });
    expect(once.labValues.find((r) => r.id === 't1#si')).toMatchObject({ value: 346.7, unit: 'pmol/L', status: 'active', correctsId: 't1' });
    expect(once.labValues.find((r) => r.id === 'i1#si')).toMatchObject({ value: 10.002, unit: 'mIU/L', status: 'active', correctsId: 'i1' });
    const twice = migrateFile(JSON.parse(JSON.stringify(once)), OPTS);
    expect(stableStringify(twice.labValues)).toBe(stableStringify(once.labValues));
    // A merge with itself, or with a device that has not loaded it yet, keeps one active row per test.
    expect(actives(mergeFiles(once, once, OPTS).labValues)).toEqual(['g1#si', 'i1#si', 't1#si']);
    expect(actives(mergeFiles(once, migrateFile(fileWith(rows), OPTS), OPTS).labValues)).toEqual(['g1#si', 'i1#si', 't1#si']);
  });

  it('US-21 AC17 — a same-day measured and calculated free testosterone stay in two slots: neither is demoted', () => {
    const rows = [
      labRow({ id: 'ft', metricName: 'Free Testosterone', value: 100, unit: 'pg/mL', createdAt: '2026-07-14T08:00:00Z' }),
      labRow({ id: 'cft', metricName: 'Calculated Free Testosterone', value: 110, unit: 'pg/mL', createdAt: '2026-07-14T09:00:00Z' }),
    ];
    const merged = mergeFiles(migrateFile(fileWith(rows), OPTS), createEmptyFile(OPTS), OPTS);
    expect(actives(merged.labValues)).toEqual(['cft#si', 'ft#si']);
  });

  it('US-21 AC12 — no calcium row is rewritten; a slot is read from the name the row was stored under', () => {
    const rows = [
      labRow({ id: 'plain', metricName: 'Calcium', value: 2.4, unit: 'mmol/L' }),
      labRow({ id: 'keyed', metricName: 'calcium_corrected', value: 2.35, unit: 'mmol/L' }),
    ];
    const out = migrateFile(fileWith(rows), OPTS);
    expect(stableStringify(out.labValues)).toBe(stableStringify(rows));
    // A row stored under the printed "Calcium" now reads as total calcium; one
    // stored under the key stays corrected. Two slots, so neither is demoted.
    expect(out.labValues.map((r) => labSlotKey(r.metricName))).toEqual(['calcium_total', 'calcium_corrected']);
    expect(actives(mergeFiles(out, createEmptyFile(OPTS), OPTS).labValues)).toEqual(['keyed', 'plain']);
  });

  it('US-21 AC17 — two legacy names that now share one slot on one day keep one active row: the later createdAt', () => {
    const rows = [
      labRow({ id: 'a', metricName: 'Fasting Glucose', value: 5.1, unit: 'mmol/L', createdAt: '2026-07-14T08:00:00Z' }),
      labRow({ id: 'b', metricName: 'FPG', value: 5.1, unit: 'mmol/L', createdAt: '2026-07-14T09:00:00Z' }),
    ];
    const merged = mergeFiles(migrateFile(fileWith(rows), OPTS), createEmptyFile(OPTS), OPTS);
    expect(actives(merged.labValues)).toEqual(['b']);
    expect(merged.labValues.find((r) => r.id === 'a')!.status).toBe('entered-in-error');
  });
});

// US-21 AC21 — load never deletes or rewrites a stored row: one above its
// test's ceiling is left exactly as it is, whether still in its printed unit
// or already converted by an older client.
describe('US-21 AC21 — rows above a ceiling are left as they are at load', () => {
  it('US-21 AC21 — a legacy nmol/L free T with a pmol/L number gets no #si child; a stored 312,600 pmol/L row is untouched', () => {
    const row = (over: Partial<FileLabValue> & { id: string }): FileLabValue => ({
      metricName: 'free_testosterone', value: 312.6, unit: 'nmol/L', referenceLow: 163, referenceHigh: 473,
      recordedAt: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', source: 'lab_import', status: 'active', correctsId: null, ...over,
    });
    const rows = [
      row({ id: 'legacy' }),
      row({ id: 'old#si', value: 312600, unit: 'pmol/L', referenceLow: 163000, referenceHigh: 473000, correctsId: 'old', recordedAt: '2026-06-01' }),
    ];
    const raw = {
      schemaVersion: 1,
      meta: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', lastDeviceId: 'dev_a', lamport: 3 },
      labValues: rows,
    };
    expect(stableStringify(migrateFile(raw, OPTS).labValues)).toBe(stableStringify(rows));
  });
});
