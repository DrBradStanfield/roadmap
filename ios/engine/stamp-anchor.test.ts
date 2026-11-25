// Lead TA-2: no write the iPhone engine makes saves a last-write-wins stamp
// later than the saved record's own `meta.updatedAt` (migrate.ts clamps one, and
// it can then lose a tie, US-10 AC8). Every Edit kind runs through the door
// Swift calls for the phone's own file (applyEditJson), with the phone's clock
// an hour ahead of the record and an hour behind it; so do the phone's erase
// (eraseOnPhone, which erasePhoneJson settles), the merge door and a new record.
// The record text the door answers, the bytes Swift writes, is walked raw
// (stamp-anchor.test-helpers.ts). The cloud doors (cloudEdit, cloudFlush,
// cloudErase) are in cloud.test.ts. Test-only, synthetic records.
import { describe, expect, it } from 'vitest';
import { parseProposedEdit } from '../../packages/health-core/src/chat-edits';
import { labSlotKey } from '../../packages/health-core/src/lab-catalog';
import { stampCount, stampedRecord, stampsAheadOfMeta } from '../../packages/health-core/src/stamp-anchor.test-helpers';
import type { Edit } from './contract';
import { applyEditJson, mergeJson, newRecordJson } from './entry';
import { eraseOnPhone } from './erase';

const T0 = '2026-09-01T09:00:00.000Z';
const CLOCKS = { ahead: '2026-09-01T10:00:00.000Z', behind: '2026-09-01T08:00:00.000Z' } as const;
const NEW_DAY = '2026-08-25';
const TODAY = '2026-09-01';
const DEVICE = 'ios-1';

function expectNoStampAhead(written: unknown): void {
  expect(stampCount(written)).toBeGreaterThan(0);
  expect(stampsAheadOfMeta(written)).toEqual([]);
}

/** One edit through the phone file's door: the record text it answers, or a throw with its refusal. */
function edited(recordText: string, edit: Edit, now: string): string {
  const outcome = JSON.parse(applyEditJson(recordText, JSON.stringify(edit), now, DEVICE)) as { ok: boolean; record?: string; message?: string };
  if (!outcome.ok || !outcome.record) throw new Error(`refused: ${outcome.message}`);
  return outcome.record;
}

