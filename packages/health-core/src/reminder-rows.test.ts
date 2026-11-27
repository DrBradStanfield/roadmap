/**
 * US-17 AC19 (untangle R9): the reminders opt-in merges as one row per token.
 * The stored object stays the newest row overall, today's rule; `shownOptIn`
 * is the newest active row. Every merge here runs the real `mergeFiles`, and
 * every tie runs the real `stableStringify`. Synthetic tokens and addresses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { buildErasedFile } from './erase';
import { mergeFiles, pickNewerOptional } from './merge';
import { migrateFile } from './migrate';
import { stampIsNewer } from './record-time';
import { mergeOptIn, rowsOf, shownOptIn } from './reminder-rows';
import { createEmptyFile, createMeasurement, stableStringify, type FileReminderOptIn, type ReminderTokenRow, type RoadmapFile } from './roadmap-file';
import { setReminderOptIn, setReminderRow } from './state-edits';

const CTX = { deviceId: 'dev_rows', now: '2026-05-09T12:00:00.000Z' };
const T = ['2026-05-01T10:00:00.000Z', '2026-05-02T10:00:00.000Z', '2026-05-03T10:00:00.000Z'];
const TOKENS = ['token-a', 'token-b', 'token-c'];

function row(token: string, status: 'active' | 'cancelled', t: number, lamport = 1, email = `${token}@example.test`): ReminderTokenRow {
  return { status, token, email, provider: 'dropbox', updatedAt: T[t], lamport };
}

function file(optIn?: FileReminderOptIn, epoch = 0): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'dev_rows', now: '2026-04-01T00:00:00.000Z' });
  f.meta.eraseEpoch = epoch;
  if (optIn) f.reminderOptIn = optIn;
  return f;
}

const merge = (a: RoadmapFile, b: RoadmapFile) => mergeFiles(a, b, CTX);
/** The object's own fields: what every reader of the stored object sees. */
const own = (optIn: FileReminderOptIn | undefined) => {
  if (!optIn) return undefined;
  const { tokens: _t, ...rest } = optIn;
  return rest;
};
const key = (optIn: FileReminderOptIn | undefined) => stableStringify(optIn ?? null);

describe('US-17 AC19: one device turns reminders on while another turns them off', () => {
  it('case 3 shows active B in both orders, and the stored object is cancelled A', () => {
    const one = file(row('token-b', 'active', 0));
    const two = file(row('token-a', 'cancelled', 1));
    for (const merged of [merge(one, two), merge(two, one)]) {
      expect(own(merged.reminderOptIn)).toEqual(row('token-a', 'cancelled', 1));
      expect(shownOptIn(merged)).toEqual(row('token-b', 'active', 0));
      expect(merged.reminderOptIn?.tokens).toEqual([row('token-b', 'active', 0)]);
    }
  });

  const cases: Array<[string, RoadmapFile, RoadmapFile, ReminderTokenRow, ReminderTokenRow]> = [
    ['1: active A, then cancelled A', file(row('token-a', 'active', 0)), file(row('token-a', 'cancelled', 1)), row('token-a', 'cancelled', 1), row('token-a', 'cancelled', 1)],
    ['2: active A, then active B', file(row('token-a', 'active', 0)), file(row('token-b', 'active', 1)), row('token-b', 'active', 1), row('token-b', 'active', 1)],
    ['3: active B, then cancelled A', file(row('token-b', 'active', 0)), file(row('token-a', 'cancelled', 1)), row('token-a', 'cancelled', 1), row('token-b', 'active', 0)],
    ['4: cancelled A, then active B', file(row('token-a', 'cancelled', 0)), file(row('token-b', 'active', 1)), row('token-b', 'active', 1), row('token-b', 'active', 1)],
    ['5: cancelled A, then cancelled B', file(row('token-a', 'cancelled', 0)), file(row('token-b', 'cancelled', 1)), row('token-b', 'cancelled', 1), row('token-b', 'cancelled', 1)],
  ];
  for (const [label, a, b, stored, shown] of cases) {
    it(`case ${label}: stored and shown, both orders`, () => {
      for (const merged of [merge(a, b), merge(b, a)]) {
        expect(own(merged.reminderOptIn)).toEqual(stored);
        expect(shownOptIn(merged)).toEqual(shown);
      }
    });
  }

  it('case 6: an erase at a higher epoch stands, token empty, and nothing nested travels', () => {
    const before = file(row('token-a', 'active', 0));
    before.reminderOptIn!.tokens = [row('token-b', 'active', 0)];
    const erased = buildErasedFile({ stored: before, own: before, device: null, ctx: CTX });
    for (const merged of [merge(before, erased), merge(erased, before)]) {
      expect(merged.reminderOptIn).toMatchObject({ status: 'cancelled', token: '', email: '' });
      expect(merged.reminderOptIn?.tokens).toBeUndefined();
      expect(shownOptIn(merged)).toMatchObject({ status: 'cancelled', token: '' });
    }
  });
});

