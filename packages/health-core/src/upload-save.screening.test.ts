/**
 * A letter's screening box through the shared Save (US-13 AC6, US-16 AC2a; owner ruling on the mount note, 2026-11-22):
 * moved from the web's review (useReviewDocuments.ts, ReviewFileSections.tsx, upload-save.ts:94-98). Seeded picks of
 * letters, checked against oracles written here from the screening table's rows and the date menu, never from the code
 * under test. Web only: a phone Save writes no screening date. Synthetic values, names and hashes only.
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
import { uploadSave, type UploadSaveIO } from './upload-save';
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

/** The oracle's own reading of the screening table (screening-rules.ts uploadMinAge, uploadSex) for the types used. */
const RULES: Record<string, { age: number; sex?: 'male' | 'female' }> = { colorectal: { age: 35 }, breast: { age: 40, sex: 'female' }, prostate: { age: 45, sex: 'male' } };
const eligible = (type: string, p: ScreeningPerson) => {
  const r = RULES[type];
  if (!r) return false; // a type outside the screening table: never a box, never written
  if (p.sex && r.sex && p.sex !== r.sex) return false;
  return p.age === undefined || p.age >= r.age;
};
/** Each reader date with the date its box writes, as the web's review read it (a past day, a month alone, else none). */
const RAW: Array<[string | null, string | null]> = [['2026-10-20', '2026-10-20'], ['2026-06', '2026-06'], ['2027-01-01', null], [null, null], ['junk', null]];
/** Each date fix with what it writes: a past day, or removed. */
const FIX: Array<[DocumentFix, string | null] | null> = [null, null, [{ date: '2026-09-09' }, '2026-09-09'], [{ date: null }, null]];

const letter = (type: string | null, raw: string | null): UnifiedExtractionResult => ({
  classification: 'scan_result', reportDate: null, values: [], additionalValues: [], unrecognized: [],
  document: { classification: 'scan_result', title: 'Synthetic scan', documentDate: raw, contentMarkdown: 'Synthetic', metadata: type ? { screeningType: type } : {} },
});
const readFile = (id: string, hash: string, x: UnifiedExtractionResult, document: DocumentFix): UploadFile =>
  ({ id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices: { ...NO_CHOICES, document } } });
const saving = (platform: 'web' | 'phone', files: UploadFile[]): UploadState => ({ phase: 'saving', platform, run: 1, files, started: NOW, firstRead: NOW, attempt: 1 });
const offCloud = (): UploadSaveIO<string> => { let n = 0; return { holds: () => false, original: () => null, mimeType: () => '', write: async () => { throw new Error('no cloud'); }, now: () => NOW, newId: () => `id-${n++}` }; };
const heldDoc = (hash: string): FileDocument => ({
  id: `held-${hash}`, title: 'Held', type: 'scan_result', date: null, fileRef: 'docs/held.pdf', contentHash: hash, mimeType: 'application/pdf', extractedText: '',
  addedAt: NOW, metadata: {}, sourceFileName: 'held.pdf',
} as FileDocument);
const field = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const written = (file: RoadmapFile, key: string) => (file.screenings as unknown as Record<string, unknown>)[field(key)];

async function save(s: UploadState, record: RoadmapFile, person?: ScreeningPerson) {
  const out = await uploadSave(s, record, NOW, false, offCloud(), person);
  if (!out.ok) throw new Error(out.reason);
  return out.commit(record);
}

/** `knee` and `colorectal_method` are outside the screening table (validation.ts SCREENING_KEYS has no `<type>_last_date`). */
const TYPES = ['colorectal', 'breast', 'prostate', 'knee', 'colorectal_method', null];
const PEOPLE: ScreeningPerson[] = [{}, { age: 30 }, { age: 42, sex: 'female' }, { age: 60, sex: 'male' }, { age: 60 }, { sex: 'female' }];

