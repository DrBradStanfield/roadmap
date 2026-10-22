// US-52 AC5, AC6, AC8: the engine doors the app's chat and lab upload use,
// run in Node (AppChatLabTests.swift runs them in JavaScriptCore).
import { describe, expect, it } from 'vitest';
import {
  chatContextJson, chatDeleteJson, chatListJson, chatMessagesJson, chatRecordExchangeJson,
  labReviewJson, labSaveSummaryJson, settledJson,
} from './app-doors';
import { applyEdit, newRecord } from './my-data';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { chatContextOf } from '../../packages/health-core/src/chat-context';

const NOW = '2026-10-21T08:00:00.000Z';
const DEVICE = 'ios-test';

function record(...edits: Parameters<typeof applyEdit>[1][]): RoadmapFile {
  return edits.reduce((file, edit) => {
    const out = applyEdit(file, edit, NOW);
    if (!out.ok) throw new Error(out.message);
    return out.file;
  }, newRecord(NOW, DEVICE, 'en-NZ', 'Pacific/Auckland'));
}

/** An async door, then its settled answer, as Swift reads it. */
async function door(call: () => string) {
  expect(call()).toBe('');
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  return JSON.parse(settledJson());
}

describe('US-52 AC5: the chat context', () => {
  it('is the widget\'s payload (chatContextOf) over the plan\'s inputs and the dated rows', () => {
    const file = record(
      { kind: 'profile', sex: 'female', birthYear: 1970, birthMonth: 3, height: 165 },
      { kind: 'add', metric: 'ldl', value: 3.4, day: '2026-01-10' },
      { kind: 'add', metric: 'ldl', value: 2.9, day: '2026-09-10' },
    );
    const context = JSON.parse(chatContextJson(JSON.stringify(file), NOW, DEVICE));
    expect(context.unitSystem).toBe('si');
    expect(context.sex).toBe('female');
    expect(context.ldlC).toBe(2.9);
    expect(context.measurementHistory.ldl).toHaveLength(2);
    // Byte for byte what health-core builds for the same inputs.
    expect(context).toEqual(JSON.parse(JSON.stringify(chatContextOf(
      { ...context, unitSystem: undefined, medications: undefined, screenings: undefined, measurementHistory: undefined }, 'si', [], [],
      file.measurements.filter((m) => m.status === 'active'),
    ))));
  });
});

describe('US-52 AC6: chat history through ChatSession', () => {
  it('records, lists, reads and deletes conversations in the web\'s file', async () => {
    const first = await door(() => chatRecordExchangeJson(null, JSON.stringify({ conversationId: 'c1', isNew: true, userText: 'What is ApoB?', assistantText: 'A particle count.' }), NOW, DEVICE));
    expect(first.ok).toBe(true);
    const file = first.value as string;
    expect(JSON.parse(file).conversations[0]).toMatchObject({ id: 'c1', title: 'What is ApoB?' });

    const second = await door(() => chatRecordExchangeJson(file, JSON.stringify({ conversationId: 'c1', isNew: false, userText: 'And LDL?', assistantText: 'Related.', isFallback: true }), '2026-10-21T08:05:00.000Z', DEVICE));
    const list = await door(() => chatListJson(second.value, NOW, DEVICE));
    expect(list.value).toEqual([expect.objectContaining({ id: 'c1', title: 'What is ApoB?' })]);
    const messages = await door(() => chatMessagesJson(second.value, 'c1', NOW, DEVICE));
    expect(messages.value.map((m: { content: string }) => m.content)).toEqual(['What is ApoB?', 'A particle count.', 'And LDL?', 'Related.']);
    expect(messages.value[3].isFallback).toBe(true);

    const deleted = await door(() => chatDeleteJson(second.value, 'c1', NOW, DEVICE));
    expect((await door(() => chatListJson(deleted.value, NOW, DEVICE))).value).toEqual([]);
    expect(JSON.parse(deleted.value).conversations[0]).toMatchObject({ deleted: true, title: '', messages: [] });
  });
});

const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01',
  values: [
    { metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
    { metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', displaySystem: 'si', confidence: 'medium', recordedAt: '2025-04-02' },
  ],
  additionalValues: [
    { name: 'Ferritin', value: 85, unit: 'µg/L' },
    { name: 'Ferritin', value: 85, unit: 'furlongs' },
  ],
  refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }],
  droppedValueCount: 1,
};

/** The review door on an empty record, as Swift calls it. */
const reviewOf = (x: object, file: RoadmapFile = record(), name = 'Bloods.pdf', hash = '') => labReviewJson(JSON.stringify(x), NOW, JSON.stringify(file), name, hash, DEVICE);