describe('US-17 AC19: a file with one real token is what it is today, byte for byte', () => {
  it('merges to the newer object exactly, with no tokens key', () => {
    const a = file(row('token-a', 'active', 0));
    const b = file(row('token-a', 'cancelled', 1));
    for (const merged of [merge(a, b), merge(b, a)]) {
      expect(JSON.stringify(merged.reminderOptIn)).toBe(JSON.stringify(b.reminderOptIn));
      expect(JSON.stringify(merged)).not.toContain('"tokens"');
    }
  });

  it('on an exact tie that differs only in key order, keeps the remote object as pickNewerOptional did', () => {
    const ordered = row('token-a', 'active', 0);
    const reordered = { updatedAt: ordered.updatedAt, lamport: ordered.lamport, provider: ordered.provider, email: ordered.email, token: ordered.token, status: ordered.status } as FileReminderOptIn;
    const [a, b] = [file(ordered), file(reordered)];
    expect(JSON.stringify(merge(a, b).reminderOptIn)).toBe(JSON.stringify(pickNewerOptional(a.reminderOptIn, b.reminderOptIn)));
    expect(JSON.stringify(merge(a, b).reminderOptIn)).toBe(JSON.stringify(reordered));
    expect(JSON.stringify(merge(b, a).reminderOptIn)).toBe(JSON.stringify(ordered));
  });

  it('drops a superseded erase marker, as today', () => {
    const marker = file({ ...row('token-a', 'cancelled', 0), token: '', email: '' });
    const live = file(row('token-a', 'active', 1));
    for (const merged of [merge(marker, live), merge(live, marker)]) {
      expect(JSON.stringify(merged.reminderOptIn)).toBe(JSON.stringify(live.reminderOptIn));
    }
  });

  it('round-trips through migrate unchanged', () => {
    const f = file(row('token-a', 'active', 0));
    f.meta.updatedAt = T[2];
    const read = migrateFile(JSON.parse(JSON.stringify(f)), CTX);
    expect(JSON.stringify(read.reminderOptIn)).toBe(JSON.stringify(f.reminderOptIn));
  });
});

