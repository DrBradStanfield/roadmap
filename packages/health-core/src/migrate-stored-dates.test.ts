import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { migrateFile } from './migrate';
import { mergeFiles } from './merge';
import { ROADMAP_DOC, recordSync } from './roadmap-doc';
import { SyncManager } from './sync-manager';
import { createEmptyFile, createMeasurement, type FileDocument, type FileLabValue } from './roadmap-file';

const CTX = { deviceId: 'synthetic', now: '2026-10-19T12:00:00.000Z' };
const LATER = { ...CTX, now: '2026-10-22T12:00:00.000Z' };
function measurement(id: string, recordedAt = '2026-10-18') {
  return createMeasurement({ id, metricType: 'ldl', value: 2, recordedAt, createdAt: CTX.now });
}
function lab(id: string, recordedAt = '2026-10-18'): FileLabValue {
  return { id, metricName: 'synthetic_unknown_test', value: 1, unit: 'u', recordedAt,
    createdAt: CTX.now, source: 'manual', status: 'active', correctsId: null,
    referenceLow: null, referenceHigh: null };
}
const badDates = [42, null, undefined, '', 'yesterday', '2026-02-29', '2026-04-31',
  '2026-02-30T08:00:00Z', '2026-13-01', '2026-01-00'];

// US-29 AC4: malformed rows are dropped/ignored, not assigned invented dates.
// US-30 AC5 reuses this hardened boundary. Clinical dates are not write clocks.
describe('US-29 AC4 — stored clinical dates at migration', () => {
  for (const key of ['measurements', 'labValues'] as const) {
    const row = key === 'measurements' ? measurement : lab;
    it.each(badDates)(`${key}: omits a row with malformed recordedAt %s without changing its neighbours`, (bad) => {
      const valid = row('valid');
      const invalid = { ...row('invalid'), recordedAt: bad };
      if (bad === undefined) delete invalid.recordedAt;
      const raw = { ...createEmptyFile(CTX), [key]: [invalid, valid], futureSection: { kept: true } };
      const snapshot = JSON.stringify(raw);
      const out = migrateFile(raw, CTX);
      expect(out[key]).toEqual([valid]);
      expect(out).toHaveProperty('futureSection', { kept: true });
      expect(JSON.stringify(raw)).toBe(snapshot);
      expect(migrateFile(raw, LATER)).toEqual(out);
      expect(migrateFile(JSON.parse(JSON.stringify(out)), LATER)).toEqual(out);
    });

    it(`${key}: preserves real days, timestamps, offsets and future observations without slot collisions`, () => {
      const dates = ['2024-02-29', '2026-10-18T23:30:00-07:00', '2026-10-19T00:30:00+13:00',
        '2026-10-20T08:30:00.123Z', '2099-01-01', '2026-10-21T08:30:00'];
      const rows = dates.map((date, i) => ({ ...row(`valid-${i}`, date), newerField: { kept: i } }));
      const raw = { ...createEmptyFile(CTX), [key]: rows };
      const out = migrateFile(raw, CTX);
      expect(out[key]).toEqual(rows);
      expect(migrateFile(raw, LATER)).toEqual(out);
      expect(migrateFile(JSON.parse(JSON.stringify(out)), LATER)).toEqual(out);
      const merged = mergeFiles(out, out, CTX);
      expect(merged[key].filter((r) => r.status === 'active')).toHaveLength(rows.length);
      expect(merged[key].map((r) => r.recordedAt).sort()).toEqual([...dates].sort());
    });

    it(`${key}: a corrupt stored date does not prevent repeated SyncManager saves and readback`, async () => {
      const cloud = new MemoryCloud();
      const raw = { ...createEmptyFile(CTX), [key]: [
        ...badDates.map((bad, i) => ({ ...row(`bad-${i}`), recordedAt: bad })), row('valid'),
      ] };
      cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(raw), version: 1 });
      const sync = recordSync(new MemoryAdapter(cloud), CTX.deviceId, CTX.now);
      const loaded = await sync.load();
      const first = await sync.save(loaded);
      const second = await sync.save(first.file);
      expect(second.file[key]).toEqual([row('valid')]);
      expect((await sync.load())[key]).toEqual([row('valid')]);
      expect(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json)[key]).toEqual([row('valid')]);
      expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBeGreaterThan(1);
    });
  }

  it('US-21: a valid legacy lab still appends its SI correction with the exact clinical timestamp', () => {
    const clinical = '2026-10-18T23:30:00-07:00';
    const original = { ...lab('printed', clinical), metricName: 'vitamin_d', unit: 'ng/mL', value: 32, newerField: true };
    const raw = { ...createEmptyFile(CTX), labValues: [original, { ...original, id: 'invalid', recordedAt: null }] };
    const out = migrateFile(raw, CTX);
    expect(out.labValues).toHaveLength(2);
    expect(out.labValues[0]).toEqual({ ...original, status: 'entered-in-error' });
    expect(out.labValues[1]).toMatchObject({ id: 'printed#si', correctsId: 'printed', status: 'active', recordedAt: clinical, newerField: true });
    expect(migrateFile(JSON.parse(JSON.stringify(out)), LATER)).toEqual(out);
  });
});

function document(id: string, addedAt: string): FileDocument {
  return { id, type: 'other', title: 'Synthetic', date: '2024-02-29', fileRef: '',
    contentHash: '', mimeType: 'application/pdf', extractedText: '', addedAt };
}

describe('document write clocks stay identical across revisions', () => {
  const CREATED = '2026-10-18T12:00:00.000Z';
  const UPDATED = '2026-10-19T12:00:00.000Z';
  const future = document('synthetic-document', '2099-01-01T00:00:00Z');

  it('does not rewrite addedAt, so a deletion still absorbs the live copy', () => {
    const live = createEmptyFile({ ...CTX, now: CREATED });
    live.documents = [{ ...future }];
    const deleted = createEmptyFile({ ...CTX, now: CREATED });
    deleted.meta.updatedAt = UPDATED;
    deleted.documents = [{ ...future, deleted: true }];
    const a = migrateFile(live, CTX);
    const b = migrateFile(deleted, CTX);
    expect(a.documents[0].addedAt).toBe(future.addedAt);
    expect(b.documents[0].addedAt).toBe(future.addedAt);
    for (const reversed of [false, true]) {
      const merged = reversed ? mergeFiles(b, a, CTX) : mergeFiles(a, b, CTX);
      expect(merged.documents.filter((row) => !row.deleted)).toEqual([]);
      expect(merged.documents).toHaveLength(1);
    }
  });

  it('preserves offset identity and keeps real post-erase rows on both sides of the legacy gate', () => {
    const ERASE = '2026-10-19T00:00:00.000Z';
    const erased = () => ({ ...createEmptyFile({ ...CTX, now: ERASE }),
      meta: { ...createEmptyFile({ ...CTX, now: ERASE }).meta, eraseEpoch: 1, erasedAt: ERASE } });
    const rows = [document('before', '2026-10-19T09:00:00+13:00'),
      document('at', ERASE), document('after', '2026-10-18T23:00:00-07:00')];
    const out = migrateFile({ ...createEmptyFile(CTX), documents: rows }, CTX);
    expect(out.documents).toEqual(rows);
    for (const [a, b] of [[out, erased()], [erased(), out]] as const) {
      const merged = mergeFiles(a, b, CTX);
      expect(merged.documents.map((r) => r.id).sort()).toEqual(['after', 'at']);
      expect(merged.documents.find((r) => r.id === 'after')!.addedAt).toBe(rows[2].addedAt);
    }
  });
});
