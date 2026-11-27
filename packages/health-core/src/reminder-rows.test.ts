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
import { mergeOptIn, optInBehind, rowsOf, shownOptIn } from './reminder-rows';
import { createEmptyFile, createMeasurement, stableStringify, type FileReminderOptIn, type ReminderTokenRow, type RoadmapFile } from './roadmap-file';
import { setReminderRow } from './state-edits';

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

describe('US-17 AC19: two erases from one epoch, and a re-enrolment between them (owner decision)', () => {
  const at = (hm: string) => `2026-05-01T${hm}:00.000Z`;
  const marker = (hm: string): FileReminderOptIn => ({ ...row('token-a', 'cancelled', 0), token: '', email: '', updatedAt: at(hm) });
  const reEnrol = (hm: string): FileReminderOptIn => ({ ...row('token-c', 'active', 0), updatedAt: at(hm) });

  it('a re-enrolment stamped after the other erase is the stored object and shows on, in both orders', () => {
    const [erased, enrolled] = [file(marker('10:00'), 1), file(reEnrol('10:15'), 1)];
    for (const merged of [merge(erased, enrolled), merge(enrolled, erased)]) {
      expect(merged.reminderOptIn).toEqual(reEnrol('10:15'));
      expect(shownOptIn(merged)).toEqual(reEnrol('10:15'));
    }
  });

  it('a re-enrolment stamped before the other erase stays as a nested row and shows on, in both orders', () => {
    const [erased, enrolled] = [file(marker('10:00'), 1), file(reEnrol('09:45'), 1)];
    for (const merged of [merge(erased, enrolled), merge(enrolled, erased)]) {
      expect(merged.reminderOptIn).toEqual({ ...marker('10:00'), tokens: [reEnrol('09:45')] });
      expect(shownOptIn(merged)).toEqual(reEnrol('09:45'));
    }
  });
});

