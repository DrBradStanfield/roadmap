// US-66: lab results a clinic sent to Apple Health Records become rows under
// the record's own FHIR rules. Each test names the AC it holds.
//
// Fixtures are HL7's own example Observations, fetched 2026-11-02:
//  - R4: the contained results of hl7.org/fhir/R4/diagnosticreport-example-lipids.json,
//    and observation-example-f204-creatinine.json;
//  - DSTU2: the same files under hl7.org/fhir/DSTU2/ (DSTU2's own `_id` and
//    `fhir_comments` keys kept, which the reader must ignore).
// HL7's examples carry no effectiveDateTime or meta; each test adds those it needs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { HEALTH_RECORDS_LOINC, importHealthRecords, type ClinicalRecordInput } from './health-records-import';
import { acceptedLabUnits, LAB_CATALOG, normalizeLabUnit } from './lab-catalog';
import { mergeFiles } from './merge';
import { migrateFile } from './migrate';
import { appendLabValue, appendMeasurement, correctValue } from './record-edits';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';
import { toCanonicalValue, UNIT_DEFS } from './units';

const NOW = '2026-11-02T08:00:00.000Z';
const LATER = '2026-11-02T09:00:00.000Z';
const R4 = '4.0.1';
const DSTU2 = '1.0.2';
const SOURCE = 'hk-source:Acme Health';

