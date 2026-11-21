/**
 * Web list PR 1f properties (US-13 AC11, AC24, AC26; US-14 AC11-12), on their own seeds, apart from the upload-view property
 * parts so those stay inside CI's time budget. Each seed reads lab reports and letters, then makes random choices (edits,
 * held text, ticks, day picks, letter dates) and reads the list and its page after every step in units chosen afresh.
 * Oracles read the extraction, the choices, the units table and the clock, never what `uploadList` or `uploadListPage`
 * computed:
 * - L17 printed: a core row names "Printed: <number> <unit>" (the report's, "(no unit)" when none) exactly when the read
 *   guessed its unit or the value as read, in the person's unit at its display step, is another number; a lab, never. An
 *   edit changes nothing (the grid reads the value as read). Mutation: the note from the row's current number
 *   (`{ ...c.at.value, valueSI: shown.current }`) fails it (seed 8, step 3: "L17: f0:v0 printed "Printed: 120 nmol/L";
 *   want null").
 * - L18 preview: each letter's preview is its whole text when 300 characters or fewer, else its first 300 and "...".
 *   Mutation: the cut without "..." fails it (seed 1: "L18: d0 previews 300 of 1000 characters, no "..."").
 * - L19 date words: a day control's button shows the day L14 says its picker shows, in words, else "—"; a letter's its
 *   date in words (its fix, else its printed day when that is a calendar day that has come), else "Set the date".
 *   Mutations: a letter's line from the view's `date` alone (`documentDateLine`, "No date" when unknown) fails it (seed 1:
 *   "L19: d0 shows "No date"; want "Set the date""); the empty day as '' fails it (seed 1: "L19: f1|test shows ""; want
 *   "—"").
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, extra, NOW } from './import-review.test-helpers';
import { offeredValues } from './import-review';
import { cellNumber, isCellMetric, type CellUnit } from './cell-unit';
import { UNDATED_PREVIOUS, type UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { uploadListPage } from './upload-list-page';
import { dayWant } from './upload-list-page.test-helpers';
import { uploadReview } from './upload-review';
import { longDate } from './upload-text';
import { LPA_UNITS, type MetricType } from './units';

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

class Failure extends Error {}
const fail = (prop: string, msg: string): never => { throw new Failure(`${prop}: ${msg}`); };

const VALUES = [
  () => core({}),
  () => core({ unitGuessed: true }),
  () => core({ unitGuessed: true, displayUnit: '', valueSI: 2.8, displayValue: 2.8 }),
  () => core({ metric: 'creatinine', valueSI: 133, displayValue: 1.5, displayUnit: 'mg/dL', displaySystem: 'conventional' }),
  () => core({ metric: 'creatinine', valueSI: 97.24, displayValue: 1.1, displayUnit: 'mg/dL', displaySystem: 'conventional' }),
  () => core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', recordedAt: '2026-09-15' }),
  () => core({ metric: 'lpa', valueSI: 120, displayValue: 120, displayUnit: 'nmol/L' }),
  () => core({ metric: 'lpa', valueSI: 120, displayValue: 50, displayUnit: 'mg/dL', displaySystem: 'conventional', unitGuessed: true }),
  () => core({ comparator: '<', valueSI: 0.6, displayValue: 0.6, recordedAt: UNDATED_PREVIOUS, printedMonth: '2026-10' }),
  () => core({ metric: 'mystery' as never, valueSI: 5, displayValue: 5, displayUnit: 'zz' }),
  () => core({ metric: 'mystery' as never, valueSI: 5, displayValue: 5, displayUnit: 'zz', unitGuessed: true }),
];
const REPORT_DAYS = ['2026-11-01', null, '2026-12-15', '2026-02-30', '2026-10'];
const PICKS = ['2026-10-05', '2026-11-01', '2026-12-01', '2026-10', '2026-09-10'];
const LENGTHS = [0, 1, 299, 300, 301, 1000];
const DOC_DATES = ['2026-10-20', null, '2026-12-25', '2026-10', '2026-02-30'];
const UNITS: readonly CellUnit[] = ['si', 'conventional', ...LPA_UNITS];
const SEEDS = 200;

/** Today on this device, as a person's calendar reads it. */
const day0 = (() => { const d = new Date(NOW); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
/** A calendar day that has come, else null: by the calendar, not by the engine's rule. */
function pastDay(x: string | null | undefined): string | null {
  const m = x ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(x) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const real = d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  return real && x! <= day0 ? x! : null;
}

type Files = Extract<UploadState, { phase: 'open' }>['files'];
function files(r: () => number): Files {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  return Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => {
    const letter = r() < 0.4;
    const id = letter ? `d${i}` : `f${i}`;
    const extraction: UnifiedExtractionResult = letter
      ? { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
        document: { classification: 'clinic_letter', title: `Letter ${i}`, documentDate: pick(DOC_DATES), contentMarkdown: `${i}`.repeat(pick(LENGTHS)), metadata: {} } }
      : { classification: 'lab_report', reportDate: pick(REPORT_DAYS), values: Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(VALUES)()),
        additionalValues: r() < 0.5 ? [extra({})] : [], unrecognized: [], document: null };
    return { id, name: `${id}.pdf`, bytes: 1, hash: `h-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read' as const, extraction, choices: NO_CHOICES } };
  });
}

function change(r: () => number, f: Files[number]): ChoiceChange {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const x = f.status.s === 'read' ? f.status.extraction : null;
  if (x?.document) return { document: { date: r() < 0.3 ? null : pick(PICKS) } };
  const refs = x ? offeredValues(x).map((v) => v.ref) : [];
  const ref = pick(refs);
  const k = r();
  if (k < 0.15) return { testDay: pick(PICKS) };
  if (k < 0.25) return { previousDay: pick(PICKS) };
  if (k < 0.35) return { columnDay: '2026-09-15', day: pick(PICKS) };
  if (k < 0.45) return { tick: ref, on: r() < 0.5 };
  return { typed: ref, text: pick(['abc', '100', '4.25', '150', '']), unit: ref[0] === 'a' ? null : pick(UNITS) };
}

function check(s: UploadState, unitOf: (m: MetricType) => CellUnit) {
  const review = uploadReview(s, EMPTY, NOW);
  const list = uploadList(s, EMPTY, NOW, review, unitOf);
  const page = uploadListPage(s, EMPTY, NOW, review, false);
  const read = 'files' in s ? s.files : [];
  const byKey = new Map(list.rows.map((row) => [row.key, row]));
  for (const f of read) {
    if (f.status.s !== 'read') continue;
    const x = f.status.extraction;
    for (const at of x.classification === 'lab_report' ? offeredValues(x) : []) {
      const row = byKey.get(`${f.id}:${at.ref}`);
      if (!row) continue;
      let want: string | null = null;
      if (at.kind === 'core') {
        const v = at.value;
        const shown = isCellMetric(v.metric) ? Number(cellNumber(v.metric, v.valueSI, unitOf(v.metric), v.comparator)) : v.displayValue;
        if (v.unitGuessed || shown !== v.displayValue) want = `Printed: ${v.displayValue} ${v.displayUnit || '(no unit)'}`;
      }
      if (row.printed !== want) fail('L17', `${row.key} printed ${JSON.stringify(row.printed)}; want ${JSON.stringify(want)}`);
    }
    const doc = x.document;
    if (!doc) continue;
    const letter = page.letters.find((l) => l.fileId === f.id);
    if (!letter) continue; // L15's
    const text = doc.contentMarkdown ?? '';
    const preview = text.length <= 300 ? text : `${text.substring(0, 300)}...`;
    if (letter.preview !== preview) fail('L18', `${f.id} previews ${letter.preview.replace(/\.\.\.$/, '').length} of ${text.length} characters${letter.preview.endsWith('...') ? '' : ', no "..."'}`);
    const fix = f.status.choices.document;
    const date = 'date' in fix ? fix.date ?? null : pastDay(doc.documentDate);
    const line = date ? longDate(date) : 'Set the date';
    if (letter.pickerLine !== line) fail('L19', `${f.id} shows ${JSON.stringify(letter.pickerLine)}; want ${JSON.stringify(line)}`);
  }
  for (const d of list.days) {
    const want = dayWant(s, d, NOW);
    if (!want) fail('L19', `${d.key} names no read file`);
    const line = want!.want.picker ? longDate(want!.want.picker) : '—';
    if (d.pickerLine !== line) fail('L19', `${d.key} shows ${JSON.stringify(d.pickerLine)}; want ${JSON.stringify(line)}`);
  }
  return list;
}

describe('L17-L19, the printed note, the letter preview and the date words, on their own seeds', () => {
  it(`hold for ${SEEDS} seeded uploads`, () => {
    const reach = { printed: 0, printedEdited: 0, cut: 0, whole: 0, noDay: 0, setDate: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
      let s: UploadState = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW, files: files(r) };
      for (let step = 0; step < 10; step++) {
        const system = pick(['si', 'conventional'] as const);
        const lpa = pick(UNITS);
        const unitOf = (m: MetricType): CellUnit => (m === 'lpa' ? lpa : system);
        try {
          const list = check(s, unitOf);
          const page = uploadListPage(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), false);
          const edited = (fileId: string, ref: string) => 'files' in s && s.files.some((f) => f.id === fileId && f.status.s === 'read' && f.status.choices.edits[ref] !== undefined);
          for (const row of list.rows) if (row.printed) { reach.printed++; if (edited(row.fileId, row.ref)) reach.printedEdited++; }
          for (const l of page.letters) { if (l.preview.endsWith('...')) reach.cut++; else reach.whole++; if (l.pickerLine === 'Set the date') reach.setDate++; }
          for (const d of list.days) if (d.pickerLine === '—') reach.noDay++;
        } catch (e) {
          if (e instanceof Failure) throw new Error(`${e.message}\nseed ${seed}, step ${step}`);
          throw e;
        }
        const f: Files[number] = pick((s as Extract<UploadState, { phase: 'open' }>).files);
        s = transition(s, { type: 'chose', id: f.id, change: change(r, f), now: NOW }).state;
      }
    }
    for (const [name, k] of Object.entries(reach)) expect([name, k > 0]).toEqual([name, true]);
  });
});
