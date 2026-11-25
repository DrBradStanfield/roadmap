/**
 * The list-view property's generator: each seed's reads, record and steps, drawn from mulberry32 in a fixed order (seed N
 * draws the same sequence only while that order holds). The harness: upload-view.property.test-helpers.ts.
 */
import { UNDATED_PREVIOUS, type AdditionalLabValue, type ExtractedValue, type UnifiedExtractionResult } from './lab-extraction';
import { bulkAppendValues, validDay, type BulkRow } from './record-edits';
import { knownAs, knownIndex } from './upload-known';
import { reportedToCanonical } from './units';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import type { ChoiceChange } from './upload-choices';
import type { PickedFile } from './upload-flow';
import { requestFlags, type UploadPlatform } from './upload-rules';
import type { TypedText } from './upload-choices';
import { offeredValues, valueAt } from './import-review';
import type { UnitSystem } from './units';
import { NOW, DAY, PAST, PICKED_DAY, FUTURE, EARLY, COLUMN, REPORT_FUTURE, type Setup, type Step, rowsOf, isActive, allRows, columnFixes } from './upload-view.property.base.test-helpers';
import { Run } from './upload-view.property.run.test-helpers';

// --- setup: what the reads answer and what the record holds ---------------------------------

const core = (over: Partial<ExtractedValue>): ExtractedValue => ({ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', ...over });
const extra = (over: Partial<AdditionalLabValue>): AdditionalLabValue => ({ name: 'Ferritin', value: 80, unit: 'µg/L', ...over });

/** One lab report: core values (ldl, hba1c) and labs from a small pool, each on no day, a past day or (rarely) a future one;
 *  where the platform asks the server for it (`requestFlags` undatedPrev: the web), sometimes the undated previous column,
 *  and some values on a second past day (`COLUMN`), a dated previous column the web's review can move (US-13 AC24). */
function genLab(r: () => number, platform: UploadPlatform): UnifiedExtractionResult {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const reportDate = coin(0.65) ? DAY : coin(0.9) ? null : REPORT_FUTURE;
  // The server keeps an own day only before the report's full day (lab-extraction.ts `ownDay`): none on an undated
  // report, and a future one only before a future report date.
  const undatedPrev = requestFlags(platform).undatedPrev;
  const past = () => (undatedPrev && coin(0.4) ? COLUMN : PAST);
  const own = () => (undatedPrev && coin(0.15) ? UNDATED_PREVIOUS : reportDate === null || coin(0.6) ? undefined : reportDate === REPORT_FUTURE && coin(0.5) ? FUTURE : past());
  const values: ExtractedValue[] = [];
  const additionalValues: AdditionalLabValue[] = [];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const kind = pick(['ldl', 'hba1c', 'ldlQ', 'ldlGuess', 'ldlHigh', 'ferritin', 'refusedAlone', 'bp', 'ldlLimit', 'ldlAsLab', 'ldlMgdl', 'unknownCore'] as const);
    const recordedAt = own();
    const day = recordedAt ? { recordedAt } : {};
    const ldl = pick([3.1, 2.4]);
    if (kind === 'ldl') values.push(core({ valueSI: ldl, displayValue: ldl, ...day, ...(coin(0.2) ? { confidence: 'medium' as const } : {}) }));
    const a1c = pick([40, 52]);
    if (kind === 'hba1c') values.push(core({ metric: 'hba1c', valueSI: a1c, displayValue: a1c, displayUnit: 'mmol/mol', ...day }));
    if (kind === 'ldlQ') values.push(core({ valueSI: 3.1, question: 'Is this LDL?', ...day }));
    if (kind === 'ldlGuess') values.push(core({ valueSI: 2.4, displayValue: 2.4, unitGuessed: true, ...day }));
    if (kind === 'ldlHigh') values.push(core({ valueSI: 500, displayValue: 500, ...day }));
    if (kind === 'ferritin') additionalValues.push(extra({ value: pick([80, 95]), ...day }));
    if (kind === 'refusedAlone') additionalValues.push(extra({ name: 'Ferritin', unit: 'zzz', ...day }));
    // A blood pressure pair, sometimes the wrong way up (the write refuses both halves, US-02 AC8).
    if (kind === 'bp') {
      const [sys, dia] = coin(0.3) ? [80, 120] : [120, 80];
      values.push(core({ metric: 'systolic_bp', valueSI: sys, displayValue: sys, displayUnit: 'mmHg', ...day }), core({ metric: 'diastolic_bp', valueSI: dia, displayValue: dia, displayUnit: 'mmHg', ...day }));
    }
    // Printed as a limit ("< 0.6", US-12 AC20).
    if (kind === 'ldlLimit') values.push(core({ valueSI: 0.6, displayValue: 0.6, comparator: '<', ...day }));
    // A lab the write files as a core value (bulk-row-target.ts).
    if (kind === 'ldlAsLab') additionalValues.push(extra({ name: 'LDL Cholesterol', value: 2.9, unit: 'mmol/L', ...day }));
    // Printed in mg/dL: the row shows the printed number, the record stores its SI conversion.
    // A core metric this build does not know (the schema takes any text): the write refuses it alone (round one, F1).
    if (kind === 'unknownCore') values.push(core({ metric: 'vitamin_zz', valueSI: 12, displayValue: 12, displayUnit: 'zz/L', ...day }));
    if (kind === 'ldlMgdl') values.push(core({ valueSI: reportedToCanonical('ldl', 116, 'mg/dL')!.valueSI, displayValue: 116, displayUnit: 'mg/dL', displaySystem: 'conventional', ...day }));
  }
  return {
    classification: 'lab_report', reportDate, values, additionalValues, unrecognized: [], document: null,
    ...(coin(0.2) ? { refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'no unit' }] } : {}),
  };
}

