/**
 * US-65 (Brad 2026-11-01): a record holding rows or profile fields this build
 * cannot read still opens. They stay where they are in the file, so every
 * build, older ones included, merges, erases and corrects them as before;
 * only readers skip them. Synthetic values only.
 */
import { describe, it, expect } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { buildErasedFile } from './erase';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { mergeFiles } from './merge';
import { migrateFile, RecordShapeError, SchemaTooNewError } from './migrate';
import { callTool } from './mcp-tools';
import { readableView } from './readable-rows';
import { correctValue } from './record-edits';
import { recordSync } from './roadmap-doc';
import { createEmptyFile, createMeasurement } from './roadmap-file';

const DAY = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-05T00:00:00.000Z';
const CTX = { deviceId: 'dev_us65', now: LATER };

const WEIGHT = createMeasurement({ id: 'w1', metricType: 'weight', value: 82, recordedAt: DAY, createdAt: DAY });
/** A newer app's metric: this build has no such metricType. */
const FUTURE = { ...createMeasurement({ id: 'f1', metricType: 'weight', value: 5, recordedAt: DAY, createdAt: DAY }), metricType: 'synthetic_future_metric', extra: { kept: true } };
/** A row whose value is a word. */
const WORDY = { ...createMeasurement({ id: 'v1', metricType: 'hdl', value: 1, recordedAt: DAY, createdAt: DAY }), value: 'synthetic' };

function rawRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  const file = createEmptyFile({ deviceId: 'dev_writer', now: DAY }) as unknown as Record<string, unknown>;
  return { ...file, measurements: [WEIGHT], ...overrides };
}

function cloudWith(json: string): { cloud: MemoryCloud; sync: ReturnType<typeof recordSync> } {
  const cloud = new MemoryCloud();
  cloud.files.set(ROADMAP_FILE_NAME, { json, version: 1 });
  return { cloud, sync: recordSync(new MemoryAdapter(cloud), CTX.deviceId, LATER) };
}

const stored = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as Record<string, any>;
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
const read = (raw: unknown) => migrateFile(raw, CTX);

describe('US-65 AC1: an unreadable row stays where it is', () => {
  it('an unknown metric row: the record opens, the row is hidden, and a save leaves it in measurements byte-equal', async () => {
    const { cloud, sync } = cloudWith(JSON.stringify(rawRecord({ measurements: [WEIGHT, FUTURE] })));
    const file = await sync.load();
    expect(ids(readableView(file).file.measurements)).toEqual(['w1']);
    expect(readableView(file).count).toBe(1);

    file.measurements.push(createMeasurement({ id: 'w2', metricType: 'hdl', value: 1.4, recordedAt: LATER, createdAt: LATER }));
    await sync.save(file);
    const kept = stored(cloud).measurements.find((m: { id: string }) => m.id === 'f1');
    expect(JSON.stringify(kept)).toBe(JSON.stringify(FUTURE));
    expect(ids(stored(cloud).measurements)).toEqual(['f1', 'w1', 'w2']);
  });

  it('a wrongly typed value and a string height are hidden from readers and kept in the file', async () => {
    const profile = { updatedAt: DAY, lamport: 3, sex: 'female', heightCm: 'synthetic-tall' };
    const { cloud, sync } = cloudWith(JSON.stringify(rawRecord({ measurements: [WEIGHT, WORDY], profile })));
    const file = await sync.load();
    const view = readableView(file);
    expect(ids(view.file.measurements)).toEqual(['w1']);
    expect(view.file.profile.heightCm).toBeUndefined();
    expect(view.file.profile.sex).toBe('female');
    expect(view.count).toBe(2);
    await sync.save(file);
    expect(stored(cloud).profile.heightCm).toBe('synthetic-tall');
    expect(stored(cloud).measurements.find((m: { id: string }) => m.id === 'v1')).toEqual(WORDY);
  });

  it('a readable record is its own view, and so is a view', () => {
    const file = read(rawRecord({}));
    expect(readableView(file)).toEqual({ file, count: 0 });
    const hidden = readableView(read(rawRecord({ measurements: [WEIGHT, FUTURE] })));
    expect(readableView(hidden.file)).toBe(hidden);
  });

  it('legacy shapes that opened on main stay visible: no status, a null source, null metadata, no createdAt', () => {
    const { status: _s, createdAt: _c, ...bare } = WEIGHT;
    const file = read(rawRecord({
      measurements: [bare, { ...WEIGHT, id: 'w3', source: null }],
      documents: [{ id: 'd1', title: 'Synthetic letter', addedAt: DAY, metadata: null }],
      medications: [{ id: 'm1', medicationKey: 'statin', drugName: 'atorvastatin', updatedAt: DAY }],
    }));
    const view = readableView(file);
    expect(view.count).toBe(0);
    expect(view.file).toBe(file);
  });
});