describe('US-17 AC19: what counts as a row', () => {
  it('skips an empty or non-string token, in the list or as the object', () => {
    const optIn = {
      ...row('token-a', 'active', 0),
      tokens: [{ ...row('x', 'active', 2), token: '' }, { ...row('x', 'active', 2), token: 5 }, row('token-b', 'cancelled', 1)],
    } as unknown as FileReminderOptIn;
    expect(rowsOf(optIn).map((r) => r.token)).toEqual(['token-a', 'token-b']);
    expect(rowsOf({ ...row('token-a', 'cancelled', 0), token: '' })).toEqual([]);
  });

  it('keeps one row per token, the newest, duplicates and nested lists included', () => {
    const optIn = {
      ...row('token-a', 'cancelled', 2),
      tokens: [row('token-b', 'active', 0), row('token-b', 'cancelled', 1), { ...row('token-a', 'active', 1), tokens: [row('token-c', 'active', 2)] }],
    } as FileReminderOptIn;
    expect(rowsOf(optIn)).toEqual([row('token-a', 'cancelled', 2), row('token-b', 'cancelled', 1)]);
  });

  it('never lets the object\'s own tokens key reach a comparison', () => {
    // One instant in two spellings, one lamport: the content tie-break decides,
    // and the shorter spelling sorts higher. Compared whole, the holder's
    // `tokens` key sorts before the other's `updatedAt` and it would lose.
    const holder = { ...row('token-a', 'active', 0), updatedAt: '2026-05-01T10:00:00Z', tokens: [row('token-c', 'cancelled', 0, 0)] };
    const plain = { ...row('token-a', 'active', 0), updatedAt: '2026-05-01T10:00:00.000Z' };
    for (const [a, b] of [[plain, holder], [holder, plain]]) {
      const merged = merge(file(a), file(b)).reminderOptIn;
      expect(merged?.updatedAt).toBe('2026-05-01T10:00:00Z');
      expect(merged?.tokens).toEqual([row('token-c', 'cancelled', 0, 0)]);
    }
  });

  it('migrate sanitizes each row as it does the object, and drops a malformed row', () => {
    const { updatedAt: _none, ...unstamped } = row('token-e', 'active', 0);
    const f = file({
      ...row('token-a', 'active', 0),
      tokens: [
        { ...row('token-b', 'active', 0), updatedAt: '2099-01-01T00:00:00.000Z', lamport: -3 },
        { ...row('x', 'active', 0), token: '' },
        { ...row('x', 'active', 0), email: { address: 'x@example.test' } },
        { ...row('x', 'active', 0), status: 'paused' },
        { ...row('x', 'active', 0), provider: 3 },
        { ...row('token-z', 'active', 2), provider: 'free text' },
        'not a row',
        { ...row('token-c', 'cancelled', 0), tokens: [row('token-d', 'active', 0)] },
        unstamped,
        { ...row('token-f', 'active', 0), token: 'f'.repeat(300) },
      ],
    } as unknown as FileReminderOptIn);
    f.meta.updatedAt = T[2];
    const read = migrateFile(JSON.parse(JSON.stringify(f)), CTX).reminderOptIn;
    expect(read?.tokens).toEqual([
      { ...row('token-b', 'active', 0), updatedAt: T[2], lamport: 0 },
      row('token-c', 'cancelled', 0),
      { ...unstamped, updatedAt: '' },
      { ...row('token-f', 'active', 0), token: 'f'.repeat(300) },
    ]);
    const empty = file({ ...row('token-a', 'active', 0), tokens: [{ ...row('x', 'active', 0), token: '' }] });
    expect(migrateFile(JSON.parse(JSON.stringify(empty)), CTX).reminderOptIn).not.toHaveProperty('tokens');
    // A row naming a provider the app does not write is dropped, so no merge can make it the stored object.
    const free = file({ ...row('token-a', 'active', 0), tokens: [{ ...row('token-z', 'active', 2), provider: 'free text' } as unknown as ReminderTokenRow] });
    free.meta.updatedAt = T[2];
    const merged = merge(migrateFile(JSON.parse(JSON.stringify(free)), CTX), file(row('token-a', 'active', 0)));
    expect(merged.reminderOptIn?.token).toBe('token-a');
    expect(JSON.stringify(merged)).not.toContain('free text');
  });
});

describe('US-17 AC19: at one epoch a nested row from before the erase time goes', () => {
  const marker = (t: number): FileReminderOptIn => ({ ...row('token-a', 'cancelled', t), token: '', email: '' });
  const erased = (optIn: FileReminderOptIn, erasedAt?: string): RoadmapFile => {
    const f = file(optIn, 1);
    return erasedAt ? { ...f, meta: { ...f.meta, erasedAt } } : f;
  };

  it('two erases from one epoch: the later erase wins and the earlier re-enrolment goes, in both orders', () => {
    const erasedLater = erased(marker(2), '2026-05-03T10:00:00.001Z');
    const reEnrolled = erased(row('token-c', 'active', 1), '2026-05-01T10:00:00.001Z');
    for (const merged of [merge(erasedLater, reEnrolled), merge(reEnrolled, erasedLater)]) {
      expect(merged.reminderOptIn).toEqual(marker(2));
      expect(shownOptIn(merged)).toEqual(marker(2));
      const bytes = JSON.stringify(merged);
      expect(bytes).not.toContain('token-c');
      expect(bytes).not.toContain('@example.test');
    }
  });

  it('a marker at t1, X at t0 and Y at t2: every grouping gives Y with no X beneath it', () => {
    const [m, x, y] = [erased(marker(1), T[1]), erased(row('token-x', 'active', 0)), erased(row('token-y', 'active', 2))];
    const ends = [merge(merge(m, x), y), merge(m, merge(x, y)), merge(merge(m, y), x), merge(merge(x, y), m), merge(y, merge(x, m))];
    for (const end of ends) {
      expect(end.reminderOptIn).toEqual(row('token-y', 'active', 2));
      expect(JSON.stringify(end)).not.toContain('token-x');
    }
  });

  it('a re-enrolment stamped after the erase survives as the stored object', () => {
    const erasedHere = erased(marker(0), '2026-05-01T10:00:00.001Z');
    const reEnrolled = erased(row('token-c', 'active', 2), '2026-05-01T09:00:00.000Z');
    for (const merged of [merge(erasedHere, reEnrolled), merge(reEnrolled, erasedHere)]) {
      expect(merged.reminderOptIn).toEqual(row('token-c', 'active', 2));
    }
  });

  it('pinned: a nested row stamped at the erase instant stays; one a millisecond before goes; no erase time, no floor', () => {
    const top = erased(row('token-y', 'active', 2), T[1]);
    const at = merge(top, erased(row('token-x', 'active', 1)));
    expect(at.reminderOptIn?.tokens).toEqual([row('token-x', 'active', 1)]);
    const before = merge(top, erased({ ...row('token-x', 'active', 1), updatedAt: '2026-05-02T09:59:59.999Z' }));
    expect(before.reminderOptIn?.tokens).toBeUndefined();
    const never = merge(erased(row('token-y', 'active', 2)), erased(row('token-x', 'active', 0)));
    expect(never.reminderOptIn?.tokens).toEqual([row('token-x', 'active', 0)]);
  });
});

