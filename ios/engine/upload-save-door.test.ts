// The shared upload's one Save door (US-52 AC8c, US-14 AC10): uploadSaveJson writes a pick's values and
// its document and lab archive rows in one step, on the phone's record or through the open cloud
// session, and answers what the app's `saved` event carries. Synthetic values, names and bytes only.
import { describe, expect, it } from 'vitest';
import { NO_CHOICES as NO } from '../../packages/health-core/src/upload-choices';
import { uploadSaveJson, uploadStepJson, uploadViewJson } from './entry';
import { FakeDropbox, NOW, phone, recordWith, type Engine } from './cloud.test-helpers';
import { TOO_NEW_RECORD } from './my-data';
import { UPLOAD_LIMITS } from '../../packages/health-core/src/upload-rules';
import { LAB_ARCHIVE_FLAG, listedRows } from '../../packages/health-core/src/document-rows';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const ldl = (v: number) => ({ metric: 'ldl', valueSI: v, displayValue: v, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' });
const lab = (reportDate: string | null, value = 3.1) => ({ classification: 'lab_report', reportDate, values: [ldl(value)], additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L' }], unrecognized: [], document: null });
const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-09-14', contentMarkdown: '# Letter', metadata: {} } };
const read = (id: string, extraction: unknown) => ({ id, name: `${id}.pdf`, bytes: 1, hash: `sha256-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: NO } });
const saving = (files: unknown[]) => JSON.stringify({ phase: 'saving', platform: 'phone', run: 1, started: NOW, firstRead: NOW, attempt: 1, files });
const MIXED = saving([read('lab', lab('2026-10-01')), read('letter', letter), { id: 'bad', name: 'bad.pdf', bytes: 1, hash: null, pages: null, status: { s: 'failed', reason: 'busy', attempt: 1 } }]);
const ORIGINALS = JSON.stringify({ lab: 'application/pdf', letter: 'application/pdf' });
const bytesOf = (id: string) => new Uint8Array(Buffer.from(`%PDF ${id}`, 'utf8')).buffer;
type Answer = { ok: boolean; record: string; erase?: string; outcome: { values: number; documents: number; archived: number; unstored: number }; reason?: string; message?: string };

describe('uploadSaveJson on the phone\'s record (US-52 AC8c)', () => {
  it('writes the values, the letter and the lab report\'s archive row listing its rows, in one step; a repeat adds nothing', async () => {
    const first = JSON.parse(await uploadSaveJson(MIXED, '', '', NOW, 'phone', ORIGINALS, bytesOf)) as Answer;
    expect(first).toMatchObject({ ok: true, outcome: { values: 2, documents: 2, archived: 0, unstored: 0 } });
    const record = JSON.parse(first.record) as RoadmapFile;
    const archive = record.documents.find((d) => d.metadata?.[LAB_ARCHIVE_FLAG] === true)!;
    expect(listedRows(archive)).toHaveLength(2);
    // Off-cloud no original is kept: the rows carry the bytes' hash alone (US-14 AC10).
    expect(record.documents.map((d) => [d.contentHash, d.fileRef])).toEqual(expect.arrayContaining([['sha256-letter', ''], ['sha256-lab', '']]));
    const again = JSON.parse(await uploadSaveJson(MIXED, first.record, '', NOW, 'phone', ORIGINALS, bytesOf)) as Answer;
    expect(again).toMatchObject({ ok: true, outcome: { values: 0, documents: 0, archived: 0 } });
    expect(JSON.parse(again.record)).toEqual(record);
  });

  it('refuses, writing nothing, a report waiting for its day, an out-of-range value, a state not saving, and unreadable input', async () => {
    const refused = async (state: string, originals = ORIGINALS) => JSON.parse(await uploadSaveJson(state, '', '', NOW, 'phone', originals, bytesOf)) as Answer;
    expect(await refused(saving([read('lab', lab(null))]))).toMatchObject({ ok: false, reason: 'not-ready', message: 'Choose the day of the test' });
    expect(await refused(saving([read('lab', lab('2026-10-01', 500))]))).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(await refused(MIXED.replace('"saving"', '"open"').replace(',"attempt":1,"files"', ',"files"'))).toMatchObject({ ok: false, reason: 'not-saving' });
    expect(await refused('{', ORIGINALS)).toMatchObject({ ok: false, reason: 'invalid-state' });
    expect(await refused(MIXED, '[1]')).toMatchObject({ ok: false, reason: 'invalid-originals' });
  });

  it('refuses an unreadable record, and one a newer app wrote in readRecord\'s words (review R7)', async () => {
    const at = async (record: string) => JSON.parse(await uploadSaveJson(MIXED, record, '', NOW, 'phone', ORIGINALS, bytesOf)) as Answer;
    expect(await at('{not json')).toMatchObject({ ok: false, reason: 'invalid-record' });
    expect(await at(JSON.stringify({ schemaVersion: 999 }))).toMatchObject({ ok: false, reason: 'record-too-new', message: TOO_NEW_RECORD });
  });

  it('with an erase but no cloud session open, refuses not-open and writes nothing (review R1)', async () => {
    expect(JSON.parse(await uploadSaveJson(MIXED, '', 'an-erase', NOW, 'phone', ORIGINALS, bytesOf))).toMatchObject({ ok: false, reason: 'not-open' });
  });
});

describe('a refused Save is a retryable saveFailed in the machine (ruling Q1 on PR 1848)', () => {
  it('any refusal (changed, not-open, erased) goes back as saveFailed; Save is offered again and runs as the next attempt', () => {
    const message = 'Your record changed while this was saving, so it was not saved. Try again.';
    const failed = JSON.parse(uploadStepJson(MIXED, JSON.stringify({ type: 'saveFailed', run: 1, attempt: 1, message }), '', 'phone'));
    expect(failed.state.phase).toBe('saveFailed');
    const view = JSON.parse(uploadViewJson(JSON.stringify(failed.state), '', NOW, true, 'phone'));
    expect(view.save).toMatchObject({ enabled: true, error: message });
    const again = JSON.parse(uploadStepJson(JSON.stringify(failed.state), '{"type":"saveStarted"}', '', 'phone'));
    expect(again.effects).toEqual([{ type: 'save', run: 1, attempt: 2 }]);
    expect(again.state).toMatchObject({ phase: 'saving', attempt: 2 });
  });
});

describe('uploadSaveJson through the cloud session (US-52 AC8c, US-14 AC5)', () => {
  async function opened(dropbox = new FakeDropbox()) {
    dropbox.put(await recordWith([], 'web'));
    const { engine, state } = await phone(dropbox);
    const { erase } = JSON.parse(await engine.cloudOpen('dropbox', 'ios-1', false, false)) as { erase: string };
    return { dropbox, engine: engine as Engine & { uploadSaveJson: typeof uploadSaveJson }, state, erase };
  }

  it('stores each original the plan stores, read from Swift by file id, then commits every row through the session; a repeat writes nothing', async () => {
    const { dropbox, engine, state, erase } = await opened();
    const asked: string[] = [];
    const reader = (id: string) => (asked.push(id), bytesOf(id));
    const answer = JSON.parse(await engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, reader)) as Answer;
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 2, archived: 0, unstored: 0 } });
    expect(asked.sort()).toEqual(['lab', 'letter']); // only the files the plan stores; never the failed one
    expect([...dropbox.documents.values()].sort()).toEqual(['%PDF lab', '%PDF letter']);
    expect(state.pending).toBe(true); // on the phone first, marked for the cloud (US-09 AC4)
    expect(await engine.cloudFlush()).toBe('saved');
    const saved = dropbox.record;
    expect(saved.documents.every((d) => d.fileRef !== '')).toBe(true);
    expect(listedRows(saved.documents.find((d) => d.metadata?.[LAB_ARCHIVE_FLAG] === true)!)).toHaveLength(2);
    const again = JSON.parse(await engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, reader)) as Answer;
    expect(again).toMatchObject({ ok: true, outcome: { values: 0, documents: 0, archived: 0 } });
    expect(dropbox.documents.size).toBe(2);
  });

  it('an original Swift cannot read is filed metadata-only with its hash, and the save goes on', async () => {
    const { dropbox, engine, erase } = await opened();
    const answer = JSON.parse(await engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, () => null)) as Answer;
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 2 } });
    expect(dropbox.documents.size).toBe(0);
    expect((JSON.parse(answer.record) as RoadmapFile).documents.map((d) => d.fileRef)).toEqual(['', '']);
  });

  it('a repeat on the saved record commits nothing: no pending marker, no phone write, no cloud put (review R2)', async () => {
    const { dropbox, engine, state, erase } = await opened();
    await engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, bytesOf);
    expect(await engine.cloudFlush()).toBe('saved');
    state.pending = false;
    const phoneText = state.phoneText;
    const uploads = dropbox.uploads;
    const again = JSON.parse(await engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, bytesOf)) as Answer;
    expect(again).toMatchObject({ ok: true, outcome: { values: 0, documents: 0, archived: 0 } });
    expect(state.pending).toBe(false);
    expect(state.phoneText).toBe(phoneText);
    await engine.cloudFlush();
    expect(dropbox.uploads).toBe(uploads);
    expect(dropbox.documents.size).toBe(2);
  });

  /** A Dropbox whose document puts wait until `release`, counting them. */
  function slowOriginals() {
    const dropbox = new FakeDropbox();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let puts = 0;
    const answer = dropbox.answer.bind(dropbox);
    dropbox.answer = (url, headers, body) => {
      const path = (JSON.parse(headers['dropbox-api-arg']) as { path: string }).path;
      if (url.endsWith('/files/upload') && path !== '/health-roadmap.json' && path !== '/chat-history.json') puts += 1;
      return answer(url, headers, body);
    };
    dropbox.delayFor = (url, headers) => (url.endsWith('/files/upload') && !headers['dropbox-api-arg'].includes('health-roadmap') ? 50 : undefined);
    return { dropbox, puts: () => puts, gate, release };
  }

  it('an unrelated edit and a save pass land while the originals upload: the Save succeeds once, keeps the edit, each original put once (review R3)', async () => {
    const slow = slowOriginals();
    const { engine, erase } = await opened(slow.dropbox);
    const saving = engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, bytesOf);
    expect(JSON.parse(engine.cloudEdit(JSON.stringify({ kind: 'add', metric: 'weight', value: 81, day: '2026-10-02' }), erase, 'si', NOW))).toMatchObject({ ok: true });
    await engine.cloudFlush(); // a save pass lands: the session takes a new working copy
    const answer = JSON.parse(await saving) as Answer;
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 2, unstored: 0 } });
    const record = JSON.parse(answer.record) as RoadmapFile;
    expect(record.measurements.filter((m) => m.metricType === 'weight')).toHaveLength(1);
    expect(record.labValues.filter((r) => r.status === 'active')).toHaveLength(2);
    expect(slow.puts()).toBe(2);
  });

  it('a competing value in the same (metric, day) slot during the upload is skipped, and the counts say so (review R3)', async () => {
    const slow = slowOriginals();
    const { engine, erase } = await opened(slow.dropbox);
    const saving = engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, bytesOf);
    expect(JSON.parse(engine.cloudEdit(JSON.stringify({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' }), erase, 'si', NOW))).toMatchObject({ ok: true });
    const answer = JSON.parse(await saving) as Answer;
    expect(answer).toMatchObject({ ok: true, outcome: { values: 1 } });
    const ldl = (JSON.parse(answer.record) as RoadmapFile).labValues.filter((r) => r.metricName === 'ldl' && r.status === 'active');
    expect(ldl).toHaveLength(1);
  });

  it('every planned original that does not land is counted in unstored: a refused put, null, a throw, not bytes, a Promise, over the cap (review R4)', async () => {
    const cap = UPLOAD_LIMITS.phone.fileBytes + 1;
    const readers: Array<[string, (id: string) => unknown, boolean]> = [
      ['refused put', bytesOf, false], ['null', () => null, true], ['throws', () => { throw new Error('gone'); }, true],
      ['text', () => 'not bytes', true], ['promise', async () => bytesOf('x'), true], ['over the cap', () => new ArrayBuffer(cap), true],
    ];
    for (const [name, reader, works] of readers) {
      const dropbox = new FakeDropbox();
      dropbox.documentsWork = works;
      const { engine, erase } = await opened(dropbox);
      const answer = JSON.parse(await engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, reader)) as Answer;
      expect(answer, name).toMatchObject({ ok: true, outcome: { values: 2, documents: 2, unstored: 2 } });
      expect(dropbox.documents.size, name).toBe(0);
    }
  });

  it('originals that did not land reach the done screen: saved carries the count, the done view warns; none, no warning (PR 1848 Codex)', async () => {
    for (const works of [false, true]) {
      const dropbox = new FakeDropbox();
      dropbox.documentsWork = works;
      const { engine, erase } = await opened(dropbox);
      const answer = JSON.parse(await engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, bytesOf)) as Answer;
      const done = JSON.parse(uploadStepJson(MIXED, JSON.stringify({ type: 'saved', run: 1, attempt: 1, outcome: answer.outcome }), '', 'phone'));
      expect(done.state.outcome.unstored, String(works)).toBe(works ? 0 : 2);
      const view = JSON.parse(uploadViewJson(JSON.stringify(done.state), '', NOW, true, 'phone'));
      expect(view.done.unstored, String(works)).toBe(works ? null : "The original file couldn't be stored; its details are saved.");
    }
  });

  it('a file id the originals do not name as their own is never read (`hasOwn`)', async () => {
    const { engine, erase } = await opened();
    const asked: string[] = [];
    const state = MIXED.replace(/"letter"/g, '"constructor"');
    await engine.uploadSaveJson(state, '', erase, NOW, 'ios-1', JSON.stringify({ lab: 'application/pdf' }), (id: string) => (asked.push(id), bytesOf(id)));
    expect(asked).toEqual(['lab']);
  });

  it('a session closed while this Save waited in the queue: refuses not-open, writes nothing (review R1)', async () => {
    const slow = slowOriginals();
    const { engine, erase } = await opened(slow.dropbox);
    const first = engine.uploadSaveJson(MIXED, '', erase, NOW, 'ios-1', ORIGINALS, bytesOf);
    const queued = engine.uploadSaveJson(saving([read('other', letter)]), '', erase, NOW, 'ios-1', JSON.stringify({ other: 'application/pdf' }), bytesOf);
    const closing = engine.cloudClose(false);
    await first;
    expect(JSON.parse(await queued)).toMatchObject({ ok: false, reason: 'not-open' });
    await closing;
    expect([...slow.dropbox.documents.keys()].some((k) => k.includes('other'))).toBe(false);
  });

  it('refuses with no cloud open for the erase given, writing nothing', async () => {
    const { engine } = await opened();
    expect(JSON.parse(await engine.uploadSaveJson(MIXED, '', 'another-erase', NOW, 'ios-1', ORIGINALS, bytesOf))).toMatchObject({ ok: false, reason: 'erased' });
  });
});
