// US-25 AC2: the parsed-record slot (my-data.ts readRecord; ios/architecture.md D2):
// a call on the record text the last call read or wrote skips the parse and the
// migration. The slot hands every door the SAME object, so no door may write to
// it. Each door runs here against a deep-frozen cached record (a write throws in
// strict mode) and must answer exactly what it answers from a cold read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEdit, newRecord, readRecord, type Edit } from './my-data';
import {
  applyEditJson, chatContextJson, documentSave, healthWritesJson, historyJson, labReviewJson, labSaveSummaryJson,
  mergeJson, planJson, remindersJson, screenJson,
} from './entry';
import { eraseOnPhone } from './erase';
import { ROADMAP_DOC } from '../../packages/health-core/src/roadmap-doc';
import { mergeFiles } from '../../packages/health-core/src/merge';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const NOW = '2026-10-21T08:00:00.000Z';
const LATER = '2026-10-21T09:00:00.000Z';
const DEVICE = 'ios-cache';

// Ids and the document clock, pinned, so a cold and a cached run write the same rows.
let ids = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(LATER));
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Empties the slot: a record with no meta is never kept. */
function forget(): void {
  readRecord(JSON.stringify({ schemaVersion: 1 }), NOW, DEVICE);
}

/** A cold read, as before the slot. */
function cold(text: string, now = NOW, deviceId = DEVICE): RoadmapFile {
  return ROADMAP_DOC.migrate(JSON.parse(text), { deviceId, now });
}