describe('US-13 AC6: a letter\'s screening box, written by the shared Save (web only)', () => {
  it('over 800 seeded picks: each type written exactly as the oracle says, at most once, the last ticked saved letter in picked order winning', async () => {
    // How often each case the properties name came up: every one must, or the seeds prove nothing about it.
    const seen = { written: 0, unticked: 0, ineligible: 0, notSaved: 0, phone: 0, twoOfAType: 0, outsideTable: 0 };
    for (let seed = 1; seed <= 800; seed++) {
      const r = mulberry32(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const platform = r() < 0.8 ? 'web' : 'phone';
      const person = r() < 0.9 ? pick(PEOPLE) : undefined;
      const held = new Set<string>();
      const letters: Array<{ type: string | null; hash: string; date: string | null; tick: boolean | undefined; file: UploadFile }> = [];
      for (let i = 0, n = 1 + Math.floor(r() * 4); i < n; i++) {
        const type = pick(TYPES);
        const [raw, rawDate] = pick(RAW);
        const fix = pick(FIX);
        const tick = pick([undefined, undefined, true, false]);
        // A copy of an earlier file in the pick, or one the record already stores: the letter is not saved.
        const hash = letters.length && r() < 0.15 ? pick(letters).hash : `h${i}`;
        if (r() < 0.1) held.add(hash);
        const document: DocumentFix = { ...(fix ? fix[0] : {}), ...(tick === undefined ? {} : { screening: tick }) };
        letters.push({ type, hash, date: fix ? fix[1] : rawDate, tick, file: readFile(`f${i}`, hash, letter(type, raw), document) });
      }
      const expected = new Map<string, string>();
      letters.forEach(({ type, hash, date, tick }, i) => {
        const saved = !held.has(hash) && letters.findIndex((l) => l.hash === hash) === i;
        const ticked = tick ?? (person?.age !== undefined);
        const rest = Boolean(type && date);
        if (platform === 'web' && person && type && eligible(type, person) && saved && ticked && date) {
          if (expected.has(`${type}_last_date`)) seen.twoOfAType++;
          expected.set(`${type}_last_date`, date);
          seen.written++;
        } else if (rest && platform === 'phone' && person && eligible(type!, person) && saved && ticked) seen.phone++;
        else if (rest && platform === 'web' && person && saved && ticked && !RULES[type!]) seen.outsideTable++;
        else if (rest && platform === 'web' && person && saved && ticked && !eligible(type!, person)) seen.ineligible++;
        else if (rest && platform === 'web' && person && eligible(type!, person) && ticked && !saved) seen.notSaved++;
        else if (rest && platform === 'web' && person && eligible(type!, person) && saved && !ticked) seen.unticked++;
      });
      const files = letters.map((l) => l.file);
      const record = held.size ? { ...EMPTY, documents: [...held].map(heldDoc) } : EMPTY;
      const { file, outcome } = await save(saving(platform, files), record, person);
      expect(Object.keys(file.screenings).filter((k) => !['updatedAt', 'lamport', 'fieldStamps'].includes(k)).sort(), `seed ${seed}`)
        .toEqual([...expected.keys()].map(field).sort());
      for (const type of ['colorectal', 'breast', 'prostate']) {
        const key = `${type}_last_date`;
        expect(written(file, key), `seed ${seed} ${key}`).toBe(expected.get(key));
      }
      expect(outcome.screenings, `seed ${seed}`).toBe(expected.size || undefined);
    }
    for (const [name, n] of Object.entries(seen)) expect(n, name).toBeGreaterThan(3);
  });

  it('two eligible ticked letters of one type: the later in picked order is written, once (as the web\'s per-key save, last call wins)', async () => {
    const s = saving('web', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), {}), readFile('b', 'hb', letter('colorectal', '2026-03-02'), {})]);
    const { file, outcome } = await save(s, EMPTY, { age: 60 });
    expect(written(file, 'colorectal_last_date')).toBe('2026-03-02');
    expect(outcome.screenings).toBe(1);
  });

  it('a screening box only for a type in the screening table: a ticked letter of any other type writes nothing', async () => {
    for (const type of ['knee', 'colorectal_method', 'endometrial']) {
      const { file, outcome } = await save(saving('web', [readFile('a', 'ha', letter(type, '2026-10-20'), { screening: true })]), EMPTY, { age: 60 });
      expect(Object.keys(file.screenings).filter((k) => !['updatedAt', 'lamport', 'fieldStamps'].includes(k)), type).toEqual([]);
      expect(outcome.screenings, type).toBeUndefined();
    }
  });

  it('the write itself takes only a key in the screening table, whatever a state carries', () => {
    const file = writeScreeningDates(EMPTY, [['knee_last_date', '2026-10-20'], ['colorectal_method', '2026-10-20'], ['colorectal_last_date', '2026-10-20']], NOW);
    expect(Object.keys(file.screenings).filter((k) => !['updatedAt', 'lamport', 'fieldStamps'].includes(k))).toEqual(['colorectalLastDate']);
  });

  it('a phone Save writes no screening date, even for an eligible ticked letter', async () => {
    const { file, outcome } = await save(saving('phone', [readFile('a', 'ha', letter('colorectal', '2026-10-20'), { screening: true })]), EMPTY, { age: 60 });
    expect(written(file, 'colorectal_last_date')).toBeUndefined();
    expect(outcome.screenings).toBeUndefined();
  });

  it('the screening date lands in the same record edit as the letter, so an erase between plan and commit refuses both (US-16 AC2a)', async () => {
    const host = (cloud: MemoryCloud): RecordHost => ({
      store: new MemoryAdapter(cloud), clearOffFileData: () => {}, clearedErase: () => null, noteCleared: () => {}, deviceId: () => 'tab',
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