describe('US-65 AC1: every build merges, erases and corrects them as before', () => {
  it('a merge of two files each holding unreadable rows keeps both, in either order', () => {
    const a = read(rawRecord({ measurements: [WEIGHT, FUTURE] }));
    const b = read(rawRecord({ measurements: [WORDY] }));
    for (const merged of [mergeFiles(a, b, CTX), mergeFiles(b, a, CTX)]) {
      expect(ids(merged.measurements)).toEqual(['f1', 'v1', 'w1']);
      expect(readableView(merged).count).toBe(2);
    }
  });

  it('an erase lists and removes them, and a stale copy cannot bring them back', () => {
    const before = read(rawRecord({ measurements: [WEIGHT, FUTURE, WORDY] }));
    const erased = buildErasedFile({ stored: before, own: before, device: null, ctx: CTX });
    expect(erased.erasedRows?.ids).toEqual(expect.arrayContaining(['f1', 'v1', 'w1']));
    for (const merged of [mergeFiles(erased, before, CTX), mergeFiles(before, erased, CTX)]) {
      expect(merged.measurements).toEqual([]);
    }
  });

  it('a correction chain whose corrected row is unreadable stays consistent', () => {
    // A wrote 'synthetic' and was corrected by B; the view shows B, and correcting B appends C.
    const a = { ...WORDY, id: 'a', status: 'entered-in-error' };
    const b = createMeasurement({ id: 'b', metricType: 'hdl', value: 1.2, recordedAt: DAY, createdAt: LATER, correctsId: 'a', source: 'manual_correction' });
    const file = read(rawRecord({ measurements: [a, b] }));
    expect(ids(readableView(file).file.measurements)).toEqual(['b']);
    const result = correctValue(file, { id: 'b', newValue: 1.3, now: LATER });
    if (!result.ok) throw new Error(result.message);
    const rows = Object.fromEntries(result.file.measurements.map((m) => [m.id, m]));
    expect(rows.a).toEqual(a);
    expect(rows.b.status).toBe('entered-in-error');
    expect(result.row.correctsId).toBe('b');
    expect(readableView(result.file).file.measurements.filter((m) => m.status === 'active').map((m) => m.value)).toEqual([1.3]);
  });
});

describe('US-65 AC3: agents never see them', () => {
  it('read_record and get_plan leave out unreadable rows and profile fields', () => {
    const file = read(rawRecord({ measurements: [WEIGHT, FUTURE, WORDY], profile: { updatedAt: DAY, sex: 'male', birthYear: 1970, heightCm: 'synthetic-tall' } }));
    const out = callTool('read_record', {}, { file, now: LATER });
    if (out.status !== 'ok') throw new Error(out.text);
    expect(out.text).not.toContain('synthetic');
    expect(JSON.stringify(out.data)).not.toContain('synthetic');
    const plan = callTool('get_plan', {}, { file, now: LATER });
    expect(JSON.stringify(plan)).not.toContain('synthetic_future_metric');
  });
});

describe('US-65 AC5: the refusals are unchanged, the file untouched', () => {
  it.each([
    ['not JSON', '{not json', /JSON/],
    ['not an object', '[1, 2]', RecordShapeError],
    ['no schemaVersion', JSON.stringify({ measurements: [] }), RecordShapeError],
    ['a row array that is not a list', JSON.stringify(rawRecord({ measurements: 'synthetic' })), RecordShapeError],
    ['a newer schema', JSON.stringify(rawRecord({ schemaVersion: 99 })), SchemaTooNewError],
  ] as const)('%s', async (_, json, error) => {
    const { cloud, sync } = cloudWith(json);
    await expect(sync.load()).rejects.toThrow(error as never);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.json).toBe(json);
  });

  it('the newer-version message is the one main shows', () => {
    expect(new SchemaTooNewError(99, 2).message).toContain('Update the app before writing, or your newer data could be lost.');
  });
});

