/**
 * Exact ties in the merge (mutation-testing trial, 2026-10-30). Every case
 * runs both merge orders: when two copies tie on time, counter or epoch, the
 * result must not depend on which side merged first (US-10, AC8), and an erase
 * at an equal epoch must neither win nor lose by order (US-09 AC20, AC23).
 */
import { describe, it, expect } from 'vitest';
import { latestStamp, mergeErasedRows, mergeFiles } from './merge';
import {
  createEmptyFile,
  stableStringify,
  type FileMeasurement,
  type FileMedication,
  type RoadmapFile,
} from './roadmap-file';

const OPTS = { deviceId: 'dev_merge', now: '2026-06-08T12:00:00Z' };

function emptyFile(): RoadmapFile {
  return createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' });
}

function measurement(p: Partial<FileMeasurement> & { id: string; value: number }): FileMeasurement {
  return {
    metricType: 'ldl',
    recordedAt: '2026-05-01',
    createdAt: '2026-05-01T08:00:00Z',
    source: 'manual',
    status: 'active',
    correctsId: null,
    externalId: null,
    ...p,
  };
}

/** mergeFiles(a, b) and mergeFiles(b, a), asserted identical byte for byte. */
function bothWays(a: RoadmapFile, b: RoadmapFile, opts = OPTS): RoadmapFile {
  const ab = mergeFiles(a, b, opts);
  const ba = mergeFiles(b, a, opts);
  expect(stableStringify(ab)).toBe(stableStringify(ba));
  return ab;
}

const actives = (f: RoadmapFile) => f.measurements.filter((m) => m.status === 'active');

describe('US-10 AC8: latestStamp picks the later instant, and of one instant the larger spelling, in either order', () => {
  const Z = '2026-05-01T09:00:00Z';
  const MS = '2026-05-01T09:00:00.000Z';
  const OFFSET = '2026-05-01T10:00:00+01:00'; // the same instant as Z

  it('one instant in two spellings: the larger string, whichever comes first', () => {
    // 'Z' (0x5A) sorts after '.' (0x2E) and after '1' in the offset spelling.
    expect(latestStamp(Z, MS)).toBe(Z);
    expect(latestStamp(MS, Z)).toBe(Z);
    expect(latestStamp(Z, OFFSET)).toBe(OFFSET); // '2026-05-01T10…' > '2026-05-01T09…'
    expect(latestStamp(OFFSET, Z)).toBe(OFFSET);
  });

  it('a later instant wins even when its string sorts lower', () => {
    const later = '2026-05-01T09:30:00Z'; // later than OFFSET (09:00Z) but a smaller string
    expect(latestStamp(OFFSET, later)).toBe(later);
    expect(latestStamp(later, OFFSET)).toBe(later);
  });

  it('the merged file clock is the same in either merge order when the two metas tie in time', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.updatedAt = Z;
    b.meta.updatedAt = MS;
    const early = { deviceId: 'dev_merge', now: '2026-01-01T00:00:00Z' };
    expect(bothWays(a, b, early).meta.updatedAt).toBe(Z);
  });
});

describe('US-10: one active row per slot on an exact createdAt tie (the larger id wins)', () => {
  it('two devices, same day, same createdAt: the larger id stays active, the other is kept as entered-in-error', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'm_A', value: 2.1 })];
    b.measurements = [measurement({ id: 'm_B', value: 2.3 })];
    const merged = bothWays(a, b);
    expect(merged.measurements).toHaveLength(2);
    expect(actives(merged).map((m) => m.id)).toEqual(['m_B']);
    expect(merged.measurements.find((m) => m.id === 'm_A')!.status).toBe('entered-in-error');
  });

  it('three contents under one reused id: the largest quarantine id wins, not the last content', () => {
    // Content order is 2.1 < 2.3 < 2.5; the quarantine ids of 2.3 and 2.5 sort
    // the other way, so "last row wins" and "larger id wins" disagree here.
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [measurement({ id: 'm1', value: 2.1 }), measurement({ id: 'm1', value: 2.3 })];
    b.measurements = [measurement({ id: 'm1', value: 2.5 })];
    const merged = bothWays(a, b);
    expect(merged.measurements).toHaveLength(3);
    const ids = merged.measurements.map((m) => m.id);
    const largest = [...ids].sort().at(-1);
    expect(actives(merged).map((m) => m.id)).toEqual([largest]);
    expect(actives(merged)[0].value).toBe(2.3);
  });
});