describe('US-17 AC19: a top row the schema accepts stays a row once nested', () => {
  it('a long token moved into the list by a merge survives migrate', () => {
    const long = { ...row('token-a', 'active', 0), token: 'a'.repeat(300) };
    const merged = merge(file(long), file(row('token-b', 'active', 1)));
    expect(merged.reminderOptIn?.tokens).toEqual([long]);
    merged.meta.updatedAt = T[2];
    expect(migrateFile(JSON.parse(JSON.stringify(merged)), CTX).reminderOptIn?.tokens).toEqual([long]);
  });
});

describe('US-17 AC19: across the erase gate the winner\'s opt-in passes whole', () => {
  it('as when it keeps none, whether or not the gate rescues a row, in either order', () => {
    // An unsettled winner: its list holds a row newer than its object.
    const winner = file({ ...row('token-a', 'active', 0), tokens: [row('token-b', 'active', 2)] }, 1);
    winner.meta.erasedAt = '2026-05-01T00:00:00.000Z';
    const loser = file(row('token-c', 'active', 1));
    const bare = merge(winner, loser);
    expect(key(bare.reminderOptIn)).toBe(key(winner.reminderOptIn));
    loser.measurements.push(createMeasurement({ id: 'm-rescued', metricType: 'weight', value: 70, recordedAt: '2026-05-02', createdAt: '2026-05-02T08:00:00.000Z', source: 'manual' }));
    for (const merged of [merge(winner, loser), merge(loser, winner)]) {
      expect(merged.measurements.map((m) => m.id)).toEqual(['m-rescued']);
      expect(key(merged.reminderOptIn)).toBe(key(winner.reminderOptIn));
    }
  });
});

describe('US-17 AC19: a file whose clocks are damaged recovers them from the rows too', () => {
  it('a nested cancel newer than the stored object keeps its time, and beats a stale active copy', () => {
    const f = file({ ...row('token-b', 'active', 0), tokens: [row('token-a', 'cancelled', 2)] });
    const raw = JSON.parse(JSON.stringify(f));
    raw.meta.updatedAt = 'not-a-date';
    raw.meta.createdAt = 'not-a-date';
    const read = migrateFile(raw, CTX);
    expect(read.reminderOptIn?.tokens).toEqual([row('token-a', 'cancelled', 2)]);
    const stale = file(row('token-a', 'active', 1));
    for (const merged of [merge(read, stale), merge(stale, read)]) {
      expect(rowsOf(merged.reminderOptIn).find((r) => r.token === 'token-a')).toEqual(row('token-a', 'cancelled', 2));
    }
  });
});