describe('US-52 AC8: the lab review and the write', () => {
  it('shows each value with its own day or the report\'s, and what was not saved', () => {
    const review = JSON.parse(reviewOf(extraction));
    expect(review.document).toBeNull();
    expect(review.isLabReport).toBe(true);
    expect(review.reportDay).toBe('2026-10-01');
    expect(review.items.map((i: { ref: string; day: string | null; check: boolean }) => [i.ref, i.day, i.check])).toEqual([
      ['v0', null, false], ['v1', '2025-04-02', true], ['a0', null, false], ['a1', null, false],
    ]);
    expect(review.items[0]).toMatchObject({ label: 'LDL Cholesterol', value: '3.1', unit: 'mmol/L' });
    expect(review.items[0].question).toBeUndefined();
    // The extractor's own question reaches the review (resolveLabValues: "Was this a blood test?").
    const asked = { ...extraction, values: [{ ...extraction.values[0], metric: 'creatinine', question: 'Was this a blood test?' }] };
    expect(JSON.parse(reviewOf(asked)).items[0].question).toBe('Was this a blood test?');
    expect(review.notSaved).toEqual([{ label: 'Creatinine', reason: 'unit unknown' }]);
    expect(review.unreadCount).toBe(1);
    // A report with no full day asks the user.
    expect(JSON.parse(reviewOf({ ...extraction, reportDate: '2026-10' })).reportDay).toBeNull();
  });

  it('writes only the ticked values through bulkAppendValues, skipping a held day and refusing a bad unit', () => {
    let file = record({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' });
    const refs = ['v0', 'v1', 'a0', 'a1'];
    const summary = JSON.parse(labSaveSummaryJson(JSON.stringify(file), JSON.stringify(extraction), JSON.stringify(refs), '2026-10-01', NOW, DEVICE));
    expect(summary.ok).toBe(true);
    expect(summary.summary.saved).toBe(2); // hba1c, ferritin
    expect(summary.summary.skipped).toBe(1); // LDL's day already held
    expect(summary.summary.refused).toHaveLength(1); // furlongs

    const out = applyEdit(file, { kind: 'labImport', extractionJson: JSON.stringify(extraction), refs, reportDay: '2026-10-01' }, NOW);
    if (!out.ok) throw new Error(out.message);
    file = out.file;
    const hba1c = file.measurements.find((m) => m.metricType === 'hba1c');
    expect(hba1c).toMatchObject({ value: 40, recordedAt: '2025-04-02', source: 'lab_import', status: 'active' });
    expect(file.labValues).toHaveLength(1);
    expect(file.labValues[0]).toMatchObject({ source: 'lab_import', recordedAt: '2026-10-01' });
    expect(file.measurements.filter((m) => m.metricType === 'ldl')).toHaveLength(1); // the typed value stays
  });

  it('refuses a future or missing report day, and a ref not in the report', () => {
    const file = JSON.stringify(record());
    const refuse = (refs: string[], day: string) => JSON.parse(labSaveSummaryJson(file, JSON.stringify(extraction), JSON.stringify(refs), day, NOW, DEVICE));
    expect(refuse(['v0'], '2027-01-01')).toMatchObject({ ok: false, reason: 'invalid-date' });
    expect(refuse(['v0'], '')).toMatchObject({ ok: false, reason: 'invalid-date' });
    expect(refuse(['v9'], '2026-10-01')).toMatchObject({ ok: false, reason: 'not-found' });
    // A value with its own day does not need the report's.
    expect(refuse(['v1'], '')).toMatchObject({ ok: true });
  });
});

const letter = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
  document: {
    classification: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2026-09-14',
    contentMarkdown: `# Letter\n${'x'.repeat(400)}`, metadata: { specialty: 'cardiology' },
  },
};

describe('US-52 AC13d: a clinic letter is offered as the web offers it', () => {
  it('shows the document card: classification, title, a past day, a 300-character preview', () => {
    const review = JSON.parse(reviewOf(letter, record(), 'Letter.pdf'));
    expect(review.isLabReport).toBe(false);
    expect(review.document).toEqual({
      classification: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2026-09-14',
      preview: `${letter.document.contentMarkdown.slice(0, 300)}...`, alreadySaved: false, held: false,
    });
  });

  it('a month alone, a future day or none is an unknown date, as the web reads it', () => {
    for (const documentDate of ['2026-09', '2027-01-01', null]) {
      expect(JSON.parse(reviewOf({ ...letter, document: { ...letter.document, documentDate } })).document.documentDate).toBeNull();
    }
  });

  it('starts unticked when the record already holds a live document from a file of that name (the web\'s dedup)', () => {
    const held = record();
    held.documents.push({
      id: 'd1', title: 'Old', type: 'clinic_letter', date: null, fileRef: '', contentHash: '', mimeType: '',
      extractedText: 'x', addedAt: NOW, metadata: {}, sourceFileName: 'Letter.pdf',
    } as RoadmapFile['documents'][number]);
    expect(JSON.parse(reviewOf(letter, held, 'Letter.pdf')).document.alreadySaved).toBe(true);
    expect(JSON.parse(reviewOf(letter, held, 'Other.pdf')).document.alreadySaved).toBe(false);
    held.documents[0].deleted = true;
    expect(JSON.parse(reviewOf(letter, held, 'Letter.pdf')).document.alreadySaved).toBe(false);
  });

  it('a lab report offers no document card even when the model sent one', () => {
    expect(JSON.parse(reviewOf({ ...extraction, document: letter.document })).document).toBeNull();
  });
});

describe('US-52 AC13d: every stored file name is health-core\'s', () => {
  it('one call names a read: a ZIP member by zipMemberName, any other file on one line and capped', async () => {
    const entry = await import('./entry');
    const { zipMemberName } = await import('../../packages/health-core/src/lab-extraction');
    const long = `${'d'.repeat(260)}/letter.png`;
    const names = JSON.parse(entry.fileNamesJson(JSON.stringify([
      { zip: 'Records.zip', path: 'a/b.png' }, { zip: 'Records.zip', path: long },
      { name: 'Letter\u0007 one\n.pdf' }, { name: `Folder/${'e'.repeat(300)}.pdf` },
    ]))) as string[];
    expect(names[0]).toBe('Records.zip/a/b.png');
    expect(names[1]).toBe(zipMemberName('Records.zip', long));
    expect(names[1]).toBe(`~635451cb/${'d'.repeat(234)}/letter.png`);
    expect(names[2]).toBe('Letter one .pdf');
    expect(names[3]).toHaveLength(255);
  });
});

/** A metadata-only row holding `hash`: a failed save's or the connector's (US-14 AC4). */
function heldRow(over: Partial<RoadmapFile['documents'][number]>): RoadmapFile['documents'][number] {
  return {
    id: crypto.randomUUID(), title: 'Held', type: 'clinic_letter', date: null, fileRef: '', contentHash: 'sha256-aa', mimeType: '',
    extractedText: 'x', addedAt: NOW, metadata: {}, sourceFileName: 'Letter.pdf', ...over,
  } as RoadmapFile['documents'][number];
}

describe('US-52 AC13d / US-14 AC4: a held metadata-only row, as the web\'s card reads it', () => {
  it('a retry after a failed save with edits starts from the newest held row: its title, and its date even when cleared', () => {
    const file = record();
    file.documents.push(
      heldRow({ title: 'Older edit', date: '2026-01-01', addedAt: '2026-10-01T00:00:00.000Z' }),
      heldRow({ title: 'Edited title', date: null, addedAt: '2026-10-02T00:00:00.000Z' }),
    );
    const review = JSON.parse(reviewOf(letter, file, 'Letter.pdf', 'sha256-aa')).document;
    expect(review).toMatchObject({ title: 'Edited title', documentDate: null, held: true, alreadySaved: true });
    // Other bytes: the model's own title and date, nothing held.
    expect(JSON.parse(reviewOf(letter, file, 'Letter.pdf', 'sha256-bb')).document).toMatchObject({ title: 'Cardiology follow-up', documentDate: '2026-09-14', held: false });
  });

  it('a connector\'s held row is held; a lab archive or an archived row is not', () => {
    const file = record();
    file.documents.push(heldRow({ title: 'From the assistant', date: '2026-08-01', metadata: { importedVia: 'connector' } }));
    expect(JSON.parse(reviewOf(letter, file, 'Letter.pdf', 'sha256-aa')).document).toMatchObject({ title: 'From the assistant', documentDate: '2026-08-01', held: true });
    const other = record();
    other.documents.push(heldRow({ type: 'pathology_report', title: 'Blood test results', extractedText: '', metadata: { labArchive: true } }), heldRow({ fileRef: 'Clinic letters/x.pdf', contentHash: 'sha256-cc' }));
    expect(JSON.parse(reviewOf(letter, other, 'Letter.pdf', 'sha256-aa')).document.held).toBe(false);
    expect(JSON.parse(reviewOf(letter, other, 'Letter.pdf', 'sha256-cc')).document.held).toBe(false);
  });
});