function genLetter(r: () => number): UnifiedExtractionResult {
  return {
    classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [],
    document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: r() < 0.7 ? '2026-10-20' : null, contentMarkdown: '## Plan', metadata: {} },
  };
}

const EMPTY = createEmptyFile({ deviceId: 'test', now: NOW });

/** A record holding some of the slots the pool lands on: the same value, a different one, and one row entered in error. */
function genRecord(r: () => number): RoadmapFile {
  const rows: BulkRow[] = [];
  const add = (p: number, row: BulkRow) => { if (r() < p) rows.push(row); };
  add(0.3, { kind: 'measurement', metricType: 'ldl', value: 3.1, recordedAt: DAY, source: 'manual' });
  add(0.3, { kind: 'measurement', metricType: 'hba1c', value: 52, recordedAt: DAY, source: 'manual' });
  add(0.25, { kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: PAST, source: 'manual' });
  add(0.25, { kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: PAST, source: 'manual' });
  add(0.2, { kind: 'measurement', metricType: 'systolic_bp', value: 130, recordedAt: DAY, source: 'manual' });
  add(0.15, { kind: 'measurement', metricType: 'diastolic_bp', value: 140, recordedAt: DAY, source: 'manual' });
  let file = bulkAppendValues(EMPTY, rows, NOW).file;
  // A letter held as a metadata-only row (no original): picking its bytes again is an archive-only known file (US-14 AC4).
  if (r() < 0.25) file = { ...file, documents: [{ id: 'held-doc', title: 'Held letter', type: 'clinic_letter', date: '2026-01-01', fileRef: '', contentHash: `h-f${Math.floor(r() * 3)}`, mimeType: '', extractedText: '', addedAt: NOW, metadata: {}, sourceFileName: 'held.pdf' }] };
  // One row entered in error, its slot left free (a deletion), or corrected (its slot moved to a new row).
  if (r() < 0.4) {
    const err = bulkAppendValues(file, [{ kind: 'measurement', metricType: 'hba1c', value: 45, recordedAt: PAST, source: 'manual' }], NOW).file;
    file = { ...err, labValues: err.labValues.map((l) => (l.recordedAt.startsWith(PAST) && l.metricName === 'hba1c' ? { ...l, status: 'entered-in-error' } : l)) };
  }
  return file;
}

