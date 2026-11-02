// Rules in merge.ts that no existing test pinned. Each test fails when one
// small change to the rule it names is made in merge.ts, a change every
// existing health-core test still passes with.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  daysBetween, laterStamp, mergeFiles, rowRootIds, stampInstant, withoutListed,
} from './merge';
import {
  createEmptyFile,
  stableStringify,
  type RoadmapFile,
  type FileMeasurement,
  type FileMedication,
  type RoadmapProfile,
} from './roadmap-file';

const OPTS = { deviceId: 'dev_merge', now: '2026-06-08T12:00:00Z' };
const STAMP = { updatedAt: '2026-03-01T00:00:00Z', lamport: 1 };

function emptyFile(): RoadmapFile {
  return createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' });
}

function measurement(p: Partial<FileMeasurement> & { id: string; metricType: string; value: number }): FileMeasurement {
  return {
    recordedAt: '2026-05-01',
    createdAt: '2026-05-01T08:00:00Z',
    source: 'manual',
    status: 'active',
    correctsId: null,
    externalId: null,
    ...p,
  };
}
function weight(id: string, recordedAt: string, createdAt: string): FileMeasurement {
  return measurement({ id, metricType: 'weight', value: 80, recordedAt, createdAt });
}
function med(id: string, medicationKey: string): FileMedication {
  return { id, medicationKey, drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', ...STAMP };
}
const ids = (file: RoadmapFile) =>
  [...file.measurements, ...file.medications].map((r) => r.id).sort();

/** The content signature unionRows quarantines under: no id, no status. */
function signature(row: FileMeasurement): string {
  const { id: _id, status: _status, ...rest } = row;
  return stableStringify(rest);
}

afterEach(() => vi.restoreAllMocks());

describe('daysBetween', () => {
  it('is negative when `to` is before `from` (a row dated ahead of the UTC day)', () => {
    expect(daysBetween('2026-05-02', '2026-05-01')).toBe(-1);
    expect(daysBetween('2026-05-01', '2026-05-11')).toBe(10);
  });
});

describe('US-10: a reused row id', () => {
  it('the SMALLEST content signature keeps the base id, in either merge order', () => {
    const a = emptyFile();
    const b = emptyFile();
    const ra = measurement({ id: 'm1', metricType: 'weight', value: 70, recordedAt: '2026-05-01' });
    const rb = measurement({ id: 'm1', metricType: 'weight', value: 80, recordedAt: '2026-05-03' });
    a.measurements = [ra];
    b.measurements = [rb];
    const smallValue = signature(ra) < signature(rb) ? ra.value : rb.value;
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.measurements.find((m) => m.id === 'm1')!.value).toBe(smallValue);
    }
  });
});

describe('US-10: stored array order', () => {
  it('measurements come out sorted by id even when slots interleave', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.measurements = [
      measurement({ id: 'a', metricType: 'weight', value: 70, createdAt: '2026-05-01T08:00:00Z' }),
      measurement({ id: 'b', metricType: 'waist', value: 80 }),
    ];
    b.measurements = [measurement({ id: 'c', metricType: 'weight', value: 71, createdAt: '2026-05-01T09:00:00Z' })];
    expect(mergeFiles(a, b, OPTS).measurements.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('current-state lists come out sorted ascending by key', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.medications = [med('med_statin', 'statin')];
    b.medications = [med('med_metformin', 'metformin')];
    expect(mergeFiles(a, b, OPTS).medications.map((m) => m.medicationKey)).toEqual(['metformin', 'statin']);
  });
});

describe('US-10 AC6: profile field clocks', () => {
  it('field stamps count when the object stamp is BEHIND them (hand-edited clock)', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.profile = {
      sex: 'male', lamport: 1, updatedAt: '2026-05-01T00:00:00Z',
      fieldStamps: { sex: { lamport: 3, updatedAt: '2026-05-03T00:00:00Z' } },
    } as RoadmapProfile;
    b.profile = { sex: 'female', lamport: 2, updatedAt: '2026-05-02T00:00:00Z' } as RoadmapProfile;
    expect(mergeFiles(a, b, OPTS).profile.sex).toBe('male');
    expect(mergeFiles(b, a, OPTS).profile.sex).toBe('male');
  });

  it('a tie in clock time stores the smaller spelling, in either order', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.profile = { sex: 'male', lamport: 1, updatedAt: '2026-05-01T00:00:00.000Z' } as RoadmapProfile;
    b.profile = { sex: 'male', lamport: 1, updatedAt: '2026-05-01T00:00:00Z' } as RoadmapProfile;
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.profile.fieldStamps!.sex.updatedAt).toBe('2026-05-01T00:00:00.000Z');
      expect(merged.profile.updatedAt).toBe('2026-05-01T00:00:00.000Z');
    }
  });

  it('an own key holding undefined on neither-stamped sides is skipped, not stamped', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.profile = { sex: 'male', heightCm: undefined, lamport: 1, updatedAt: '2026-05-01T00:00:00Z' } as RoadmapProfile;
    b.profile = { sex: 'male', lamport: 1, updatedAt: '2026-05-01T00:00:00Z' } as RoadmapProfile;
    const merged = mergeFiles(a, b, OPTS);
    expect(Object.keys(merged.profile.fieldStamps ?? {})).toEqual(['sex']);
  });
});

