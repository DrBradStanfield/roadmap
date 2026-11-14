// US-52 AC5, AC6, AC8: the engine doors the app's chat and lab upload use,
// run in Node (AppChatLabTests.swift runs them in JavaScriptCore).
import { describe, expect, it } from 'vitest';
import {
  chatContextJson, chatDeleteJson, chatListJson, chatMessagesJson, chatRecordExchangeJson,
  labReviewJson, labSaveSummaryJson, settledJson,
} from './app-doors';
import { labReviewGroupsJson } from './entry';
import { applyEdit, newRecord } from './my-data';
import { erasePhoneJson } from './erase';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { chatContextOf } from '../../packages/health-core/src/chat-context';
import { currentValueRows } from '../../packages/health-core/src/blood-tests';
import { labUnitRefusalLine } from '../../packages/health-core/src/lab-series';

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
      currentValueRows(file),
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

  // US-12 AC19 (break-it pass 2026-11-01): unread rows said only "2 values could not be
  // read"; now each is named, with why. A limit is saved since AC20 (lab-limits.test.ts).
  it('US-12 AC19: names each value the server could not read under "Not saved", one line per reason, and counts only the unnamed', () => {
    const unread = { ...extraction, droppedValueCount: 5, unreadValues: [
      { name: 'hdl', reason: 'unreadable' }, { name: 'lpa', reason: 'unreadable' }, { name: 'vitamin_d', reason: 'unreadable' }, { name: 'hdl', reason: 'unreadable' },
    ] };
    const review = JSON.parse(reviewOf(unread));
    expect(review.notSaved).toEqual([
      { label: 'Creatinine', reason: 'unit unknown' },
      { label: 'HDL Cholesterol, Lp(a), Vitamin D (25-OH)', reason: 'could not be read' },
    ]);
    expect(review.unreadCount).toBe(1);
  });

  // Review R1: two lines with one label had one SwiftUI id (LabReviewView keys rows).
  it('US-12 AC19: lists each label once: one test read twice, and a refused and an unread creatinine', () => {
    const both = { ...extraction, droppedValueCount: 3, unreadValues: [
      { name: 'hdl', reason: 'unreadable' }, { name: 'hdl', reason: 'unreadable' }, { name: 'creatinine', reason: 'unreadable' },
    ] };
    const { notSaved, unreadCount } = JSON.parse(reviewOf(both));
    expect(notSaved).toEqual([
      { label: 'Creatinine', reason: 'unit unknown; could not be read' },
      { label: 'HDL Cholesterol', reason: 'could not be read' },
    ]);
    expect(unreadCount).toBe(0);
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
    // A core value is a core lab row (US-66 AC1, AC6); the extra one stays a plain lab row (AC8).
    const core = (metric: string) => file.labValues.filter((l) => l.core === true && l.metricName === metric);
    expect(core('hba1c')).toEqual([expect.objectContaining({ value: 40, unit: 'mmol/mol', recordedAt: '2025-04-02', source: 'lab_import', status: 'active' })]);
    const extras = file.labValues.filter((l) => l.core !== true);
    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({ source: 'lab_import', recordedAt: '2026-10-01' });
    expect(core('ldl')).toHaveLength(1); // the typed value stays
    expect(file.measurements).toEqual([]);
  });

  // US-21 AC26 (Brad 2026-11-09): an uploaded value past its plausible range is refused like a typed
  // one; the review names it as not saved, with the end it passed, and the save writes the rest.
  it('US-21 AC26: refuses a value past its plausible range, naming its bound, and saves the rest', () => {
    const slip = { ...extraction, additionalValues: [{ name: 'Glucose', value: 3000, unit: 'mg/dL' }, { name: 'Ferritin', value: 85, unit: 'µg/L' }] };
    const file = record();
    const summary = JSON.parse(labSaveSummaryJson(JSON.stringify(file), JSON.stringify(slip), JSON.stringify(['a0', 'a1']), '2026-10-01', NOW, DEVICE));
    expect(summary.summary.saved).toBe(1);
    // The web's upload line, shown whole: LabReviewView prints `line` as it is, with no "Not saved," before it.
    expect(summary.summary.refused).toEqual([{
      label: 'Glucose', message: 'a value above 150 mmol/L is almost certainly a misread number or unit, so it was not saved. Check the report.',
      line: 'Glucose: a value above 150 mmol/L is almost certainly a misread number or unit, so it was not saved. Check the report.',
    }]);
    const out = applyEdit(file, { kind: 'labImport', extractionJson: JSON.stringify(slip), refs: ['a0', 'a1'], reportDay: '2026-10-01' }, NOW);
    if (!out.ok) throw new Error(out.message);
    expect(out.file.labValues.map((l) => l.metricName)).toEqual(['Ferritin']);
  });

  // US-52 AC8 (H400): a refused unit printed the raw key and the assistant's refusal
  // ("immature_granulocytes: ..."). Since US-21 AC28 a % is stored, so this uses mg/L.
  it('US-52 AC8: a refused unit reads as the web\'s line, never the raw key or the assistant\'s words', () => {
    const percent = { ...extraction, additionalValues: [
      // A unit neither test takes (a differential in % is stored since US-21 AC28).
      { name: 'rdw_sd', value: 42, unit: 'mg/L' }, { name: 'immature_granulocytes', value: 0.4, unit: 'mg/L' },
    ] };
    const summary = JSON.parse(labSaveSummaryJson(JSON.stringify(record()), JSON.stringify(percent), JSON.stringify(['a0', 'a1']), '2026-10-01', NOW, DEVICE));
    const refused = summary.summary.refused as Array<{ label: string; message: string; line?: string }>;
    expect(refused.map((r) => r.label)).toEqual(['RDW-SD', 'Immature granulocytes']);
    expect(refused.map((r) => r.line)).toEqual([
      labUnitRefusalLine('rdw_sd', 'mg/L'), labUnitRefusalLine('immature_granulocytes', 'mg/L'),
    ]);
    for (const r of refused) {
      const shown = r.line ?? `Not saved, ${r.label}: ${r.message}`; // LabReportSave.line
      expect(shown).not.toContain('_');
      expect(shown).not.toContain('Do not');
    }
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

/** The groups door as Swift calls it: the record, the ticks and the test day it holds now. */
const groupsOf = (x: object, refs: string[], file: RoadmapFile = record(), day = '2026-10-01') =>
  JSON.parse(labReviewGroupsJson(JSON.stringify(file), JSON.stringify(x), JSON.stringify(refs), day, NOW, DEVICE));
const ldlHigh = { metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' };
const lab = (values: object[], additionalValues: object[] = [], more: object = {}) => ({ classification: 'lab_report', reportDate: '2026-10-01', values, additionalValues, ...more });

describe('US-13 AC13 / US-52 AC8: the review leads with a summary and rows only for unsure values (D3)', () => {
  it('zero unsure: a summary, "N values will be saved" behind Show all, and Save sends every ticked value', () => {
    const g = groupsOf(lab([ldlHigh], [{ name: 'Ferritin', value: 85, unit: 'µg/L' }]), ['v0', 'a0']);
    expect(g.summary).toBe('Found 2 blood test values');
    expect(g.items).toEqual([{ ref: 'v0', group: 'sure' }, { ref: 'a0', group: 'sure' }]);
    expect(g.check).toBeNull();
    expect(g.sure).toEqual({ willSave: '2 values will be saved', showAll: 'Show all 2', hide: 'Hide' });
    expect(g.alreadySaved).toBeNull();
    expect(g.notSaved).toBeNull();
    expect(g).toMatchObject({ saveRefs: ['v0', 'a0'], save: 'Save 2 values' });
  });

  it('a hidden sure value keeps its tick and is saved; unticked after Show all, it is not', () => {
    const x = lab([ldlHigh], [{ name: 'Ferritin', value: 85, unit: 'µg/L' }]);
    expect(groupsOf(x, ['v0', 'a0']).saveRefs).toContain('a0');
    const unticked = groupsOf(x, ['v0']);
    expect(unticked).toMatchObject({ saveRefs: ['v0'], save: 'Save 1 value', sure: { willSave: '1 value will be saved', showAll: 'Show all 2' } });
  });

  it('only unsure: the rows, no Show all, singular words', () => {
    const g = groupsOf(lab([{ ...ldlHigh, confidence: 'medium' }]), ['v0']);
    expect(g.items).toEqual([{ ref: 'v0', group: 'unsure', reasons: ['confidence'] }]);
    expect(g.check).toEqual({ title: 'Check this value', footer: 'We were not sure about these. Check each against the report.' });
    expect(g.sure).toBeNull();
    expect(g).toMatchObject({ saveRefs: ['v0'], save: 'Save 1 value' });
  });

  // US-21 AC28: the iPhone review's own door saves a white-cell % as its share, beside the count.
  it('US-21 AC28: neutrophils and immature granulocytes in % are saved, none refused', () => {
    const x = lab([], [{ name: 'neutrophils', value: 60, unit: '%' }, { name: 'immature_granulocytes', value: 0.4, unit: '%' }, { name: 'neutrophils', value: 3.1, unit: '×10⁹/L' }]);
    const g = groupsOf(x, ['a0', 'a1', 'a2']);
    expect(g.saveRefs).toEqual(['a0', 'a1', 'a2']);
    expect(g.notSaved).toBeNull();
    const out = applyEdit(record(), { kind: 'labImport', extractionJson: JSON.stringify(x), refs: ['a0', 'a1', 'a2'], reportDay: '2026-10-01' }, NOW);
    if (!out.ok) throw new Error(out.message);
    expect(out.file.labValues.filter((l) => !l.core).map((l) => [l.metricName, l.unit]).sort()).toEqual([
      ['immature_granulocytes_pct', '%'], ['neutrophils', '×10⁹/L'], ['neutrophils_pct', '%'],
    ]);
  });

  it('nothing to save: the summary and the not-saved line in the person\'s words, no key and no assistant text', () => {
    // A unit the test does not take (a % is stored since US-21 AC28, so mg/L stands in).
    const x = lab([], [{ name: 'Ferritin', value: 85, unit: 'furlongs' }, { name: 'immature_granulocytes', value: 0.4, unit: 'mg/L' }],
      { refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }], droppedValueCount: 1 });
    const g = groupsOf(x, ['a0', 'a1']);
    expect(g.summary).toBe('Found 2 blood test values');
    expect(g.saveRefs).toEqual([]);
    expect(g.save).toBeNull(); // no Save offered
    // Every value unticked where one could save: Save stays, with no value to send.
    expect(groupsOf(lab([ldlHigh]), [])).toMatchObject({ saveRefs: [], save: 'Save 0 values' });
    expect(g.notSaved).toEqual({
      title: '4 values not saved',
      lines: ['Ferritin, Immature granulocytes: this unit is not one we know for this test', 'Creatinine: no unit was printed', '1 other value could not be read'],
      footer: 'To add one, use + Add a blood test after saving.',
    });
    for (const line of g.notSaved.lines) {
      expect(line).not.toContain('_');
      expect(line).not.toContain('Do not');
    }
    // The save's own dry run refuses the same values: nothing Save sends is refused.
    const dry = JSON.parse(labSaveSummaryJson(JSON.stringify(record()), JSON.stringify(x), JSON.stringify(['a0', 'a1']), '2026-10-01', NOW, DEVICE));
    expect(dry.summary.refused).toHaveLength(2);
  });

  it('already saved: one count line, not a row and not sent; a different value is a row that is never written (Q2a)', () => {
    const same = groupsOf(lab([ldlHigh]), ['v0'], record({ kind: 'add', metric: 'ldl', value: 3.1, day: '2026-10-01' }));
    expect(same).toMatchObject({ items: [{ ref: 'v0', group: 'saved' }], alreadySaved: '1 already in your record', check: null, sure: null, saveRefs: [], save: null });
    const other = groupsOf(lab([ldlHigh]), ['v0'], record({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' }));
    expect(other.items).toEqual([{ ref: 'v0', group: 'unsure', reasons: ['conflict'], conflict: 'Your record already has a different value for this day. It stays as it is.' }]);
    expect(other.saveRefs).toEqual([]);
    // Another day frees the slot: the groups follow the test day the screen holds.
    expect(groupsOf(lab([ldlHigh]), ['v0'], record({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' }), '2026-09-30').saveRefs).toEqual(['v0']);
  });

  it('a refused test, an unread one and unnamed drops read as the person\'s lines, labels never keys (LabSaveAllTests\' notes)', () => {
    const x = lab([ldlHigh], [], { refusedValues: [{ metric: 'widget_marker', value: 9, unit: '', reason: 'Unit not recognised.' }],
      unreadValues: [{ name: 'gadget_marker', reason: 'unreadable' }], droppedValueCount: 3 });
    expect(groupsOf(x, ['v0']).notSaved.lines).toEqual(['Widget Marker: no unit was printed', 'Gadget Marker: could not be read', '2 other values could not be read']);
    const slip = lab([], [{ name: 'Glucose', value: 3000, unit: 'mg/dL' }, { name: 'Ferritin', value: 85, unit: 'µg/L' }]);
    expect(groupsOf(slip, ['a0', 'a1'])).toMatchObject({ saveRefs: ['a1'], notSaved: { lines: ['Glucose: the number looks misread. Check the report'] } });
  });

  it('a value with no day yet waits behind the date question: never "will be saved", never sent, Save still offered', () => {
    const g = groupsOf({ ...lab([ldlHigh]), reportDate: null }, ['v0'], record(), '');
    expect(g).toMatchObject({ items: [{ ref: 'v0', group: 'waiting' }], sure: null, check: null, saveRefs: [], save: 'Save 0 values' });
    expect(groupsOf({ ...lab([ldlHigh]), reportDate: null }, ['v0'], record(), '2026-10-01')).toMatchObject({ saveRefs: ['v0'] });
  });

  it('a core value outside its range shows the save\'s own refusal on its row, and the receipt still names it (US-52 AC8)', () => {
    const x = lab([{ ...ldlHigh, valueSI: 500, displayValue: 500 }], [{ name: 'Ferritin', value: 85, unit: 'µg/L' }]);
    const g = groupsOf(x, ['v0', 'a0']);
    const dry = JSON.parse(labSaveSummaryJson(JSON.stringify(record()), JSON.stringify(x), JSON.stringify(['v0', 'a0']), '2026-10-01', NOW, DEVICE));
    expect(dry.summary.saved).toBe(1);
    expect(dry.summary.refused).toHaveLength(1);
    const [r] = dry.summary.refused;
    expect(g.items[0]).toMatchObject({ ref: 'v0', group: 'unsure', refusal: r.line ?? `Not saved, ${r.label}: ${r.message}` });
    expect(g.items[0].refusal).toContain('LDL');
    expect(g.saveRefs).toEqual(['a0']);
    // Alone, the row still says why; no extraction rows are omitted.
    expect(groupsOf(lab([{ ...ldlHigh, valueSI: 500, displayValue: 500 }]), ['v0'])).toMatchObject({ saveRefs: [], omitted: [], items: [{ refusal: g.items[0].refusal }] });
  });

  it('omitted names only the extraction\'s own refused and unread rows, for save all\'s notes', () => {
    const x = lab([], [{ name: 'Ferritin', value: 85, unit: 'furlongs' }], { refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit unknown' }], droppedValueCount: 1 });
    expect(groupsOf(x, ['a0']).omitted).toEqual(['Creatinine: no unit was printed', '1 other value could not be read']);
  });

  // Codex re-check of PR 1824: the receipt dry-ran the ticked rows in their own order, where
  // 140/110 passed, while the write ranked the current 100 first and refused 100/110.
  describe('the receipt is the write\'s own answer: its saved count is what the writer wrote', () => {
    const bp = (metric: string, v: number, own?: string) => ({ metric, valueSI: v, displayValue: v, displayUnit: 'mmHg', displaySystem: 'si', confidence: 'high', ...(own ? { recordedAt: own } : null) });
    const cases: Array<[string, object, string[], RoadmapFile, number]> = [
      ['a previous systolic, an inverted current pair and LDL, the day moved to the previous one',
        lab([bp('systolic_bp', 140, '2026-09-01'), bp('systolic_bp', 100), bp('diastolic_bp', 110), ldlHigh]), ['v0', 'v1', 'v2', 'v3'], record(), 1],
      ['LDL out of range beside Ferritin', lab([{ ...ldlHigh, valueSI: 500, displayValue: 500 }], [{ name: 'Ferritin', value: 85, unit: 'µg/L' }]), ['v0', 'a0'], record(), 1],
      ['only a value the record holds differently', lab([ldlHigh]), ['v0'], record({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-09-01' }), 0],
      ['every value already saved', lab([ldlHigh]), ['v0'], record({ kind: 'add', metric: 'ldl', value: 3.1, day: '2026-09-01' }), 0],
    ];
    for (const [name, x, refs, file, written] of cases) {
      it(name, () => {
        const json = JSON.stringify(x);
        const summary = JSON.parse(labSaveSummaryJson(JSON.stringify(file), json, JSON.stringify(refs), '2026-09-01', NOW, DEVICE)).summary;
        const out = applyEdit(file, { kind: 'labImport', extractionJson: json, refs, reportDay: '2026-09-01' }, NOW);
        if (!out.ok) throw new Error(out.message);
        const wrote = [...out.file.measurements, ...out.file.labValues].filter((r) => r.source === 'lab_import').length;
        expect(wrote).toBe(written);
        expect(summary.saved).toBe(wrote);
        expect(summary.saved + summary.skipped + summary.refused.length).toBe(refs.length);
      });
    }
  });

  it('a letter\'s review leads with the shared summary line (Codex R2)', () => {
    expect(groupsOf(letter, [], record(), '').summary).toBe('Found 1 clinic letter');
  });

  it('what Save sends is what the save writes: the dry run saves every sent ref and refuses or skips none', () => {
    const file = record({ kind: 'add', metric: 'ldl', value: 2.5, day: '2026-10-01' });
    const g = groupsOf(extraction, ['v0', 'v1', 'a0', 'a1'], file);
    expect(g.saveRefs).toEqual(['a0', 'v1']); // send order: the report's own day before a value's printed one (readingRank)
    const dry = JSON.parse(labSaveSummaryJson(JSON.stringify(file), JSON.stringify(extraction), JSON.stringify(g.saveRefs), '2026-10-01', NOW, DEVICE));
    expect(dry.summary).toEqual({ saved: 2, skipped: 0, refused: [] });
    // AppChatLabTests' plan: the report's own day first, then the value's printed day.
    expect(groupsOf(extraction, ['v0', 'v1', 'a0', 'a1']).saveRefs).toEqual(['v0', 'a0', 'v1']);
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

describe('US-25 AC6b: a settled door marks words meant for the person (review R8)', () => {
  it('a Refusal settles as refused; any other failure does not', async () => {
    expect(await door(() => erasePhoneJson('[]', null, NOW, DEVICE)))
      .toEqual({ ok: false, message: 'This file is not a health record.', refused: true });
    expect(await door(() => erasePhoneJson('{"hello":1}', null, NOW, DEVICE))).toMatchObject({ ok: false, refused: false });
  });
});