const extraction = {
  classification: 'lab_report', reportDate: NEW_DAY,
  values: [{ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', displaySystem: 'si', confidence: 'high' }],
  additionalValues: [{ name: 'Ferritin', value: 85, unit: 'µg/L' }],
};

/**
 * Every Edit kind, each as the app sends it; typed by kind, so a new kind fails
 * the engine typecheck until it is listed. `before`: an edit run first, to give
 * the edit something to act on.
 */
const EDITS: Record<Edit['kind'], Array<{ edit: Edit; before?: Edit }>> = {
  profile: [{ edit: { kind: 'profile', height: 181 } }],
  bloodPressure: [{ edit: { kind: 'bloodPressure', systolic: 120, diastolic: 80, day: NEW_DAY } }],
  units: [{ edit: { kind: 'units', unitSystem: 'conventional' } }],
  alcohol: [{ edit: { kind: 'alcohol', alcohol: 'none' } }],
  lpaUnit: [{ edit: { kind: 'lpaUnit', unit: 'mg/dL' } }],
  add: [{ edit: { kind: 'add', metric: 'weight', value: 80, day: NEW_DAY } }],
  correct: [{ edit: { kind: 'correct', id: 'w1', value: 81 } }],
  medication: [{ edit: { kind: 'medication', medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' } }],
  supplement: [{ edit: { kind: 'supplement', supplementKey: 'vitamin_d', supplementName: 'Vitamin D', doseValue: 2000, doseUnit: 'IU', status: 'active' } }],
  appleHealth: [{ edit: { kind: 'appleHealth', samples: [{ externalId: 'hk-1', metricType: 'weight', value: 80, measuredAt: `${NEW_DAY}T08:30:00+12:00` }] } }],
  healthRecords: [{ edit: { kind: 'healthRecords', records: [{ sourceId: 'src', resourceType: 'Observation', fhirVersion: '4.0.1', json: JSON.stringify({
    resourceType: 'Observation', id: 'hdl-1', status: 'final', effectiveDateTime: NEW_DAY, meta: { versionId: '1' },
    code: { coding: [{ system: 'http://loinc.org', code: '2085-9' }] },
    valueQuantity: { value: 1.3, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' },
  }) }] } }],
  labImport: [{ edit: { kind: 'labImport', extractionJson: JSON.stringify(extraction), refs: ['v0', 'a0'], reportDay: NEW_DAY } }],
  labAdd: [{
    before: { kind: 'labAddName', name: 'Ferritin', value: 85, unit: 'ug/L', day: '2026-08-01' },
    edit: { kind: 'labAdd', series: labSlotKey('Ferritin'), value: 90, day: NEW_DAY },
  }],
  labAddName: [{ edit: { kind: 'labAddName', name: 'TSH', value: 2.1, unit: 'mIU/L', day: NEW_DAY } }],
  medicationField: [{ edit: { kind: 'medicationField', field: 'statin', value: 'rosuvastatin' } }],
  screening: [{ edit: { kind: 'screening', key: 'colorectal_last_date', value: '2025-03' } }],
  customSupplement: [{ edit: { kind: 'customSupplement', name: 'Taurine' } }],
  chatEdits: [
    { edit: { kind: 'chatEdits', part: 'review', today: TODAY, edits: [parseProposedEdit('propose_field_edit', { field: 'ldlC', value: 3.1, unit: 'mmol/L', date: NEW_DAY })] } },
    { edit: { kind: 'chatEdits', part: 'medications', today: TODAY, edits: [parseProposedEdit('propose_medication_edit', { medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' })] } },
  ],
  chatUndo: [{ edit: { kind: 'chatUndo', medications: [{ medicationKey: 'statin', drugName: 'rosuvastatin', doseValue: 10, doseUnit: 'mg' }] } }],
};

const CASES = Object.values(EDITS).flat().map((c) => [`${c.edit.kind}${c.edit.kind === 'chatEdits' ? ` (${c.edit.part})` : ''}`, c] as const);

describe('TA-2: every engine edit door write stamps nothing past meta.updatedAt', () => {
  for (const [clock, now] of Object.entries(CLOCKS)) {
    it.each(CASES)(`%s, phone clock ${clock} of the record`, (_name, { edit, before }) => {
      let record = JSON.stringify(stampedRecord(T0));
      if (before) record = edited(record, before, now);
      const written = edited(record, edit, now);
      expect(written).not.toBe(record); // it wrote
      expectNoStampAhead(JSON.parse(written));
    });
  }
});

describe('TA-2: the phone erase, the merge door and a new record', () => {
  for (const [clock, now] of Object.entries(CLOCKS)) {
    it(`eraseOnPhone (erasePhoneJson), phone clock ${clock} of the record`, async () => {
      const { record } = await eraseOnPhone(JSON.stringify(stampedRecord(T0)), null, now, DEVICE);
      const written = JSON.parse(record);
      expect(written.meta.eraseEpoch).toBe(1);
      expect(written.reminderOptIn.status).toBe('cancelled');
      expectNoStampAhead(written);
    });

    it(`mergeJson of a phone edit and the stored record, phone clock ${clock}`, () => {
      const phone = edited(JSON.stringify(stampedRecord(T0)), { kind: 'screening', key: 'colorectal_last_date', value: '2025-03' }, now);
      const merged = JSON.parse(mergeJson(phone, JSON.stringify(stampedRecord(T0)), now, DEVICE));
      expect(merged.screenings.colorectalLastDate).toBe('2025-03');
      expectNoStampAhead(merged);
    });

    it(`newRecordJson, phone clock ${clock}`, () => {
      expectNoStampAhead(JSON.parse(newRecordJson(now, DEVICE, 'en-US', 'America/New_York')));
    });
  }
});