/** The next step for this run, from its state: landings first, chosen values among them, then Save. */
export function genStep(r: () => number, run: Run, phase: { saves: number; chosen: number; resolved: number }): Step | null {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const s = run.s;
  if (s.phase === 'choosing') {
    const n = 1 + Math.floor(r() * 3);
    // Some are a photo or a scan (`original: false`, US-52 AC13e): never an original or an archive row.
    // Sometimes every file has one name (a phone's "IMG_0001.jpg" twice): ids, never names, key the rows.
    const same = coin(0.15);
    // Sometimes a name longer than any surface keeps (cut to MAX_FILE_NAME_LENGTH); on the web sometimes one ZIP, whose
    // members (f0...) are named by their path inside it (`uploadFileName`, web list PR 1d review G3).
    const long = coin(0.1);
    const name = (i: number) => (same ? 'report.pdf' : long && i === 0 ? `${'a very long report name '.repeat(12)}${i}.pdf` : `report-${i}.pdf`);
    if (run.setup.platform === 'web' && coin(0.15)) return { type: 'event', e: { type: 'picked', files: [{ id: 'zip', name: 'labs.zip', bytes: 1, kind: 'zip' }], needsConsent: false, now: NOW } };
    const files: PickedFile[] = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, name: name(i), bytes: 1, kind: 'file', ...(coin(0.25) ? { original: false as const } : {}) }));
    return { type: 'event', e: { type: 'picked', files, needsConsent: coin(0.2), now: NOW } };
  }
  const listing = 'files' in s ? s.files.find((f) => f.status.s === 'listing') : undefined;
  if (s.phase === 'open' && listing) {
    const same = coin(0.2);
    const members = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({ id: `f${i}`, name: same ? 'scans/report.pdf' : `scans/2026/report-${i}.pdf`, bytes: 1 }));
    return { type: 'event', e: { type: 'listed', run: s.run, zip: listing.id, members } };
  }
  if (s.phase === 'consent') return { type: 'event', e: { type: 'consented' } };
  if (s.phase === 'done' || s.phase === 'failed') return null;
  const run_ = s.run;
  if (s.phase === 'saving') {
    const meanwhile = coin(0.25) ? otherWriter(r, run) : null;
    // Another writer between Save and the commit: appends rows, or frees a held slot (a kept conflict's held row deleted).
    const free = coin(0.15) ? freeable(r, run) : null;
    return { type: 'save', ok: phase.saves > 0 || coin(0.85), meanwhile: meanwhile ?? (free ? [] : null), merge: coin(0.5), free, when: coin(0.5) ? 'beforeSave' : 'beforeCommit' };
  }
  if (s.phase === 'saveFailed') {
    phase.saves++;
    // A choice on a row the view shows (an erroring one first, when Save waits on it), or Save again when the view lets it.
    const shown = run.last ? surface(run) : [];
    const row = shown.find((x) => x.blocks) ?? (shown.length && coin(0.3) ? pick(shown) : undefined);
    if (row) return { type: 'event', e: { type: 'chose', id: row.fileId, change: { tick: row.ref, on: !row.ticked }, now: NOW } };
    return run.last?.view.save.enabled ? tapOrSave(r, run) : null;
  }
  // open
  const busy = s.files.filter((f) => ['hashing', 'converting', 'sending'].includes(f.status.s));
  const read = s.files.filter((f) => f.status.s === 'read');
  const roll = r();
  if (busy.length && roll < 0.7) {
    const f = pick(busy);
    if (f.status.s === 'hashing') {
      const twin = coin(0.05) && s.files[0].id !== f.id ? s.files[0].hash ?? `h-${f.id}` : `h-${f.id}`;
      if (coin(0.03)) return { type: 'event', e: { type: 'hashFailed', run: run_, id: f.id } };
      // Known as the engine door says it (knownAs on the record), and sometimes a known the record does not show.
      const known = knownAs(knownIndex(run.record), twin) ?? (coin(0.05) ? { as: pick(['document', 'labReport'] as const), archiveOnly: coin(0.5) } : null);
      return { type: 'event', e: { type: 'hashed', run: run_, id: f.id, hash: twin, known } };
    }
    if (f.status.s === 'converting') {
      if (coin(0.03)) return { type: 'event', e: { type: 'convertFailed', run: run_, id: f.id, reason: pick(['unreadable', 'timeout'] as const) } };
      return { type: 'event', e: { type: 'converted', run: run_, id: f.id, pages: 1, truncated: coin(0.1) } };
    }
    if (coin(0.1)) return { type: 'event', e: { type: 'sendFailed', run: run_, id: f.id, failure: pick(['busy', 'network', 'refused'] as const) } };
    return { type: 'event', e: { type: 'answered', run: run_, id: f.id, extraction: run.setup.extractions[f.id], legacy: coin(0.03), now: NOW } };
  }
  if (roll < 0.74) return { type: 'event', e: { type: 'retry', id: 'all' } };
  if (roll < 0.76 && busy.length) return { type: 'event', e: { type: 'stop' } };
  if (roll < 0.8 && phase.chosen < 30) {
    // Mostly a write; sometimes a deletion of a held row, often the one a Replace aims at.
    const aimed = s.files.flatMap((f) => (f.status.s === 'read' ? Object.values(f.status.choices.replace) : []));
    const live = rowsOf(run.record).filter(isActive).map((x) => x.id);
    const target = aimed.find((id) => live.includes(id)) ?? (live.length ? pick(live) : null);
    if (target && coin(0.3)) return { type: 'delete', id: target };
    return { type: 'record', rows: otherWriter(r, run), merge: coin(0.4) };
  }
  if (read.length && (busy.length || phase.chosen < 6 || coin(0.6)) && phase.chosen < 30) {
    phase.chosen++;
    const f = pick(read);
    const change = genChange(r, run, f.id);
    if (change) return { type: 'event', e: { type: 'chose', id: f.id, change, now: NOW } };
  }
  if (busy.length) return { type: 'event', e: { type: 'retry', id: 'all' } };
  // Save blocked: clear it as the person would, through the control the view gives (P4 checked it exists).
  const v = run.last?.view;
  if (v && !v.save.enabled && phase.resolved < 12 && coin(0.9)) {
    phase.resolved++;
    const err = surface(run).find((row) => row.blocks);
    if (err) return { type: 'event', e: { type: 'chose', id: err.fileId, change: coin(0.6) ? { tick: err.ref, on: false } : { edit: err.ref, value: 3.1 }, now: NOW } };
    const day = v.sections.find((x) => x.kind === 'undated');
    if (day && day.kind === 'undated') return { type: 'event', e: { type: 'chose', id: day.fileId, change: { testDay: coin(0.8) ? PICKED_DAY : DAY }, now: NOW } };
    const prev = v.sections.find((x) => x.kind === 'undatedPrevious');
    if (prev && prev.kind === 'undatedPrevious') return { type: 'event', e: { type: 'chose', id: prev.fileId, change: { previousDay: coin(0.8) ? EARLY : PAST }, now: NOW } };
    const column = run.last?.review.labFiles.find((f) => f.needsColumnDay);
    if (column) return { type: 'event', e: { type: 'chose', id: column.fileId, change: columnFixes(s, column)[0], now: NOW } };
  }
  // Nothing in flight: Save as the person would, only when the view enables it; else give up the sequence.
  if (run.last?.view.save.enabled) return tapOrSave(r, run);
  return null;
}

