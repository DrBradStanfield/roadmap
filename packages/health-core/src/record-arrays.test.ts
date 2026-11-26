/**
 * Lead A1-3: which arrays hold the record's rows is said once, in
 * roadmap-file.ts, and every list that names them derives from it. These
 * tests walk that one list through each consumer, so a new row array that
 * any consumer missed fails here (and an unclassified array fails the
 * typecheck on RECORD_ARRAYS, ROWS and ROW_STAMPS).
 */
import { describe, expect, it } from 'vitest';
import { APPEND_ONLY_ARRAYS, createEmptyFile, ROW_ARRAYS, type RoadmapFile } from './roadmap-file';
import { ROADMAP_DOC } from './roadmap-doc';
import { readableView } from './readable-rows';
import { rowRootIds } from './merge';
import { RecordShapeError } from './migrate';

const ctx = { deviceId: 'd', now: '2026-11-25T00:00:00.000Z' };
const empty = () => createEmptyFile(ctx);
/** One row per array, unreadable to every reader test (a wrong type on a field each reads). */
const junkRow = (id: string) => ({ id, metricType: 5, metricName: 5, medicationKey: 5, supplementKey: 5, title: 5 });
const withRow = (key: (typeof ROW_ARRAYS)[number], row: object): RoadmapFile =>
  ({ ...empty(), [key]: [row] }) as unknown as RoadmapFile;

describe('the record\'s row arrays, kept once (lead A1-3)', () => {
  it('keeps the shape gate\'s order, and the append-only ones in rowIds\' former order', () => {
    expect(ROW_ARRAYS).toEqual(['measurements', 'labValues', 'medications', 'supplements', 'documents', 'medicationHistory', 'supplementHistory']);
    expect(APPEND_ONLY_ARRAYS).toEqual(['measurements', 'labValues', 'documents', 'medicationHistory', 'supplementHistory']);
  });

  it('every row array is an array in a new record', () => {
    for (const key of ROW_ARRAYS) expect(empty()[key]).toEqual([]);
  });

  it.each([...ROW_ARRAYS])('the shape gate refuses a %s that is not a list', (key) => {
    expect(() => ROADMAP_DOC.migrate({ schemaVersion: 1, [key]: 'not a list' }, ctx)).toThrow(RecordShapeError);
    expect(() => ROADMAP_DOC.migrate({ schemaVersion: 1, [key]: 'not a list' }, ctx)).toThrow(`its ${key} is not a list`);
  });

  it.each([...ROW_ARRAYS])('readers skip an unreadable row in %s', (key) => {
    const view = readableView(withRow(key, junkRow('x')));
    expect(view.count).toBe(1);
    expect(view.file[key]).toEqual([]);
  });

  it.each([...ROW_ARRAYS])('the erase sees the ids of rows in %s', (key) => {
    expect(rowRootIds(withRow(key, { id: `row-${key}` }))).toEqual([`row-${key}`]);
  });

  it.each([...ROW_ARRAYS])('verify-after-write checks %s ids only when the array is append-only', (key) => {
    const ids = ROADMAP_DOC.rowIds!(withRow(key, { id: `row-${key}` }));
    expect(ids).toEqual(APPEND_ONLY_ARRAYS.includes(key) ? [`row-${key}`] : []);
  });
});