describe('US-17 AC19: a file with tokens rows is at least version 2', () => {
  it('the merge that first writes tokens lifts two version-1 files to 2, in either order', () => {
    const [a, b] = [file(row('token-a', 'active', 0)), file(row('token-b', 'active', 1))];
    expect([a.schemaVersion, b.schemaVersion]).toEqual([1, 1]);
    for (const merged of [merge(a, b), merge(b, a)]) {
      expect(merged.reminderOptIn?.tokens).toHaveLength(1);
      expect(merged.schemaVersion).toBe(2);
    }
  });

  it('a one-token merge stays at version 1, byte for byte', () => {
    const [a, b] = [file(row('token-a', 'active', 0)), file(row('token-a', 'cancelled', 1))];
    const merged = merge(a, b);
    expect(merged.schemaVersion).toBe(1);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(merge(b, a)));
    expect(JSON.stringify(merged)).not.toContain('"tokens"');
  });

  it('migrate stamps a hand-written version-1 file with tokens at 2, and leaves a core file at 3', () => {
    const f = file({ ...row('token-a', 'active', 0), tokens: [row('token-b', 'active', 0)] });
    f.meta.updatedAt = T[2];
    expect(migrateFile(JSON.parse(JSON.stringify(f)), CTX).schemaVersion).toBe(2);
    expect(migrateFile(JSON.parse(JSON.stringify({ ...f, schemaVersion: 3 })), CTX).schemaVersion).toBe(3);
  });
});

describe('US-17 AC19: the published schema describes the rows (US-29)', () => {
  const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../docs/health-roadmap-file.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, validateFormats: false }).compile(schema);
  const valid = (f: unknown) => validate(JSON.parse(JSON.stringify(f))) as boolean;

  it('a merged two-token file validates; one stamped below 2, or with a malformed row, does not', () => {
    const merged = merge(file(row('token-a', 'active', 0)), file(row('token-b', 'cancelled', 1)));
    expect(valid(merged)).toBe(true);
    expect(valid({ ...merged, schemaVersion: 1 })).toBe(false);
    for (const bad of [{ token: '' }, { status: 'paused' }, { email: { a: 1 } }, { provider: 3 }, { provider: 'free text' }]) {
      const opt = { ...merged.reminderOptIn!, tokens: [{ ...merged.reminderOptIn!.tokens![0], ...bad }] };
      expect(valid({ ...merged, reminderOptIn: opt }), JSON.stringify(bad)).toBe(false);
    }
    expect(valid(merge(file(row('token-a', 'active', 0)), file(row('token-a', 'cancelled', 1))))).toBe(true);
  });
});

describe('US-17 AC19: setReminderRow writes the stored object', () => {
  const NOW = '2026-05-09T12:00:00.000Z';

  it('stamps past an erase marker whose clock runs ahead, and keeps the other rows', () => {
    const ahead = '2026-06-01T00:00:00.000Z';
    const f = file({ ...row('token-a', 'cancelled', 0, 4), token: '', email: '', updatedAt: ahead, tokens: [row('token-b', 'active', 2, 7)] });
    const written = setReminderRow(f, { status: 'active', token: 'token-c', email: 'token-c@example.test', provider: 'dropbox' }, NOW).reminderOptIn;
    expect(own(written)).toEqual({ status: 'active', token: 'token-c', email: 'token-c@example.test', provider: 'dropbox', updatedAt: ahead, lamport: 8 });
    expect(written?.tokens).toEqual([row('token-b', 'active', 2, 7)]);
  });

  it('a Turn off of one token keeps its address and leaves the other token on', () => {
    const f = file({ ...row('token-a', 'active', 1), tokens: [row('token-b', 'active', 0)] });
    const after = setReminderRow(f, { status: 'cancelled', token: 'token-a', email: 'token-a@example.test', provider: 'dropbox' }, NOW);
    expect(own(after.reminderOptIn)).toMatchObject({ status: 'cancelled', token: 'token-a', email: 'token-a@example.test', updatedAt: NOW, lamport: 2 });
    expect(shownOptIn(after)).toEqual(row('token-b', 'active', 0));
  });

  it('until part 2 the live writer, setReminderOptIn, still replaces the opt-in whole, as today', () => {
    const f = file({ ...row('token-b', 'cancelled', 1), tokens: [row('token-a', 'active', 0)] });
    const after = setReminderOptIn(f, { status: 'active', token: 'token-c', email: 'token-c@example.test', provider: 'dropbox' }, NOW);
    expect(after.reminderOptIn).toEqual({ status: 'active', token: 'token-c', email: 'token-c@example.test', provider: 'dropbox', updatedAt: NOW, lamport: 2 });
  });

  it('on a file with no rows, stamps as setReminderOptIn does', () => {
    const fields = { status: 'active', token: 'token-a', email: 'token-a@example.test', provider: 'dropbox' } as const;
    expect(setReminderRow(file(), fields, NOW)).toEqual(setReminderOptIn(file(), fields, NOW));
    const f = file(row('token-a', 'cancelled', 0, 3));
    expect(setReminderRow(f, fields, NOW)).toEqual(setReminderOptIn(f, fields, NOW));
  });
});