describe('US-10 AC8: tied clocks on a last-write-wins row resolve the same way in either order', () => {
  const med = (drugName: string): FileMedication => ({
    id: 'med_statin', medicationKey: 'statin', drugName, doseValue: 20, doseUnit: 'mg', updatedAt: '2026-05-01T09:00:00Z', lamport: 3,
  });

  it('same updatedAt and lamport, different drug: one winner, the same both ways', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.medications = [med('atorvastatin')];
    b.medications = [med('rosuvastatin')];
    const merged = bothWays(a, b);
    expect(merged.medications).toHaveLength(1);
    // The content tie-break: the larger stable string.
    const expected = [med('atorvastatin'), med('rosuvastatin')].sort((x, y) => (stableStringify(x) < stableStringify(y) ? -1 : 1))[1];
    expect(merged.medications[0].drugName).toBe(expected.drugName);
  });
});

describe('US-10: recommendation snapshots on one date keep the richer copy, from either side', () => {
  const snap = (n: number, tag = 's') => ({ date: '2026-06-01', suggestions: Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}` }) as any) });

  it('the local copy is richer: it replaces the remote one', () => {
    const local = emptyFile();
    const remote = emptyFile();
    local.recommendationSnapshots = [snap(3)];
    remote.recommendationSnapshots = [snap(1)];
    expect(mergeFiles(local, remote, OPTS).recommendationSnapshots[0].suggestions).toHaveLength(3);
    expect(bothWays(local, remote).recommendationSnapshots[0].suggestions).toHaveLength(3);
  });

  it('equally rich: the larger stable string wins in either order', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.recommendationSnapshots = [snap(2, 'a')];
    b.recommendationSnapshots = [snap(2, 'b')];
    expect(bothWays(a, b).recommendationSnapshots[0].suggestions[0].id).toBe('b0');
  });
});

describe('US-09 AC23, US-10: an exact tie in eraseEpoch', () => {
  it('equal epochs with no list: neither copy is erased by the other; rows union both ways', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.eraseEpoch = 2;
    b.meta.eraseEpoch = 2;
    a.measurements = [measurement({ id: 'm_a', value: 2.1, recordedAt: '2026-05-01' })];
    b.measurements = [measurement({ id: 'm_b', value: 2.2, recordedAt: '2026-05-02' })];
    const merged = bothWays(a, b);
    expect(merged.meta.eraseEpoch).toBe(2);
    expect(actives(merged).map((m) => m.id)).toEqual(['m_a', 'm_b']);
  });

  it('equal epochs, both listed: the ids union and the larger fromEpoch stands, in either order', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.eraseEpoch = 3;
    b.meta.eraseEpoch = 3;
    a.erasedRows = { fromEpoch: 1, ids: ['x'] };
    b.erasedRows = { fromEpoch: 3, ids: ['y'] };
    expect(mergeErasedRows(a, b)).toEqual({ fromEpoch: 3, ids: ['x', 'y'] });
    expect(mergeErasedRows(b, a)).toEqual({ fromEpoch: 3, ids: ['x', 'y'] });
  });

  it('equal epochs, one list: it claims nothing at that epoch (eraseEpoch + 1), in either order', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.eraseEpoch = 3;
    b.meta.eraseEpoch = 3;
    a.erasedRows = { fromEpoch: 2, ids: ['x'] };
    expect(mergeErasedRows(a, b)).toEqual({ fromEpoch: 4, ids: ['x'] });
    expect(mergeErasedRows(b, a)).toEqual({ fromEpoch: 4, ids: ['x'] });
  });

  it('epochs one apart: the higher wins in either order, and the lower copy brings no pre-erase row', () => {
    const erased = emptyFile();
    erased.meta.eraseEpoch = 1;
    erased.meta.erasedAt = '2026-05-10T00:00:00Z';
    const stale = emptyFile();
    stale.measurements = [measurement({ id: 'm_old', value: 2.1, createdAt: '2026-05-01T08:00:00Z' })];
    const merged = bothWays(erased, stale);
    expect(merged.meta.eraseEpoch).toBe(1);
    expect(merged.measurements).toEqual([]);
  });
});

describe('US-10 AC8: two spellings of one erasedAt instant resolve the same way in either order', () => {
  it('equal epochs, no lists, erasedAt tie: the larger spelling, byte for byte both ways', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.eraseEpoch = 2;
    b.meta.eraseEpoch = 2;
    a.meta.erasedAt = '2026-05-10T00:00:00.000Z';
    b.meta.erasedAt = '2026-05-10T00:00:00Z'; // the same instant; 'Z' sorts after '.'
    const ab = mergeFiles(a, b, OPTS);
    const ba = mergeFiles(b, a, OPTS);
    expect(JSON.stringify(ab)).toBe(JSON.stringify(ba));
    expect(ab.meta.erasedAt).toBe('2026-05-10T00:00:00Z');
  });
});

describe('US-10: recommendation snapshots on dates only one side has all survive, in a stable order', () => {
  const snap = (date: string) => ({ date, suggestions: [{ id: `s_${date}` } as any] });

  it('a local-only date and a remote-only date both survive the merge, in either order', () => {
    const local = emptyFile();
    const remote = emptyFile();
    local.recommendationSnapshots = [snap('2026-06-02')];
    remote.recommendationSnapshots = [snap('2026-06-01')];
    expect(mergeFiles(local, remote, OPTS).recommendationSnapshots.map((s) => s.date)).toEqual(['2026-06-01', '2026-06-02']);
    expect(mergeFiles(remote, local, OPTS).recommendationSnapshots.map((s) => s.date)).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('snapshot order does not depend on merge order', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.recommendationSnapshots = [snap('2026-06-03'), snap('2026-06-01')];
    b.recommendationSnapshots = [snap('2026-06-02')];
    const merged = bothWays(a, b);
    expect(JSON.stringify(mergeFiles(a, b, OPTS))).toBe(JSON.stringify(mergeFiles(b, a, OPTS)));
    expect(merged.recommendationSnapshots.map((s) => s.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });
});

describe('US-10: the erase-gate rescue re-merge keeps this merge\'s device and clock', () => {
  // The higher epoch wins; the stale copy's row created after erasedAt is
  // rescued through a second mergeFiles call, which must still see opts.
  function rescueInputs() {
    const erased = emptyFile();
    erased.meta.eraseEpoch = 1;
    erased.meta.erasedAt = '2026-05-10T00:00:00Z';
    erased.meta.updatedAt = '2026-05-10T00:00:00Z';
    const stale = emptyFile();
    stale.meta.updatedAt = '2026-05-12T00:00:00Z';
    stale.measurements = [measurement({ id: 'm_new', value: 2.1, recordedAt: '2026-05-11', createdAt: '2026-05-11T08:00:00Z' })];
    return { erased, stale };
  }

  it('the rescued row survives, and lastDeviceId and updatedAt come from opts.now, in either order', () => {
    const { erased, stale } = rescueInputs();
    const merged = bothWays(erased, stale);
    expect(merged.measurements.map((m) => m.id)).toEqual(['m_new']);
    expect(merged.meta.eraseEpoch).toBe(1);
    expect(merged.meta.lastDeviceId).toBe(OPTS.deviceId);
    expect(merged.meta.updatedAt).toBe(OPTS.now);
  });

  it("the loser's later meta clock is not rewound when it is later than opts.now", () => {
    const { erased, stale } = rescueInputs();
    stale.meta.updatedAt = '2026-07-01T00:00:00Z'; // after OPTS.now
    const merged = bothWays(erased, stale);
    expect(merged.meta.updatedAt).toBe('2026-07-01T00:00:00Z');
    expect(merged.meta.lastDeviceId).toBe(OPTS.deviceId);
  });
});