const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01',
  values: [
    { metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
    { metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', displaySystem: 'si', confidence: 'medium', recordedAt: '2025-04-02' },
  ],
  additionalValues: [{ name: 'Ferritin', value: 85, unit: 'µg/L' }],
  refusedValues: [],
  droppedValueCount: 0,
};
const letter = {
  classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [],
  document: { classification: 'clinic_letter', title: 'Cardiology follow-up', documentDate: '2026-09-14', contentMarkdown: '# Letter', metadata: { specialty: 'cardiology' } },
};
const letterChoice = { kind: 'document', sourceFileName: 'Letter.pdf', title: 'Heart clinic', documentDate: '2026-09-14', mimeType: 'application/pdf' };

/** A record with a row in every array a door reads: values, a correction, pressure, drugs, a document, an opt-in. */
function richText(): string {
  let file = newRecord(NOW, DEVICE, 'en-NZ', 'Pacific/Auckland');
  const edits: Edit[] = [
    { kind: 'profile', sex: 'male', birthYear: 1966, birthMonth: 3, height: 178 },
    { kind: 'add', metric: 'weight', value: 82, day: '2026-10-01' },
    { kind: 'add', metric: 'ldl', value: 3.4, day: '2026-09-01' },
    { kind: 'bloodPressure', systolic: 128, diastolic: 82, day: '2026-10-02', replace: false },
    { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 10, doseUnit: 'mg' },
    { kind: 'supplement', supplementKey: 'omega3', supplementName: 'Omega-3', doseValue: 1, doseUnit: 'g', status: 'active' },
    { kind: 'labImport', extractionJson: JSON.stringify(extraction), refs: ['v1', 'a0'], reportDay: '2026-10-01' },
  ];
  for (const edit of edits) {
    const out = applyEdit(file, edit, NOW);
    if (!out.ok) throw new Error(out.message);
    file = out.file;
  }
  const weight = file.measurements.find((row) => row.metricType === 'weight')!;
  const corrected = applyEdit(file, { kind: 'correct', id: weight.id, value: 81 }, NOW);
  if (!corrected.ok) throw new Error(corrected.message);
  return JSON.stringify({
    ...corrected.file,
    documents: [{ id: 'doc-1', documentType: 'clinic_letter', title: 'Old letter', documentDate: '2026-01-01', contentMd: 'x', addedAt: NOW, sourceFileName: 'Old.pdf' }],
    reminderOptIn: { status: 'active', token: 't', email: '', provider: 'ios', updatedAt: NOW, lamport: 1 },
  });
}

/** The door's answer from a cold read, then from the cached record frozen: both the same, nothing written to it. */
async function sameFrozen(text: string, door: () => string | Promise<string>): Promise<string> {
  forget();
  ids = 0;
  const fromCold = await door();
  forget();
  const kept = readRecord(text, NOW, DEVICE);
  expect(readRecord(text, NOW, DEVICE)).toBe(kept);
  deepFreeze(kept);
  ids = 0;
  const fromKept = await door();
  expect(fromKept).toBe(fromCold);
  return fromKept;
}

/** Every door that reads a record, on `text`. */
function readingDoors(text: string): Array<[string, () => string | Promise<string>]> {
  return [
    ['plan', () => planJson(text, NOW, DEVICE)],
    ['plan, US units for LDL', () => planJson(text, NOW, DEVICE, '{"ldl":"conventional"}')],
    ['screen', () => screenJson(text, NOW, DEVICE)],
    ['screen, US units for LDL', () => screenJson(text, NOW, DEVICE, '{"ldl":"conventional"}')],
    ['history weight', () => historyJson(text, 'weight', NOW, DEVICE)],
    ['history blood pressure', () => historyJson(text, 'blood_pressure', NOW, DEVICE)],
    ['healthWrites', () => healthWritesJson(text, NOW, DEVICE)],
    ['reminders', () => remindersJson(text, NOW, DEVICE)],
    ['chat context', () => chatContextJson(text, NOW, DEVICE)],
    ['labReview (a document reads the record)', () => labReviewJson(JSON.stringify(letter), NOW, text, 'Old.pdf', '', DEVICE)],
    ['labSaveSummary', () => labSaveSummaryJson(text, JSON.stringify(extraction), '["v0","v1","a0"]', '2026-10-01', NOW, DEVICE)],
    ['merge with another record', () => mergeJson(text, newRecordText(), NOW, DEVICE)],
    ['erasePhone', async () => JSON.stringify(await eraseOnPhone(text, null, LATER, DEVICE))],
    ['documentSave, phone path', () => documentSave(text, JSON.stringify(letter), JSON.stringify(letterChoice), null, '', LATER, DEVICE)],
  ];
}

function newRecordText(): string {
  return JSON.stringify(newRecord(NOW, 'web', 'en-NZ', 'Pacific/Auckland'));
}

/** Every edit kind the app sends, valid against richText's record. */
function edits(text: string): Array<[string, Edit]> {
  const weight = cold(text).measurements.find((row) => row.metricType === 'weight' && row.status === 'active')!;
  const pressure = cold(text).measurements.filter((row) => row.metricType.endsWith('_bp')).map((row) => row.id);
  return [
    ['profile', { kind: 'profile', birthYear: 1965 }],
    ['profile feet and inches', { kind: 'profile', heightFeet: 5, heightInches: 9 }],
    ['units', { kind: 'units', unitSystem: 'conventional' }],
    ['add', { kind: 'add', metric: 'waist', value: 90, day: '2026-10-20' }],
    ['correct', { kind: 'correct', id: weight.id, value: 80 }],
    ['bloodPressure replace', { kind: 'bloodPressure', systolic: 125, diastolic: 80, day: '2026-10-02', replace: true, seenIds: pressure }],
    ['medication', { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg' }],
    ['supplement stop', { kind: 'supplement', supplementKey: 'omega3', supplementName: 'Omega-3', status: 'stopped' }],
    ['appleHealth', { kind: 'appleHealth', samples: [{ externalId: 'hk-1', metricType: 'weight', value: 80, measuredAt: '2026-10-21T08:30:00+13:00' }] }],
    ['customSupplement', { kind: 'customSupplement', name: 'Creatine' }],
    ['medicationField', { kind: 'medicationField', field: 'statin', value: 'rosuvastatin' }],
    ['screening', { kind: 'screening', key: 'colorectal_method', value: 'fit_annual' }],
    ['labImport', { kind: 'labImport', extractionJson: JSON.stringify(extraction), refs: ['v0', 'v1', 'a0'], reportDay: '2026-10-01' }],
  ];
}

describe('the parsed-record slot never changes an answer (ios/architecture.md D2)', () => {
  const text = richText();

  for (const [name, door] of readingDoors(text)) {
    it(`${name}: the same answer from the frozen cached record`, async () => {
      await sameFrozen(text, door);
    });
  }

  for (const [name, edit] of edits(text)) {
    it(`apply ${name}: the same answer from the frozen cached record, and its output kept as a cold read of it`, async () => {
      const answer = JSON.parse(await sameFrozen(text, () => applyEditJson(text, JSON.stringify(edit), NOW, DEVICE))) as { ok: boolean; record: string };
      expect(answer.ok).toBe(true);
      // Its output is read once, cold, then served from the slot: what a cold read gives.
      const kept = readRecord(answer.record, NOW, DEVICE);
      expect(readRecord(answer.record, NOW, DEVICE)).toBe(kept);
      expect(kept).toStrictEqual(cold(answer.record));
      // And the reading doors answer from it, frozen, as from a cold read of its text.
      deepFreeze(kept);
      const doors = readingDoors(answer.record).slice(0, 8); // the ones that leave the slot alone
      const fromKept = doors.map(([, door]) => door());
      forget();
      expect(doors.map(([, door]) => door())).toEqual(fromKept);
    });
  }

  it('erasePhone and documentSave keep their output as a cold read of it', async () => {
    forget();
    const erased = (await eraseOnPhone(text, null, LATER, DEVICE)).record;
    expect(readRecord(erased, LATER, DEVICE)).toStrictEqual(cold(erased, LATER));
    forget();
    const saved = (JSON.parse(await documentSave(text, JSON.stringify(letter), JSON.stringify(letterChoice), null, '', LATER, DEVICE)) as { record: string }).record;
    const kept = readRecord(saved, LATER, DEVICE);
    expect(kept.documents).toHaveLength(2);
    expect(kept).toStrictEqual(cold(saved, LATER));
  });

  it('merge of a record with itself: one cached object on both sides, the same merge as two cold reads', () => {
    forget();
    deepFreeze(readRecord(text, NOW, DEVICE));
    expect(mergeJson(text, text, NOW, DEVICE)).toBe(JSON.stringify(mergeFiles(cold(text), cold(text), { deviceId: DEVICE, now: NOW })));
  });
});

describe('what the slot serves', () => {
  it('a different text or device is a fresh read, never the kept object', () => {
    const text = richText();
    forget();
    const kept = readRecord(text, NOW, DEVICE);
    expect(readRecord(`${text} `, NOW, DEVICE)).not.toBe(kept);
    readRecord(text, NOW, DEVICE);
    expect(readRecord(text, NOW, 'other-phone')).not.toBe(kept);
    // The device is in the key because a record with no lastDeviceId takes the reader's.
    const { lastDeviceId: _drop, ...meta } = JSON.parse(text).meta as Record<string, unknown>;
    const anonymous = JSON.stringify({ ...JSON.parse(text), meta });
    expect(readRecord(anonymous, NOW, 'a').meta.lastDeviceId).toBe('a');
    expect(readRecord(anonymous, NOW, 'b').meta.lastDeviceId).toBe('b');
  });

  it('a record without both meta stamps is never kept: its migration reads `now`', () => {
    const blank = JSON.stringify({ schemaVersion: 1 });
    const first = readRecord(blank, NOW, DEVICE);
    const second = readRecord(blank, LATER, DEVICE);
    expect(second).not.toBe(first);
    expect(second.meta.createdAt).toBe(LATER);
    const { meta, ...rest } = JSON.parse(richText()) as RoadmapFile;
    for (const broken of [{ ...meta, createdAt: 'yesterday' }, { ...meta, updatedAt: 1760000000000 }, { ...meta, updatedAt: undefined }]) {
      const half = JSON.stringify({ ...rest, meta: broken });
      expect(readRecord(half, LATER, DEVICE)).not.toBe(readRecord(half, LATER, DEVICE));
    }
  });

  it('the condition holds: a record whose two meta stamps start yyyy-mm-ddT migrates the same at any now', () => {
    const { meta, ...rest } = JSON.parse(richText()) as RoadmapFile;
    for (const [createdAt, updatedAt] of [
      ['2026-01-01T00:00:00Z', '2026-10-21T08:00:00.000Z'],
      ['2026-01-01T09:00:00+13:00', '2026-10-21T08:00:00.000+02:00'],
      ['2026-01-01Tjunk', '2026-02-30T00:00:00Z'],
    ]) {
      const raw = JSON.stringify({ ...rest, meta: { ...meta, createdAt, updatedAt } });
      expect(cold(raw, '2020-01-01T00:00:00.000Z')).toStrictEqual(cold(raw, '2030-06-01T00:00:00.000Z'));
      forget();
      expect(readRecord(raw, NOW, DEVICE)).toBe(readRecord(raw, LATER, DEVICE));
    }
  });
});