/** HL7 R4 lipid example, LDL (calc) 4.6 mmol/L under 13457-7. */
const R4_LDL = {
  resourceType: 'Observation', id: 'ldlcholesterol', status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '13457-7', display: 'Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation' }], text: 'LDL Chol. (Calc)' },
  subject: { reference: 'Patient/pat2' },
  performer: [{ reference: 'Organization/1832473e-2fe0-452d-abe9-3cdb9879522f', display: 'Acme Laboratory, Inc' }],
  valueQuantity: { value: 4.6, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' },
  referenceRange: [{ high: { value: 3.0, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' } }],
};

/** HL7 DSTU2 lipid example, HDL 1.3 mmol/L under 2085-9, with DSTU2's comment keys. */
const DSTU2_HDL = {
  resourceType: 'Observation', id: 'hdlcholesterol', status: 'final',
  _id: { fhir_comments: ['   all the data items (= Observations) are contained   '] },
  code: { coding: [{ system: 'http://loinc.org', code: '2085-9' }], text: 'Cholesterol in HDL' },
  subject: { reference: 'Patient/pat2' },
  performer: [{ reference: 'Organization/1832473e-2fe0-452d-abe9-3cdb9879522f', display: 'Acme Laboratory, Inc' }],
  valueQuantity: { value: 1.3, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' },
  referenceRange: [{ low: { value: 1.5, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' } }],
};

/** HL7 creatinine example (R4 f204): a local code only, a SNOMED unit code, no date. */
const R4_CREATININE_LOCAL = {
  resourceType: 'Observation', id: 'f204', identifier: [{ system: 'https://intranet.aumc.nl/labvalues', value: '1304-03720-Creatinine' }],
  status: 'final',
  code: { coding: [{ system: 'https://intranet.aumc.nl/labtestcodes', code: '20005', display: 'Creatinine(Serum)' }] },
  subject: { reference: 'Patient/f201', display: 'Roel' },
  issued: '2013-04-04T14:34:00+01:00',
  valueQuantity: { value: 122, unit: 'umol/L', system: 'http://snomed.info/sct', code: '258814008' },
  interpretation: [{ coding: [{ system: 'http://snomed.info/sct', code: '166717003', display: 'Serum creatinine raised' }] }],
  referenceRange: [{ low: { value: 64 }, high: { value: 104 } }],
};

/** The DSTU2 shape of the same example: interpretation is one concept, not a list. */
const DSTU2_CREATININE_LOCAL = {
  ...R4_CREATININE_LOCAL,
  _status: { fhir_comments: ['   Creatinine was measured on April fourth   '] },
  interpretation: { coding: [{ system: 'http://hl7.org/fhir/v2/0078', code: 'H' }] },
};

function empty(): RoadmapFile {
  return createEmptyFile({ deviceId: 'phone', now: '2026-10-01T00:00:00.000Z' });
}

function rec(obs: object, extra: Partial<ClinicalRecordInput> = {}): ClinicalRecordInput {
  return { sourceId: SOURCE, resourceType: 'Observation', fhirVersion: R4, json: JSON.stringify(obs), ...extra };
}

/** An Observation from a fixture with the fields a test needs. */
function obs(base: object, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { effectiveDateTime: '2026-10-21', meta: { versionId: '1' }, ...base, ...fields };
}

/** One LOINC result in the shape a US lab sends it. */
function lab(code: string, value: number, unit: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return obs({
    resourceType: 'Observation', id: `obs-${code}`, status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code }] },
    valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit },
  }, fields);
}

function run(file: RoadmapFile, records: ClinicalRecordInput[], now = NOW) {
  return importHealthRecords(file, records, { now });
}

describe('US-66 AC2: what lands', () => {
  it('AC2 R4: the HL7 LDL lands as one core row in mmol/L, source health_records', () => {
    const { file, counts } = run(empty(), [rec(obs(R4_LDL))]);
    expect(counts).toEqual({ added: 1, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.measurements).toEqual([expect.objectContaining({
      metricType: 'ldl', value: 4.6, recordedAt: '2026-10-21T00:00:00.000Z', createdAt: NOW,
      source: 'health_records', status: 'active', correctsId: null,
      externalId: `${SOURCE}|Observation|ldlcholesterol#1`,
    })]);
    expect(file.meta.updatedAt).toBe(NOW);
  });

  it('AC2 DSTU2: the HL7 HDL lands, DSTU2 comment keys and all', () => {
    const { file, counts } = run(empty(), [rec(obs(DSTU2_HDL), { fhirVersion: DSTU2 })]);
    expect(counts.added).toBe(1);
    expect(file.measurements[0]).toMatchObject({ metricType: 'hdl', value: 1.3, source: 'health_records' });
  });

  it('AC2: a US LDL in mg/dL is stored in mmol/L, by the typed path\'s factor', () => {
    const { file } = run(empty(), [rec(lab('2089-1', 100, 'mg/dL'))]);
    expect(file.measurements[0].metricType).toBe('ldl');
    expect(file.measurements[0].value).toBeCloseTo(toCanonicalValue('ldl', 100, 'conventional'), 10);
  });

  it('AC2: HbA1c in UCUM %{HbA1c} is stored in mmol/mol; mmol/mol stays as it is', () => {
    const { file } = run(empty(), [rec(lab('4548-4', 6.5, '%{HbA1c}')), rec(lab('59261-8', 48, 'mmol/mol', { effectiveDateTime: '2026-10-22' }))]);
    expect(file.measurements.map((m) => [m.metricType, m.value])).toEqual([
      ['hba1c', toCanonicalValue('hba1c', 6.5, 'conventional')], ['hba1c', 48],
    ]);
  });

  it('AC2: Lp(a) in mg/dL converts by its existing factor, in nmol/L it is kept', () => {
    const { file } = run(empty(), [rec(lab('10835-7', 50, 'mg/dL')), rec(lab('43583-4', 120, 'nmol/L', { effectiveDateTime: '2026-10-22' }))]);
    expect(file.measurements.map((m) => m.value)).toEqual([toCanonicalValue('lpa', 50, 'conventional'), 120]);
  });

  it('AC2: creatinine by moles, ApoB, PSA, total cholesterol and triglycerides land as core rows', () => {
    const { file, counts } = run(empty(), [
      rec(lab('14682-9', 88, 'umol/L')), rec(lab('1884-6', 90, 'mg/dL')), rec(lab('2857-1', 1.2, 'ng/mL')),
      rec(lab('2093-3', 5.1, 'mmol/L')), rec(lab('2571-8', 1.4, 'mmol/L')),
    ]);
    expect(counts.added).toBe(5);
    expect(file.measurements.map((m) => [m.metricType, m.value])).toEqual([
      ['creatinine', 88], ['apob', toCanonicalValue('apob', 90, 'conventional')], ['psa', 1.2], ['total_cholesterol', 5.1], ['triglycerides', 1.4],
    ]);
  });

  it('AC2: a catalogue lab lands in the catalogue unit with the lab\'s reference range', () => {
    const ferritin = lab('2276-4', 85, 'ng/mL', {
      referenceRange: [{ low: { value: 30, unit: 'ng/mL', system: 'http://unitsofmeasure.org', code: 'ng/mL' }, high: { value: 400, unit: 'ng/mL' } }],
    });
    const { file } = run(empty(), [rec(ferritin), rec(lab('3016-3', 2.1, 'm[IU]/L'))]);
    expect(file.labValues).toEqual([
      expect.objectContaining({ metricName: 'ferritin', value: 85, unit: 'µg/L', referenceLow: 30, referenceHigh: 400, source: 'health_records', externalId: `${SOURCE}|Observation|obs-2276-4#1` }),
      expect.objectContaining({ metricName: 'tsh', value: 2.1, unit: 'mIU/L', referenceLow: null, referenceHigh: null }),
    ]);
    expect(file.measurements).toEqual([]);
  });

  it('AC2: a reference range printed in another unit than the result is dropped, the result kept', () => {
    const ferritin = lab('2276-4', 85, 'ng/mL', { referenceRange: [{ low: { value: 0.03, unit: 'mg/L' }, high: { value: 0.4, unit: 'mg/L' } }] });
    const { file } = run(empty(), [rec(ferritin)]);
    expect(file.labValues[0]).toMatchObject({ value: 85, referenceLow: null, referenceHigh: null });
  });

  it('AC2: statuses amended and corrected land like final', () => {
    const { counts } = run(empty(), [
      rec(lab('2089-1', 3, 'mmol/L', { status: 'amended' })),
      rec(lab('2085-9', 1.2, 'mmol/L', { status: 'corrected' })),
    ]);
    expect(counts.added).toBe(2);
  });

  it('AC2: no glucose code is in the map (fasting is not knowable from the code)', () => {
    expect(Object.keys(HEALTH_RECORDS_LOINC)).not.toContain('2345-7');
    expect(Object.values(HEALTH_RECORDS_LOINC)).not.toContain('glucose');
  });
});

describe('US-66 AC3: the day', () => {
  it('AC3: a datetime keeps its own offset; its day is the draw\'s local day', () => {
    const { file } = run(empty(), [rec(obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00-07:00' }))]);
    expect(file.measurements[0].recordedAt).toBe('2026-10-21T08:30:00.000-07:00');
  });

  it('AC3: no effective date, a period with no start, a month alone or an unreal day does not land', () => {
    const { effectiveDateTime: _drop, ...noDate } = obs(R4_LDL);
    const { file, counts } = run(empty(), [
      rec(noDate),
      rec({ ...noDate, effectivePeriod: { end: '2026-10-21T09:30:10+01:00' } }),
      rec(obs(R4_LDL, { effectiveDateTime: '2026-10' })),
      rec(obs(R4_LDL, { effectiveDateTime: '2026-02-30' })),
      rec(obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00' })), // a time with no offset
    ]);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 5 });
    expect(file.measurements).toEqual([]);
  });

  // HL7's glucose example (f001) dates its draw with effectivePeriod in both versions:
  // R4 a start only, DSTU2 a start and an end.
  it('AC3 R4: with no effectiveDateTime, effectivePeriod.start is the draw, its offset kept', () => {
    const { effectiveDateTime: _drop, ...noDate } = obs(R4_LDL);
    const { file } = run(empty(), [rec({ ...noDate, effectivePeriod: { start: '2026-10-21T09:30:10+01:00' } })]);
    expect(file.measurements[0]).toMatchObject({ metricType: 'ldl', recordedAt: '2026-10-21T09:30:10.000+01:00' });
  });

  it('AC3 DSTU2: effectivePeriod.start is the draw, the end ignored; a date-only start is that day', () => {
    const { effectiveDateTime: _drop, ...noDate } = obs(DSTU2_HDL);
    const { file } = run(empty(), [
      rec({ ...noDate, effectivePeriod: { start: '2026-10-21T09:30:10+01:00', end: '2026-10-24T09:30:10+01:00' } }, { fhirVersion: DSTU2 }),
      rec({ ...obs(R4_LDL), effectiveDateTime: undefined, effectivePeriod: { start: '2026-10-22' } }, { fhirVersion: DSTU2 }),
    ]);
    expect(file.measurements.map((m) => m.recordedAt)).toEqual(['2026-10-21T09:30:10.000+01:00', '2026-10-22T00:00:00.000Z']);
  });

  it('AC3: effectiveDateTime wins over a period; a period start later than now does not land', () => {
    const { file, counts } = run(empty(), [
      rec(obs(R4_LDL, { effectivePeriod: { start: '2026-10-01T09:00:00Z' } })),
      rec({ ...obs(DSTU2_HDL), effectiveDateTime: undefined, effectivePeriod: { start: '2026-11-02T09:00:00Z' } }, { fhirVersion: DSTU2 }),
    ]);
    expect(counts).toMatchObject({ added: 1, notRead: 1 });
    expect(file.measurements[0].recordedAt).toBe('2026-10-21T00:00:00.000Z');
  });

  it('AC3: a result later than now does not land; five minutes of clock skew is not later', () => {
    const { counts } = run(empty(), [
      rec(obs(R4_LDL, { effectiveDateTime: '2026-11-02T08:30:00Z' })),
      rec(obs(DSTU2_HDL, { effectiveDateTime: '2026-11-02T08:04:00Z' })),
      rec(lab('2093-3', 5, 'mmol/L', { effectiveDateTime: '2026-11-04' })),
    ]);
    expect(counts).toMatchObject({ added: 1, notRead: 2 });
  });

  it('AC3: a date-only result dated today where the day has begun lands (a UK morning before UTC midnight)', () => {
    // 23:30 UTC on 1 Nov is already 2 Nov somewhere on earth.
    const { file } = run(empty(), [rec(obs(R4_LDL, { effectiveDateTime: '2026-11-02' }))], '2026-11-01T23:30:00.000Z');
    expect(file.measurements[0].recordedAt).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('US-66 AC4: not read, counted', () => {
  it('AC4: HL7\'s creatinine with only a local code is not read, in both versions', () => {
    const { file, counts } = run(empty(), [rec(obs(R4_CREATININE_LOCAL)), rec(obs(DSTU2_CREATININE_LOCAL), { fhirVersion: DSTU2 })]);
    expect(counts.notRead).toBe(2);
    expect(file.measurements).toEqual([]);
  });

  it('AC4: the same creatinine with its LOINC code lands, its SNOMED unit code passed over for the printed unit', () => {
    const coded = { ...R4_CREATININE_LOCAL, code: { coding: [...R4_CREATININE_LOCAL.code.coding, { system: 'http://loinc.org', code: '14682-9' }] } };
    const { file } = run(empty(), [rec(obs(coded))]);
    expect(file.measurements[0]).toMatchObject({ metricType: 'creatinine', value: 122 });
  });

  it('AC4: no number, an unknown unit, a value out of range, an unknown status, each is not read', () => {
    const { counts } = run(empty(), [
      rec(obs({ ...R4_LDL, valueQuantity: undefined, valueString: 'see note' })),
      rec(lab('2089-1', 3, 'mmol/dL')),
      rec(lab('2089-1', 3, 'mg')),
      rec(lab('2276-4', 85, 'ng/dL')),
      rec(lab('2089-1', 50, 'mmol/L')),
      rec(lab('2089-1', 3, 'mmol/L', { status: 'preliminary' })),
      rec(lab('2089-1', 3, 'mmol/L', { status: 'cancelled' })),
      rec(lab('2089-1', 3, 'mmol/L', { status: 'registered' })),
    ]);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 8 });
  });

  it('AC4: a result with <, <=, > or >= is held back for now (US-12 AC20 seam); R4\'s "ad" is not a bound', () => {
    const records = ['<', '<=', '>', '>=', 'ad'].map((comparator, i) => rec(lab('2857-1', 0.01, 'ng/mL', {
      id: `psa-${i}`, valueQuantity: { value: 0.01, unit: 'ng/mL', comparator },
    })));
    const before = empty();
    const { file, counts } = run(before, records);
    expect(counts.notRead).toBe(5);
    expect(file).toBe(before);
  });

  it('AC4: not an Observation, not DSTU2 or R4, broken JSON, a malformed id or a source with "#": not read', () => {
    const { counts } = run(empty(), [
      rec({ resourceType: 'DiagnosticReport', id: 'lipids', status: 'final' }),
      rec(obs(R4_LDL), { resourceType: 'DiagnosticReport' }),
      rec(obs(R4_LDL), { fhirVersion: '3.0.1' }),
      { ...rec(obs(R4_LDL)), json: '{"resourceType":"Observation",' },
      rec(obs(R4_LDL, { id: 'has space' })),
      rec(obs(R4_LDL), { sourceId: 'a#b' }),
      rec(obs(R4_LDL), { sourceId: '' }),
      null as unknown as ClinicalRecordInput,
    ]);
    expect(counts.notRead).toBe(8);
  });

  it('AC4: two LOINC codes naming two different tests are not guessed between', () => {
    const both = lab('2089-1', 3, 'mmol/L', { code: { coding: [{ system: 'http://loinc.org', code: '2089-1' }, { system: 'http://loinc.org', code: '2085-9' }] } });
    expect(run(empty(), [rec(both)]).counts.notRead).toBe(1);
  });

  it('AC4: a LOINC code under another system is not a LOINC code', () => {
    const other = lab('2089-1', 3, 'mmol/L', { code: { coding: [{ system: 'http://example.org/codes', code: '2089-1' }] } });
    expect(run(empty(), [rec(other)]).counts.notRead).toBe(1);
  });
});

describe('US-66 AC5: identity and version', () => {
  it('AC5: a version already in the record does not land again, and the record comes back as given', () => {
    const once = run(empty(), [rec(obs(R4_LDL))]).file;
    const again = run(once, [rec(obs(R4_LDL))], LATER);
    expect(again.counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(again.file).toBe(once);
  });

  it('AC5: a version the person marked entered-in-error does not land again (a reinstall re-reads everything)', () => {
    const once = run(empty(), [rec(obs(R4_LDL))]).file;
    const id = once.measurements[0].id;
    const marked: RoadmapFile = { ...once, measurements: once.measurements.map((m) => (m.id === id ? { ...m, status: 'entered-in-error' as const } : m)) };
    const again = run(marked, [rec(obs(R4_LDL))], LATER);
    expect(again.counts.alreadyInRecord).toBe(1);
    expect(again.file).toBe(marked);
  });

  it('AC5: an older version seen again after an amendment does not undo it', () => {
    const v1 = rec(obs(R4_LDL));
    const v2 = rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }));
    const amended = run(run(empty(), [v1]).file, [v2], LATER).file;
    const again = run(amended, [v1], LATER);
    expect(again.counts.alreadyInRecord).toBe(1);
    expect(again.file).toBe(amended);
  });

  it('AC5: two institutions\' results with the same FHIR id both land', () => {
    const { file, counts } = run(empty(), [
      rec(obs(R4_LDL)),
      rec(obs(R4_LDL, { effectiveDateTime: '2026-10-25' }), { sourceId: 'hk-source:Other Clinic' }),
    ]);
    expect(counts.added).toBe(2);
    expect(file.measurements.map((m) => m.externalId)).toEqual([
      `${SOURCE}|Observation|ldlcholesterol#1`, 'hk-source:Other Clinic|Observation|ldlcholesterol#1',
    ]);
  });

  it('AC5: the version is meta.versionId, else meta.lastUpdated, else status, value and unit', () => {
    const { file } = run(empty(), [
      rec(obs(R4_LDL, { meta: { lastUpdated: '2026-10-22T10:00:00Z' } })),
      rec(obs(DSTU2_HDL, { meta: undefined }), { fhirVersion: DSTU2 }),
    ]);
    expect(file.measurements.map((m) => m.externalId)).toEqual([
      `${SOURCE}|Observation|ldlcholesterol#2026-10-22T10:00:00Z`, `${SOURCE}|Observation|hdlcholesterol#final:1.3:mmol/L`,
    ]);
  });
});

describe('US-66 AC6: amended or corrected', () => {
  it('AC6: a newer version with a new value replaces the row as a FHIR correction on its day', () => {
    const first = run(empty(), [rec(obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00-07:00' }))]).file;
    const old = first.measurements[0];
    const amended = obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00-07:00', status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } });
    const { file, counts } = run(first, [rec(amended)], LATER);
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.measurements).toEqual([
      { ...old, status: 'entered-in-error' },
      expect.objectContaining({
        metricType: 'ldl', value: 3.9, recordedAt: old.recordedAt, createdAt: LATER, source: 'health_records', status: 'active',
        correctsId: old.id, externalId: `${SOURCE}|Observation|ldlcholesterol#2`,
      }),
    ]);
    expect(file.meta.updatedAt).toBe(LATER);
  });

  it('AC6: a newer version with the same value appends nothing', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const { file, counts } = run(first, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(first);
  });

  it('AC6: a catalogue lab\'s amendment is a correction too', () => {
    const first = run(empty(), [rec(lab('2276-4', 85, 'ng/mL'))]).file;
    const { file, counts } = run(first, [rec(lab('2276-4', 58, 'ng/mL', { meta: { versionId: '2' }, status: 'corrected' }))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.map((l) => [l.value, l.status, l.correctsId])).toEqual([[85, 'entered-in-error', null], [58, 'active', first.labValues[0].id]]);
  });

  it('AC6: two versions in one batch land oldest first, so the newer one is active', () => {
    const v1 = obs(R4_LDL, { meta: { lastUpdated: '2026-10-22T10:00:00Z' } });
    const v2 = obs(R4_LDL, { meta: { lastUpdated: '2026-10-23T10:00:00Z' }, status: 'amended', valueQuantity: { value: 3.9, unit: 'mmol/L' } });
    const { file, counts } = run(empty(), [rec(v2), rec(v1)]);
    expect(counts).toMatchObject({ added: 1, corrected: 1 });
    expect(file.measurements.filter((m) => m.status === 'active').map((m) => m.value)).toEqual([3.9]);
  });

  it('AC6: a version that moves the result to another day is not read, and the row stays', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const moved = obs(R4_LDL, { meta: { versionId: '2' }, effectiveDateTime: '2026-10-20', valueQuantity: { value: 3.9, unit: 'mmol/L' } });
    const { file, counts } = run(first, [rec(moved)], LATER);
    expect(counts.notRead).toBe(1);
    expect(file).toBe(first);
  });
});

describe('US-66 AC7 and AC8: withdrawn, and the person\'s call', () => {
  it('AC7: entered-in-error flips the imported row and appends nothing', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const { file, counts } = run(first, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '2' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 1, alreadyInRecord: 0, notRead: 0 });
    expect(file.measurements).toEqual([{ ...first.measurements[0], status: 'entered-in-error' }]);
    expect(file.meta.updatedAt).toBe(LATER);
  });

  it('AC7: a withdrawal of a result never imported changes nothing', () => {
    const before = empty();
    const { file, counts } = run(before, [rec(obs(R4_LDL, { status: 'entered-in-error' }))]);
    expect(counts.notRead).toBe(1);
    expect(file).toBe(before);
  });

  it('AC7: a withdrawal never touches a value the person typed on that day', () => {
    const typed = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error('setup');
    const { file } = run(typed.file, [rec(obs(R4_LDL, { status: 'entered-in-error' }))], LATER);
    expect(file).toBe(typed.file);
  });

  it('AC8: once withdrawn, no later version of that result lands', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const withdrawn = run(first, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '2' } }))], LATER).file;
    const { file, counts } = run(withdrawn, [rec(obs(R4_LDL, { status: 'corrected', meta: { versionId: '3' }, valueQuantity: { value: 3.3, unit: 'mmol/L' } }))], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(withdrawn);
  });

  it('AC8: a result the person corrected by hand keeps their value against a later version', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const fixed = correctValue(first, { id: first.measurements[0].id, newValue: 4.2, now: LATER });
    if (!fixed.ok) throw new Error('setup');
    const { file, counts } = run(fixed.file, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(fixed.file);
  });
});

describe('US-66 AC9: typed and uploaded values win', () => {
  it('AC9: a typed value on the day holds it; the result is counted as already in the record', () => {
    const typed = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error('setup');
    const { file, counts } = run(typed.file, [rec(obs(R4_LDL))], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(typed.file);
  });

  it('AC9: an uploaded lab value on the day holds it too', () => {
    const uploaded = appendLabValue(empty(), { metricName: 'ferritin', value: 90, unit: 'µg/L', recordedAt: '2026-10-21', now: NOW, source: 'lab_import' });
    if (!uploaded.ok) throw new Error('setup');
    const { file, counts } = run(uploaded.file, [rec(lab('2276-4', 85, 'ng/mL'))], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(uploaded.file);
  });

  it('AC9: a second institution\'s result for the same test and day does not replace the first', () => {
    const { file, counts } = run(empty(), [rec(obs(R4_LDL)), rec(obs(R4_LDL, { valueQuantity: { value: 4.4, unit: 'mmol/L' } }), { sourceId: 'hk-source:Other' })]);
    expect(counts).toMatchObject({ added: 1, alreadyInRecord: 1 });
    expect(file.measurements.map((m) => m.value)).toEqual([4.6]);
  });

  it('AC9: a withdrawn result frees its day for a typed value, not for the next import of it', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const withdrawn = run(first, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '2' } }))], LATER).file;
    expect(appendMeasurement(withdrawn, { metricType: 'ldl', value: 3, recordedAt: '2026-10-21', now: LATER }).ok).toBe(true);
  });
});

