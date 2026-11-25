/**
 * The list view against Save, over seeded random uploads (US-52 AC8c, US-13 AC13, US-12 AC26; the
 * upload-flow.property.test.ts pattern, mulberry32, no dependency). Each sequence picks 1-3 files on
 * the phone, runs the machine's own landings in random order with chosen values between them, then
 * saves through `uploadSave`, sometimes on a record another writer changed. After every step:
 *   P1 every offered value is a row or a not-saved line, once; P2 the rows the view shows ticked and
 *   writable are the rows Save writes; P3 the Save label and the "will be saved" lines count them;
 *   P4 a disabled Save names a blocker the view gives a control for, and that control clears it;
 *   P5 FHIR after commit; P6 no broken string. A failure prints the seed and a minimised event list.
 *   P7 each written row shows what Save writes (its number, unit, day, the value a Replace replaces).
 *   P8 the review's day for each value (`days`, `waits`) is the one worked out from the extraction and the choices alone.
 * The web list's engine half (web list PR 1a), each with an oracle that never reads what the view computed, and the
 * mutation each was shown failing on before it passed:
 *   K1 a day change keeps each day control's key, and moves only its own source's rows (a test day may also take or give
 *      back a previous column's day, by the before-the-test rule). Mutation: the test-day control's key holding the day
 *      picked (`key: \`${f.fileId}|test|${chosen}\``).
 *   B  Save's blockers are what the extraction and choices make them: a ticked value with no day waits at its source's
 *      control, a ticked row with an error at its row; each names a row or control the view draws; Save is enabled only
 *      with none. Two KNOWN pins of main's own, for 1b (upload-view.gaps.test.ts): columnBlockerUndrawn (a waiting dated
 *      column's day has no control yet) and copyBlocksWithoutError. Mutation: the test-day blocker keyed at the previous
 *      column's control.
 *   K4 while saving, a row drawn as saving is one the press promised (`reviewed`), matched by (file, ref); outside saving,
 *      `saves` is what the row shows ticked and writable (P2). Mutation: `saves` ignoring `reviewed`.
 *   P7 also: a written row's `shown` number, read back in the person's unit, is what Save writes (web; the phone gets none).
 * The web list's ledger (web list PR 1b, upload-list.test-helpers.ts names each mutation): L1 every offered value is a row,
 *   once, in order, under its printed day, and a choice never changes the rows; L2 each row shows the choices; L3 held text
 *   blocks Save and `uploadSave` refuses; L4 one quantity, the candidate, gives the error and the blocker; L5 no silent
 *   non-write; L6 the repeat-Save probe runs after every Save (on a record another writer changed, it must not refuse).
 *   B now reads the blockers from the candidate (no KNOWN case left): mutation, the column blocker kept for a value
 *   refused on any day (`needsColumnDay = ticked.some((v) => v.waits)`), fails it.
 * Web list PR 1d (mutations named in upload-list.test-helpers.ts): L9 each row's reasons are the read's, attention is
 *   exactly unsure, error or entered, and every row with attention says why or the group note shows; L12 day-control
 *   names are distinct (KNOWN sameNamedFileDays noted); L7 also logs the unit each edit was typed in; L10 the
 *   heading counts the rows with attention and Show all the rest; L11 each row's name is its test, file and day, distinct
 *   but where three share them (KNOWN thirdReadingShared noted), and a Replace is named with its day.
 * The gaps it found (owner rulings 2026-11-20) are pinned, fixed, in upload-view.gaps.test.ts.
 * The harness lives here (the seeds, the reach counters, minimising a failure) and in upload-view.property.base, .view, .run
 * and .gen.test-helpers.ts; upload-view.property.part1.test.ts to part6 each run one range of the same seeds (sweepPart).
 * Synthetic values, names and hashes only.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNDATED_PREVIOUS } from './lab-extraction';
import { slotOfRow, validDay } from './record-edits';
import { DAY_NOT_HAPPENED, LAB_DAY_REFUSAL } from './lab-series';
import { PRESSURE_ORDER } from './validation';
import { inFlight, type UploadState } from './upload-flow';
import type { UploadReview } from './upload-review';
import type { UploadView } from './upload-view';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { mulberry32, seedIds, withSeededIds, NOW, type Setup, type Step, rowsOf, allRows, Failure, valueRecordedAt } from './upload-view.property.base.test-helpers';
import { Run } from './upload-view.property.run.test-helpers';
import { genStep, genSetup } from './upload-view.property.gen.test-helpers';

/** Runs `steps` from scratch, with the ids seed `seed` ran them on; the failure's property, or null. */
async function replay(seed: number, setup: Setup, steps: Step[]): Promise<Failure | null> {
  seedIds(seed, 'run');
  const run = new Run(setup, () => {});
  try { for (const step of steps) await run.apply(step); } catch (e) { if (e instanceof Failure) return e; throw e; }
  return null;
}

