import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { migrateFile } from './migrate';
import { mergeFiles } from './merge';
import { recordSync } from './roadmap-doc';
import { createEmptyFile, type FileLabValue } from './roadmap-file';

const CTX = { deviceId: 'synthetic', now: '2026-10-31T12:00:00.000Z' };
function lab(id: string, extra: Record<string, unknown> = {}): FileLabValue {
  return { id, metricName: 'ferritin', value: 85, unit: 'µg/L', recordedAt: '2026-10-18',
    createdAt: CTX.now, source: 'manual', status: 'active', correctsId: null,
    referenceLow: null, referenceHigh: null, ...extra } as FileLabValue;
}
const badNames = [undefined, null, 7, { key: 'ferritin' }, ['ferritin'], true];

// US-29 AC4b: an agent writing the file directly (US-29) can leave out a lab
// row's `metricName`. Migration used to throw on that row ("Cannot read
// properties of undefined (reading 'trim')"), so the whole record failed to load
// and nothing could be saved. The row names no test, so it is omitted, like a
// row with no real day (AC4a).
describe('US-29 AC4b — a lab row with no test name at migration', () => {
  it.each(badNames.map((bad) => ({ bad })))('omits an active row whose metricName is $bad and keeps its neighbours', ({ bad }) => {
    const invalid = lab('invalid', { metricName: bad, value: 5, unit: 'mg/dL' });
    if (bad === undefined) delete (invalid as Partial<FileLabValue>).metricName;
    const valid = lab('valid');
    const raw = { ...createEmptyFile(CTX), labValues: [invalid, valid] };
    const snapshot = JSON.stringify(raw);
    const out = migrateFile(raw, CTX);
    expect(out.labValues).toEqual([valid]);
    expect(JSON.stringify(raw)).toBe(snapshot);
    expect(migrateFile(JSON.parse(JSON.stringify(out)), CTX)).toEqual(out);
  });

  it('omits a nameless row that is not active too, since every merge reads its name', () => {
    const raw = { ...createEmptyFile(CTX), labValues: [lab('old', { metricName: undefined, status: 'entered-in-error' }), lab('valid')] };
    const out = migrateFile(raw, CTX);
    expect(out.labValues).toEqual([lab('valid')]);
    expect(() => mergeFiles(out, out, CTX)).not.toThrow();
  });

  it('keeps a legacy named row and its SI correction (the conversion still runs)', () => {
    const legacy = lab('printed', { metricName: 'vitamin_d', unit: 'ng/mL', value: 32 });
    const out = migrateFile({ ...createEmptyFile(CTX), labValues: [lab('x', { metricName: null }), legacy] }, CTX);
    expect(out.labValues.map((r) => [r.id, r.status])).toEqual([['printed', 'entered-in-error'], ['printed#si', 'active']]);
  });

  it('a record holding a nameless row still loads, saves and reads back', async () => {
    const cloud = new MemoryCloud();
    const raw = { ...createEmptyFile(CTX), labValues: [lab('nameless', { metricName: undefined }), lab('valid')] };
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(raw), version: 1 });
    const sync = recordSync(new MemoryAdapter(cloud), CTX.deviceId, CTX.now);
    const loaded = await sync.load();
    expect(loaded.labValues).toEqual([lab('valid')]);
    const saved = await sync.save(loaded);
    expect(saved.file.labValues).toEqual([lab('valid')]);
    expect(JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json).labValues).toEqual([lab('valid')]);
  });
});
