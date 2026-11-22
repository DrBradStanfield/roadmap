/**
 * The list-view property's run: one sequence stepped through the machine and Save, every step checked (K4, L3, L6, P2, P3,
 * P5). The harness and the properties' list: upload-view.property.test-helpers.ts.
 */
import { bulkRowTarget } from './bulk-row-target';
import { bulkAppendValues, slotKey, slotOfRow, type BulkRow } from './record-edits';
import { mergeFiles } from './merge';
import type { RoadmapFile } from './roadmap-file';
import { initialUpload, transition, type UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { lostReplaces, uploadReview, type UploadReview } from './upload-review';
import { uploadSave, type UploadSaveIO } from './upload-save';
import { uploadView, type UploadView } from './upload-view';
import type { UploadList } from './upload-list';
import { checkKeysKept, holdsText, keepInputs } from './upload-list.test-helpers';
import { checkSaveBar } from './upload-list-page.test-helpers';
import { uploadListPage, type ListPage } from './upload-list-page';
import type { TypedText } from './upload-choices';
import { UPLOAD_TEXT } from './upload-text';
import { NOW, type Setup, type Step, rowsOf, isActive, key, allRows, written, fail, type Note, fullDayChange, checkDayChange, checkFhir, unitsOf } from './upload-view.property.base.test-helpers';
import { checkText, checkView } from './upload-view.property.view.test-helpers';

/** A cloud that keeps what is written; ids fixed so runs compare. */
function io(cloud: boolean, failWrites: readonly string[] = []): UploadSaveIO<string> {
  let n = 0;
  return cloud
    ? { holds: () => true, original: (id) => `bytes of ${id}`, mimeType: () => 'application/pdf', now: () => NOW, newId: () => `doc-${n++}`,
      write: async (_ref, _bytes, id) => { if (failWrites.includes(id)) throw new Error('The cloud refused it.'); } }
    : { holds: () => false, original: () => null, mimeType: () => '', write: async () => { throw new Error('no cloud'); }, now: () => NOW, newId: () => `doc-${n++}` };
}

/** The state as the engine door steps and views it: a Replace whose target left its slot dropped, its value unticked. */
function doorState(s: UploadState, record: RoadmapFile): UploadState {
  if (!('files' in s) || !s.files.some((f) => f.status.s === 'read' && Object.keys(f.status.choices.replace).length)) return s;
  const lost = lostReplaces(uploadReview(s, record, NOW), s);
  return lost.length ? transition(s, { type: 'replacesLost', lost }).state : s;
}

/** One sequence run step by step; every step checked. */
export class Run {
  s: UploadState;
  record: RoadmapFile;
  last: { view: UploadView; review: UploadReview; list: UploadList; page: ListPage; record: RoadmapFile } | null = null;
  /** Rows the last commit wrote as corrections (Replace). */
  corrections = 0;
  /** The last step's view came after the door dropped a lost Replace. */
  lostReplace = false;
  /** The last commit's facts, for the reach counts: values skipped, originals unstored, originals filed behind a held row. */
  saved = { skipped: 0, unstored: 0, archiveOnly: 0 };
  constructor(readonly setup: Setup, readonly note: Note) { this.record = setup.record; this.s = initialUpload(setup.platform); }

  /** Day changes K1 compared; saving pages K4 checked with a row written now that was never promised. */
  k1 = 0;
  k4 = 0;
  /** Saving pages whose Save words L16 checked. */
  savingWords = 0;
  /** Saves refused for held text (L3). */
  typedRefused = 0;
  /** What the person entered in each row, logged from their own events (L7). */
  inputs = new Map<string, { typed: TypedText | null; edit: number | undefined }>();

  async apply(step: Step): Promise<void> {
    const before = this.last?.view;
    const listBefore = this.last?.list;
    const phaseBefore = this.s.phase;
    const dayChange = step.type === 'event' && step.e.type === 'chose' && fullDayChange(step.e.change) ? step.e : null;
    await this.step(step);
    if (this.s.phase === 'saving') this.checkSaving();
    const open = (phase: UploadState['phase']) => phase === 'open' || phase === 'saveFailed';
    if (dayChange && before && this.last && open(phaseBefore) && open(this.s.phase)) { checkDayChange(before, this.last.view, this.s, dayChange); this.k1++; }
    // L1: a choice never adds, drops or moves a row.
    if (step.type === 'event' && step.e.type === 'chose' && listBefore && this.last && open(phaseBefore) && open(this.s.phase)) checkKeysKept(listBefore, this.last.list, fail);
    // L3: with text held anywhere, Save as the platform runs it refuses, writing nothing.
    if (this.s.phase === 'open' && holdsText(this.s)) {
      // Forced into saving past the machine (which starts no Save while a file is in flight), as a stale tap could be.
      const saving: UploadState = { ...this.s, phase: 'saving', attempt: 1, reviewed: this.last?.view.reviewed };
      const out = await uploadSave(saving, this.record, NOW, this.setup.cloud, io(this.setup.cloud));
      if (out.ok || out.reason !== 'not-ready') fail('L3', `uploadSave with held text answered ${out.ok ? 'ok' : out.reason}`);
      this.typedRefused++;
    }
  }

  /**
   * K4: while saving, the page drawn on the record as it is now shows as saving only what the press promised (`reviewed`),
   * matched by (file, ref). Mutation that fails it: `saves` ignoring `reviewed` (sent and written alone).
   */
  private checkSaving() {
    if (this.s.phase !== 'saving' || !this.s.reviewed) return;
    const promised = new Set(this.s.reviewed.map((v) => key(v.file, v.ref)));
    const review = uploadReview(this.s, this.record, NOW);
    const view = uploadView(this.s, this.record, NOW, review, this.setup.cloud, unitsOf(this.setup));
    // A drawn row the record now lets Save write that the press never promised: where `saves` must read `reviewed`.
    if (allRows(view).some((row) => written(review).has(key(row.fileId, row.ref)) && !promised.has(key(row.fileId, row.ref)))) this.k4++;
    const extra = allRows(view).filter((row) => row.saves && !promised.has(key(row.fileId, row.ref)));
    if (extra.length) fail('K4', `drawn as saving but never promised: ${extra.map((row) => key(row.fileId, row.ref)).join(', ')}`);
    if (allRows(view).some((row) => !row.saves && promised.has(key(row.fileId, row.ref)))) this.note('promisedNoLongerWrites');
    // L16 while saving: the Save button says "Saving...".
    checkSaveBar(this.s, review, view, uploadListPage(this.s, this.record, NOW, review, this.setup.cloud), fail);
    this.savingWords++;
  }

  private async step(step: Step): Promise<void> {
    // The engine door drops a Replace whose target left its slot before each event and in each view (replacesLost).
    if (step.type === 'event') this.s = doorState(this.s, this.record);
    const takesChoices = this.s.phase === 'open' || this.s.phase === 'saveFailed';
    // The engine door fills what the page would write when Save is pressed (ios/engine/upload-doors.ts); the app computes nothing.
    // Save carries the drawn page's `reviewed`, echoed by the app as it was drawn (the view the person tapped).
    if (step.type === 'event' && step.e.type === 'saveStarted') this.s = transition(this.s, { ...step.e, reviewed: this.last?.view.reviewed }).state;
    else if (step.type === 'tap') {
      this.record = this.write(this.record, step.rows, step.merge, step.free);
      this.s = transition(doorState(this.s, this.record), { type: 'saveStarted', reviewed: this.last?.view.reviewed }).state;
    }
    else if (step.type === 'event') this.s = transition(this.s, step.e).state;
    else if (step.type === 'record') this.record = this.write(this.record, step.rows, step.merge);
    else if (step.type === 'delete') this.record = { ...this.record, labValues: this.record.labValues.map((l) => (l.id === step.id ? { ...l, status: 'entered-in-error' as const } : l)), measurements: this.record.measurements.map((m) => (m.id === step.id ? { ...m, status: 'entered-in-error' as const } : m)) };
    else await this.save(step);
    const ch = step.type === 'event' && step.e.type === 'chose' ? step.e : null;
    // The machine takes a choice only open or after a failed Save (upload-flow.ts 'chose'); L7 logs the expected effect then.
    keepInputs(this.s, this.inputs, ch ? { id: ch.id, change: ch.change, taken: takesChoices } : null, fail);
    if (this.s.phase === 'done' || this.s.phase === 'saving') return;
    if (this.s.phase === 'open' || this.s.phase === 'saveFailed') {
      const door = doorState(this.s, this.record);
      this.lostReplace = door !== this.s;
      this.s = door;
    }
    // The door's own step (a lost Replace dropped) is not the person's: L7 checks it too.
    keepInputs(this.s, this.inputs, null, fail);
    const { view, review, list, page } = checkView(this.s, this.record, this.setup, this.note, this.inputs);
    this.last = { view, review, list, page, record: this.record };
  }

  /** Another writer's rows: on this record, or on another device's copy of the record as it was at the start, merged in. */
  private write(record: RoadmapFile, rows: BulkRow[], merge: boolean, free: string | null = null): RoadmapFile {
    if (free) record = { ...record, labValues: record.labValues.map((l) => (l.id === free ? { ...l, status: 'entered-in-error' as const } : l)), measurements: record.measurements.map((m) => (m.id === free ? { ...m, status: 'entered-in-error' as const } : m)) };
    if (!merge) return bulkAppendValues(record, rows, NOW).file;
    const remote = bulkAppendValues({ ...this.setup.record, meta: { ...this.setup.record.meta, lastDeviceId: 'other' } }, rows, NOW).file;
    return mergeFiles(record, remote, { deviceId: 'test', now: NOW });
  }

  private async save(step: Extract<Step, { type: 'save' }>) {
    if (this.s.phase !== 'saving') return;
    const seen = this.last;
    const atSave = step.meanwhile && step.when === 'beforeSave' ? this.write(this.record, step.meanwhile, step.merge, step.free) : this.record;
    const out = await uploadSave(this.s, atSave, NOW, this.setup.cloud, io(this.setup.cloud, this.setup.failWrites));
    // Refused only when the record changed after the review so that Save would refuse (a blood pressure's other half, say):
    // nothing is written, the app sends the refusal as a failed Save, and the next view names the blocker (P4).
    if (!out.ok && (atSave === seen?.record || out.reason !== 'not-ready')) fail('P4', `Save was enabled but uploadSave refused: ${out.message}`);
    if (!out.ok) { this.note('refusedAfterChange'); this.record = atSave; this.s = transition(this.s, { type: 'saveFailed', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, message: out.message }).state; return; }
    // A failed save: the cloud refused the write, so nothing is committed.
    if (!step.ok) { this.s = transition(this.s, { type: 'saveFailed', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, message: 'The cloud refused the write.' }).state; return; }
    const atCommit = step.meanwhile && step.when === 'beforeCommit' ? this.write(atSave, step.meanwhile, step.merge, step.free) : atSave;
    const { file, outcome } = out.commit(atCommit);
    checkFhir(atCommit, file);
    const added = rowsOf(file).filter((row) => !rowsOf(atCommit).some((b) => b.id === row.id) && isActive(row));
    this.corrections = added.filter((row) => row.correctsId).length;
    this.saved = { skipped: (outcome.skippedValues ?? 0) + (outcome.skippedLabValues ?? 0), unstored: outcome.unstored, archiveOnly: outcome.archived };
    if (added.length !== outcome.values) fail('P2', `outcome says ${outcome.values} values, the commit added ${added.length}`);
    const skipped = (outcome.skippedValues ?? 0) + (outcome.skippedLabValues ?? 0);
    if (seen) {
      // P2: what the view showed writable is what the commit added (metric, day, value, correctsId).
      const plan = uploadSavePlan(this.s, seen.record, NOW, seen.review, this.setup.cloud);
      const planned = plan.labRows.flatMap((x) => x.rows);
      // Slot and correction; a core value's number too (a lab's is stored in its catalog unit, or as a core value).
      const slotOf = (row: BulkRow) => slotKey(bulkRowTarget(row).slot, bulkRowTarget(row).metric, row.recordedAt);
      const coreValue = new Map(planned.flatMap((row) => (row.kind === 'measurement' ? [[slotOf(row), row.value] as const] : [])));
      const want = planned.map((row) => `${slotOf(row)}|${row.kind === 'measurement' ? row.value : ''}|${row.correctsId ?? ''}`).sort();
      const got = added.map((row) => `${slotOfRow(row)}|${coreValue.has(slotOfRow(row)) ? row.value : ''}|${row.correctsId ?? ''}`).sort();
      const changed = !!step.meanwhile || seen.record !== this.record;
      if (!changed && (JSON.stringify(want) !== JSON.stringify(got) || skipped)) fail('P2', `view planned ${JSON.stringify(want)}, commit added ${JSON.stringify(got)}, skipped ${skipped}`);
      // Nothing a person reviewed vanishes: each reviewed value not written is counted in the outcome.
      const missing = want.filter((w) => !got.includes(w)).length;
      // Every reviewed value is written, counted as skipped, or named as refused at the commit (a pressure pair turned).
      const refused = outcome.refused?.length ?? 0;
      if (refused) this.note('refusedAtCommit');
      if (changed && missing !== skipped + refused) fail('P2', `record changed: ${missing} reviewed values not written, ${skipped} counted\nwant ${JSON.stringify(want)}\ngot ${JSON.stringify(got)}`);
      // Never more: nothing is written that the page did not show as to be written.
      if (got.some((g) => !want.includes(g))) fail('P2', `written but never shown as to be written\nwant ${JSON.stringify(want)}\ngot ${JSON.stringify(got)}`);
      // P3: the done line says what the label promised, less what it counts as skipped.
      if (outcome.values !== plan.counts.values - skipped - refused) fail('P3', `label promised ${plan.counts.values} values, ${skipped} skipped, done says ${outcome.values}`);
      if (outcome.documents !== plan.counts.documents) fail('P3', `label promised ${plan.counts.documents} documents, done says ${outcome.documents}`);
      // A file with no original (a photo or a scan) plans no archive and no archive-only original; nothing it writes holds an original or a lab archive.
      const noOriginal = new Set(('files' in this.s ? this.s.files : []).filter((f) => f.original === false).map((f) => f.id));
      if ([...plan.labArchives, ...plan.archiveOnly].some((d) => noOriginal.has(d.fileId))) fail('P3', 'an original or archive planned for a file with none');
      // By bytes held only by such files: the same bytes picked from Files too may be archived.
      const pickedFiles = 'files' in this.s ? this.s.files : [];
      const withOriginal = new Set(pickedFiles.filter((f) => !noOriginal.has(f.id)).map((f) => f.hash));
      const noOriginalHashes = new Set(pickedFiles.filter((f) => noOriginal.has(f.id) && !withOriginal.has(f.hash)).map((f) => f.hash));
      const newDocs = file.documents.filter((d) => !atCommit.documents.some((b) => b.id === d.id));
      if (newDocs.some((d) => noOriginalHashes.has(d.contentHash ?? null) && (d.fileRef || d.metadata?.labArchive === true))) fail('P3', 'a file with no original wrote an original or a lab archive row');
      const unstoredPlanned = this.setup.cloud && [...plan.documents, ...plan.labArchives, ...plan.archiveOnly].some((d) => this.setup.failWrites.includes(d.fileId) && !noOriginal.has(d.fileId));
      if (unstoredPlanned !== outcome.unstored > 0) fail('P3', `unstored ${outcome.unstored}, a refused original planned: ${unstoredPlanned}`);
    }
    // P5, L6: a repeat Save on the committed record runs after every Save, held text or not. Where no other writer acted it
    // never refuses and adds nothing. Where one did, it may refuse only as the view would (a pressure half now the wrong way
    // up), and a value the first Save counted as skipped, its slot taken then freed, is one the page did promise.
    const quiet = seen?.record === atSave && atSave === atCommit;
    const again = await uploadSave(this.s, file, NOW, this.setup.cloud, io(this.setup.cloud, this.setup.failWrites));
    if (!again.ok && (quiet || again.reason !== 'not-ready')) fail('L6', `repeat Save refused: ${again.message}`);
    if (again.ok && quiet) {
      const repeat = again.commit(file);
      // An original the cloud refused is tried again (US-14 AC4): its hash-only row may be filed afresh, never a new value or a new file.
      const liveHashes = (f: RoadmapFile) => JSON.stringify([...new Set(f.documents.filter((d) => !d.deleted).map((d) => d.contentHash))].sort());
      const clean = repeat.file === file || (outcome.unstored > 0 && liveHashes(repeat.file) === liveHashes(file) && rowsOf(repeat.file).length === rowsOf(file).length);
      if (!clean || repeat.outcome.values || repeat.outcome.documents) fail('P5', `a repeat Save wrote ${JSON.stringify(repeat.outcome)}`);
      if (repeat.file !== file) this.note('repeatRefilesUnstored');
    }
    this.record = file;
    this.s = transition(this.s, { type: 'saved', run: this.s.run, attempt: (this.s as { attempt: number }).attempt, outcome }).state;
    if (this.s.phase !== 'done') fail('P3', 'saved but not done');
    const doneReview = uploadReview(this.s, file, NOW);
    const done = uploadView(this.s, file, NOW, doneReview, this.setup.cloud);
    checkText(done);
    // L16 once done: close is the done screen's own label.
    checkSaveBar(this.s, doneReview, done, uploadListPage(this.s, file, NOW, doneReview, this.setup.cloud), fail);
    // US-14 AC13: originals kept and nothing else written heads with the kept line alone.
    const keptOnly = outcome.archived > 0 && !outcome.values && !outcome.documents;
    if (done.done?.line !== (keptOnly ? UPLOAD_TEXT.archivedLine(outcome.archived) : UPLOAD_TEXT.savedLine(outcome.values, outcome.documents))) fail('P3', 'done line');
    if (done.done?.archived !== (outcome.archived && !keptOnly ? UPLOAD_TEXT.archivedLine(outcome.archived) : null)) fail('P3', 'done kept line');
    const lines = [...(outcome.skippedValues ? [UPLOAD_TEXT.skippedLine(outcome.skippedValues, false)] : []), ...(outcome.skippedLabValues ? [UPLOAD_TEXT.skippedLine(outcome.skippedLabValues, true)] : [])];
    if (JSON.stringify(done.done?.skipped) !== JSON.stringify(lines)) fail('P3', `done skipped lines ${JSON.stringify(done.done?.skipped)}`);
    if (!!done.done?.unstored !== outcome.unstored > 0) fail('P3', 'unstored line');
    if (!!done.done?.notSaved.length !== !!outcome.refused?.length) fail('P3', `done not-saved lines ${JSON.stringify(done.done?.notSaved)}`);
  }
}