/**
 * A change the list lets the person make: on a row it shows (tick, Replace with the row's held id or
 * a stale one, an edit), the test's day only while the undated section asks it, a document's fixes.
 * The previous column's day on the web, while the file prints one (the phone never asks for one): a past day before the
 * report's, one on or after it, a partial pick, or none; a dated previous column's day on the web (US-13 AC24).
 */
function genChange(r: () => number, run: Run, fileId: string): ChoiceChange | null {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const f = 'files' in run.s ? run.s.files.find((x) => x.id === fileId) : undefined;
  const view = run.last?.view;
  if (f?.status.s !== 'read' || !view) return null;
  if (f.status.extraction.classification !== 'lab_report') {
    const k = r();
    if (k < 0.3) return { document: { title: pick(['Renamed letter', 'Letter from the clinic']) } };
    if (k < 0.6) return { document: { kind: pick(['clinic_letter', 'scan_result', 'other']) } };
    return { document: { date: pick(['2026-10-10', null, FUTURE, '2026-02-30']) } };
  }
  const rows = surface(run).filter((row) => row.fileId === fileId);
  const asksDay = view.sections.some((x) => x.kind === 'undated' && x.fileId === fileId);
  // The phone's pickers offer only days up to today (UploadReviewView.swift `in: ...Date.now`, DayCalendar).
  // The web's date input has no limit (UploadListDays.tsx), so a day to come too.
  if (asksDay && (!rows.length || coin(0.4))) return { testDay: pick(run.setup.platform === 'web' ? [PICKED_DAY, DAY, PAST, FUTURE] : [PICKED_DAY, DAY, PAST]) };
  const printsUndated = [...(f.status.extraction.values ?? []), ...(f.status.extraction.additionalValues ?? [])].some((x) => x.recordedAt === UNDATED_PREVIOUS);
  if (printsUndated && coin(0.3)) return { previousDay: pick([EARLY, PAST, PICKED_DAY, DAY, '2026-10', null]) };
  // A dated previous column's day, on the web only (US-13 AC24): a valid early day, a partial pick that waits, another column's
  // printed day, or a real day on or after the test's (DAY, PICKED_DAY: it waits, PR 1926 R1).
  const columns = printedDays(f.status.extraction);
  if (run.setup.platform === 'web' && columns.length && coin(0.25)) {
    const columnDay = pick(columns);
    const others = columns.filter((d) => d !== columnDay);
    return { columnDay, day: pick([EARLY, '2026-10', DAY, PICKED_DAY, FUTURE, ...(others.length ? [pick(others)] : [])]) };
  }
  if (!rows.length) return null;
  const row = pick(rows);
  const k = r();
  // Sometimes a tick on a ticked row that holds text (a tap on a checked box): it must keep the text (L7).
  if (k < 0.45) return { tick: row.ref, on: !row.ticked || (k < 0.15 && !!row.typed) };
  if (k < 0.75) {
    if (row.replacing) return { replace: row.ref, correctsId: null };
    const stale = rowsOf(run.record).filter((x) => !isActive(x)).map((x) => x.id);
    const correctsId = row.replaces && coin(0.8) ? row.replaces : stale.length ? pick(stale) : 'no-such-row';
    return row.replaces || coin(0.2) ? { replace: row.ref, correctsId } : { tick: row.ref, on: !row.ticked };
  }
  // Text typed into a row, on the web (US-13 AC12): a number, one the cells question, one that is no number, or nothing.
  if (run.setup.platform === 'web' && coin(0.5)) {
    const at = valueAt(f.status.extraction, row.ref);
    // Mostly the unit the person reads; sometimes one that does not fit the value (round one, F3: refused, never a throw).
    const unit = coin(0.15) ? pick(['nmol/L', 'mg/L', 'mg/dL', 'si', null] as const) : at?.kind === 'core' ? run.setup.system : null;
    return { typed: row.ref, text: pick(['abc', '3..5', '1,234', '3.6', '12.9', '500', '', '3.14']), unit };
  }
  return { edit: row.ref, value: pick([2.0, 3.1, 52, 500, null, Number.NaN]) };
}

