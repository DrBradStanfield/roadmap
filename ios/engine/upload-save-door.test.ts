// The shared upload's one Save door (US-52 AC8c, US-14 AC10): uploadSaveJson writes a pick's values and
// its document and lab archive rows in one step, on the phone's record or through the open cloud
// session, and answers what the app's `saved` event carries. Synthetic values, names and bytes only.
import { describe, expect, it } from 'vitest';
import { uploadSaveJson, uploadStepJson, uploadViewJson } from './entry';
import { FakeDropbox, NOW, phone, recordWith, type Engine } from './cloud.test-helpers';
import { LAB_ARCHIVE_FLAG, listedRows } from '../../packages/health-core/src/document-rows';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NO = { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} };
const ldl = (v: number) => ({ metric: 'ldl', valueSI: v, displayValue: v, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' });
const lab = (reportDate: string | null, value = 3.1) => ({ classification: 'lab_report', reportDate, values: [ldl(value)], additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L' }], unrecognized: [], document: null });
const letter = { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-09-14', contentMarkdown: '# Letter', metadata: {} } };
const read = (id: string, extraction: unknown) => ({ id, name: `${id}.pdf`, bytes: 1, hash: `sha256-${id}`, pages: { count: 1, truncated: false }, status: { s: 'read', extraction, choices: NO } });
const saving = (files: unknown[]) => JSON.stringify({ phase: 'saving', platform: 'phone', run: 1, started: NOW, firstRead: NOW, attempt: 1, files });
const MIXED = saving([read('lab', lab('2026-10-01')), read('letter', letter), { id: 'bad', name: 'bad.pdf', bytes: 1, hash: null, pages: null, status: { s: 'failed', reason: 'busy', attempt: 1 } }]);
const ORIGINALS = JSON.stringify({ lab: 'application/pdf', letter: 'application/pdf' });
const bytesOf = (id: string) => new Uint8Array(Buffer.from(`%PDF ${id}`, 'utf8')).buffer;
type Answer = { ok: boolean; record: string; erase?: string; outcome: { values: number; documents: number; archived: number }; unstored: number; reason?: string; message?: string };

describe('uploadSaveJson on the phone\'s record (US-52 AC8c)', () => {
  it('writes the values, the letter and the lab report\'s archive row listing its rows, in one step; a repeat adds nothing', async () => {
    const first = JSON.parse(await uploadSaveJson(MIXED, '', '', NOW, 'phone', ORIGINALS, bytesOf)) as Answer;
    expect(first).toMatchObject({ ok: true, outcome: { values: 2, documents: 1, archived: 0 }, unstored: 0 });
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
  async function opened() {
    const dropbox = new FakeDropbox();
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
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 1, archived: 0 }, unstored: 0 });
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
    expect(answer).toMatchObject({ ok: true, outcome: { values: 2, documents: 1 } });
    expect(dropbox.documents.size).toBe(0);
    expect((JSON.parse(answer.record) as RoadmapFile).documents.map((d) => d.fileRef)).toEqual(['', '']);
  });

  it('refuses with no cloud open for the erase given, writing nothing', async () => {
    const { engine } = await opened();
    expect(JSON.parse(await engine.uploadSaveJson(MIXED, '', 'another-erase', NOW, 'ios-1', ORIGINALS, bytesOf))).toMatchObject({ ok: false, reason: 'erased' });
  });
});