describe('US-17 AC19: pinned ties (the real comparator)', () => {
  it('on a clock tie a cancelled row beats its active twin while both keep the address', () => {
    const [on, off] = [row('token-a', 'active', 0), row('token-a', 'cancelled', 0)];
    expect(own(mergeOptIn(on, off))).toEqual(off);
    expect(own(mergeOptIn(off, on))).toEqual(off);
    // With the address blanked the active twin would win: why cancelled rows keep it.
    expect(own(mergeOptIn(on, { ...off, email: '' }))).toEqual(on);
  });

  it('an old merge keeps the identical object without its list (a stated limit)', () => {
    const bare = row('token-a', 'active', 1);
    const listed: FileReminderOptIn = { ...bare, tokens: [row('token-b', 'cancelled', 0)] };
    expect(pickNewerOptional<FileReminderOptIn>(bare, listed)).toBe(bare);
    expect(pickNewerOptional<FileReminderOptIn>(listed, bare)).toBe(bare);
    // The new merge keeps the row the list holds.
    expect(mergeOptIn(bare, listed)?.tokens).toEqual(listed.tokens);
  });
});

/* ---- Seeded properties over the real merge ---------------------------- */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random row: three tokens, both statuses, three times, two lamports, and
 *  two addresses, so rows tie on the clock and differ only by content. */
function randomRow(r: () => number): ReminderTokenRow {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  return row(pick(TOKENS), r() < 0.5 ? 'active' : 'cancelled', Math.floor(r() * 3), Math.floor(r() * 2), pick(['x@example.test', 'y@example.test']));
}

/** A random opt-in: absent, an erase marker, or a row with a list that may be
 *  absent, may miss the object's own token, and may repeat a token. */
function randomOptIn(r: () => number): FileReminderOptIn | undefined {
  if (r() < 0.15) return undefined;
  const top: FileReminderOptIn = r() < 0.1 ? { ...randomRow(r), status: 'cancelled', token: '', email: '' } : randomRow(r);
  if (r() < 0.5) return top;
  const tokens = Array.from({ length: Math.floor(r() * 4) }, () => randomRow(r));
  return tokens.length > 0 ? { ...top, tokens } : top;
}

/** A random copy at epoch 0-2. An erased copy carries the erase's list, as every
 *  erase writes one (erase.ts), so it is version 2 already. Without it the version
 *  alone depends on merge order across the gate: two version-1 copies at the
 *  losing epoch may merge to `tokens` (version 2) first, and the gate keeps the
 *  higher version of its inputs. A stated Limit of US-17 AC19. */
function randomFile(r: () => number): RoadmapFile {
  const f = file(randomOptIn(r), Math.floor(r() * 3));
  const epoch = f.meta.eraseEpoch ?? 0;
  if (epoch === 0) return f;
  // An erase time at a row's instant, between rows, or after them all.
  const erasedAt = [T[0], '2026-05-02T00:00:00.000Z', T[2]][Math.floor(r() * 3)];
  return { ...f, schemaVersion: 2, erasedRows: { fromEpoch: epoch, ids: [] }, meta: { ...f.meta, erasedAt } };
}
const optKey = (f: RoadmapFile) => stableStringify([f.schemaVersion, f.reminderOptIn ?? null]);

/** The expected token map, from the raw rows of the copies at the winning epoch: each token's newest row. */
function expectedTokens(copies: RoadmapFile[], storedToken?: string): Record<string, ReminderTokenRow> {
  const top = Math.max(...copies.map((f) => f.meta.eraseEpoch ?? 0));
  const live = copies.filter((c) => (c.meta.eraseEpoch ?? 0) === top);
  // Copies that meet at one epoch drop nested rows from before the latest erase time; one alone passes whole.
  const floors = live.map((c) => c.meta.erasedAt).filter((at): at is string => at !== undefined).sort();
  const floor = live.length > 1 ? floors[floors.length - 1] : undefined;
  const map: Record<string, ReminderTokenRow> = {};
  for (const f of live) {
    const o = f.reminderOptIn;
    for (const raw of o ? [o, ...(o.tokens ?? [])] : []) {
      if (typeof raw.token !== 'string' || raw.token === '') continue;
      const r = own(raw as FileReminderOptIn)!;
      if (!map[r.token] || stampIsNewer(r, map[r.token])) map[r.token] = r;
    }
  }
  for (const [token, r] of Object.entries(map)) if (token !== storedToken && floor !== undefined && Date.parse(r.updatedAt) < Date.parse(floor)) delete map[token];
  return map;
}
const tokenMap = (f: RoadmapFile) => Object.fromEntries(rowsOf(f.reminderOptIn).map((r) => [r.token, r]));

