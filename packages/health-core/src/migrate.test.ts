import { describe, it, expect } from 'vitest';
import { migrateFile, SchemaTooNewError } from './migrate';
import { CURRENT_SCHEMA_VERSION } from './roadmap-file';

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