/** Drops steps one at a time while the same property still fails. */
async function minimise(seed: number, setup: Setup, steps: Step[], prop: string): Promise<Step[]> {
  let cur = steps;
  for (let i = cur.length - 1; i >= 0; i--) {
    const next = [...cur.slice(0, i), ...cur.slice(i + 1)];
    const f = await replay(seed, setup, next);
    if (f?.prop === prop) cur = next;
  }
  return cur;
}

/** The setup as a reader needs it: each file's values, the record's rows by slot, the cloud. */
const brief = (setup: Setup) => JSON.stringify({
  files: Object.fromEntries(Object.entries(setup.extractions).map(([id, x]) => [id, x.classification !== 'lab_report' ? x.classification
    : { reportDate: x.reportDate, values: [...(x.values ?? []).map((v) => `${v.metric} ${v.valueSI} ${v.recordedAt ?? '-'}${v.question ? ' q' : ''}${v.unitGuessed ? ' guessed' : ''}`), ...(x.additionalValues ?? []).map((v) => `${v.name} ${v.value} ${v.unit} ${v.recordedAt ?? '-'}`)], refused: x.refusedValues?.length ?? 0 }])),
  record: rowsOf(setup.record).map((row) => `${row.id.slice(0, 4)} ${slotOfRow(row)} ${row.value} ${row.status}`),
  cloud: setup.cloud,
});

/** A Replace the run had chosen was just dropped by the door (its target deleted). */
const lostBefore = (run: Run) => run.lostReplace;

/** A lab file waiting on a column whose pick is a real past day, but not before the test's day (US-13 AC24). */
const waitsNotBefore = (review: UploadReview, s: UploadState) => review.labFiles.some((lf) => {
  const f = 'files' in s ? s.files.find((x) => x.id === lf.fileId) : undefined;
  if (f?.status.s !== 'read') return false;
  const { extraction, choices } = f.status;
  return lf.waits.some((ref) => {
    const pick = validDay(choices.columnDays?.[valueRecordedAt(extraction, ref) ?? ''] ?? undefined, { now: NOW })?.slice(0, 10);
    return !!pick && !!lf.day && pick >= lf.day.slice(0, 10);
  });
});

/** A row drawn to be written whose day is a column pick, not the day it printed (US-13 AC24). */
const movedColumn = (view: UploadView, review: UploadReview, s: UploadState) => (view.reviewed ?? []).some((w) => {
  const f = 'files' in s ? s.files.find((x) => x.id === w.file) : undefined;
  const lf = review.labFiles.find((x) => x.fileId === w.file);
  const printed = f?.status.s === 'read' ? valueRecordedAt(f.status.extraction, w.ref) : undefined;
  const day = lf?.days[w.ref]?.slice(0, 10);
  return !!printed && printed !== UNDATED_PREVIOUS && !!day && day !== printed && allRows(view).some((row) => row.fileId === w.file && row.ref === w.ref && row.day === day);
});

export const SEEDS = 3000;

/** What a run of seeds reached (each counter: steps or sequences that met it) and the known gaps it saw, by seed. */
export interface Sweep { reach: Record<string, number>; gaps: Record<string, number[]> }

/**
 * Seeds `from` to `to` (of 1 to SEEDS), each exactly as the single test ran it: seed N draws the same sequence, and its rows
 * the same ids (withSeededIds). `out`: a path; the reach and the gaps seen are written to it, suffixed with the range.
 */
export const sweepSeeds = (from: number, to: number, out?: string): Promise<Sweep> => withSeededIds(() => sweep(from, to, out));

