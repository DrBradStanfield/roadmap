/**
 * The list-view property's checks on each view: P1-P4, P6, P7, B and the list's L checks. The harness and the properties'
 * list: upload-view.property.test-helpers.ts.
 */
import type { BulkRow } from './record-edits';
import { rangeFault, reportedToCanonical, UNIT_DEFS, type MetricType } from './units';
import type { RoadmapFile } from './roadmap-file';
import type { ChoiceChange } from './upload-choices';
import { inFlight, transition, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview, type UploadReview } from './upload-review';
import { uploadView, type UploadView, type ValueRow } from './upload-view';
import { uploadList, type UploadList } from './upload-list';
import { checkExistence, checkHeading, checkInputKind, checkInputs, checkNames, checkNoSilentNonWrite, checkOneQuantity, checkTypedBlocks, checkWhy, checkDayNames, type PersonInputs } from './upload-list.test-helpers';
import { checkDayWords, checkLetters, checkSaveBar, checkUnits } from './upload-list-page.test-helpers';
import { uploadListPage, type ListPage } from './upload-list-page';
import { FIX_ERRORS_TEXT, UPLOAD_TEXT } from './upload-text';
import { IMPORT_REVIEW_TEXT, isOfferedRef, offeredValues } from './import-review';
import { cellLabel, cellRange, cellToSI } from './cell-unit';
import type { UnitSystem } from './units';
import { NOW, PICKED_DAY, EARLY, type Setup, rowsOf, key, shownWritable, allRows, written, fail, type Note, sourceKey, refusedAnyDay, checkOracles, checkDays, expectedDay, columnFixes, unitsOf } from './upload-view.property.base.test-helpers';

