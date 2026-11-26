// US-72 AC18 (H35, owner's rulings 2026-11-27): a Health Records result whose date is
// malformed, unreal, later than now or missing is skipped, never dated by a fall-back, and
// counted as `undated` inside `notRead`. A malformed `meta` is not a bad date: it stays lenient.
// Synthetic values throughout.
import { describe, expect, it } from 'vitest';
import { importHealthRecords, type ClinicalRecordInput } from './health-records-import';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const NOW = '2026-11-02T08:00:00.000Z';
const NONE = { added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 };
const LONG = `2026-10-21T08:00:00Z${'0'.repeat(60)}`;

const empty = (): RoadmapFile => createEmptyFile({ deviceId: 'phone', now: '2026-10-01T00:00:00.000Z' });
const run = (records: ClinicalRecordInput[]) => importHealthRecords(empty(), records, { now: NOW });

/** An LDL result, released on 22 Oct; the test adds the draw it needs. */
function ldl(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Observation', id, status: 'final', meta: { versionId: '1' },
    code: { coding: [{ system: 'http://loinc.org', code: '13457-7' }] },
    valueQuantity: { value: 3.1, unit: 'mmol/L' }, issued: '2026-10-22T09:00:00Z', ...fields,
  };
}
const rec = (json: object, resourceType = 'Observation'): ClinicalRecordInput =>
  ({ sourceId: 'src', resourceType, fhirVersion: '1.0.2', json: JSON.stringify(json) });

/** A panel drawn on 21 Oct, released on 22 Oct, its results contained. */
function panel(results: Record<string, unknown>[], fields: Record<string, unknown> = {}): ClinicalRecordInput {
  return rec({
    resourceType: 'DiagnosticReport', id: 'panel-1', status: 'final', meta: { lastUpdated: '2026-10-22T10:00:00Z' },
    effectiveDateTime: '2026-10-21T08:00:00Z', issued: '2026-10-22T09:00:00Z',
    contained: results, result: results.map((r) => ({ reference: `#${String(r.id)}` })), ...fields,
  }, 'DiagnosticReport');
}

describe('US-72 AC18: a result with a bad date is skipped and counted, never dated by a fall-back', () => {
  it('H35 1: a top-level Observation whose effectivePeriod is malformed is one undated not-read, never a row on `issued`', () => {
    for (const effectivePeriod of [20261021, { start: 20261021 }, { start: LONG }, '2026-10-21']) {
      const { file, counts } = run([rec(ldl('a', { effectivePeriod }))]);
      expect(counts, JSON.stringify(effectivePeriod)).toEqual({ ...NONE, notRead: 1, undated: 1 });
      expect(file.labValues).toEqual([]);
    }
  });

  it('H35 2: a contained result with a malformed effectivePeriod is undated, never on the report\'s draw; the others land', () => {
    const { effectiveDateTime: _d, ...noDraw } = ldl('r1');
    const { file, counts } = run([panel([{ ...noDraw, effectivePeriod: { start: 20261021 } }, ldl('r2', { code: { coding: [{ system: 'http://loinc.org', code: '2085-9' }] } })])]);
    expect(counts).toEqual({ ...NONE, added: 1, notRead: 1, undated: 1 });
    expect(file.labValues.map((l) => [l.metricName, l.recordedAt])).toEqual([['hdl', '2026-10-21T08:00:00.000Z']]);
  });

  it('H35 3 (ruling 2): a top-level Observation with a malformed meta still lands on its own draw', () => {
    for (const meta of ['junk', { lastUpdated: LONG }, { versionId: 7 }]) {
      const { file, counts } = run([rec(ldl('a', { meta, effectiveDateTime: '2026-10-20' }))]);
      expect(counts, JSON.stringify(meta)).toEqual({ ...NONE, added: 1 });
      expect(file.labValues[0].recordedAt).toBe('2026-10-20T00:00:00.000Z');
    }
  });

  it('H35 4: a contained result with a malformed meta of its own still lands, versioned by the report\'s meta', () => {
    const { file, counts } = run([panel([ldl('r1', { meta: { lastUpdated: LONG } })])]);
    expect(counts).toEqual({ ...NONE, added: 1 });
    expect(file.labValues[0].externalId).toBe('src|DiagnosticReport|panel-1|r1#2026-10-22T10:00:00Z||final|3.1||mmol/L');
  });

  it('H35 5: a well-formed period with no start still falls to `issued`, as AC3 says', () => {
    const { file, counts } = run([rec(ldl('a', { effectivePeriod: { end: '2026-10-21T09:00:00Z' } }))]);
    expect(counts).toEqual({ ...NONE, added: 1 });
    expect(file.labValues[0].recordedAt).toBe('2026-10-22T09:00:00.000Z');
  });

  it('counts: every bad date is undated inside notRead; any other reason is notRead alone', () => {
    const { counts } = run([
      rec(ldl('d1', { effectiveDateTime: LONG })), // over the schema's 64 characters
      rec(ldl('d2', { effectiveDateTime: 'not a date' })),
      rec(ldl('d3', { effectiveDateTime: '2026-02-30' })), // an unreal day
      rec(ldl('d4', { effectiveDateTime: '2026-11-09' })), // later than now
      rec(ldl('d5', { issued: 'yesterday' })), // a release only, unreadable
      rec(ldl('d6', { issued: undefined })), // no date at all
      rec(ldl('o1', { effectiveDateTime: '2026-10-20', code: { coding: [{ system: 'http://loinc.org', code: '2345-7' }] } })), // a test not read
      rec(ldl('o2', { effectiveDateTime: '2026-10-20', status: 'preliminary' })),
      rec(ldl('o3!', { effectivePeriod: { start: 20261021 } })), // a bad id as well as a bad date
      rec(ldl('ok', { effectiveDateTime: '2026-10-20' })),
    ]);
    expect(counts).toEqual({ ...NONE, added: 1, notRead: 9, undated: 6 });
  });

  it('a malformed report-level date is one undated not-read; a batch with no bad date leaves the count out', () => {
    expect(run([panel([ldl('r1')], { effectiveDateTime: LONG })]).counts).toEqual({ ...NONE, notRead: 1, undated: 1 });
    expect(run([rec(ldl('a', { effectiveDateTime: '2026-10-20' }))]).counts).not.toHaveProperty('undated');
  });
});