async function sweep(from: number, to: number, out?: string): Promise<Sweep> {
  const gaps: Record<string, number[]> = {};
  const reach = {
    steps: 0, saved: 0, saveFailedThenSaved: 0, replacing: 0, corrections: 0, changedBeforeSave: 0, blockedFix: 0, blockedDay: 0, conflicts: 0, documents: 0,
    merges: 0, replaceLost: 0, changedBeforeTap: 0, freedBeforeCommit: 0, skipped: 0, unstored: 0, archiveOnly: 0, copies: 0, alreadySaved: 0, futureDay: 0, undatedPrevious: 0, pressureRefused: 0, limitTicked: 0, labAsCore: 0, edited: 0, noOriginalSaved: 0, columnMoved: 0, columnNotBefore: 0,
    k1DayChanges: 0, k4Unpromised: 0, conventionalShown: 0, blockedAtColumn: 0, blockedAtRowAndDay: 0,
    typedRefused: 0, typedSavedAfter: 0, sameNamed: 0, listAlreadyInRecord: 0, listWaits: 0, listSameDayTicked: 0, listCopyError: 0, unsentBlocked: 0, tickOnHeld: 0, inputNone: 0,
    listReasons: 0, listHeading: 0, anotherReading: 0, replaceNamed: 0, listCheckNote: 0, editUnitKept: 0, twoColumns: 0, zipMembers: 0, longName: 0, touchedUncounted: 0,
    heldBesideToggle: 0, dayNotHappened: 0, dayLimits: 0, lettersShown: 0, closeWord: 0, savingWord: 0,
  };
  for (let seed = from; seed <= to; seed++) {
    const r = mulberry32(seed);
    seedIds(seed, 'setup');
    const setup = genSetup(r, seed % 2 ? 'si' : 'conventional');
    seedIds(seed, 'run');
    const run = new Run(setup, (gap) => { const seeds = (gaps[gap] ??= []); if (seeds[seeds.length - 1] !== seed) seeds.push(seed); });
    const steps: Step[] = [];
    const phase = { saves: 0, chosen: 0, resolved: 0 };
    for (let i = 0; i < 200; i++) {
      const step = genStep(r, run, phase);
      if (!step) break;
      steps.push(step);
      try { await run.apply(step); } catch (e) {
        if (!(e instanceof Failure)) throw e;
        const small = await minimise(seed, setup, steps, e.prop);
        throw new Error(`${e.message}\nseed ${seed}, step ${i}\nsetup: ${brief(setup)}\nminimised steps: ${JSON.stringify(small)}`);
      }
      reach.steps++;
      const lastView = run.last?.view;
      if (lastView && run.setup.system === 'conventional' && allRows(lastView).some((row) => row.shown?.unit === 'mg/dL')) reach.conventionalShown++;
      if (lastView?.save.blockers.some((b) => b.at.includes('|printed:'))) reach.blockedAtColumn++;
      if (lastView && lastView.save.blockers.some((b) => b.why === FIX_ERRORS_TEXT) && lastView.save.blockers.some((b) => b.why === UPLOAD_TEXT.chooseDay)) reach.blockedAtRowAndDay++;
      if (step.type === 'save' && run.s.phase === 'done') reach.corrections += run.corrections;
      // A dated previous column's value moved by its pick, drawn to be written on the page Save ran from and saved (P7 checked its day).
      if (step.type === 'save' && run.s.phase === 'done' && run.last && movedColumn(run.last.view, run.last.review, run.s)) reach.columnMoved++;
      if (run.s.phase === 'done') { reach.saved++; if (phase.saves) reach.saveFailedThenSaved++; if (run.s.files.some((f) => f.original === false)) reach.noOriginalSaved++; }
      if (step.type === 'save' && step.meanwhile) reach.changedBeforeSave++;
      // A tick on a row holding text, which keeps it (L7); a row whose input takes no typing (L8).
      if (step.type === 'event' && step.e.type === 'chose' && 'tick' in step.e.change && step.e.change.on && run.inputs.get(`${step.e.id}:${step.e.change.tick}`)?.typed) reach.tickOnHeld++;
      if (run.last?.list.rows.some((row) => row.input === 'none')) reach.inputNone++;
      if (step.type === 'tap') reach.changedBeforeTap++;
      if (step.type === 'save' && step.free) reach.freedBeforeCommit++;
      if ((step.type === 'record' || (step.type === 'save' && step.meanwhile)) && step.merge) reach.merges++;
      if (step.type === 'delete' && lostBefore(run)) reach.replaceLost++;
      if (step.type === 'save' && run.s.phase === 'done') { reach.skipped += run.saved.skipped; reach.unstored += run.saved.unstored; reach.archiveOnly += run.saved.archiveOnly; }
      const v = run.last?.view;
      const list = run.last?.list;
      if (list && run.s.phase === 'open') {
        if ('files' in run.s && new Set(run.s.files.map((f) => f.name)).size < run.s.files.length && list.rows.length) reach.sameNamed++;
        if (list.rows.some((r) => r.status.kind === 'alreadyInRecord')) reach.listAlreadyInRecord++;
        if (list.rows.some((r) => r.reasons.length)) reach.listReasons++;
        if (list.check) reach.listHeading++;
        if (list.rows.some((r) => r.name.endsWith(', another reading'))) reach.anotherReading++;
        if (list.rows.some((r) => r.replaceLabel)) reach.replaceNamed++;
        if (list.checkNote) reach.listCheckNote++;
        if (list.rows.some((r) => r.name.includes('labs.zip/'))) reach.zipMembers++;
        if (list.days.some((d) => d.fileName.startsWith('a very long'))) reach.longName++;
        if (list.check === null && list.rows.some((r) => r.attention)) reach.touchedUncounted++;
        if (run.s.files.some((f) => f.status.s === 'read' && f.status.choices.editUnits)) reach.editUnitKept++;
        if (list.days.some((d, i) => d.source === 'column' && list.days.some((e, j) => j !== i && e.source === 'column' && e.fileId === d.fileId))) reach.twoColumns++;
        if (list.rows.some((r) => r.status.kind === 'waits')) reach.listWaits++;
        // Web list PR 1e: a pick that waits, by each of its words (L14); a letter's text previewed (L15); the close button saying
        // Close (L16). Held text in a unit the person no longer reads (L13) is counted where it is reached: one seed in 3000
        // reached it here, upload-list.units.property.test.ts 2428 times in its 400 seeds, with checkUnits as its oracle.
        // A row holding text (no toggle) beside a row of the same test that keeps its toggle (L13, owner ruling on PR 1951).
        if (list.rows.some((r) => r.typed && r.shown.cell && list.rows.some((o) => o !== r && o.unit.toggle && o.shown.cell?.metric === r.shown.cell!.metric))) reach.heldBesideToggle++;
        if (list.days.some((d) => d.chosen && !d.day && d.hint === DAY_NOT_HAPPENED)) reach.dayNotHappened++;
        if (list.days.some((d) => d.chosen && !d.day && d.hint !== DAY_NOT_HAPPENED)) reach.dayLimits++;
        if (run.last!.page.letters.some((l) => l.text)) reach.lettersShown++;
        if (run.last!.page.close === UPLOAD_TEXT.close) reach.closeWord++;
        if (list.rows.some((r) => r.status.kind === 'sameDay' && r.ticked)) reach.listSameDayTicked++;
        if (list.rows.some((r) => r.status.kind === 'error' && r.error !== null && !allRows(v!).some((x) => x.fileId === r.fileId && x.ref === r.ref && x.error))) reach.listCopyError++;
        if (v?.save.blockers.some((b) => b.why === FIX_ERRORS_TEXT && run.last!.review.classification.values.some((c) => !c.sent && `${run.last!.review.labFiles[c.file].fileId}:${c.ref}` === b.at))) reach.unsentBlocked++;
      }
      if (v && run.s.phase === 'open' && !inFlight(run.s)) {
        if (v.save.why === FIX_ERRORS_TEXT) reach.blockedFix++;
        if (v.save.why === UPLOAD_TEXT.chooseDay) reach.blockedDay++;
        if (allRows(v).some((row) => row.replacing)) reach.replacing++;
        if (allRows(v).some((row) => row.conflict)) reach.conflicts++;
        if (v.documents) reach.documents++;
        if (allRows(v).some((row) => row.copy)) reach.copies++;
        if (v.alreadySaved) reach.alreadySaved++;
        if (v.sections.some((x) => x.kind === 'notSaved' && x.lines.some((l) => l.includes(LAB_DAY_REFUSAL) || l.includes(DAY_NOT_HAPPENED)))) reach.futureDay++;
        if (allRows(v).some((row) => row.error === PRESSURE_ORDER)) reach.pressureRefused++;
        if (allRows(v).some((row) => row.ticked && row.value?.startsWith('<'))) reach.limitTicked++;
        if (allRows(v).some((row) => row.ticked && row.ref[0] === 'a' && row.label === 'LDL Cholesterol')) reach.labAsCore++;
        if (run.s.files.some((f) => f.status.s === 'read' && Object.keys(f.status.choices.edits).length)) reach.edited++;
        // A column that waits because its pick, a real past day, is not before the test's day (P8 checks the wait).
        if (run.last && waitsNotBefore(run.last.review, run.s)) reach.columnNotBefore++;
        // A value of the undated previous column on a picked day, shown to be written (P7 checks its day).
        if (allRows(v).some((row) => run.last?.view.reviewed?.some((w) => w.file === row.fileId && w.ref === row.ref) && run.s.phase === 'open' && run.s.files.some((f) => f.id === row.fileId && f.status.s === 'read' && valueRecordedAt(f.status.extraction, row.ref) === UNDATED_PREVIOUS))) reach.undatedPrevious++;
      }
    }
    reach.k1DayChanges += run.k1;
    reach.k4Unpromised += run.k4;
    reach.savingWord += run.savingWords;
    reach.typedRefused += run.typedRefused;
    if (run.typedRefused && run.s.phase === 'done') reach.typedSavedAfter++;
  }
  if (out) writeFileSync(`${out}.${from}-${to}.json`, JSON.stringify({ reach, gaps: Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, { seqs: v.length, first: v.slice(0, 5) }])) }, null, 1));
  return { reach, gaps };
}