/** The rows the platform draws, as a person acts on them: the web's list, the phone's view. `blocks`: it holds up Save. */
function surface(run: Run): Array<{ fileId: string; ref: string; ticked: boolean; replaces: string | null; replacing: boolean; blocks: boolean; typed: TypedText | null }> {
  if (!run.last) return [];
  if (run.setup.platform === 'web') return run.last.list.rows.map((r) => ({ ...r, blocks: r.status.kind === 'error' }));
  return allRows(run.last.view).map((r) => ({ ...r, blocks: !!r.error && r.ticked, typed: null }));
}

/** The real past days a report's values printed: each a dated column the web's review can move (US-13 AC24). */
const printedDays = (x: UnifiedExtractionResult): string[] =>
  [...new Set(offeredValues(x).map(({ value }) => value.recordedAt).filter((d): d is string => !!d && !!validDay(d, { now: NOW })))];

/** Save as the person taps it; sometimes another writer acts between the drawn page and the tap. */
function tapOrSave(r: () => number, run: Run): Step {
  if (r() >= 0.25) return { type: 'event', e: { type: 'saveStarted' } };
  const free = r() < 0.5 ? freeable(r, run) : null;
  return { type: 'tap', rows: free ? [] : otherWriter(r, run), merge: r() < 0.3, free };
}

