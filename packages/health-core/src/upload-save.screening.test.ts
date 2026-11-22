/**
 * A letter's screening box through the shared Save (US-13 AC6, US-16 AC2a; owner rulings on the mount note and on PR 1957,
 * 2026-11-22): moved from the web's review (useReviewDocuments.ts, ReviewFileSections.tsx, upload-save.ts:94-98). Seeded
 * picks of letters, checked against oracles written here from the screening table's rows and the date menu, never from
 * the code under test, and against what the list page shows ticked. Web only: a phone Save writes no screening date.
 * Synthetic values, names and hashes only.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY, NOW } from './import-review.test-helpers';
import type { UnifiedExtractionResult } from './lab-extraction';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { RecordSession } from './record-session';
import type { RecordHost } from './record-host';
import type { FileDocument, RoadmapFile } from './roadmap-file';
import { NO_CHOICES, type DocumentFix } from './upload-choices';
import type { UploadFile, UploadState } from './upload-flow';
import { uploadListPage } from './upload-list-page';
import { uploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { setScreening } from './state-edits';
import { writeScreeningDates, type ScreeningPerson } from './upload-screening';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The oracle's own reading of the screening table, copied by hand from screening-rules.ts (each row's uploadMinAge and
 *  uploadSex): the six types with a `<type>_last_date` in SCREENING_KEYS. */
const RULES: Record<string, { age: number; sex?: 'male' | 'female' }> = {
  colorectal: { age: 35 }, breast: { age: 40, sex: 'female' }, cervical: { age: 25, sex: 'female' },
  lung: { age: 50 }, prostate: { age: 45, sex: 'male' }, dexa: { age: 50 },
};
const IN_TABLE = Object.keys(RULES);
const inTable = (type: string) => Object.prototype.hasOwnProperty.call(RULES, type);
const eligible = (type: string, p: ScreeningPerson) => {
  if (!inTable(type)) return false; // a type outside the screening table: never a box, never written
  const r = RULES[type];
  if (p.sex && r.sex && p.sex !== r.sex) return false;
  return p.age === undefined || p.age >= r.age;
};
/** Each reader date with the date its box writes, as the web's review read it (a past day, a month alone, else none). */
const RAW: Array<[string | null, string | null]> = [['2026-10-20', '2026-10-20'], ['2026-06', '2026-06'], ['2027-01-01', null], [null, null], ['junk', null]];
/** Each date fix with what it writes: a past day, or removed. */
const FIX: Array<[DocumentFix, string | null] | null> = [null, null, [{ date: '2026-09-09' }, '2026-09-09'], [{ date: null }, null]];
/** The dates a row the record holds for a letter's bytes carries: unlike any reader date, so a row that dated a box shows. */
const HELD_DATE = '2026-05-05';
const STORED_DATE = '2026-04-04';

const letter = (type: string | null, raw: string | null): UnifiedExtractionResult => ({
  classification: 'scan_result', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'scan_result', title: 'Synthetic scan', documentDate: raw, contentMarkdown: 'Synthetic', metadata: type ? { screeningType: type } : {} },
});
const readFile = (id: string, hash: string, x: UnifiedExtractionResult, document: DocumentFix): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices: { ...NO_CHOICES, document } } });
const saving = (platform: 'web' | 'phone', files: UploadFile[]): UploadState => ({ phase: 'saving', platform, run: 1, files, started: NOW, firstRead: NOW, attempt: 1 });
const offCloud = (): UploadSaveIO<string> => { let n = 0; return { holds: () => false, original: () => null, mimeType: () => '', write: async () => { throw new Error('no cloud'); }, now: () => NOW, newId: () => `id-${n++}` }; };
/** A cloud whose write fails for the files named. */
const cloud = (failing: Set<string>): UploadSaveIO<string> => {
  let n = 0;
  return {
    holds: () => true, original: (id) => `bytes of ${id}`, mimeType: () => 'application/pdf', now: () => NOW, newId: () => `id-${n++}`,
    write: async (_ref, _bytes, id) => { if (failing.has(id)) throw new Error('refused'); },
  };
};
/** A row the record holds for these bytes: its original stored, or metadata-only (no original); each dated or not. */
type Held = 'stored' | 'storedDated' | 'dated' | 'undated';
const HELD: Held[] = ['stored', 'storedDated', 'dated', 'undated'];
const heldRow = (hash: string, k: Held): FileDocument => ({
  id: `held-${hash}`, title: 'Held', type: 'scan_result', date: k === 'dated' ? HELD_DATE : k === 'storedDated' ? STORED_DATE : null,
  fileRef: k.startsWith('stored') ? 'docs/held.pdf' : '', contentHash: hash,
  mimeType: 'application/pdf', extractedText: '', addedAt: NOW, metadata: {}, sourceFileName: 'held.pdf',
} as FileDocument);
const field = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const written = (file: RoadmapFile, key: string) => (file.screenings as unknown as Record<string, unknown>)[field(key)];
const writtenKeys = (file: RoadmapFile) => Object.keys(file.screenings).filter((k) => !['updatedAt', 'lamport', 'fieldStamps'].includes(k)).sort();

