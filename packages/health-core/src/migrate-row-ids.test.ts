import { describe, expect, it } from 'vitest';
import { migrateFile } from './migrate';
import { mergeFiles } from './merge';
import { createEmptyFile, createMeasurement, createLabValue } from './roadmap-file';

const opts = { deviceId: 'synthetic', now: '2026-06-15T12:00:00Z' };
const stamp = '2025-01-15T03:00:00+02:00';
const valid = {
  measurements: createMeasurement({ id: 'measurement', metricType: 'ldl', value: 3, recordedAt: stamp, createdAt: stamp }),
  labValues: createLabValue({ id: 'lab', metricName: 'synthetic-test', value: 7, unit: 'synthetic', recordedAt: stamp, createdAt: stamp }),
  medications: { id: 'med', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: null, doseUnit: null, updatedAt: stamp },
  medicationHistory: { id: 'med-history', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: null, doseUnit: null, updatedAt: stamp, changeType: 'started' },
  supplements: { id: 'supp', supplementKey: 'synthetic', supplementName: 'synthetic', doseValue: null, doseUnit: null, status: 'active', startedAt: stamp, updatedAt: stamp },
  supplementHistory: { id: 'supp-history', supplementKey: 'synthetic', supplementName: 'synthetic', doseValue: null, doseUnit: null, status: 'active', startedAt: stamp, updatedAt: stamp, changeType: 'started' },
  documents: { id: 'doc', title: 'synthetic', type: 'other', date: '2025-01-15', fileRef: '', contentHash: '', mimeType: '', extractedText: '', addedAt: stamp },
};

describe('US-10 AC2, AC4: untrusted id-bearing rows', () => {
  for (const [key, row] of Object.entries(valid)) {
    it(`${key}: drops malformed IDs without changing retained rows or source bytes`, () => {
      const retained = { ...row, future: { exact: '  future field 🧪  ' } };
      const { id: _id, ...withoutId } = retained;
      const raw = { ...createEmptyFile(opts), [key]: [retained, withoutId, ...[null, 0, {}, []], ...['', 42, null, {}, []].map((id) => ({ ...retained, id }))] };
      const bytes = JSON.stringify(raw);
      const migrated = migrateFile(JSON.parse(bytes), opts);
      expect(() => mergeFiles(migrated, migrated, opts)).not.toThrow();
      expect(migrated[key as keyof typeof valid]).toEqual([retained]);
      expect(JSON.stringify(migrated[key as keyof typeof valid])).toBe(JSON.stringify([retained]));
      expect(JSON.stringify(raw)).toBe(bytes);
    });
  }

  it('preserves ID-less singletons and arrays keyed by category/date', () => {
    const raw = { ...createEmptyFile(opts),
      profile: { updatedAt: stamp, sex: 'male', future: 'kept' },
      screenings: { updatedAt: stamp, future: 'kept' },
      reminderPreferences: [{ category: 'medication_review', enabled: false, updatedAt: stamp }],
      recommendationSnapshots: [{ date: '2025-01-15', suggestions: [], future: 'kept' }],
    };
    const migrated = migrateFile(raw, opts);
    for (const key of ['profile', 'screenings', 'reminderPreferences', 'recommendationSnapshots'] as const) expect(migrated[key]).toEqual(raw[key]);
  });

  it('keeps document and clinical tombstones sticky in both merge orders', () => {
    const raw = { ...createEmptyFile(opts), measurements: [valid.measurements, {}], documents: [valid.documents, {}] };
    const live = migrateFile(raw, opts);
    const dead = migrateFile({ ...raw, measurements: [{ ...valid.measurements, status: 'entered-in-error' }, {}], documents: [{ ...valid.documents, deleted: true }, {}] }, opts);
    for (const [a, b] of [[live, dead], [dead, live]]) {
      const merged = mergeFiles(a, b, opts);
      expect(merged.measurements).toHaveLength(1);
      expect(merged.measurements[0].status).toBe('entered-in-error');
      expect(merged.documents).toHaveLength(1);
      expect(merged.documents[0].deleted).toBe(true);
    }
  });
});
