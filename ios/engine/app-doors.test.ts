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

describe('US-52 AC8: the lab review and the write', () => {
  it('shows each value with its own day or the report\'s, and what was not saved', () => {
    const review = JSON.parse(labReviewJson(JSON.stringify(extraction), NOW));
    expect(review.isLabReport).toBe(true);
    expect(review.reportDay).toBe('2026-10-01');
    expect(review.items.map((i: { ref: string; day: string | null; check: boolean }) => [i.ref, i.day, i.check])).toEqual([
      ['v0', null, false], ['v1', '2025-04-02', true], ['a0', null, false], ['a1', null, false],
    ]);
    expect(review.items[0]).toMatchObject({ label: 'LDL Cholesterol', value: '3.1', unit: 'mmol/L' });
    expect(review.items[0].question).toBeUndefined();
    // The extractor's own question reaches the review (resolveLabValues: "Was this a blood test?").
    const asked = { ...extraction, values: [{ ...extraction.values[0], metric: 'creatinine', question: 'Was this a blood test?' }] };
    expect(JSON.parse(labReviewJson(JSON.stringify(asked), NOW)).items[0].question).toBe('Was this a blood test?');
    expect(review.notSaved).toEqual([{ label: 'Creatinine', reason: 'unit unknown' }]);
    expect(review.unreadCount).toBe(1);
    // A report with no full day asks the user.
    expect(JSON.parse(labReviewJson(JSON.stringify({ ...extraction, reportDate: '2026-10' }), NOW)).reportDay).toBeNull();
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