describe('US-66 AC10: erase', () => {
  it('AC10: a result drawn before the record\'s erase does not land; one drawn after does', () => {
    const erased: RoadmapFile = { ...empty(), meta: { ...empty().meta, erasedAt: '2026-10-22T00:00:00.000Z' } };
    const { file, counts } = run(erased, [rec(obs(R4_LDL)), rec(obs(DSTU2_HDL, { effectiveDateTime: '2026-10-23' }), { fhirVersion: DSTU2 })]);
    expect(counts).toMatchObject({ added: 1, notRead: 1 });
    expect(file.measurements.map((m) => m.metricType)).toEqual(['hdl']);
  });
});

describe('US-66 AC12: the record schema and the web', () => {
  const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../docs/health-roadmap-file.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, validateFormats: false }).compile(schema);

  it('AC12: a record holding health_records rows, a lab value\'s externalId included, validates', () => {
    const { file } = run(empty(), [rec(obs(R4_LDL)), rec(lab('2276-4', 85, 'ng/mL'))]);
    const ok = validate(JSON.parse(JSON.stringify(file)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('AC12: merge and migrate keep a lab value\'s externalId', () => {
    const { file } = run(empty(), [rec(lab('2276-4', 85, 'ng/mL'))]);
    const opts = { deviceId: 'laptop', now: LATER };
    const merged = migrateFile(JSON.parse(JSON.stringify(mergeFiles(file, empty(), opts))), opts);
    expect(merged.labValues[0].externalId).toBe(`${SOURCE}|Observation|obs-2276-4#1`);
    // A merged record re-read on the phone is still deduplicated by it.
    expect(run(merged, [rec(lab('2276-4', 85, 'ng/mL'))], LATER).counts.alreadyInRecord).toBe(1);
  });
});

describe('US-66 AC2: UCUM unit spellings', () => {
  it('reads UCUM\'s bracket and brace forms as the spellings the record knows', () => {
    expect(['m[IU]/L', 'u[IU]/mL', 'mm[Hg]', '%{HbA1c}', 'mL/min/{1.73_m2}'].map(normalizeLabUnit))
      .toEqual(['mIU/L', 'µIU/mL', 'mmHg', '%', 'mL/min/1.73m²']);
  });

  it('a brace after a space is not UCUM and stays, to be refused', () => {
    expect(normalizeLabUnit('mmol/L {H}')).toBe('mmol/L {H}');
  });

  it('changes no spelling the record already accepts: none holds a brace or bracket', () => {
    const spellings = [
      ...LAB_CATALOG.flatMap((entry) => acceptedLabUnits(entry)),
      ...Object.values(UNIT_DEFS).flatMap((def) => [def.label.si, def.label.conventional, def.canonical]),
    ];
    expect(spellings.length).toBeGreaterThan(100);
    expect(spellings.filter((s) => /[{}[\]]/.test(s))).toEqual([]);
  });
});

describe('US-66 AC2: the SI labs\' molar and mass-or-moles lipid codes', () => {
  it.each([
    ['14646-4', 'hdl', 1.3], ['39469-2', 'ldl', 2.9], ['22748-8', 'ldl', 2.9],
    ['14647-2', 'total_cholesterol', 5.2], ['35200-5', 'total_cholesterol', 5.2],
    ['14927-8', 'triglycerides', 1.4], ['35217-9', 'triglycerides', 1.4],
  ])('%s in mmol/L lands as %s', (code, metric, value) => {
    const o = obs({ ...R4_LDL, id: `x${code}` }, {
      code: { coding: [{ system: 'http://loinc.org', code }] },
      valueQuantity: { value, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' },
      referenceRange: undefined,
    });
    const { file, counts } = importHealthRecords(empty(), [rec(o)], { now: NOW });
    expect(counts.added).toBe(1);
    expect(file.measurements).toEqual([expect.objectContaining({ metricType: metric, value, source: 'health_records', status: 'active' })]);
  });
});
