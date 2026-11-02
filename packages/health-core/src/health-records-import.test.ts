// US-72: lab results a clinic sent to Apple Health Records become rows under
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
import { HEALTH_RECORDS_LOINC, importHealthRecords, isVersionMarker, type ClinicalRecordInput } from './health-records-import';
import { acceptedLabUnits, LAB_CATALOG } from './lab-catalog';
import { mergeFiles } from './merge';
import { migrateFile } from './migrate';
import { isReadableRow } from './readable-rows';
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

describe('US-72 AC2: what lands', () => {
  it('AC2 R4: the HL7 LDL lands as one core row in mmol/L, source health_records', () => {
    const { file, counts } = run(empty(), [rec(obs(R4_LDL))]);
    expect(counts).toEqual({ added: 1, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    // One blood-test table (US-66): a core row in labValues, its range in the core unit; no measurement.
    expect(file.labValues).toEqual([expect.objectContaining({
      metricName: 'ldl', core: true, unit: 'mmol/L', value: 4.6, referenceLow: null, referenceHigh: 3,
      recordedAt: '2026-10-21T00:00:00.000Z', createdAt: NOW,
      source: 'health_records', status: 'active', correctsId: null,
      externalId: `${SOURCE}|Observation|ldlcholesterol#|1|final|4.6||mmol/L`,
    })]);
    expect(file.measurements).toEqual([]);
    expect(file.meta.updatedAt).toBe(NOW);
  });

  it('AC2: a record gaining its first core row is schemaVersion 3, by the record\'s own stamp (one blood-test table)', () => {
    const before = empty();
    expect(before.schemaVersion).toBeLessThan(3);
    expect(run(before, [rec(obs(R4_LDL))]).file.schemaVersion).toBe(3);
    // A catalogue lab alone is no core row: the version stays.
    expect(run(before, [rec(lab('2276-4', 85, 'ng/mL'))]).file.schemaVersion).toBe(before.schemaVersion);
  });

  it('AC9: a typed LDL saved in the old shape (in measurements) is found where migrate moves it, and corrected', () => {
    const typed = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error('setup');
    const [row] = typed.file.labValues;
    const { metricName, unit: _unit, referenceLow: _low, referenceHigh: _high, core: _core, ...rest } = row;
    const old = { ...typed.file, schemaVersion: 2, labValues: [], measurements: [{ ...rest, metricType: metricName }] };
    const opts = { deviceId: 'phone', now: NOW };
    const { file, counts } = run(migrateFile(JSON.parse(JSON.stringify(old)), opts), [rec(obs(R4_LDL))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.measurements).toEqual([]);
    expect(file.labValues.map((l) => [l.id, l.metricName, l.core, l.status, l.value, l.correctsId])).toEqual([
      [row.id, 'ldl', true, 'entered-in-error', 3.1, null], [expect.any(String), 'ldl', true, 'active', 4.6, row.id],
    ]);
  });

  it('AC2 DSTU2: the HL7 HDL lands, DSTU2 comment keys and all', () => {
    const { file, counts } = run(empty(), [rec(obs(DSTU2_HDL), { fhirVersion: DSTU2 })]);
    expect(counts.added).toBe(1);
    expect(file.labValues[0]).toMatchObject({ metricName: 'hdl', value: 1.3, source: 'health_records' });
  });

  it('AC2: a US LDL in mg/dL is stored in mmol/L, by the typed path\'s factor', () => {
    const { file } = run(empty(), [rec(lab('2089-1', 100, 'mg/dL'))]);
    expect(file.labValues[0].metricName).toBe('ldl');
    expect(file.labValues[0].value).toBeCloseTo(toCanonicalValue('ldl', 100, 'conventional'), 10);
  });

  it('AC2: HbA1c in UCUM %{HbA1c} is stored in mmol/mol; mmol/mol stays as it is', () => {
    const { file } = run(empty(), [rec(lab('4548-4', 6.5, '%{HbA1c}')), rec(lab('59261-8', 48, 'mmol/mol', { effectiveDateTime: '2026-10-22' }))]);
    expect(file.labValues.map((m) => [m.metricName, m.value])).toEqual([
      ['hba1c', toCanonicalValue('hba1c', 6.5, 'conventional')], ['hba1c', 48],
    ]);
  });

  it('AC2: Lp(a) in mg/dL converts by its existing factor, in nmol/L it is kept', () => {
    const { file } = run(empty(), [rec(lab('10835-7', 50, 'mg/dL')), rec(lab('43583-4', 120, 'nmol/L', { effectiveDateTime: '2026-10-22' }))]);
    expect(file.labValues.map((m) => m.value)).toEqual([toCanonicalValue('lpa', 50, 'conventional'), 120]);
  });

  it('AC2: creatinine by moles, ApoB, PSA, total cholesterol and triglycerides land as core rows', () => {
    const { file, counts } = run(empty(), [
      rec(lab('14682-9', 88, 'umol/L')), rec(lab('1884-6', 90, 'mg/dL')), rec(lab('2857-1', 1.2, 'ng/mL')),
      rec(lab('2093-3', 5.1, 'mmol/L')), rec(lab('2571-8', 1.4, 'mmol/L')),
    ]);
    expect(counts.added).toBe(5);
    expect(file.labValues.map((m) => [m.metricName, m.value])).toEqual([
      ['creatinine', 88], ['apob', toCanonicalValue('apob', 90, 'conventional')], ['psa', 1.2], ['total_cholesterol', 5.1], ['triglycerides', 1.4],
    ]);
  });

  it('AC2: a catalogue lab lands in the catalogue unit with the lab\'s reference range', () => {
    const ferritin = lab('2276-4', 85, 'ng/mL', {
      referenceRange: [{ low: { value: 30, unit: 'ng/mL', system: 'http://unitsofmeasure.org', code: 'ng/mL' }, high: { value: 400, unit: 'ng/mL' } }],
    });
    const { file } = run(empty(), [rec(ferritin), rec(lab('3016-3', 2.1, 'm[IU]/L'))]);
    expect(file.labValues).toEqual([
      expect.objectContaining({ metricName: 'ferritin', value: 85, unit: 'µg/L', referenceLow: 30, referenceHigh: 400, source: 'health_records', externalId: `${SOURCE}|Observation|obs-2276-4#|1|final|85||ng/mL` }),
      expect.objectContaining({ metricName: 'tsh', value: 2.1, unit: 'mIU/L', referenceLow: null, referenceHigh: null }),
    ]);
    expect(file.labValues.filter((v) => v.core)).toEqual([]);
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

describe('US-72 AC3: the day', () => {
  it('AC3: a datetime keeps its own offset; its day is the draw\'s local day', () => {
    const { file } = run(empty(), [rec(obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00-07:00' }))]);
    expect(file.labValues[0].recordedAt).toBe('2026-10-21T08:30:00.000-07:00');
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
    expect(file.labValues).toEqual([]);
  });

  // HL7's glucose example (f001) dates its draw with effectivePeriod in both versions:
  // R4 a start only, DSTU2 a start and an end.
  it('AC3 R4: with no effectiveDateTime, effectivePeriod.start is the draw, its offset kept', () => {
    const { effectiveDateTime: _drop, ...noDate } = obs(R4_LDL);
    const { file } = run(empty(), [rec({ ...noDate, effectivePeriod: { start: '2026-10-21T09:30:10+01:00' } })]);
    expect(file.labValues[0]).toMatchObject({ metricName: 'ldl', recordedAt: '2026-10-21T09:30:10.000+01:00' });
  });

  it('AC3 DSTU2: effectivePeriod.start is the draw, the end ignored; a date-only start is that day', () => {
    const { effectiveDateTime: _drop, ...noDate } = obs(DSTU2_HDL);
    const { file } = run(empty(), [
      rec({ ...noDate, effectivePeriod: { start: '2026-10-21T09:30:10+01:00', end: '2026-10-24T09:30:10+01:00' } }, { fhirVersion: DSTU2 }),
      rec({ ...obs(R4_LDL), effectiveDateTime: undefined, effectivePeriod: { start: '2026-10-22' } }, { fhirVersion: DSTU2 }),
    ]);
    expect(file.labValues.map((m) => m.recordedAt)).toEqual(['2026-10-21T09:30:10.000+01:00', '2026-10-22T00:00:00.000Z']);
  });

  it('AC3: effectiveDateTime wins over a period; a period start later than now does not land', () => {
    const { file, counts } = run(empty(), [
      rec(obs(R4_LDL, { effectivePeriod: { start: '2026-10-01T09:00:00Z' } })),
      rec({ ...obs(DSTU2_HDL), effectiveDateTime: undefined, effectivePeriod: { start: '2026-11-02T09:00:00Z' } }, { fhirVersion: DSTU2 }),
    ]);
    expect(counts).toMatchObject({ added: 1, notRead: 1 });
    expect(file.labValues[0].recordedAt).toBe('2026-10-21T00:00:00.000Z');
  });

  it('AC3: a result later than now does not land; five minutes of clock skew is not later', () => {
    const { counts } = run(empty(), [
      rec(obs(R4_LDL, { effectiveDateTime: '2026-11-02T08:30:00Z' })),
      rec(obs(DSTU2_HDL, { effectiveDateTime: '2026-11-02T08:04:00Z' })),
      rec(lab('2093-3', 5, 'mmol/L', { effectiveDateTime: '2026-11-04' })),
    ]);
    expect(counts).toMatchObject({ added: 1, notRead: 2 });
  });

  // Apple's simulator sample accounts (Sample Institution A, read 2026-11-02): DSTU2
  // Observations that carry `issued` and no effective date. Values made up.
  const APPLE_SAMPLE_DSTU2 = {
    resourceType: 'Observation', id: '3fb9cf6c-3a2d-4c09-a3c2-7d3f2d8e1a10', status: 'final',
    category: { coding: [{ system: 'http://hl7.org/fhir/observation-category', code: 'laboratory' }] },
    code: { coding: [{ system: 'http://loinc.org', code: '2093-3', display: 'Cholesterol' }], text: 'Cholesterol' },
    subject: { reference: 'Patient/1' },
    issued: '2026-10-21T14:34:00+01:00',
    valueQuantity: { value: 190, unit: 'mg/dL', system: 'http://unitsofmeasure.org', code: 'mg/dL' },
    referenceRange: [{ text: '<200 mg/dL' }],
  };

  it('AC3 DSTU2 (Apple\'s sample shape): an Observation with only `issued` lands on the issued day, its offset kept', () => {
    const { file, counts } = run(empty(), [rec(APPLE_SAMPLE_DSTU2, { fhirVersion: DSTU2 })]);
    expect(counts).toEqual({ added: 1, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues).toEqual([expect.objectContaining({
      metricName: 'total_cholesterol', recordedAt: '2026-10-21T14:34:00.000+01:00', source: 'health_records', status: 'active',
    })]);
  });

  it('AC3: effectiveDateTime and effectivePeriod.start each win over `issued`', () => {
    const { file } = run(empty(), [
      rec({ ...APPLE_SAMPLE_DSTU2, effectiveDateTime: '2026-10-19' }, { fhirVersion: DSTU2 }),
      rec({ ...APPLE_SAMPLE_DSTU2, id: 'b', effectivePeriod: { start: '2026-10-18' } }, { fhirVersion: DSTU2 }),
    ]);
    expect(file.labValues.map((m) => m.recordedAt)).toEqual(['2026-10-19T00:00:00.000Z', '2026-10-18T00:00:00.000Z']);
  });

  it('AC3, AC10: an `issued` later than now, unreadable, or before the erase does not land', () => {
    const erased: RoadmapFile = { ...empty(), meta: { ...empty().meta, erasedAt: '2026-10-22T00:00:00.000Z' } };
    const { file, counts } = run(erased, [
      rec({ ...APPLE_SAMPLE_DSTU2, id: 'a', issued: '2026-11-02T09:30:00Z' }, { fhirVersion: DSTU2 }),
      rec({ ...APPLE_SAMPLE_DSTU2, id: 'b', issued: '2026-02-30T09:30:00Z' }, { fhirVersion: DSTU2 }),
      rec({ ...APPLE_SAMPLE_DSTU2, id: 'c' }, { fhirVersion: DSTU2 }),
      rec({ ...APPLE_SAMPLE_DSTU2, id: 'd', issued: '2026-10-23T09:30:00Z' }, { fhirVersion: DSTU2 }),
    ]);
    expect(counts).toMatchObject({ added: 1, notRead: 3 });
    expect(file.labValues.map((m) => m.recordedAt)).toEqual(['2026-10-23T09:30:00.000Z']);
  });

  it('AC3: a date-only result dated today where the day has begun lands (a UK morning before UTC midnight)', () => {
    // 23:30 UTC on 1 Nov is already 2 Nov somewhere on earth.
    const { file } = run(empty(), [rec(obs(R4_LDL, { effectiveDateTime: '2026-11-02' }))], '2026-11-01T23:30:00.000Z');
    expect(file.labValues[0].recordedAt).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('US-72 AC4: not read, counted', () => {
  it('AC4: HL7\'s creatinine with only a local code is not read, in both versions', () => {
    const { file, counts } = run(empty(), [rec(obs(R4_CREATININE_LOCAL)), rec(obs(DSTU2_CREATININE_LOCAL), { fhirVersion: DSTU2 })]);
    expect(counts.notRead).toBe(2);
    expect(file.labValues).toEqual([]);
  });

  it('AC4: the same creatinine with its LOINC code lands, its SNOMED unit code passed over for the printed unit', () => {
    const coded = { ...R4_CREATININE_LOCAL, code: { coding: [...R4_CREATININE_LOCAL.code.coding, { system: 'http://loinc.org', code: '14682-9' }] } };
    const { file } = run(empty(), [rec(obs(coded))]);
    expect(file.labValues[0]).toMatchObject({ metricName: 'creatinine', value: 122 });
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

  it('AC4: the IFCC HbA1c code (59261-8) is read only in mmol/mol; a % under it is not read', () => {
    const { file, counts } = run(empty(), [rec(lab('59261-8', 6.5, '%')), rec(lab('59261-8', 6.5, '%{HbA1c}')), rec(lab('59261-8', 48, 'mmol/mol', { effectiveDateTime: '2026-10-22' }))]);
    expect(counts).toMatchObject({ added: 1, notRead: 2 });
    expect(file.labValues.map((m) => m.value)).toEqual([48]);
  });

  it('AC4 (US-12 AC20): a PSA "<0.01" lands with its comparator, the bound in the stored unit', () => {
    const { file, counts } = run(empty(), [rec(lab('2857-1', 0.01, 'ng/mL', { valueQuantity: { value: 0.01, unit: 'ng/mL', comparator: '<' } }))]);
    expect(counts.added).toBe(1);
    expect(file.labValues).toEqual([expect.objectContaining({ metricName: 'psa', value: 0.01, comparator: '<', source: 'health_records' })]);
  });

  it('AC4 (US-12 AC20): an eGFR ">90" lands as a lab value with its comparator', () => {
    const { file, counts } = run(empty(), [rec(lab('98979-8', 90, 'mL/min/{1.73_m2}', { valueQuantity: { value: 90, unit: 'mL/min/{1.73_m2}', comparator: '>' } }))]);
    expect(counts.added).toBe(1);
    expect(file.labValues).toEqual([expect.objectContaining({ metricName: 'egfr', value: 90, unit: 'mL/min/1.73m²', comparator: '>', source: 'health_records' })]);
  });

  it('AC4: each of <, <=, > and >= is kept; R4\'s "ad" is not a bound, so not read', () => {
    const records = ['<', '<=', '>', '>=', 'ad'].map((comparator, i) => rec(lab('2857-1', 0.01, 'ng/mL', {
      id: `psa-${i}`, effectiveDateTime: `2026-10-0${i + 1}`, valueQuantity: { value: 0.01, unit: 'ng/mL', comparator },
    })));
    const { file, counts } = run(empty(), records);
    expect(counts).toMatchObject({ added: 4, notRead: 1 });
    expect(file.labValues.map((m) => m.comparator)).toEqual(['<', '<=', '>', '>=']);
  });

  it('AC6: a newer version that turns an exact result into a limit is a correction', () => {
    const first = run(empty(), [rec(lab('2857-1', 0.01, 'ng/mL'))]).file;
    const { file, counts } = run(first, [rec(lab('2857-1', 0.01, 'ng/mL', { status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 0.01, unit: 'ng/mL', comparator: '<' } }))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.map((m) => [m.status, m.comparator])).toEqual([['entered-in-error', undefined], ['active', '<']]);
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

describe('US-72 AC5: identity and version', () => {
  it('AC5: a version already in the record does not land again, and the record comes back as given', () => {
    const once = run(empty(), [rec(obs(R4_LDL))]).file;
    const again = run(once, [rec(obs(R4_LDL))], LATER);
    expect(again.counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(again.file).toBe(once);
  });

  it('AC5: a version the person marked entered-in-error does not land again (a reinstall re-reads everything)', () => {
    const once = run(empty(), [rec(obs(R4_LDL))]).file;
    const id = once.labValues[0].id;
    const marked: RoadmapFile = { ...once, labValues: once.labValues.map((m) => (m.id === id ? { ...m, status: 'entered-in-error' as const } : m)) };
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
    expect(file.labValues.map((m) => m.externalId)).toEqual([
      `${SOURCE}|Observation|ldlcholesterol#|1|final|4.6||mmol/L`, 'hk-source:Other Clinic|Observation|ldlcholesterol#|1|final|4.6||mmol/L',
    ]);
  });

  it('AC5: the version is lastUpdated, versionId, status, value, comparator and the stated unit together', () => {
    const { file } = run(empty(), [
      rec(obs(R4_LDL, { meta: { lastUpdated: '2026-10-22T10:00:00Z' } })),
      rec(obs(DSTU2_HDL, { meta: undefined }), { fhirVersion: DSTU2 }),
      rec(lab('2857-1', 0.01, 'ng/mL', { meta: { versionId: '3', lastUpdated: '2026-10-22T11:00:00Z' }, valueQuantity: { value: 0.01, comparator: '<', unit: 'ng/mL' } })),
    ]);
    expect(file.labValues.map((m) => m.externalId)).toEqual([
      `${SOURCE}|Observation|ldlcholesterol#2026-10-22T10:00:00Z||final|4.6||mmol/L`,
      `${SOURCE}|Observation|hdlcholesterol#||final|1.3||mmol/L`,
      `${SOURCE}|Observation|obs-2857-1#2026-10-22T11:00:00Z|3|final|0.01|<|ng/mL`,
    ]);
  });

  it('AC5, AC7: a withdrawal under an equal lastUpdated is honoured (re-check R1)', () => {
    const stamp = { lastUpdated: '2026-10-22T10:00:00Z' };
    const first = run(empty(), [rec(obs(R4_LDL, { meta: stamp }))]).file;
    const { file, counts } = run(first, [rec(obs(R4_LDL, { meta: stamp, status: 'entered-in-error' }))], LATER);
    expect(counts.withdrawn).toBe(1);
    expect(file.labValues.map((m) => m.status)).toEqual(['entered-in-error', 'entered-in-error']);
  });

  it('AC5: whole-number versionIds longer than 15 digits still order (Codex re-check R2)', () => {
    const newer = rec(obs(R4_LDL, { meta: { versionId: '1000000000000001' } }));
    const older = rec(obs(R4_LDL, { meta: { versionId: '1000000000000000' }, status: 'entered-in-error' }));
    const held = run(empty(), [newer]).file;
    const { file, counts } = run(held, [older], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(held);
  });

  it('AC5: no "#" or "|" from the provider reaches the version, so the identity and the parts split back', () => {
    const { file } = run(empty(), [rec(obs(R4_LDL, { meta: { versionId: 'v#2|b' } }))]);
    expect(file.labValues[0].externalId).toBe(`${SOURCE}|Observation|ldlcholesterol#|v2b|final|4.6||mmol/L`);
  });

  it('AC5: a server that keeps the same versionId (not a number) while the value changes sends a new version', () => {
    const first = run(empty(), [rec(obs(R4_LDL, { meta: { versionId: 'a' } }))]).file;
    const { file, counts } = run(first, [rec(obs(R4_LDL, { meta: { versionId: 'a' }, status: 'amended', valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.filter((m) => m.status === 'active').map((m) => m.value)).toEqual([3.9]);
  });

  it('AC5, AC6: an amendment that changes only the comparator, meta unchanged and absent, is a correction', () => {
    const exact = { resourceType: 'Observation', id: 'psa', status: 'final', effectiveDateTime: '2026-10-21', code: { coding: [{ system: 'http://loinc.org', code: '2857-1' }] } };
    const first = run(empty(), [rec({ ...exact, valueQuantity: { value: 0.01, unit: 'ng/mL' } })]).file;
    const { file, counts } = run(first, [rec({ ...exact, valueQuantity: { value: 0.01, comparator: '<', unit: 'ng/mL' } })], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 0.01, comparator: '<' })]);
  });

  it('AC5: a version older than the active imported row never replaces it (by lastUpdated)', () => {
    const v1 = rec(obs(R4_LDL, { meta: { lastUpdated: '2026-10-22T10:00:00Z' } }));
    const v2 = rec(obs(R4_LDL, { meta: { lastUpdated: '2026-10-23T10:00:00Z' }, status: 'amended', valueQuantity: { value: 3.9, unit: 'mmol/L' } }));
    const held = run(empty(), [v2]).file;
    const { file, counts } = run(held, [v1, v2], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 2, notRead: 0 });
    expect(file).toBe(held);
  });

  it('AC5: a version older than the active imported row never replaces it (by integer versionId, no lastUpdated)', () => {
    const v1 = rec(obs(R4_LDL, { meta: { versionId: '9' } }));
    const v2 = rec(obs(R4_LDL, { meta: { versionId: '10' }, status: 'amended', valueQuantity: { value: 3.9, unit: 'mmol/L' } }));
    const held = run(empty(), [v2]).file;
    const { file, counts } = run(held, [v1, v2], LATER);
    expect(counts.alreadyInRecord).toBe(2);
    expect(file).toBe(held);
  });

  it('AC5, AC7: a stale withdrawal leaves the newer active row as it is', () => {
    const v2 = rec(obs(R4_LDL, { meta: { lastUpdated: '2026-10-23T10:00:00Z' }, status: 'amended', valueQuantity: { value: 3.9, unit: 'mmol/L' } }));
    const staleWithdrawal = rec(obs(R4_LDL, { meta: { lastUpdated: '2026-10-22T10:00:00Z' }, status: 'entered-in-error' }));
    const held = run(empty(), [v2]).file;
    const { file, counts } = run(held, [staleWithdrawal], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file).toBe(held);
  });

  it('AC5: an equal lastUpdated is not later: a new value under an unbumped lastUpdated is held back', () => {
    const at = { lastUpdated: '2026-10-22T10:00:00Z' };
    const held = run(empty(), [rec(obs(R4_LDL, { meta: at }))]).file;
    const { file, counts } = run(held, [rec(obs(R4_LDL, { meta: at, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(held);
  });
});

describe('US-72 AC6: amended or corrected', () => {
  it('AC6: a newer version with a new value replaces the row as a FHIR correction on its day', () => {
    const first = run(empty(), [rec(obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00-07:00' }))]).file;
    const old = first.labValues[0];
    const amended = obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00-07:00', status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } });
    const { file, counts } = run(first, [rec(amended)], LATER);
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues).toEqual([
      { ...old, status: 'entered-in-error' },
      expect.objectContaining({
        metricName: 'ldl', value: 3.9, recordedAt: old.recordedAt, createdAt: LATER, source: 'health_records', status: 'active',
        correctsId: old.id, externalId: `${SOURCE}|Observation|ldlcholesterol#|2|amended|3.9||mmol/L`,
      }),
    ]);
    expect(file.meta.updatedAt).toBe(LATER);
  });

  it('AC5, AC6: a newer version with the same value, unit and comparator appends only a version marker (Codex R1)', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const old = first.labValues[0];
    const { file, counts } = run(first, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file.labValues).toEqual([
      old,
      expect.objectContaining({
        metricName: 'ldl', value: 4.6, recordedAt: old.recordedAt, createdAt: LATER, source: 'health_records',
        status: 'entered-in-error', correctsId: null, externalId: `${SOURCE}|Observation|ldlcholesterol#|2|amended|4.6||mmol/L|m`,
      }),
    ]);
    expect(isVersionMarker(file.labValues[1])).toBe(true);
    // The marker is remembered: the same version again changes nothing.
    expect(run(file, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LATER).file).toBe(file);
  });

  it('AC5: final, amended and corrected are alike: a re-stamp of the same value is a marker whatever its status', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const { file, counts } = run(first, [
      rec(obs(R4_LDL, { status: 'corrected', meta: { versionId: '2' } })),
      rec(obs(R4_LDL, { status: 'final', meta: { versionId: '3' } })),
    ], LATER);
    expect(counts.alreadyInRecord).toBe(2);
    expect(file.labValues.map((m) => [m.status, m.correctsId])).toEqual([['active', null], ['entered-in-error', null], ['entered-in-error', null]]);
  });

  it('AC5, AC6: v1, then v3 with the same value, then an unseen older v2 is stale: nothing changes (re-check R1)', () => {
    const v1 = rec(obs(R4_LDL, { meta: { versionId: '1' } }));
    const v3 = rec(obs(R4_LDL, { meta: { versionId: '3' } }));
    const held = run(run(empty(), [v1]).file, [v3], LATER).file;
    expect(held.labValues.filter((m) => m.status === 'active').map((m) => m.externalId)).toEqual([`${SOURCE}|Observation|ldlcholesterol#|1|final|4.6||mmol/L`]);
    expect(held.labValues.map((m) => m.externalId)).toContain(`${SOURCE}|Observation|ldlcholesterol#|3|final|4.6||mmol/L|m`);
    for (const v2 of [
      rec(obs(R4_LDL, { meta: { versionId: '2' }, status: 'entered-in-error' })),
      rec(obs(R4_LDL, { meta: { versionId: '2' }, status: 'amended', valueQuantity: { value: 3.9, unit: 'mmol/L' } })),
    ]) {
      const { file, counts } = run(held, [v2], LATER);
      expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
      expect(file).toBe(held);
    }
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
    expect(file.labValues.filter((m) => m.status === 'active').map((m) => m.value)).toEqual([3.9]);
  });

  it('AC6: a version that moves the result to another day is not read, and the row stays', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const moved = obs(R4_LDL, { meta: { versionId: '2' }, effectiveDateTime: '2026-10-20', valueQuantity: { value: 3.9, unit: 'mmol/L' } });
    const { file, counts } = run(first, [rec(moved)], LATER);
    expect(counts.notRead).toBe(1);
    expect(file).toBe(first);
  });

  // FHIR's `issued` is when THIS version was released, so an amendment of a result
  // dated by `issued` carries a later one: that is not a move (both reviewers).
  const ISSUED_ONLY = (value: number, issued: string, fields: Record<string, unknown> = {}) =>
    lab('2093-3', value, 'mg/dL', { effectiveDateTime: undefined, issued, ...fields });

  it('AC3, AC6: an amendment dated by a later `issued` corrects the result on its first day', () => {
    const first = run(empty(), [rec(ISSUED_ONLY(190, '2026-10-21T14:34:00+01:00'))]).file;
    const old = first.labValues[0];
    const { file, counts } = run(first, [rec(ISSUED_ONLY(240, '2026-10-24T09:00:00+01:00', { status: 'amended', meta: { versionId: '2' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({
      metricName: 'total_cholesterol', recordedAt: old.recordedAt, correctsId: old.id,
    })]);
    expect(file.labValues.filter((m) => m.status === 'active')[0].recordedAt.slice(0, 10)).toBe('2026-10-21');
  });

  it('AC3, AC5: a same-value version with a later `issued` is a marker on the first day', () => {
    const first = run(empty(), [rec(ISSUED_ONLY(190, '2026-10-21T14:34:00+01:00'))]).file;
    const { file, counts } = run(first, [rec(ISSUED_ONLY(190, '2026-10-24T09:00:00+01:00', { meta: { versionId: '2' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file.labValues.map((m) => [m.status, m.recordedAt])).toEqual([
      ['active', first.labValues[0].recordedAt], ['entered-in-error', first.labValues[0].recordedAt],
    ]);
  });

  it('AC3, AC6: a later-issued amendment of a withdrawn or hand-corrected result keeps its first day', () => {
    const first = run(empty(), [rec(ISSUED_ONLY(190, '2026-10-21T14:34:00+01:00'))]).file;
    const fixed = correctValue(first, { id: first.labValues[0].id, newValue: 5.5, now: LATER });
    if (!fixed.ok) throw new Error('setup');
    const { file, counts } = run(fixed.file, [rec(ISSUED_ONLY(240, '2026-10-24T09:00:00+01:00', { status: 'amended', meta: { versionId: '2' } }))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.filter((m) => m.status === 'active').map((m) => [m.source, m.recordedAt.slice(0, 10)])).toEqual([['health_records', '2026-10-21']]);
  });

  it('AC6: a version that adds an effective date to a result first dated by `issued` is not read when the day differs (the record cannot tell it from a move)', () => {
    const first = run(empty(), [rec(ISSUED_ONLY(190, '2026-10-21T14:34:00+01:00'))]).file;
    const { file, counts } = run(first, [rec(ISSUED_ONLY(240, '2026-10-24T09:00:00+01:00', { effectiveDateTime: '2026-10-20', meta: { versionId: '2' } }))], LATER);
    expect(counts.notRead).toBe(1);
    expect(file).toBe(first);
  });
});

describe('US-72 AC7 and AC8: withdrawn, and the person\'s call', () => {
  it('AC7: entered-in-error flips the imported row and appends only a marker of the withdrawal\'s version', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const { file, counts } = run(first, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '2' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 1, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues).toEqual([
      { ...first.labValues[0], status: 'entered-in-error' },
      expect.objectContaining({
        value: 4.6, recordedAt: first.labValues[0].recordedAt, status: 'entered-in-error', correctsId: null,
        source: 'health_records', externalId: `${SOURCE}|Observation|ldlcholesterol#|2|entered-in-error|4.6||mmol/L|m`,
      }),
    ]);
    expect(file.labValues.map((m) => isVersionMarker(m))).toEqual([false, true]);
    expect(file.meta.updatedAt).toBe(LATER);
  });

  it('AC7, AC5: v1, then its withdrawal v3, then an older final v2 in a later import stays out', () => {
    const v1 = run(empty(), [rec(obs(R4_LDL, { meta: { versionId: '1' } }))]).file;
    const withdrawn = run(v1, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '3' } }))], LATER).file;
    const { file, counts } = run(withdrawn, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file).toBe(withdrawn);
  });

  it('AC7, AC5: a withdrawal of a result the person already rejected is remembered, so an older final stays out', () => {
    const v1 = run(empty(), [rec(obs(R4_LDL, { meta: { versionId: '1' } }))]).file;
    const rejected: RoadmapFile = { ...v1, labValues: v1.labValues.map((m) => ({ ...m, status: 'entered-in-error' as const })) };
    const withdrawn = run(rejected, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '3' } }))], LATER);
    expect(withdrawn.counts.alreadyInRecord).toBe(1);
    expect(withdrawn.file.labValues).toHaveLength(2);
    const { file } = run(withdrawn.file, [rec(obs(R4_LDL, { meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(file).toBe(withdrawn.file);
  });

  it('AC7: a withdrawal already in the record still flips an active copy a merge brought back', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const withdrawal = rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '2' } }));
    const withdrawn = run(first, [withdrawal], LATER).file;
    // Another device's copy of v1, imported before it saw the withdrawal, came back active.
    const back: RoadmapFile = { ...withdrawn, labValues: [...withdrawn.labValues, { ...first.labValues[0], id: 'other-device' }] };
    const { file, counts } = run(back, [withdrawal], LATER);
    expect(counts.withdrawn).toBe(1);
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([]);
    expect(file.labValues).toHaveLength(3);
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

  it('AC8: a result the lab withdrew lands again when the lab sends a new version', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const withdrawn = run(first, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '2' } }))], LATER).file;
    const { file, counts } = run(withdrawn, [rec(obs(R4_LDL, { status: 'corrected', meta: { versionId: '3' }, valueQuantity: { value: 3.3, unit: 'mmol/L' } }))], LATER);
    expect(counts).toEqual({ added: 1, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues.map((m) => [m.value, m.status])).toEqual([[4.6, 'entered-in-error'], [4.6, 'entered-in-error'], [3.3, 'active']]);
  });

  it('AC8: a result the person marked entered-in-error stays out in that version, and lands in a new one with a new value', () => {
    const once = run(empty(), [rec(obs(R4_LDL))]).file;
    const rejected: RoadmapFile = { ...once, labValues: once.labValues.map((m) => ({ ...m, status: 'entered-in-error' as const })) };
    expect(run(rejected, [rec(obs(R4_LDL))], LATER).file).toBe(rejected);
    const { file, counts } = run(rejected, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(counts.added).toBe(1);
    expect(file.labValues.filter((m) => m.status === 'active').map((m) => m.externalId)).toEqual([`${SOURCE}|Observation|ldlcholesterol#|2|amended|3.9||mmol/L`]);
  });

  it('AC8: a re-stamp with the same value does not lift the person\'s rejection; it lands a marker only', () => {
    const once = run(empty(), [rec(obs(R4_LDL))]).file;
    const rejected: RoadmapFile = { ...once, labValues: once.labValues.map((m) => ({ ...m, status: 'entered-in-error' as const })) };
    const { file, counts } = run(rejected, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([]);
    expect(file.labValues.map((m) => isVersionMarker(m))).toEqual([false, true]);
  });

  it('AC8, AC9: a re-stamp with the same value does not override the person\'s hand edit', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const fixed = correctValue(first, { id: first.labValues[0].id, newValue: 4.2, now: LATER });
    if (!fixed.ok) throw new Error('setup');
    const { file, counts } = run(fixed.file, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 4.2, source: 'manual_correction' })]);
  });

  it('AC8: after the person\'s rejection, an unseen older version is stale and stays out', () => {
    const v2 = run(empty(), [rec(obs(R4_LDL, { meta: { versionId: '2' } }))]).file;
    const rejected: RoadmapFile = { ...v2, labValues: v2.labValues.map((m) => ({ ...m, status: 'entered-in-error' as const })) };
    const { file, counts } = run(rejected, [rec(obs(R4_LDL, { meta: { versionId: '1' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(counts.alreadyInRecord).toBe(1);
    expect(file).toBe(rejected);
  });

  it('AC8, AC9: a result the person corrected by hand is corrected again by the lab\'s new version', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const fixed = correctValue(first, { id: first.labValues[0].id, newValue: 4.2, now: LATER });
    if (!fixed.ok) throw new Error('setup');
    const theirs = fixed.file.labValues.find((m) => m.status === 'active')!;
    const same = run(fixed.file, [rec(obs(R4_LDL))], LATER);
    expect(same.file).toBe(fixed.file);
    const { file, counts } = run(fixed.file, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.find((m) => m.id === theirs.id)?.status).toBe('entered-in-error');
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 3.9, correctsId: theirs.id, source: 'health_records' })]);
  });

  it('AC7: a withdrawn result frees its day for a typed value', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const withdrawn = run(first, [rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '2' } }))], LATER).file;
    expect(appendMeasurement(withdrawn, { metricType: 'ldl', value: 3, recordedAt: '2026-10-21', now: LATER }).ok).toBe(true);
  });
});

describe('US-72 AC9: the import wins a conflict', () => {
  it('AC9: a typed value with a different value on the day is corrected by the result, keeping its recordedAt', () => {
    const typed = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error('setup');
    const theirs = typed.file.labValues[0];
    const { file, counts } = run(typed.file, [rec(obs(R4_LDL, { effectiveDateTime: '2026-10-21T08:30:00-07:00' }))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues).toEqual([
      { ...theirs, status: 'entered-in-error' },
      expect.objectContaining({
        metricName: 'ldl', value: 4.6, recordedAt: theirs.recordedAt, createdAt: LATER, source: 'health_records', status: 'active',
        correctsId: theirs.id, externalId: `${SOURCE}|Observation|ldlcholesterol#|1|final|4.6||mmol/L`,
      }),
    ]);
  });

  it('AC9: a typed value with the same value appends nothing; the result is counted as already in the record', () => {
    const typed = appendMeasurement(empty(), { metricType: 'ldl', value: 4.6, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error('setup');
    const { file, counts } = run(typed.file, [rec(obs(R4_LDL))], LATER);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file).toBe(typed.file);
  });

  it('AC9: a typed exact value with the result printed as a limit is a conflict', () => {
    const typed = appendMeasurement(empty(), { metricType: 'psa', value: 0.01, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error('setup');
    const { file, counts } = run(typed.file, [rec(lab('2857-1', 0.01, 'ng/mL', { valueQuantity: { value: 0.01, unit: 'ng/mL', comparator: '<' } }))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ comparator: '<', source: 'health_records' })]);
  });

  it.each(['manual', 'manual_correction', 'lab_import', 'lab_import_edited', 'apple_health'] as const)('AC9: an active %s row with another value is corrected', (source) => {
    const typed = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: NOW });
    if (!typed.ok) throw new Error('setup');
    const held: RoadmapFile = { ...typed.file, labValues: typed.file.labValues.map((m) => ({ ...m, source })) };
    const { file, counts } = run(held, [rec(obs(R4_LDL))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.map((m) => [m.source, m.status, m.value])).toEqual([[source, 'entered-in-error', 3.1], ['health_records', 'active', 4.6]]);
  });

  it('AC9: an uploaded lab value on the day is corrected by a different result, and kept by the same one', () => {
    const uploaded = appendLabValue(empty(), { metricName: 'ferritin', value: 90, unit: 'µg/L', recordedAt: '2026-10-21', now: NOW, source: 'lab_import' });
    if (!uploaded.ok) throw new Error('setup');
    const same = run(uploaded.file, [rec(lab('2276-4', 90, 'ng/mL'))], LATER);
    expect(same.counts.alreadyInRecord).toBe(1);
    expect(same.file).toBe(uploaded.file);
    const { file, counts } = run(uploaded.file, [rec(lab('2276-4', 85, 'ng/mL'))], LATER);
    expect(counts.corrected).toBe(1);
    expect(file.labValues.map((l) => [l.source, l.status, l.value, l.correctsId])).toEqual([
      ['lab_import', 'entered-in-error', 90, null], ['health_records', 'active', 85, uploaded.file.labValues[0].id],
    ]);
  });

  // Adversary R2 (Brad: "the Apple Health import is the source of truth"): a result that lost
  // its day in a merge was not rejected by the person, so the lab's next version wins it back.
  const LAST = '2026-11-02T10:00:00.000Z';
  it('AC9: a typed value that beat the result in a merge is corrected back by the lab\'s re-stamp', () => {
    const phone = run(empty(), [rec(obs(R4_LDL))]).file;
    const web = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: LATER });
    if (!web.ok) throw new Error('setup');
    const merged = mergeFiles(phone, web.file, { deviceId: 'phone', now: LATER });
    const typed = merged.labValues.find((m) => m.status === 'active')!;
    expect(typed).toMatchObject({ value: 3.1, source: 'manual' });
    const { file, counts } = run(merged, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LAST);
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues.find((m) => m.id === typed.id)?.status).toBe('entered-in-error');
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([
      expect.objectContaining({ value: 4.6, correctsId: typed.id, source: 'health_records', recordedAt: typed.recordedAt }),
    ]);
  });

  it('AC9: the same value that beat the result in a merge lands a marker only', () => {
    const phone = run(empty(), [rec(obs(R4_LDL))]).file;
    const web = appendMeasurement(empty(), { metricType: 'ldl', value: 4.6, recordedAt: '2026-10-21', now: LATER });
    if (!web.ok) throw new Error('setup');
    const merged = mergeFiles(phone, web.file, { deviceId: 'phone', now: LATER });
    const { file, counts } = run(merged, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LAST);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 4.6, source: 'manual' })]);
    expect(file.labValues.map((m) => isVersionMarker(m))).toEqual([false, false, true]);
  });

  it('AC8: the person\'s corrections of the result on another device, merged in, still stand against a re-stamp', () => {
    const phone = run(empty(), [rec(obs(R4_LDL))]).file;
    const once = correctValue(phone, { id: phone.labValues[0].id, newValue: 4.2, now: LATER });
    if (!once.ok) throw new Error('setup');
    const twice = correctValue(once.file, { id: once.file.labValues.find((m) => m.status === 'active')!.id, newValue: 3.1, now: LATER });
    if (!twice.ok) throw new Error('setup');
    const merged = mergeFiles(phone, twice.file, { deviceId: 'phone', now: LATER });
    const { file, counts } = run(merged, [rec(obs(R4_LDL, { status: 'amended', meta: { versionId: '2' } }))], LAST);
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 3.1, source: 'manual_correction' })]);
  });

  // Adversary R1 (re-check): a person's correction is their call only when it reaches the result's
  // newest landed version; one of an older version that a merge put over the lab's amendment lost a merge.
  const at = (h: number) => `2026-11-02T${String(h).padStart(2, '0')}:00:00.000Z`;
  const ldl = (value: number, versionId: string, status = 'amended') =>
    rec(obs(R4_LDL, { status, meta: { versionId }, valueQuantity: { value, unit: 'mmol/L' } }));
  it('AC8, AC9: a correction of an older version merged over the lab\'s amendment is a lost merge; the re-stamp wins', () => {
    const phone1 = run(empty(), [ldl(4.6, '1', 'final')], at(1)).file;
    const web = correctValue(phone1, { id: phone1.labValues[0].id, newValue: 4.2, now: at(3) });
    if (!web.ok) throw new Error('setup');
    const phone2 = run(phone1, [ldl(3.0, '2')], at(2)).file;
    const merged = mergeFiles(phone2, web.file, { deviceId: 'phone', now: at(4) });
    expect(merged.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 4.2, source: 'manual_correction' })]);
    const { file, counts } = run(merged, [ldl(3.0, '3')], at(5));
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 3.0, source: 'health_records' })]);
  });

  it('AC8, AC9: the same correction made before the amendment arrives is corrected by it (the race\'s control)', () => {
    const phone1 = run(empty(), [ldl(4.6, '1', 'final')], at(1)).file;
    const web = correctValue(phone1, { id: phone1.labValues[0].id, newValue: 4.2, now: at(3) });
    if (!web.ok) throw new Error('setup');
    const { file, counts } = run(web.file, [ldl(3.0, '2')], at(5));
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 3.0, source: 'health_records' })]);
  });

  it('AC5, AC9: a lost merge\'s marker carries the version\'s content, so a deleted day stays empty for it', () => {
    const phone = run(empty(), [ldl(4.6, '1', 'final')], at(1)).file;
    const web = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: at(2) });
    if (!web.ok) throw new Error('setup');
    const merged = mergeFiles(phone, web.file, { deviceId: 'phone', now: at(2) });
    const v2 = run(merged, [ldl(3.1, '2')], at(3));
    expect(v2.counts.alreadyInRecord).toBe(1);
    const marker = v2.file.labValues.find((m) => isVersionMarker(m))!;
    expect(marker).toMatchObject({ value: 3.1, unit: 'mmol/L', referenceLow: null, referenceHigh: 3.0 });
    expect(marker.comparator).toBeUndefined();
    // The person deletes the day (a rejection: the typed row goes, nothing replaces it).
    const deleted: RoadmapFile = { ...v2.file, labValues: v2.file.labValues.map((m) => (m.status === 'active' ? { ...m, status: 'entered-in-error' as const } : m)) };
    const same = run(deleted, [ldl(3.1, '3')], at(5));
    expect(same.counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(same.file.labValues.filter((m) => m.status === 'active')).toEqual([]);
    const other = run(deleted, [ldl(4.6, '3')], at(5));
    expect(other.counts).toEqual({ added: 1, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(other.file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 4.6, source: 'health_records' })]);
  });

  it.each([['A to B to A', true], ['A to A', false]])('AC9: a correction chain that loops (%s) ends, and the result corrects the day', (_name, viaB) => {
    const phone = run(empty(), [ldl(4.6, '1', 'final')], at(1)).file;
    const typed = appendMeasurement(empty(), { metricType: 'ldl', value: 3.1, recordedAt: '2026-10-21', now: at(2) });
    if (!typed.ok) throw new Error('setup');
    const merged = mergeFiles(phone, typed.file, { deviceId: 'phone', now: at(2) });
    const a = merged.labValues.find((m) => m.status === 'active')!;
    const b = { ...a, id: 'row-b', status: 'entered-in-error' as const, correctsId: a.id };
    const looped: RoadmapFile = {
      ...merged,
      labValues: [...merged.labValues.map((m) => (m.id === a.id ? { ...m, correctsId: viaB ? b.id : a.id } : m)), ...(viaB ? [b] : [])],
    };
    const { file, counts } = run(looped, [ldl(3.0, '2')], at(5));
    expect(counts).toEqual({ added: 0, corrected: 1, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 3.0, correctsId: a.id })]);
  });

  it('AC9: a second institution\'s result for the same test and day does not replace the first', () => {
    const { file, counts } = run(empty(), [rec(obs(R4_LDL)), rec(obs(R4_LDL, { valueQuantity: { value: 4.4, unit: 'mmol/L' } }), { sourceId: 'hk-source:Other' })]);
    expect(counts).toMatchObject({ added: 1, alreadyInRecord: 1 });
    expect(file.labValues.map((m) => m.value)).toEqual([4.6]);
  });
});