async function save(s: UploadState, record: RoadmapFile, person?: ScreeningPerson, on = false, io: UploadSaveIO<string> = offCloud()) {
  const out = await uploadSave(s, record, NOW, on, io, person);
  if (!out.ok) throw new Error(out.reason);
  return out.commit(record);
}

const MONTH_WORDS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The date a box's words name, as every other date on the list reads: "20 Oct 2026" is 2026-10-20, "Jun 2026" 2026-06. */
const dateOf = (said: string) => {
  const [d, m, y] = said.split(' ').length === 3 ? said.split(' ') : [null, ...said.split(' ')];
  const month = `${y}-${String(MONTH_WORDS.indexOf(m!) + 1).padStart(2, '0')}`;
  return d ? `${month}-${d.padStart(2, '0')}` : month;
};
/** A date as a day, to compare: a month alone is its first day. */
const dayOf = (date: string) => (date.length === 7 ? `${date}-01` : date);
/** A screening date the record holds, with the day the plan reads it as (screening-inputs.ts, by hand): none, a day, a
 *  month, equal to a letter's date, later or earlier than every letter, and three the plan reads as no date (no 13th
 *  month, no 30 Feb, a month after NOW's). */
const HELD_SCREENING: Array<[string | null, string | null]> = [
  [null, null], [null, null], [null, null], [null, null], ['2026-10-20', '2026-10-20'], ['2026-06', '2026-06-01'], ['2026-10-01', '2026-10-01'],
  ['2025-01-15', '2025-01-15'], ['2026-11-01', '2026-11-01'], ['2026-13', null], ['2026-02-30', null], ['2027-03', null],
];
const page = (s: UploadState, record: RoadmapFile, on: boolean, person?: ScreeningPerson) => {
  const open = { ...s, phase: 'open' } as UploadState;
  return uploadListPage(open, record, NOW, uploadReview(open, record, NOW), on, person);
};
/** What the list page shows ticked, by key: the latest date its words name. An older ticked box of the same type is
 *  drawn but not written (a known gap, PR 1995's leads), so the page is checked against what Save writes this way. */
function shownTicked(s: UploadState, record: RoadmapFile, on: boolean, person?: ScreeningPerson): Map<string, string> {
  const shown = new Map<string, string>();
  for (const { screening: b } of page(s, record, on, person).letters) {
    const date = b?.checked ? dateOf(/ to (.+)$/.exec(b.tail)![1]) : null;
    const key = `${b?.type}_last_date`;
    if (date && (!shown.has(key) || dayOf(date) > dayOf(shown.get(key)!))) shown.set(key, date);
  }
  return shown;
}

/** `knee`, `colorectal_method` and `endometrial` are outside the screening table (validation.ts SCREENING_KEYS has no
 *  `<type>_last_date` for them). */
const TYPES = [...IN_TABLE, 'knee', 'colorectal_method', 'endometrial', null];
const PEOPLE: ScreeningPerson[] = [{}, { age: 20 }, { age: 30 }, { age: 42, sex: 'female' }, { age: 47, sex: 'male' }, { age: 55 }, { age: 72, sex: 'female' }, { age: 60, sex: 'male' }, { sex: 'female' }];