describe('US-17 AC19: a legacy erased copy (no erase list) and the version, a stated Limit', () => {
  it('pinned: the opt-in agrees in every order; the version alone depends on which losers met first', () => {
    const erased = file({ ...row('token-a', 'cancelled', 2), token: '', email: '' }, 1);
    const [one, two] = [file(row('token-a', 'active', 0)), file(row('token-b', 'cancelled', 1))];
    const losersFirst = merge(merge(one, two), erased);
    const erasedFirst = merge(merge(erased, one), two);
    expect(key(losersFirst.reminderOptIn)).toBe(key(erasedFirst.reminderOptIn));
    expect([losersFirst.schemaVersion, erasedFirst.schemaVersion]).toEqual([2, 1]);
  });
});

describe('US-17 AC19: the opt-in merge is a semilattice (seeded, real stableStringify)', () => {
  it('is commutative, associative and idempotent, in every order, over 3,000 triples', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const [a, b, c] = [randomFile(r), randomFile(r), randomFile(r)];
      expect(optKey(merge(a, b)), `commutative ${seed}`).toBe(optKey(merge(b, a)));
      const left = merge(merge(a, b), c);
      expect(optKey(left), `associative ${seed}`).toBe(optKey(merge(a, merge(b, c))));
      // A copy the gate passed whole may be hand-written, its rows out of order;
      // once merged at its own epoch it is a fixed point.
      const settled = merge(left, left);
      expect(key(settled.reminderOptIn), `idempotent ${seed}`).toBe(key(mergeOptIn(left.reminderOptIn, undefined, left.meta.erasedAt)));
      expect(optKey(merge(settled, settled)), `idempotent ${seed}`).toBe(optKey(settled));
      expect(optKey(merge(settled, a)), `absorbs ${seed}`).toBe(optKey(settled));
      // Every order of the three copies, either grouping, ends on one opt-in and one shown row.
      const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
      const ends = orders.flatMap(([x, y, z]) => [merge(merge(x, y), z), merge(x, merge(y, z))]);
      expect(new Set(ends.map(optKey)).size, `orders ${seed}`).toBe(1);
      expect(new Set(ends.map((f) => stableStringify(shownOptIn(f) ?? null))).size, `shown ${seed}`).toBe(1);
    }
  });

  it('three live tokens and a later cancel of one: every token keeps its own newest row', () => {
    const copies = [
      file(row('token-a', 'active', 0)),
      file({ ...row('token-b', 'active', 1), tokens: [row('token-a', 'active', 0)] }),
      file(row('token-c', 'active', 1, 2)),
      file({ ...row('token-b', 'cancelled', 2), tokens: [row('token-c', 'active', 0)] }),
    ];
    const ends = [copies.reduce((x, y) => merge(x, y)), copies.reduceRight((x, y) => merge(x, y))];
    for (const merged of ends) {
      expect(tokenMap(merged)).toEqual(expectedTokens(copies));
      expect(tokenMap(merged)).toEqual({ 'token-a': row('token-a', 'active', 0), 'token-b': row('token-b', 'cancelled', 2), 'token-c': row('token-c', 'active', 1, 2) });
      expect(own(merged.reminderOptIn)).toEqual(row('token-b', 'cancelled', 2));
      expect(shownOptIn(merged)).toEqual(row('token-c', 'active', 1, 2));
    }
  });

  it('stores the newest of every row at the top epoch, the erase marker included', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const copies = [randomFile(r), randomFile(r), randomFile(r)];
      const top = Math.max(...copies.map((f) => f.meta.eraseEpoch ?? 0));
      const live = copies.filter((f) => (f.meta.eraseEpoch ?? 0) === top).map((f) => f.reminderOptIn);
      const candidates = live.flatMap((o) => (o ? [own(o)!, ...rowsOf(o)] : []));
      const merged = copies.reduce((x, y) => merge(x, y));
      // Every token and its winning row, against the map built from the raw rows.
      expect(tokenMap(merged), `tokens ${seed}`).toEqual(expectedTokens(copies, merged.reminderOptIn?.token));
      if (candidates.length === 0) continue;
      const newest = candidates.reduce((x, y) => (stampIsNewer(y, x) ? y : x));
      // Only one copy at the top epoch passes through the gate untouched, as today.
      if (live.length === 1) expect(key(merged.reminderOptIn), `${seed}`).toBe(key(live[0]));
      else expect(own(merged.reminderOptIn), `${seed}`).toEqual(newest);
    }
  });
});