/** The seeds run as this many ranges, one test file each (upload-view.property.part1.test.ts and on). */
export const PARTS = 6;

/**
 * Reach counters some ranges never reach, each with the parts that must reach it (asserted there alone). None today: with
 * the ids seeded, every range reaches every counter it keeps (measured 2026-11-22).
 */
export const REACHED_ONLY_IN: Record<string, number[]> = {};

/**
 * Part `part` (1 to PARTS) of the seeds as one test. The single test over all 3000 took 116 s on a loaded CI runner
 * (main, run 44894369479), 4 s short of its 120 s timeout and over the 40 s file budget; locally a part takes about 4 s.
 * Reach: the single test asserted 20000 steps and every counter over all seeds. Each part asserts its share of the steps
 * (the shares sum to 20000) and every counter within its own range, which each range reached when the run was split
 * (2026-11-22), except a counter named in REACHED_ONLY_IN, asserted in the parts it names. No counter goes unasserted: one
 * named there must name a part. A counter a range stops reaching fails here by name; name it there with the parts that
 * still reach it (each seed's reach: sweepSeeds(seed, seed)). `out`: as sweepSeeds takes it.
 */
export function sweepPart(part: number, out?: string): void {
  const size = SEEDS / PARTS;
  const from = (part - 1) * size + 1;
  const to = part * size;
  describe('upload-view property: the list view against Save (US-52 AC8c, US-13 AC13)', () => {
    it(`holds for seeds ${from}-${to} of ${SEEDS} seeded uploads, P1-P6 after every step`, async () => {
      const { reach } = await sweepSeeds(from, to, out);
      expect(reach.steps).toBeGreaterThan((20000 * size) / SEEDS);
      for (const [name, k] of Object.entries(reach)) if (REACHED_ONLY_IN[name]?.includes(part) ?? true) expect([name, k > 0]).toEqual([name, true]);
      for (const [name, parts] of Object.entries(REACHED_ONLY_IN)) expect([name, name in reach && parts.length > 0 && parts.every((p) => p >= 1 && p <= PARTS)]).toEqual([name, true]);
    }, 90_000);
  });
}