describe('US-72 AC10: erase', () => {
  it('AC10: a result drawn before the record\'s erase does not land; one drawn after does', () => {
    const erased: RoadmapFile = { ...empty(), meta: { ...empty().meta, erasedAt: '2026-10-22T00:00:00.000Z' } };
    const { file, counts } = run(erased, [rec(obs(R4_LDL)), rec(obs(DSTU2_HDL, { effectiveDateTime: '2026-10-23' }), { fhirVersion: DSTU2 })]);
    expect(counts).toMatchObject({ added: 1, notRead: 1 });
    expect(file.labValues.map((m) => m.metricName)).toEqual(['hdl']);
  });
});

describe('US-72 AC12: the record schema and the web', () => {
  const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../docs/health-roadmap-file.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, validateFormats: false }).compile(schema);

  it('AC12: a record holding health_records rows, a lab value\'s externalId included, validates', () => {
    const { file } = run(empty(), [rec(obs(R4_LDL)), rec(lab('2276-4', 85, 'ng/mL'))]);
    const ok = validate(JSON.parse(JSON.stringify(file)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('AC12 (US-65): a lab value\'s externalId is read as a measurement\'s is: a string, null or absent', () => {
    const row = { id: 'l1', metricName: 'ferritin', value: 85, unit: 'µg/L', recordedAt: '2026-10-21T00:00:00.000Z' };
    expect([undefined, null, 'src|Observation|x#|1|final|85||ng/mL'].map((externalId) => isReadableRow('labValues', { ...row, externalId }))).toEqual([true, true, true]);
    expect([5, { id: 1 }, ['x']].map((externalId) => isReadableRow('labValues', { ...row, externalId }))).toEqual([false, false, false]);
  });

  it('AC12: merge and migrate keep a lab value\'s externalId', () => {
    const { file } = run(empty(), [rec(lab('2276-4', 85, 'ng/mL'))]);
    const opts = { deviceId: 'laptop', now: LATER };
    const merged = migrateFile(JSON.parse(JSON.stringify(mergeFiles(file, empty(), opts))), opts);
    expect(merged.labValues[0].externalId).toBe(`${SOURCE}|Observation|obs-2276-4#|1|final|85||ng/mL`);
    // A merged record re-read on the phone is still deduplicated by it.
    expect(run(merged, [rec(lab('2276-4', 85, 'ng/mL'))], LATER).counts.alreadyInRecord).toBe(1);
  });
});

describe('US-72 AC5: version markers', () => {
  const withdrawal = rec(obs(R4_LDL, { status: 'entered-in-error', meta: { versionId: '3' } }));

  it('AC5: a marker never changes another row\'s status in a merge, either way round, on either device', () => {
    const first = run(empty(), [rec(obs(R4_LDL))]).file;
    const marked = run(first, [rec(obs(R4_LDL, { meta: { versionId: '2' } }))], LATER).file;
    const opts = { deviceId: 'laptop', now: LATER };
    for (const merged of [mergeFiles(marked, first, opts), mergeFiles(first, marked, opts)]) {
      expect(merged.labValues.map((m) => [m.externalId?.split('#')[1], m.status, m.correctsId]).sort()).toEqual([
        ['|1|final|4.6||mmol/L', 'active', null], ['|2|final|4.6||mmol/L|m', 'entered-in-error', null],
      ]);
    }
  });

  it('AC5: readers leave markers out as any entered-in-error row', () => {
    const { file } = run(run(empty(), [rec(obs(R4_LDL))]).file, [rec(obs(R4_LDL, { meta: { versionId: '2' } }))], LATER);
    expect(file.labValues.filter((m) => m.status === 'active')).toHaveLength(1);
  });

  it('AC5, AC7: a real withdrawn result, a corrected one and a rejected one are never markers', () => {
    const v1 = run(empty(), [rec(obs(R4_LDL, { meta: { versionId: '1' } }))]).file;
    const withdrawn = run(v1, [withdrawal], LATER).file;
    expect(withdrawn.labValues.map((m) => isVersionMarker(m))).toEqual([false, true]);
    // 4.6, corrected to 3.9, corrected back to 4.6: the first 4.6 is a corrected result, shown.
    const v2 = run(v1, [rec(obs(R4_LDL, { meta: { versionId: '2' }, valueQuantity: { value: 3.9, unit: 'mmol/L' } }))], LATER).file;
    const back = run(v2, [rec(obs(R4_LDL, { meta: { versionId: '4' } }))], '2026-11-02T10:00:00.000Z').file;
    expect(back.labValues.map((m) => [m.value, m.status, isVersionMarker(m)])).toEqual([
      [4.6, 'entered-in-error', false], [3.9, 'entered-in-error', false], [4.6, 'active', false],
    ]);
    const rejected = v1.labValues.map((m) => ({ ...m, status: 'entered-in-error' as const }));
    expect(isVersionMarker(rejected[0])).toBe(false);
  });

  it('AC5: a marker in the same batch as the row it copies, versions unordered, is hidden and the result shown', () => {
    const { file } = run(empty(), [rec(obs(R4_LDL, { meta: { versionId: 'a' } })), rec(obs(R4_LDL, { meta: { versionId: 'b' } }))]);
    expect(file.labValues.map((m) => [m.status, isVersionMarker(m)])).toEqual([['active', false], ['entered-in-error', true]]);
  });
});

describe('US-72 AC2: UCUM unit spellings', () => {
  it('reads UCUM\'s bracket and brace forms, as the code or the printed unit, as the spellings the record knows', () => {
    const days = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
    const results = [lab('3016-3', 2.1, 'm[IU]/L'), lab('3016-3', 2.1, 'u[IU]/mL'), lab('4548-4', 6.5, '%{HbA1c}'), lab('98979-8', 90, 'mL/min/{1.73_m2}')];
    const asCode = results.map((r, i) => rec({ ...r, id: `code${i}`, effectiveDateTime: days[i] }));
    // The same results with no UCUM code: the printed unit is read the same way.
    const asPrinted = results.map((r, i) => rec({
      ...r, id: `printed${i}`, effectiveDateTime: days[i],
      valueQuantity: { value: (r.valueQuantity as { value: number }).value, unit: (r.valueQuantity as { unit: string }).unit },
    }));
    for (const batch of [asCode, asPrinted]) {
      const { file, counts } = run(empty(), batch);
      expect(counts).toMatchObject({ added: 4, notRead: 0 });
      expect(file.labValues.filter((v) => !v.core).map((v) => [v.metricName, v.value, v.unit])).toEqual([
        ['tsh', 2.1, 'mIU/L'], ['tsh', 2.1, 'mIU/L'], ['egfr', 90, 'mL/min/1.73m²'],
      ]);
      expect(file.labValues.filter((v) => v.core).map((m) => [m.metricName, m.value])).toEqual([['hba1c', toCanonicalValue('hba1c', 6.5, 'conventional')]]);
    }
  });

  it('a brace after a space is not UCUM: the result is not read', () => {
    const { file, counts } = run(empty(), [rec(lab('2089-1', 2.9, 'mmol/L {H}'))]);
    expect(counts).toMatchObject({ added: 0, notRead: 1 });
    expect(file.labValues).toEqual([]);
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

describe('US-72 AC2: eGFR codes', () => {
  it('AC2: an MDRD eGFR (33914-3) lands as egfr (Brad 2026-11-02); the race-specific MDRD codes do not', () => {
    const { file, counts } = run(empty(), [
      rec(lab('33914-3', 72, 'mL/min/{1.73_m2}')),
      rec(lab('48642-3', 72, 'mL/min/{1.73_m2}', { effectiveDateTime: '2026-10-22' })),
      rec(lab('48643-1', 72, 'mL/min/{1.73_m2}', { effectiveDateTime: '2026-10-23' })),
    ]);
    expect(counts).toMatchObject({ added: 1, notRead: 2 });
    expect(file.labValues).toEqual([expect.objectContaining({ metricName: 'egfr', value: 72, unit: 'mL/min/1.73m²', source: 'health_records' })]);
  });
});

describe('US-72 AC2: the SI labs\' molar and mass-or-moles lipid codes', () => {
  it.each([
    ['14646-4', 'hdl', 1.3], ['39469-2', 'ldl', 2.9], ['22748-8', 'ldl', 2.9],
    ['14647-2', 'total_cholesterol', 5.2], ['35200-5', 'total_cholesterol', 5.2],
    ['14927-8', 'triglycerides', 1.4], ['35217-9', 'triglycerides', 1.4], ['3043-7', 'triglycerides', 1.4],
  ])('%s in mmol/L lands as %s', (code, metric, value) => {
    const o = obs({ ...R4_LDL, id: `x${code}` }, {
      code: { coding: [{ system: 'http://loinc.org', code }] },
      valueQuantity: { value, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' },
      referenceRange: undefined,
    });
    const { file, counts } = importHealthRecords(empty(), [rec(o)], { now: NOW });
    expect(counts.added).toBe(1);
    expect(file.labValues).toEqual([expect.objectContaining({ metricName: metric, value, source: 'health_records', status: 'active' })]);
  });
});

describe('US-72 AC5, AC6, AC7, AC8: replays, marked markers, moves and a lab\'s reinstatement (re-check R3)', () => {
  const at = (hour: number) => `2026-11-02T${String(hour).padStart(2, '0')}:00:00.000Z`;
  const version = (id: number, fields: Record<string, unknown> = {}) => rec(obs(R4_LDL, { meta: { versionId: String(id) }, ...fields }));
  const value = (v: number) => ({ valueQuantity: { value: v, unit: 'mmol/L' } });
  const withdrawalOf = (id: number) => version(id, { status: 'entered-in-error' });
  const rejectAll = (f: RoadmapFile): RoadmapFile => ({ ...f, labValues: f.labValues.map((m) => ({ ...m, status: 'entered-in-error' as const })) });
  const shown = (f: RoadmapFile) => f.labValues.map((m) => [m.value, m.status, isVersionMarker(m)]);

  it('AC7: a replayed withdrawal never withdraws a newer version that landed after it, in one batch or alone', () => {
    const v1 = version(1);
    const v2 = withdrawalOf(2);
    const v3 = version(3, { status: 'amended', ...value(6.0) });
    const held = run(run(run(empty(), [v1], at(1)).file, [v2], at(2)).file, [v3], at(3)).file;
    expect(held.labValues.filter((m) => m.status === 'active').map((m) => m.value)).toEqual([6.0]);
    for (const batch of [[v1, v2, v3], [v1], [v2], [v3]]) {
      const { file, counts } = run(held, batch, at(4));
      expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: batch.length, notRead: 0 });
      expect(file).toBe(held);
    }
  });

  it('AC5: a marker is marked in its externalId; a result that filled the slot and was then withdrawn or corrected by hand is still shown (Codex R2)', () => {
    const v1 = run(empty(), [version(1)], at(1)).file;
    const v2 = run(v1, [version(2, { status: 'amended', ...value(3.9) })], at(2)).file;
    const v3 = run(v2, [withdrawalOf(3)], at(3)).file;
    const v4 = run(v3, [version(4, { status: 'corrected' })], at(4));
    expect(v4.counts.added).toBe(1);
    const v4Row = v4.file.labValues[v4.file.labValues.length - 1];
    expect(v4.file.labValues.map((m) => m.externalId?.split('#')[1])).toEqual([
      '|1|final|4.6||mmol/L', '|2|amended|3.9||mmol/L', '|3|entered-in-error|4.6||mmol/L|m', '|4|corrected|4.6||mmol/L',
    ]);
    const withdrawn = run(v4.file, [withdrawalOf(5)], at(5)).file;
    expect(shown(withdrawn)).toEqual([
      [4.6, 'entered-in-error', false], [3.9, 'entered-in-error', false], [3.9, 'entered-in-error', true],
      [4.6, 'entered-in-error', false], [4.6, 'entered-in-error', true],
    ]);
    const fixed = correctValue(v4.file, { id: v4Row.id, newValue: 4.2, now: at(5) });
    if (!fixed.ok) throw new Error('setup');
    expect(fixed.file.labValues.filter((m) => m.id === v4Row.id).map((m) => [m.status, isVersionMarker(m)])).toEqual([['entered-in-error', false]]);
  });

  it('AC5, AC8: three rejected results with alternating values are all shown; none is taken for a marker (adversary R3)', () => {
    let file = rejectAll(run(empty(), [version(1)], at(1)).file);
    file = rejectAll(run(file, [version(2, value(3.9))], at(2)).file);
    file = rejectAll(run(file, [version(3)], at(3)).file);
    expect(shown(file)).toEqual([[4.6, 'entered-in-error', false], [3.9, 'entered-in-error', false], [4.6, 'entered-in-error', false]]);
  });

  it('AC6: a new version on another day is not read when the result was corrected by hand', () => {
    const first = run(empty(), [version(1)], at(1)).file;
    const fixed = correctValue(first, { id: first.labValues[0].id, newValue: 4.2, now: at(2) });
    if (!fixed.ok) throw new Error('setup');
    const { file, counts } = run(fixed.file, [version(2, { effectiveDateTime: '2026-10-20', ...value(3.9) })], at(3));
    expect(counts.notRead).toBe(1);
    expect(file).toBe(fixed.file);
  });

  it('AC6: a new version on another day, or of another test, is not read when the lab withdrew the result', () => {
    const withdrawn = run(run(empty(), [version(1)], at(1)).file, [withdrawalOf(2)], at(2)).file;
    for (const moved of [
      version(3, { effectiveDateTime: '2026-10-20', ...value(3.9) }),
      version(3, { code: { coding: [{ system: 'http://loinc.org', code: '2093-3' }] }, ...value(5.2) }),
    ]) {
      const { file, counts } = run(withdrawn, [moved], at(3));
      expect(counts.notRead).toBe(1);
      expect(file).toBe(withdrawn);
    }
  });

  it('AC8: after the lab\'s own withdrawal, its newer version with the same value lands (fills the slot, or corrects a typed value)', () => {
    const withdrawn = run(run(empty(), [version(1)], at(1)).file, [withdrawalOf(2)], at(2)).file;
    const back = run(withdrawn, [version(3, { status: 'corrected' })], at(3));
    expect(back.counts).toEqual({ added: 1, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 });
    expect(back.file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({
      value: 4.6, source: 'health_records', externalId: `${SOURCE}|Observation|ldlcholesterol#|3|corrected|4.6||mmol/L`,
    })]);
    const typed = appendMeasurement(withdrawn, { metricType: 'ldl', value: 4.2, recordedAt: '2026-10-21', now: at(3) });
    if (!typed.ok) throw new Error('setup');
    const theirs = typed.file.labValues[typed.file.labValues.length - 1];
    const over = run(typed.file, [version(3)], at(4));
    expect(over.counts.corrected).toBe(1);
    expect(over.file.labValues.filter((m) => m.status === 'active')).toEqual([expect.objectContaining({ value: 4.6, correctsId: theirs.id })]);
  });

  it('AC8: after the person\'s own rejection, a newer version with the same value is a marker only', () => {
    const rejected = rejectAll(run(empty(), [version(1)], at(1)).file);
    const { file, counts } = run(rejected, [version(2, { status: 'corrected' })], at(2));
    expect(counts).toEqual({ added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 1, notRead: 0 });
    expect(shown(file)).toEqual([[4.6, 'entered-in-error', false], [4.6, 'entered-in-error', true]]);
  });
});