/** A held row to delete, often one a value of the upload meets in its slot. */
function freeable(r: () => number, run: Run): string | null {
  const live = rowsOf(run.record).filter(isActive).map((x) => x.id);
  return live.length ? live[Math.floor(r() * live.length)] : null;
}

/** Another writer's rows: fill a slot the upload aims at, or correct a held row (a Replace's target moves). */
function otherWriter(r: () => number, run: Run): BulkRow[] {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const held = rowsOf(run.record).filter(isActive);
  if (held.length && r() < 0.4) {
    const row = pick(held);
    return ['metricType' in row || row.core
      ? { kind: 'measurement', metricType: 'metricType' in row ? row.metricType : row.metricName, value: row.value + 0.5, recordedAt: row.recordedAt.slice(0, 10), source: 'manual', correctsId: row.id }
      : { kind: 'lab', metricName: row.metricName, value: row.value + 1, unit: row.unit, referenceLow: null, referenceHigh: null, recordedAt: row.recordedAt.slice(0, 10), source: 'manual', correctsId: row.id }];
  }
  return [pick<BulkRow>([
    { kind: 'measurement', metricType: 'ldl', value: 2.7, recordedAt: pick([DAY, PAST, PICKED_DAY]), source: 'manual' },
    { kind: 'measurement', metricType: 'hba1c', value: 48, recordedAt: pick([DAY, PAST]), source: 'manual' },
    { kind: 'measurement', metricType: 'diastolic_bp', value: 125, recordedAt: pick([DAY, PAST]), source: 'manual' },
    { kind: 'lab', metricName: 'Ferritin', value: 70, unit: 'µg/L', referenceLow: null, referenceHigh: null, recordedAt: pick([DAY, PAST]), source: 'manual' },
  ])];
}

/** `system` is given, not drawn, so every seed draws the same values as before it was added. */
export function genSetup(r: () => number, system: UnitSystem): Setup {
  const extractions: Record<string, UnifiedExtractionResult> = {};
  const platform: UploadPlatform = r() < 0.5 ? 'web' : 'phone';
  for (let i = 0; i < 3; i++) extractions[`f${i}`] = r() < 0.75 ? genLab(r, platform) : genLetter(r);
  return { extractions, record: genRecord(r), cloud: r() < 0.5, failWrites: r() < 0.2 ? ['f0'] : [], platform, system };
}