describe('US-10 AC8: stamp helpers', () => {
  it('stampInstant reads only strings: an array holding a stamp is NaN', () => {
    expect(stampInstant(['2026-05-01'])).toBeNaN();
    expect(stampInstant(['2026-05-01T00:00:00Z'])).toBeNaN();
  });

  it('laterStamp keeps `now` when the replaced stamp is the same instant', () => {
    expect(laterStamp('2026-05-01T00:00:00Z', '2026-05-01T00:00:00.000Z')).toBe('2026-05-01T00:00:00Z');
  });

  // stampInstant rebuilds the one form ECMAScript defines before parsing, so
  // V8 and the iPhone's JavaScriptCore read every string the same way.
  it('refuses minute 60 without asking the engine', () => {
    const parse = vi.spyOn(Date, 'parse');
    expect(stampInstant('2026-05-01T10:60:30Z')).toBeNaN();
    expect(parse).not.toHaveBeenCalled();
  });

  it('pads a short fraction to three digits before the engine reads it', () => {
    const parse = vi.spyOn(Date, 'parse');
    stampInstant('2026-05-02T09:00:00.5Z');
    expect(parse).toHaveBeenCalledWith('2026-05-02T09:00:00.500Z');
  });
});

describe('US-09 AC23: the epoch gate', () => {
  it('a copy that saw some of the listed erases still keeps rows no erase listed', () => {
    // Erases at 1, 2 and 3 all listed (fromEpoch 1). The stale copy saw 1 and 2,
    // so it is one erase behind (epoch 2 against the winner's 3).
    const erased = emptyFile();
    erased.schemaVersion = 2;
    erased.meta.eraseEpoch = 3;
    erased.meta.erasedAt = '2026-04-15T00:00:00.000Z';
    erased.erasedRows = { fromEpoch: 1, ids: ['gone'] };
    const stale = emptyFile();
    stale.meta.eraseEpoch = 2;
    stale.measurements = [weight('gone', '2026-04-01', '2026-04-01T08:00:00Z'), weight('before', '2026-04-02', '2026-04-02T08:00:00Z')];
    stale.medications = [med('statin-row', 'statin')];
    for (const merged of [mergeFiles(stale, erased, OPTS), mergeFiles(erased, stale, OPTS)]) {
      // 'before' predates erasedAt and the statin has no creation stamp: only
      // the list rule keeps them; the legacy erasedAt rule would drop both.
      expect(ids(merged)).toEqual(['before', 'statin-row']);
      expect(merged.meta.eraseEpoch).toBe(3);
    }
  });

  it('with nothing to rescue, returns the winner as it is, not re-merged with itself', () => {
    const winner = emptyFile();
    winner.meta.eraseEpoch = 1;
    winner.meta.erasedAt = '2026-04-15T00:00:00.000Z';
    winner.profile = { ...winner.profile, sex: 'female' };
    const stale = emptyFile();
    stale.measurements = [weight('old', '2026-04-01', '2026-04-01T08:00:00Z')]; // before erasedAt
    for (const merged of [mergeFiles(stale, winner, OPTS), mergeFiles(winner, stale, OPTS)]) {
      expect(merged.measurements).toEqual([]);
      expect(merged.profile).toEqual(winner.profile); // no fieldStamps added by a self-merge
    }
  });
});

describe('US-09 AC23: rows whose id is not a string are skipped, never read', () => {
  const odd = () => [{ id: 5 }, { id: undefined }] as unknown as FileMeasurement[];

  it('rowRootIds', () => {
    const file = emptyFile();
    file.measurements = [...odd(), weight('x#si', '2026-04-01', '2026-04-01T08:00:00Z')];
    expect(rowRootIds(file)).toEqual(['x']);
  });

  it('withoutListed keeps them', () => {
    const file = emptyFile();
    file.measurements = [...odd(), weight('x', '2026-04-01', '2026-04-01T08:00:00Z')];
    expect(withoutListed(file, new Set(['x'])).measurements).toEqual(odd());
  });

  it('the epoch gate does not carry them across', () => {
    const erased = emptyFile();
    erased.schemaVersion = 2;
    erased.meta.eraseEpoch = 1;
    erased.erasedRows = { fromEpoch: 1, ids: [] };
    const stale = emptyFile();
    stale.medications = [{ ...med('m', 'statin'), id: undefined } as unknown as FileMedication];
    expect(mergeFiles(stale, erased, OPTS).medications).toEqual([]);
  });
});

describe('US-09 AC23: withoutListed', () => {
  it('returns the same object when it names no row', () => {
    const file = emptyFile();
    expect(withoutListed(file, new Set())).toBe(file);
  });
});

describe('equal-epoch meta', () => {
  it('createdAt: the earlier of the two, in either order', () => {
    const a = emptyFile();
    const b = emptyFile();
    a.meta.createdAt = '2025-01-01T00:00:00Z';
    b.meta.createdAt = '2026-01-01T00:00:00Z';
    expect(mergeFiles(a, b, OPTS).meta.createdAt).toBe('2025-01-01T00:00:00Z');
    expect(mergeFiles(b, a, OPTS).meta.createdAt).toBe('2025-01-01T00:00:00Z');
  });
});