describe('US-17 AC19: the check after a save reads the merge\'s own order', () => {
  it('a written opt-in is never behind itself after a JSON round trip, malformed token included', () => {
    const malformed = { ...row('x', 'cancelled', 1), token: { not: 'a string' } } as unknown as FileReminderOptIn;
    for (const w of [{ ...row('token-a', 'cancelled', 1), tokens: [row('token-b', 'active', 0)] }, malformed, { ...row('token-a', 'cancelled', 0), token: '', email: '' }]) {
      expect(optInBehind(w, JSON.parse(JSON.stringify(w)))).toBe(false);
    }
  });

  it('a written opt-in is never behind a merge that holds it', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const [w, p] = [randomFile(r), randomFile(r)];
      const written = mergeOptIn(w.reminderOptIn, undefined);
      if (!written) continue;
      expect(optInBehind(written, mergeOptIn(written, p.reminderOptIn)), `${seed}`).toBe(false);
    }
  });

  it('a lost nested row or a lost stored object is behind', () => {
    const w = { ...row('token-a', 'cancelled', 1), tokens: [row('token-b', 'active', 0)] };
    expect(optInBehind(w, row('token-a', 'cancelled', 1))).toBe(true);
    expect(optInBehind(row('token-a', 'cancelled', 1), row('token-a', 'active', 0))).toBe(true);
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

  it('writes only the row it is given: a spread opt-in cannot bring in its list', () => {
    const f = file(row('token-a', 'active', 0));
    const spread = { status: 'cancelled', token: 'token-b', email: 'token-b@example.test', provider: 'dropbox', tokens: [row('token-z', 'active', 1)] } as unknown as ReminderTokenRow;
    const after = setReminderRow(f, spread, NOW);
    expect(rowsOf(after.reminderOptIn).map((r) => r.token)).toEqual(['token-a', 'token-b']);
    expect(JSON.stringify(after)).not.toContain('token-z');
  });

  it('on a file with no rows, or its own token only, stamps as the replaced whole-object writer did', () => {
    const fields = { status: 'active', token: 'token-a', email: 'token-a@example.test', provider: 'dropbox' } as const;
    const first = setReminderRow(file(), fields, NOW);
    expect(first.reminderOptIn).toEqual({ ...fields, updatedAt: NOW, lamport: 1 });
    expect(first.meta.updatedAt).toBe(NOW);
    expect(setReminderRow(file(row('token-a', 'cancelled', 0, 3)), fields, NOW).reminderOptIn).toEqual({ ...fields, updatedAt: NOW, lamport: 4 });
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

/** One instant spelled two ways, so rows tie on the clock and differ only by content. */
const STAMPS = [T[0], T[1], '2026-05-02T10:00:00Z', T[2]];

/** A random row: three tokens, both statuses, four stamps, two lamports and two addresses. */
function randomRow(r: () => number): ReminderTokenRow {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const base = row(pick(TOKENS), r() < 0.5 ? 'active' : 'cancelled', 0, Math.floor(r() * 2), pick(['x@example.test', 'y@example.test']));
  return { ...base, updatedAt: pick(STAMPS) };
}

/** A random opt-in: absent, an erase marker, or a row with a list that may be
 *  absent, unsorted, may miss the object's own token, and may repeat a token. */
function randomOptIn(r: () => number): FileReminderOptIn | undefined {
  if (r() < 0.15) return undefined;
  const top: FileReminderOptIn = r() < 0.15 ? { ...randomRow(r), status: 'cancelled', token: '', email: '' } : randomRow(r);
  if (r() < 0.4) return top;
  const tokens = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomRow(r));
  return { ...top, tokens };
}

/** The erase bookkeeping a copy may carry: no list, a list covering its epoch,
 *  or one from the next; no erase time, one before every row, or one after. */
function withErase(f: RoadmapFile, r: () => number): RoadmapFile {
  const epoch = f.meta.eraseEpoch ?? 0;
  const list = [undefined, { fromEpoch: epoch, ids: [] }, { fromEpoch: epoch + 1, ids: [] }][Math.floor(r() * 3)];
  const erasedAt = [undefined, '2026-04-30T00:00:00.000Z', '2026-05-04T00:00:00.000Z'][Math.floor(r() * 3)];
  const { erasedRows: _list, ...rest } = f;
  const { erasedAt: _at, ...meta } = f.meta;
  return { ...rest, meta: { ...meta, ...(erasedAt ? { erasedAt } : null) }, ...(list ? { erasedRows: list } : null) } as RoadmapFile;
}

const randomFile = (r: () => number) => withErase(file(randomOptIn(r), Math.floor(r() * 3)), r);
const optKey = (f: RoadmapFile) => key(f.reminderOptIn);
const shownKey = (f: RoadmapFile) => stableStringify(shownOptIn(f) ?? null);

/** The expected opt-in, built from the raw rows of the copies at the top epoch,
 *  not through `rowsOf`: one copy there passes whole; several join row by row. */
function expectedOptIn(copies: RoadmapFile[]): FileReminderOptIn | undefined {
  const top = Math.max(...copies.map((f) => f.meta.eraseEpoch ?? 0));
  const live = copies.filter((c) => (c.meta.eraseEpoch ?? 0) === top);
  if (live.length === 1) return live[0].reminderOptIn;
  const strip = (x: object) => { const { tokens: _t, ...rest } = x as FileReminderOptIn; return rest as ReminderTokenRow; };
  const tops: ReminderTokenRow[] = [];
  const real: Record<string, ReminderTokenRow> = {};
  for (const o of live.map((c) => c.reminderOptIn)) {
    if (!o) continue;
    tops.push(strip(o));
    for (const raw of [o, ...(o.tokens ?? [])]) {
      if (typeof raw.token !== 'string' || raw.token === '') continue;
      const r = strip(raw);
      if (!real[r.token] || stampIsNewer(r, real[r.token])) real[r.token] = r;
    }
  }
  const all = [...tops, ...Object.values(real)];
  if (all.length === 0) return undefined;
  const stored = all.reduce((x, y) => (stampIsNewer(y, x) ? y : x));
  const tokens = Object.values(real).filter((r) => r.token !== stored.token).sort((x, y) => (x.token < y.token ? -1 : 1));
  return tokens.length > 0 ? { ...stored, tokens } : stored;
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

describe('US-17 AC19: the opt-in merge is a semilattice (seeded, real mergeFiles)', () => {
  it('is commutative, associative and idempotent, in every order and grouping, over 3,000 triples', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const [a, b, c] = [randomFile(r), randomFile(r), randomFile(r)];
      expect(optKey(merge(a, b)), `commutative ${seed}`).toBe(optKey(merge(b, a)));
      const left = merge(merge(a, b), c);
      expect(optKey(left), `associative ${seed}`).toBe(optKey(merge(a, merge(b, c))));
      // A copy the gate passed whole may be hand-written, its rows out of order;
      // once merged at its own epoch it is a fixed point.
      const settled = merge(left, left);
      expect(key(settled.reminderOptIn), `idempotent ${seed}`).toBe(key(mergeOptIn(left.reminderOptIn, undefined)));
      expect(optKey(merge(settled, settled)), `idempotent ${seed}`).toBe(optKey(settled));
      const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
      const ends = orders.flatMap(([x, y, z]) => [merge(merge(x, y), z), merge(x, merge(y, z))]);
      expect(new Set(ends.map(optKey)).size, `orders ${seed}`).toBe(1);
      expect(new Set(ends.map(shownKey)).size, `shown ${seed}`).toBe(1);
      // The oracle, from the raw rows.
      expect(optKey(left), `oracle ${seed}`).toBe(key(expectedOptIn([a, b, c])));
    }
  });

  it('the erase time and the erase list never change the merged opt-in', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const copies = [randomFile(r), randomFile(r), randomFile(r)];
      const other = rng(seed + 100_000);
      const varied = copies.map((f) => withErase(f, other));
      const [x, y] = [copies, varied].map((cs) => cs.reduce((p, q) => merge(p, q)));
      expect(optKey(y), `erase bookkeeping ${seed}`).toBe(optKey(x));
      expect(shownKey(y), `erase bookkeeping ${seed}`).toBe(shownKey(x));
    }
  });

  it('three erased copies, two listed and one not, give one opt-in in every grouping', () => {
    const at = (h: string) => `2026-05-01T${h}:00:00.000Z`;
    const erasedCopy = (optIn: FileReminderOptIn, erasedAt: string, listed: boolean): RoadmapFile => {
      const f = file(optIn, 1);
      return { ...f, meta: { ...f.meta, erasedAt }, ...(listed ? { erasedRows: { fromEpoch: 1, ids: [] } } : null) };
    };
    const a = erasedCopy({ ...row('token-x', 'active', 0), updatedAt: at('09') }, at('08'), true);
    const b = erasedCopy({ ...row('token-y', 'cancelled', 0), updatedAt: at('11') }, at('10'), true);
    const c = erasedCopy({ ...row('token-a', 'cancelled', 0), token: '', email: '', updatedAt: at('07') }, at('07'), false);
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const ends = orders.flatMap(([x, y, z]) => [merge(merge(x, y), z), merge(x, merge(y, z))]);
    expect(new Set(ends.map(optKey)).size).toBe(1);
    expect(ends[0].reminderOptIn).toEqual({ ...row('token-y', 'cancelled', 0), updatedAt: at('11'), tokens: [{ ...row('token-x', 'active', 0), updatedAt: at('09') }] });
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
      expect(key(merged.reminderOptIn)).toBe(key(expectedOptIn(copies)));
      expect(tokenMap(merged)).toEqual({ 'token-a': row('token-a', 'active', 0), 'token-b': row('token-b', 'cancelled', 2), 'token-c': row('token-c', 'active', 1, 2) });
      expect(own(merged.reminderOptIn)).toEqual(row('token-b', 'cancelled', 2));
      expect(shownOptIn(merged)).toEqual(row('token-c', 'active', 1, 2));
    }
  });
});

/* ---- A mixed fleet: old merges keep the newer object whole ------------- */

/** Every stamp in its one canonical spelling. */
function canonical(o: FileReminderOptIn | undefined): FileReminderOptIn | undefined {
  const fix = <R extends ReminderTokenRow>(x: R): R => ({ ...x, updatedAt: new Date(Date.parse(x.updatedAt)).toISOString() });
  return o && { ...fix(o), ...(o.tokens ? { tokens: o.tokens.map(fix) } : null) };
}

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
        // One spelling per instant: a same-instant spelling tie is a stated Limit against the old rule.
        const f = file(canonical(randomOptIn(r)));
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