/* ---- A mixed fleet: old merges keep the newer object whole ------------- */

/** What a merge from before this change does to the opt-in: the newer object, its list with it. */
const oldMerge = (a: RoadmapFile, b: RoadmapFile): RoadmapFile => ({
  ...merge(a, b),
  reminderOptIn: pickNewerOptional(a.reminderOptIn, b.reminderOptIn),
});

/** The previous singleton writer, copied here so part 2 can change the live one:
 *  a fresh object, no list, one past the object it replaces. */
function oldWrite(f: RoadmapFile, fields: Omit<ReminderTokenRow, 'updatedAt' | 'lamport'>, now: string): RoadmapFile {
  const prior = f.reminderOptIn;
  const updatedAt = prior && Date.parse(prior.updatedAt) > Date.parse(now) ? prior.updatedAt : now;
  return { ...f, reminderOptIn: { ...fields, updatedAt, lamport: (prior?.lamport ?? 0) + 1 } };
}

describe('US-17 AC19: old and new merges mixed', () => {
  it('pinned: an old write drops the list; a copy that still holds it brings the rows back, and none can once it is gone', () => {
    const listed = file({ ...row('token-a', 'cancelled', 1), tokens: [row('token-b', 'active', 0)] });
    const other = file({ ...row('token-a', 'cancelled', 1), tokens: [row('token-b', 'active', 0)] });
    const dropped = oldWrite(listed, { status: 'active', token: 'token-c', email: 'token-c@example.test', provider: 'dropbox' }, '2026-05-04T10:00:00.000Z');
    expect(dropped.reminderOptIn?.tokens).toBeUndefined();
    expect(tokenMap(merge(dropped, other))).toEqual({ 'token-a': row('token-a', 'cancelled', 1), 'token-b': row('token-b', 'active', 0), 'token-c': own(dropped.reminderOptIn) });
    expect(tokenMap(merge(dropped, file(row('token-a', 'cancelled', 1))))).toEqual({ 'token-a': row('token-a', 'cancelled', 1), 'token-c': own(dropped.reminderOptIn) });
  });

  it('stores today\'s object after every merge, and converges once old merges stop', () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const r = rng(seed);
      const pick = (n: number) => Math.floor(r() * n);
      // Each copy as an app leaves it: the object newest of its own rows.
      const copies = Array.from({ length: 2 + pick(3) }, (): RoadmapFile => {
        const f = file(randomOptIn(r));
        return { ...f, reminderOptIn: mergeOptIn(f.reminderOptIn, undefined) };
      });
      for (let step = 0; step < 8; step++) {
        const [i, j] = [pick(copies.length), pick(copies.length)];
        if (r() < 0.25) {
          // An old web write: a fresh object, no list, at a valid later time.
          const at = new Date(Date.parse('2026-05-04T10:00:00.000Z') + step * 86_400_000).toISOString();
          const status = r() < 0.5 ? 'active' : 'cancelled';
          const token = TOKENS[pick(3)];
          copies[i] = oldWrite(copies[i], { status, token, email: `${token}@example.test`, provider: 'dropbox' }, at);
          continue;
        }
        const today = pickNewerOptional(copies[i].reminderOptIn, copies[j].reminderOptIn);
        const merged = r() < 0.4 ? oldMerge(copies[i], copies[j]) : merge(copies[i], copies[j]);
        expect(own(merged.reminderOptIn), `seed ${seed} step ${step}`).toEqual(own(today));
        copies[i] = merged;
        copies[j] = merged;
      }
      // New code gossips until quiet: every copy ends on one opt-in.
      const end = copies.reduce((x, y) => merge(x, y));
      expect(optKey(copies.reduceRight((x, y) => merge(x, y))), `converge ${seed}`).toBe(optKey(end));
      for (const c of copies) expect(optKey(merge(c, end)), `converge ${seed}`).toBe(optKey(end));
    }
  });
});
