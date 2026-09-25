/**
 * The clocks of a field-stamped profile or screening answers (US-10 AC6):
 * what a tie picks, what a comparison costs, and the stamp invariant every
 * writer and the merge keep. stableStringify is wrapped so a test can count
 * the serialisations a merge spends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergeFiles, stampFields } from './merge';
import { createEmptyFile, stableStringify, type RoadmapFile, type RoadmapProfile, type SyncStamp } from './roadmap-file';

vi.mock('./roadmap-file', async (original) => {
  const actual = await original<typeof import('./roadmap-file')>();
  return { ...actual, stableStringify: vi.fn(actual.stableStringify) };
});

const OPTS = { deviceId: 'dev_merge', now: '2026-06-08T12:00:00Z' };
const T0 = '2026-05-01T00:00:00Z';
const T1 = '2026-05-02T09:00:00Z';
const T2 = '2026-05-02T09:05:00Z';
const at = (lamport: number, updatedAt: string) => ({ lamport, updatedAt });

function withProfile(profile: Record<string, unknown>): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' });
  file.profile = profile as unknown as RoadmapProfile;
  return file;
}

beforeEach(() => {
  vi.mocked(stableStringify).mockClear();
});

describe('a tie between two field stamps picks the same value it always did (US-10 AC6)', () => {
  // Winners as the merge picked them before the clock comparison changed: the
  // larger serialised value. So 50 beats 5, and 9 beats 10.
  const cases: Array<[unknown, unknown, unknown]> = [
    [5, 50, 50],
    [9, 10, 9],
    [-1, 1, 1],
    ['a', 'b', 'b'],
    ['male', 'female', 'male'],
    [true, false, true],
    [180, undefined, 180],
    [7, 7, 7],
  ];
  it.each(cases)('%j against %j: %j wins, whichever side merges', (x, y, winner) => {
    const a = withProfile({ v: x, updatedAt: T1, lamport: 2, fieldStamps: { v: at(2, T1) } });
    const b = withProfile({ v: y, updatedAt: T1, lamport: 2, fieldStamps: { v: at(2, T1) } });
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect((merged.profile as unknown as Record<string, unknown>).v).toBe(winner);
      expect(merged.profile.fieldStamps).toEqual({ v: at(2, T1) });
    }
  });

  it('a field stamp tied with the object\'s own reads as the field\'s, and a tie in time falls to the value', () => {
    // Both sides' field stamps equal their own stamp; `w` ties on lamport and time.
    const a = withProfile({ v: 1, w: 'x', updatedAt: T2, lamport: 3, fieldStamps: { v: at(3, T2), w: at(1, T0) } });
    const b = withProfile({ v: 2, w: 'y', updatedAt: T1, lamport: 3, fieldStamps: { v: at(3, T1), w: at(1, T0) } });
    for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS)]) {
      expect(merged.profile).toMatchObject({ v: 1, w: 'y', updatedAt: T2, lamport: 3 });
    }
  });
});

describe('comparing clocks serialises nothing (US-10 AC6)', () => {
  it('a merge of two stamped profiles with tied field stamps and equal values calls stableStringify not once', () => {
    const a = withProfile({ x: 1, y: 2, z: 3, updatedAt: T1, lamport: 2, fieldStamps: { x: at(1, T0), y: at(2, T1), z: at(1, T0) } });
    const b = withProfile({ x: 1, y: 2, z: 3, updatedAt: T0, lamport: 1, fieldStamps: { x: at(1, T0), y: at(1, T0), z: at(1, T0) } });
    b.screenings.updatedAt = T0; // two empty screenings with one stamp would tie on content, as whole objects always did
    vi.mocked(stableStringify).mockClear();
    mergeFiles(a, b, OPTS);
    expect(vi.mocked(stableStringify)).not.toHaveBeenCalled();
  });
});

/** -1, 0 or 1: lamport first, then time — the order the merge reads stamps in. */
function cmp(a: SyncStamp, b: SyncStamp): number {
  const la = a.lamport ?? 0;
  const lb = b.lamport ?? 0;
  if (la !== lb) return la < lb ? -1 : 1;
  return a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? -1 : 1;
}

/** The stamp invariant: the object's own stamp is at or above every field stamp. */
function holdsInvariant(obj: RoadmapProfile): boolean {
  return Object.values(obj.fieldStamps ?? {}).every((stamp) => cmp(obj, stamp) >= 0);
}

describe('the stamp invariant: stampFields and the merge keep the object\'s stamp at or above every field stamp (US-10 AC6)', () => {
  it('holds after any run of writes, older-app writes, merges and merges with an empty object', () => {
    // A seeded generator, so a failure replays.
    let seed = 20260925;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const FIELDS = ['sex', 'heightCm', 'birthYear', 'unitSystem'] as const;
    const TIMES = ['2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z', '2026-05-04T00:00:00Z'];
    const VALUES = [undefined, 1, 2, 'a', 'b'];

    const fresh = (): RoadmapProfile => {
      const obj: Record<string, unknown> = { updatedAt: pick(TIMES) };
      if (rand() < 0.7) obj.lamport = Math.floor(rand() * 3);
      for (const field of FIELDS) if (rand() < 0.5) obj[field] = pick(VALUES.slice(1));
      return obj as unknown as RoadmapProfile;
    };
    const merge = (a: RoadmapProfile, b: RoadmapProfile) => {
      const fa = withProfile(a as unknown as Record<string, unknown>);
      const fb = withProfile(b as unknown as Record<string, unknown>);
      return mergeFiles(fa, fb, OPTS).profile;
    };

    let checked = 0;
    for (let run = 0; run < 300; run++) {
      const copies = [fresh(), fresh(), fresh()];
      for (let step = 0; step < 12; step++) {
        const i = Math.floor(rand() * copies.length);
        const op = rand();
        if (op < 0.4) {
          const changes: Record<string, unknown> = {};
          for (const field of FIELDS) if (rand() < 0.4) changes[field] = pick(VALUES);
          copies[i] = stampFields(copies[i], changes as Partial<RoadmapProfile>, pick(TIMES));
        } else if (op < 0.5) {
          // An older app, or a hand edit under the agent rules: a field
          // changed in place, the time moved, the lamport and field stamps left.
          copies[i] = { ...copies[i], [pick(FIELDS)]: pick(VALUES.slice(1)), updatedAt: TIMES[TIMES.length - 1] };
        } else if (op < 0.6) {
          // The empty record a missing file migrates to, stamped at any clock.
          const empty = { updatedAt: pick(TIMES), lamport: Math.floor(rand() * 5) } as RoadmapProfile;
          copies[i] = rand() < 0.5 ? merge(copies[i], empty) : merge(empty, copies[i]);
        } else {
          copies[i] = merge(copies[i], pick(copies));
        }
        expect(holdsInvariant(copies[i]), JSON.stringify(copies[i])).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(3600);
  });
});