describe('US-13 AC6: a letter\'s screening box, written by the shared Save (web only)', () => {
  it('over 1200 seeded picks: the dates written are exactly the oracle\'s, the latest the list page shows ticked per type, and a second Save changes nothing', async () => {
    // How often each case the properties name came up: every one must, or the seeds prove nothing about it.
    const seen = { written: 0, heldBeaten: 0, heldBehind: 0, heldUnread: 0, unticked: 0, ineligible: 0, copy: 0, phone: 0, twoOfAType: 0, threeOfAType: 0, outsideTable: 0, heldStored: 0, heldStoredDated: 0, heldDated: 0, heldUndated: 0, writeFailed: 0, monthOnly: 0, cloudOn: 0, cloudOff: 0 };
    for (let seed = 1; seed <= 1200; seed++) {
      const r = mulberry32(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const platform = r() < 0.8 ? 'web' : 'phone';
      const person = r() < 0.9 ? pick(PEOPLE) : undefined;
      const on = r() < 0.5;
      const held = new Map<string, Held>();
      // Some picks are letters of one type only, so two and three of a type come up in every order of their dates.
      const oneType = r() < 0.3 ? pick(IN_TABLE) : null;
      const failing = new Set<string>();
      // A screening date the record already holds, per type.
      const heldDates = new Map(IN_TABLE.map((t) => [`${t}_last_date`, pick(HELD_SCREENING)] as const));
      const letters: Array<{ type: string | null; hash: string; rawDate: string | null; fix: string | null | undefined; tick: boolean | undefined; file: UploadFile }> = [];
      for (let i = 0, n = 1 + Math.floor(r() * (oneType ? 5 : 4)); i < n; i++) {
        const type = oneType ?? pick(TYPES);
        const [raw, rawDate] = pick(RAW);
        const fix = pick(FIX);
        const tick = pick([undefined, undefined, true, false]);
        // A copy of an earlier file in the pick (not shown, not saved), or bytes the record already holds.
        const hash = letters.length && r() < 0.15 ? pick(letters).hash : `h${i}`;
        if (!held.has(hash) && r() < 0.25) held.set(hash, pick(HELD));
        if (r() < 0.2) failing.add(`f${i}`);
        const document: DocumentFix = { ...(fix ? fix[0] : {}), ...(tick === undefined ? {} : { screening: tick }) };
        letters.push({ type, hash, rawDate, fix: fix ? fix[1] : undefined, tick, file: readFile(`f${i}`, hash, letter(type, raw), document) });
      }
      const expected = new Map<string, string>();
      const perType = new Map<string, number>();
      letters.forEach(({ type, hash, rawDate, fix, tick, file: f }, i) => {
        const shown = letters.findIndex((l) => l.hash === hash) === i;
        // US-13 AC6: the person's date fix, else the date the reader gave (a day, or a month alone). A row the record
        // holds for the same bytes, stored or metadata-only, dated or not, never dates the box (owner ruling 2026-11-22).
        const date = fix !== undefined ? fix : rawDate;
        const ticked = tick ?? (person?.age !== undefined);
        const rest = Boolean(type && date && ticked && person);
        // Brad 2026-11-23: a box shows, and its date is written, only when it is later than the day the plan reads the
        // record's date as; a date the plan does not read counts as none.
        const [stored, heldDay] = type && inTable(type) ? heldDates.get(`${type}_last_date`)! : [null, null];
        const forward = date !== null && (heldDay === null || dayOf(date) > heldDay);
        if (platform === 'web' && rest && shown && eligible(type!, person!) && !forward) seen.heldBeaten++;
        else if (platform === 'web' && rest && shown && eligible(type!, person!)) {
          if (heldDay !== null) seen.heldBehind++;
          else if (stored !== null) seen.heldUnread++;
          const count = (perType.get(type!) ?? 0) + 1;
          perType.set(type!, count);
          if (count === 2) seen.twoOfAType++;
          if (count === 3) seen.threeOfAType++;
          if (held.get(hash) === 'stored') seen.heldStored++;
          if (held.get(hash) === 'storedDated') seen.heldStoredDated++;
          if (held.get(hash) === 'dated') seen.heldDated++;
          if (held.get(hash) === 'undated') seen.heldUndated++;
          if (date!.length === 7) seen.monthOnly++;
          if (on) seen.cloudOn++; else seen.cloudOff++;
          if (on && failing.has(f.id)) seen.writeFailed++;
          // Among letters of one type the latest date is written, whatever the pick order.
          const key = `${type}_last_date`;
          if (!expected.has(key) || dayOf(date!) > dayOf(expected.get(key)!)) expected.set(key, date!);
          seen.written++;
        } else if (rest && platform === 'phone' && shown && eligible(type!, person!)) seen.phone++;
        else if (rest && platform === 'web' && shown && !inTable(type!)) seen.outsideTable++;
        else if (rest && platform === 'web' && shown && !eligible(type!, person!)) seen.ineligible++;
        else if (rest && platform === 'web' && !shown && eligible(type!, person!)) seen.copy++;
        else if (type && date && person && platform === 'web' && shown && eligible(type, person) && !ticked) seen.unticked++;
      });
      const docs = held.size ? { ...EMPTY, documents: [...held].map(([h, k]) => heldRow(h, k)) } : EMPTY;
      const record = [...heldDates].reduce((f, [key, [stored]]) => (stored === null ? f : setScreening(f, key, stored, NOW)), docs);
      const after = new Map([...heldDates].flatMap(([key, [stored]]) => (stored === null ? [] : [[key, stored] as const])));
      for (const [key, date] of expected) after.set(key, date);
      const s = saving(platform, letters.map((l) => l.file));
      const { file, outcome } = await save(s, record, person, on, on ? cloud(failing) : offCloud());
      expect(writtenKeys(file), `seed ${seed}`).toEqual([...after.keys()].map(field).sort());
      for (const type of IN_TABLE) expect(written(file, `${type}_last_date`), `seed ${seed} ${type}`).toBe(after.get(`${type}_last_date`));
      expect(outcome.screenings, `seed ${seed}`).toBe(expected.size || undefined);
      // The latest date the page shows ticked per type is what Save writes. Not every ticked box is written: an older
      // letter of a type beside a later one is drawn ticked and not written.
      expect(shownTicked(s, record, on, person), `seed ${seed} page`).toEqual(expected);
      // The same upload saved again on the record it wrote leaves its screening dates byte for byte, stamps included.
      const again = await save(s, file, person, on, on ? cloud(failing) : offCloud());
      expect(JSON.stringify(again.file.screenings), `seed ${seed} repeat`).toBe(JSON.stringify(file.screenings));
    }
    for (const [name, n] of Object.entries(seen)) expect(n, name).toBeGreaterThan(3);
  });

  it('a letter whose bytes the record holds, with or without the original, dated or not, still writes its ticked date: the reader\'s', async () => {
    for (const k of HELD) {
      const record = { ...EMPTY, documents: [heldRow('ha', k)] };
      const { file, outcome } = await save(saving('web', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), {})]), record, { age: 60 });
      expect(written(file, 'colorectal_last_date'), k).toBe('2026-10-20');
      expect(outcome.screenings).toBe(1);
    }
  });

  it('a letter whose original write fails still writes its ticked date', async () => {
    const { file } = await save(saving('web', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), {})]), EMPTY, { age: 60 }, true, cloud(new Set(['a'])));
    expect(written(file, 'colorectal_last_date')).toBe('2026-10-20');
  });

  it('a type text that is not exactly a table type gives no box and writes nothing', async () => {
    for (const type of ['Colorectal', 'COLORECTAL', ' colorectal ', 'colorectal_last_date', '__proto__', 'constructor', 'a.b', 'a/b']) {
      const s = saving('web', [readFile('a', 'ha', letter(type, '2026-10-20'), { screening: true })]);
      const open = { ...s, phase: 'open' } as UploadState;
      expect(uploadListPage(open, EMPTY, NOW, uploadReview(open, EMPTY, NOW), false, { age: 60 }).letters[0].screening, type).toBeUndefined();
      const { file, outcome } = await save(s, EMPTY, { age: 60 });
      expect(writtenKeys(file), type).toEqual([]);
      expect(outcome.screenings, type).toBeUndefined();
    }
  });

  it('a failed Save then a retry writes each date once, and a repeat on the saved record stamps nothing new', async () => {
    const s = saving('web', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), {})]);
    // The first attempt's commit never lands (its edit is refused): the record stays as it was.
    await uploadSave(s, EMPTY, NOW, false, offCloud(), { age: 60 });
    const retry: UploadState = { ...s, attempt: 2 } as UploadState;
    const first = await save(retry, EMPTY, { age: 60 });
    expect(first.file.screenings.fieldStamps?.[field('colorectal_last_date')]).toEqual({ lamport: 1, updatedAt: NOW });
    const again = await save(retry, first.file, { age: 60 });
    expect(again.file.screenings).toBe(first.file.screenings);
  });

  it('a repeat Save of the same upload on the record it saved leaves the screening dates as they are (a month-only letter included)', async () => {
    const s = saving('web', [readFile('a', 'ha', letter('colorectal', '2026-03-02'), {}), readFile('b', 'hb', letter('colorectal', '2026-10'), {})]);
    const first = await save(s, EMPTY, { age: 60 });
    expect(written(first.file, 'colorectal_last_date')).toBe('2026-10');
    const again = await save(s, first.file, { age: 60 });
    expect(again.file.screenings).toEqual(first.file.screenings);
  });

  // Brad 2026-11-23 ("this", option 2): a screening date never goes backwards.
  it('two eligible ticked letters of one type: the latest date is written, once, whatever the pick order', async () => {
    for (const [a, b] of [['2026-10-20', '2026-03-02'], ['2026-03-02', '2026-10-20'], ['2026-10', '2026-03-02'], ['2026-03-02', '2026-10']]) {
      const s = saving('web', [readFile('a', 'ha', letter('colorectal', a), {}), readFile('b', 'hb', letter('colorectal', b), {})]);
      const { file, outcome } = await save(s, EMPTY, { age: 60 });
      expect(written(file, 'colorectal_last_date'), `${a} ${b}`).toBe(a > b ? a : b);
      expect(outcome.screenings).toBe(1);
    }
  });

  it('a letter no later than the date the record holds offers no box and writes nothing; a later one does (Brad 2026-11-23)', async () => {
    const one = (raw: string) => saving('web', [readFile('a', 'ha', letter('colorectal', raw), {})]);
    for (const [held, raw, moves] of [
      ['2026-10-20', '2026-03-02', false], ['2026-10-20', '2026-10-20', false], ['2026-10-20', '2026-10', false], ['2026-10', '2026-10-01', false],
      ['2026-03-02', '2026-10-20', true], ['2026-10', '2026-10-20', true], ['2026-03-02', '2026-10', true],
    ] as const) {
      const record = setScreening(EMPTY, 'colorectal_last_date', held, NOW);
      const box = page(one(raw), record, false, { age: 60 }).letters[0].screening;
      const { file, outcome } = await save(one(raw), record, { age: 60 });
      expect(box?.checked, `${held} ${raw} box`).toBe(moves ? true : undefined);
      expect(written(file, 'colorectal_last_date'), `${held} ${raw}`).toBe(moves ? raw : held);
      expect(outcome.screenings, `${held} ${raw} count`).toBe(moves ? 1 : undefined);
    }
  });

  it('a held date the plan reads as no date (no 13th month, no 30 Feb, a future month) lets a letter\'s date be written', async () => {
    for (const held of ['2026-13', '2026-02-30', '2027-03']) {
      const record = setScreening(EMPTY, 'colorectal_last_date', held, NOW);
      const s = saving('web', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), {})]);
      expect(page(s, record, false, { age: 60 }).letters[0].screening?.checked, held).toBe(true);
      const { file, outcome } = await save(s, record, { age: 60 });
      expect(written(file, 'colorectal_last_date'), held).toBe('2026-10-20');
      expect(outcome.screenings, held).toBe(1);
    }
  });

  it('a later date that lands between the plan and the commit is never moved back, and the outcome counts no date', async () => {
    const out = await uploadSave(saving('web', [readFile('a', 'ha', letter('colorectal', '2026-03-02'), {})]), EMPTY, NOW, false, offCloud(), { age: 60 });
    if (!out.ok) throw new Error(out.reason);
    const { file, outcome } = out.commit(setScreening(EMPTY, 'colorectal_last_date', '2026-10-20', NOW));
    expect(written(file, 'colorectal_last_date')).toBe('2026-10-20');
    expect(outcome.screenings).toBeUndefined();
  });

  it('the box prints its date as every other date on the list reads, the type still apart for bold', () => {
    for (const [raw, said] of [['2026-10-20', ' screening date to 20 Oct 2026'], ['2026-06', ' screening date to Jun 2026']]) {
      const box = page(saving('web', [readFile('a', 'ha', letter('colorectal', raw), {})]), EMPTY, false, { age: 60 }).letters[0].screening!;
      expect([box.lead, box.type, box.tail]).toEqual(['Update ', 'colorectal', said]);
    }
  });

  it('a screening box only for a type in the screening table: a ticked letter of any other type writes nothing', async () => {
    for (const type of ['knee', 'colorectal_method', 'endometrial']) {
      const { file, outcome } = await save(saving('web', [readFile('a', 'ha', letter(type, '2026-10-20'), { screening: true })]), EMPTY, { age: 60 });
      expect(writtenKeys(file), type).toEqual([]);
      expect(outcome.screenings, type).toBeUndefined();
    }
  });

  it('the write itself takes only a key in the screening table, whatever a state carries', () => {
    const { file } = writeScreeningDates(EMPTY, [['knee_last_date', '2026-10-20'], ['colorectal_method', '2026-10-20'], ['colorectal_last_date', '2026-10-20']], NOW);
    expect(writtenKeys(file)).toEqual(['colorectalLastDate']);
  });

  it('a phone Save writes no screening date, even for an eligible ticked letter', async () => {
    const { file, outcome } = await save(saving('phone', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), { screening: true })]), EMPTY, { age: 60 });
    expect(written(file, 'colorectal_last_date')).toBeUndefined();
    expect(outcome.screenings).toBeUndefined();
  });

  it('the screening date lands in the same record edit as the letter, so an erase between plan and commit refuses both (US-16 AC2a)', async () => {
    const host = (c: MemoryCloud): RecordHost => ({
      store: new MemoryAdapter(c), clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {}, deviceId: () => 'tab',
      clock: { now: () => Date.parse(NOW) }, timers: { set: () => 0, clear: () => {} }, remoteChanged: () => {}, failureCause: () => 'x', report: () => {},
      tier: 'cloud',
      mirror: { adapter: new MemoryAdapter(new MemoryCloud()), pending: { get: () => false, set: () => {}, clear: () => {} }, writesStopped: () => false, wipe: async () => {}, opened: () => {} },
    } as unknown as RecordHost);
    const session = await RecordSession.open(host(new MemoryCloud()));
    const asked = session.eraseIdentity;
    const out = await uploadSave(saving('web', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), {})]), session.file, NOW, false, offCloud(), { age: 60 });
    if (!out.ok) throw new Error(out.reason);
    expect((await session.erase()).success).toBe(true);
    expect(session.edit((f) => out.commit(f).file, asked)).toBe(false);
    expect(written(session.file, 'colorectal_last_date')).toBeUndefined();
    expect(session.file.documents).toEqual([]);
    // Without the erase moving, the same edit lands the letter and its date together.
    const again = await uploadSave(saving('web', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), {})]), session.file, NOW, false, offCloud(), { age: 60 });
    if (!again.ok) throw new Error(again.reason);
    expect(session.edit((f) => again.commit(f).file, session.eraseIdentity)).toBe(true);
    expect(written(session.file, 'colorectal_last_date')).toBe('2026-10-20');
    expect(session.file.documents).toHaveLength(1);
  });
});