const BAD_TEXT = /undefined|NaN|\[object|\d{4}-\d{2}-\d{2}T\d{2}:/;
/** P6: every string the view shows; ids, refs, reason keys and section kinds are not shown. */
export function checkText(view: UploadView) {
  const walk = (x: unknown, path: string) => {
    if (typeof x === 'string') {
      if (!x.trim() || BAD_TEXT.test(x)) fail('P6', `${path} = ${JSON.stringify(x)}`);
    } else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${path}[${i}]`));
    else if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) if (!['fileId', 'ref', 'replaces', 'reasons', 'kind', 'month', 'before'].includes(k) || (k === 'kind' && path.includes('documents'))) walk(y, `${path}.${k}`);
    }
  };
  walk(view, 'view');
}

/** P1, P2 (same record), P3, P4, B on one view, in the person's units on the web. `note`: a known gap seen. */
export function checkView(s: UploadState, record: RoadmapFile, setup: Setup, note: Note, inputs: PersonInputs): { view: UploadView; review: UploadReview; list: UploadList; page: ListPage } {
  const { cloud } = setup;
  const review = uploadReview(s, record, NOW);
  const view = uploadView(s, record, NOW, review, cloud, unitsOf(setup));
  // The web's list, in the person's units; checked on both platforms' states, though only the web draws it.
  const unitOf = () => setup.system;
  const list = uploadList(s, record, NOW, review, unitOf);
  checkText(view);
  checkText(list as unknown as UploadView);
  checkExistence(s, review, list, fail);
  checkInputs(s, review, list, inputs, fail);
  checkTypedBlocks(s, view, inputs, fail);
  checkInputKind(s, review, list, NOW, fail);
  checkOneQuantity(s, review, view, list, unitOf, fail);
  checkNoSilentNonWrite(s, review, list, fail);
  checkWhy(s, review, list, fail);
  checkDayNames(s, list, note, fail);
  checkHeading(s, review, list, fail);
  checkNames(s, review, list, NOW, note, fail);
  // L13 in the person's units; across unit toggles on its own seeds (upload-list.units.property.test.ts), so this run
  // stays inside CI's time budget.
  checkUnits(s, list, unitOf, fail);
  checkDayWords(s, list, NOW, fail);
  const page = uploadListPage(s, record, NOW, review, cloud);
  checkLetters(s, view, page, fail);
  checkSaveBar(s, review, view, page, fail);
  const rows = allRows(view);
  // P1: each offered value once, as a row or a not-saved line, or behind its report's day question.
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(key(row.fileId, row.ref), (seen.get(key(row.fileId, row.ref)) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) fail('P1', `two rows for ${k}`);
  const notSavedLines = view.sections.flatMap((x) => (x.kind === 'notSaved' ? x.lines : []));
  const daySection = new Set(view.sections.flatMap((x) => (x.kind === 'undated' || x.kind === 'undatedPrevious' ? [x.fileId] : [])));
  review.labFiles.forEach((lf, i) => {
    const f = ('files' in s ? s.files : []).find((x) => x.id === lf.fileId)!;
    if (f.status.s !== 'read') return;
    const x = f.status.extraction;
    const refs = [...(x.values ?? []).map((_, j) => `v${j}`), ...(x.additionalValues ?? []).map((_, j) => `a${j}`)];
    for (const ref of refs) {
      const v = review.classification.values.find((c) => c.file === i && c.ref === ref);
      if (!v) fail('P1', `${lf.fileId} ${ref} not classified`);
      const asRow = seen.get(key(lf.fileId, ref)) ?? 0;
      if (asRow) { if (v!.group === 'notSaved' || v!.group === 'saved' || v!.group === 'waiting') fail('P1', `${ref} is ${v!.group} and a row`); continue; }
      if (v!.group === 'notSaved') { if (!notSavedLines.some((l) => l.includes(v!.label))) fail('P1', `${ref} not saved, in no line`); continue; }
      if (v!.group === 'saved') continue; // counted in the already-saved line (checked below), or an equal copy of a reading that saves
      if (v!.group === 'waiting') {
        if (daySection.has(lf.fileId)) continue;
        // The web draws the list, where every value is a row under its day control (L1): a waiting value it unticked, or
        // one whose dated column waits for its pick (US-13 AC24), need no section of the phone's view.
        if (setup.platform === 'web') continue;
        fail('P1', `${lf.fileId} ${ref} waits for a day no section asks (ticked ${lf.ticked.includes(ref)})`);
      }
      fail('P1', `${lf.fileId} ${ref} (${v!.group}) is missing from the view`);
    }
  });
  // P1: values held already, equal, are counted, as the web counts them (an equal copy of this upload's own reading is not).
  const held = review.classification.values.filter((v) => isOfferedRef(v.ref) && v.group === 'saved' && !('duplicate' in v && v.duplicate)).length;
  if ((view.alreadySaved ?? null) !== (held ? IMPORT_REVIEW_TEXT.alreadySaved(held) : null)) fail('P1', `already-saved line ${view.alreadySaved} for ${held}`);
  // A copy of another reading carries no Replace: Replace lives on the reading that holds the slot.
  for (const row of rows) if (row.copy && (row.replaces || row.replacing || row.replace)) fail('P2', `${row.fileId} ${row.ref} is a copy with a Replace`);
  // P2: shown writable == what the review writes == the plan's rows.
  const shown = shownWritable(view, review, s);
  const writes = written(review);
  const plan = uploadSavePlan(s, record, NOW, review, cloud);
  if (plan.labRows.flatMap((x) => x.rows).length !== writes.size) fail('P2', 'plan rows != written values');
  for (const k of writes) if (!shown.has(k)) fail('P2', `${k} is written but not shown ticked and writable`);
  // `saves` is what the row shows: ticked and writable (K4 checks it while saving, when no view is checked here).
  for (const row of rows) if (row.saves !== shown.has(key(row.fileId, row.ref))) fail('P2', `${row.fileId} ${row.ref} saves ${row.saves}, shown writable ${!row.saves}`);
  for (const k of shown) if (!writes.has(k)) {
    const [fileId, ref] = k.split('|');
    const fi = review.labFiles.findIndex((x) => x.fileId === fileId);
    fail('P2', `${k} is shown ticked and writable but Save does not write it\nrow ${JSON.stringify(rows.find((x) => key(x.fileId, x.ref) === k))}\nvalue ${JSON.stringify(review.classification.values.find((v) => v.file === fi && v.ref === ref))}`);
  }
  // P3: the label and the lines count those rows and the documents shown.
  const docs = view.documents?.rows.length ?? 0;
  if (docs !== plan.documents.length) fail('P3', 'documents shown != planned');
  if (view.documents && view.documents.line !== UPLOAD_TEXT.documentsLine(docs)) fail('P3', 'documents line');
  const n = writes.size;
  const label = n || docs || !plan.counts.originals ? UPLOAD_TEXT.saveBoth(n, docs) : UPLOAD_TEXT.saveOriginals(plan.counts.originals);
  if (view.save.label !== label) fail('P3', `label ${view.save.label} != ${label}`);
  const sureWrites = (view.sure?.rows ?? []).filter((row) => writes.has(key(row.fileId, row.ref))).length;
  if (view.sure && view.sure.line !== IMPORT_REVIEW_TEXT.willSave(sureWrites)) fail('P3', `sure line ${view.sure.line} != ${sureWrites}`);
  checkDays(s, review);
  checkNumbers(s, review, rows, writes, record, setup);
  checkOracles(s, review, record);
  checkBlockers(s, view, review, list, plan);
  // P4: a disabled Save with nothing in flight names a blocker the view lets the person clear.
  if ((s.phase === 'open' || s.phase === 'saveFailed') && !view.save.enabled && inFlight(s) === 0) {
    const why = view.save.why;
    if (!why) fail('P4', 'disabled with no reason');
    if (why === FIX_ERRORS_TEXT) {
      // The rows that block, as the list draws them (the phone's view draws a sent one's error, not a copy's: main's rule).
      const errs = list.rows.filter((row) => row.status.kind === 'error');
      if (!errs.length) fail('P4', 'fix errors, but no row blocks');
      for (const row of errs) {
        const after = transition(s, { type: 'chose', id: row.fileId, change: { tick: row.ref, on: false }, now: NOW }).state;
        const again = uploadReview(after, record, NOW);
        if (uploadList(after, record, NOW, again, unitOf).rows.some((x) => x.key === row.key && x.status.kind === 'error')) fail('P4', `unticking ${row.ref} leaves its block`);
      }
    } else if (why === UPLOAD_TEXT.chooseDay) {
      for (const lf of review.labFiles.filter((f) => f.needsDay)) {
        if ((lf.needsTestDay || lf.needsPreviousDay) && !daySection.has(lf.fileId)) fail('P4', `${lf.fileId} needs a day and no section asks it`);
        const changes: ChoiceChange[] = lf.needsTestDay ? [{ testDay: PICKED_DAY }] : lf.needsPreviousDay ? [{ previousDay: EARLY }] : columnFixes(s, lf);
        const after = changes.reduce<UploadState>((st, change) => transition(st, { type: 'chose', id: lf.fileId, change, now: NOW }).state, s);
        const again = uploadReview(after, record, NOW).labFiles.find((f) => f.fileId === lf.fileId)!;
        if (lf.needsTestDay ? again.needsTestDay : lf.needsPreviousDay ? again.needsPreviousDay : again.needsColumnDay) fail('P4', `choosing the day leaves ${lf.fileId} waiting`);
        // Never a day asked only for values the write refuses whatever the day (they sit under Not saved).
        const fi = review.labFiles.indexOf(lf);
        const dayless = review.classification.values.filter((v) => v.file === fi && !v.sent && lf.ticked.includes(v.ref));
        if (lf.needsTestDay && !dayless.some((v) => v.group === 'waiting' || (v.group === 'unsure' && v.reasons.includes('outOfRange')))) fail('P4', `${lf.fileId} asked a day only for values the write refuses`);
      }
    } else if (why !== UPLOAD_TEXT.saveNothing) fail('P4', `unknown blocker ${why}`);
  }
  return { view, review, list, page };
}

/**
 * P7: each row Save writes shows what Save writes: its number (an edit as typed; else as printed, whose SI
 * conversion is what a core value stores), its unit, its day; a Replace shows the value it replaces.
 */
function checkNumbers(s: UploadState, review: UploadReview, rows: ValueRow[], writes: Set<string>, record: RoadmapFile, setup: Setup) {
  const planned = new Map(review.classification.values.filter((v) => v.sent && v.writes).map((v, k) => [key(review.labFiles[v.file].fileId, v.ref), review.classification.rows[k]]));
  const reads = new Map(('files' in s ? s.files : []).flatMap((f) => (f.status.s === 'read' ? [[f.id, f.status] as const] : [])));
  for (const row of rows) {
    const k = key(row.fileId, row.ref);
    // The phone's view is given no units: its rows carry no `shown`, as before.
    if (setup.platform === 'phone' && row.shown !== undefined) fail('P7', `${k} has a shown value on the phone`);
    const bulk = planned.get(k);
    if (!writes.has(k) || !bulk) continue;
    const edit = reads.get(row.fileId)?.choices.edits[row.ref];
    const shown = Number((row.value ?? '').replace(/^[<>]=?\s*/, ''));
    if (row.day !== bulk.recordedAt.slice(0, 10)) fail('P7', `${k} shows day ${row.day}, Save writes ${bulk.recordedAt}`);
    if (setup.platform === 'web') checkShown(k, row, bulk, setup.system);
    if (edit !== undefined) {
      if (shown !== edit || bulk.value !== edit) fail('P7', `${k} edited to ${edit}: shows ${row.value}, Save writes ${bulk.value}`);
    } else if (bulk.kind === 'measurement') {
      const si = reportedToCanonical(bulk.metricType as MetricType, shown, row.unit ?? '')?.valueSI;
      if (si === undefined || Math.abs(si - bulk.value) > 1e-6 * Math.max(1, Math.abs(si))) fail('P7', `${k} shows ${row.value} ${row.unit}, Save writes ${bulk.value} (SI ${si})`);
    } else if (shown !== bulk.value || row.unit !== bulk.unit) fail('P7', `${k} shows ${row.value} ${row.unit}, Save writes ${bulk.value} ${bulk.unit}`);
    if (bulk.correctsId) {
      const old = rowsOf(record).find((x) => x.id === bulk.correctsId);
      if (!old || !row.held?.includes(String(old.value))) fail('P7', `${k} replaces ${old?.value}, shows held ${row.held}`);
    }
  }
}

/** P7 in the person's unit (the web's): a written row's `shown` number, read back from that unit, is what Save writes, to the place shown. */
function checkShown(k: string, row: ValueRow, bulk: BulkRow, system: UnitSystem) {
  const own = row.shown;
  if (!own) return fail('P7', `${k} has no shown value`);
  if (bulk.kind === 'lab') {
    if (Number(own.number) !== bulk.value || own.unit !== bulk.unit) fail('P7', `${k} shows ${own.number} ${own.unit}, Save writes ${bulk.value} ${bulk.unit}`);
    return;
  }
  const metric = bulk.metricType as MetricType;
  if (own.unit !== cellLabel(metric, system)) fail('P7', `${k} shown in ${own.unit}, the person reads ${cellLabel(metric, system)}`);
  // Within half a step of the last place shown (display rounding), read back in SI.
  const n = Number(own.number);
  const back = cellToSI(metric, n, system);
  const step = 0.5 * 10 ** -((own.number.split('.')[1] ?? '').length);
  if (Math.abs(back - bulk.value) > Math.abs(cellToSI(metric, n + step, system) - back) + 1e-9) fail('P7', `${k} shows ${own.number} ${own.unit} (${back} SI), Save writes ${bulk.value}`);
}

/**
 * B: Save's blockers, from the extraction, the choices and the units table (and, for a kept conflict or a blood pressure
 * pair, the review): a ticked value with no day waits at its source's control (the test's and a dated column's never for
 * a value the write refuses on any day); a row blocks at itself when it holds text, or is ticked, selected and faulty
 * (L4's fault, sent or not). Each names a row or a day control the list draws, once. Save is enabled only with none, and
 * says the first. Mutations that fail it: the test-day blocker keyed at the previous column's control; the column blocker
 * kept for a value refused on any day.
 */
function checkBlockers(s: UploadState, view: UploadView, review: UploadReview, list: UploadList, plan: ReturnType<typeof uploadSavePlan>) {
  const { blockers } = view.save;
  if (s.phase !== 'open' && s.phase !== 'saveFailed') { if (blockers.length) fail('B', `${blockers.length} blockers while ${s.phase}`); return; }
  const days = new Set<string>();
  const fixes = new Set<string>();
  const classified = new Map(review.classification.values.map((v) => [`${review.labFiles[v.file].fileId}:${v.ref}`, v]));
  for (const f of s.files) {
    if (f.status.s !== 'read' || f.status.extraction.classification !== 'lab_report') continue;
    const st = f.status;
    for (const at of offeredValues(st.extraction)) {
      const { ref } = at;
      const ticked = st.choices.ticks[ref] ?? true;
      const v = classified.get(`${f.id}:${ref}`)!;
      const typed = st.choices.typed?.[ref] !== undefined;
      const metric = at.kind === 'core' && Object.prototype.hasOwnProperty.call(UNIT_DEFS, at.value.metric) ? at.value.metric as MetricType : null;
      const pairOrUnknown = at.kind === 'core' && !metric;
      const candidate = st.choices.edits[ref] ?? (at.kind === 'core' ? at.value.valueSI : at.value.value);
      const pair = v.sent && !v.writes && v.group === 'unsure' && v.reasons.includes('outOfRange');
      const fault = (!!metric && (!!rangeFault(cellRange(metric, 'si'), candidate) || pair)) || (pairOrUnknown && pair);
      const kept = v.group === 'unsure' && v.reasons.includes('conflict') && (!!v.copy || !review.labFiles.find((l) => l.fileId === f.id)!.replacing.includes(ref));
      const future = v.group === 'notSaved' && (v.reason === 'futureDay' || v.reason === 'futureCoreDay');
      if (typed || (ticked && fault && !kept && !future)) fixes.add(`${f.id}:${ref}`);
      if (!ticked || expectedDay(st, ref).day !== null) continue;
      // The undated previous column waits for any ticked value (main's rule); the test's and a dated column's never for a
      // value the write refuses whatever its day (it sits under Not saved).
      const src = sourceKey(f.id, st.extraction, ref);
      if (src.endsWith('|previous') || !refusedAnyDay(st, ref)) days.add(src);
    }
  }
  const want = [...fixes, ...days].sort();
  const got = blockers.map((b) => b.at).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) fail('B', `blockers at ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  // A report that writes nothing while it waits for a day holds Save at one of its day controls: never a silent skip.
  for (const lf of review.labFiles) if (lf.needsDay && !got.some((at) => at.startsWith(`${lf.fileId}|`))) fail('B', `${lf.fileId} waits for a day and Save does not`);
  const controls = new Set([...list.rows.map((r) => r.key), ...list.days.map((d) => d.key)]);
  for (const b of blockers) {
    const wantWhy = fixes.has(b.at) ? FIX_ERRORS_TEXT : UPLOAD_TEXT.chooseDay;
    if (b.why !== wantWhy) fail('B', `blocker at ${b.at} says "${b.why}"`);
    if (!controls.has(b.at)) fail('B', `blocker at ${b.at}, which the list does not draw`);
  }
  if (blockers.length && view.save.enabled) fail('B', 'Save enabled with a blocker');
  if (blockers.length && inFlight(s) === 0 && view.save.why !== blockers[0].why) fail('B', `why "${view.save.why}" is not the first blocker`);
  // With none, Save is on, or there is nothing to save (`planIsEmpty`).
  const nothing = plan.counts.values + plan.counts.documents + plan.counts.originals === 0;
  if (!blockers.length && inFlight(s) === 0 && !view.save.enabled && !(view.save.why === UPLOAD_TEXT.saveNothing && nothing)) fail('B', `Save off with no blocker: ${view.save.why}`);
}
