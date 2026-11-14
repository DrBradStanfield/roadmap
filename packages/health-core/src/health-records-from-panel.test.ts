// US-72 AC17: a result HealthKit took out of a lab's panel. Apple hands each contained
// Observation of a DiagnosticReport over as its own `labResultRecord`, with the id
// `DiagnosticReport/<report id>#<result id>`. Synthetic values throughout.
import { describe, expect, it } from 'vitest';
import { importHealthRecords, type ClinicalRecordInput } from './health-records-import';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const NOW = '2026-11-02T08:00:00.000Z';
const LATER = '2026-11-02T09:00:00.000Z';
const SOURCE = 'com.apple.public.health.clinical.00000000-0000-0000-0000-000000000000';
const NONE = { added: 0, corrected: 0, withdrawn: 0, alreadyInRecord: 0, notRead: 0 };

function empty(): RoadmapFile {
  return createEmptyFile({ deviceId: 'phone', now: '2026-10-01T00:00:00.000Z' });
}

/** An LDL result as HealthKit hands it over: its own date and status, a profile-only meta. */
function result(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Observation', id, status: 'final', meta: { profile: ['http://fhir.org/guides/argonaut/StructureDefinition/argo-observationresults'] },
    category: { coding: [{ system: 'http://hl7.org/fhir/observation-category', code: 'laboratory' }] },
    code: { coding: [{ system: 'http://loinc.org', code: '13457-7' }, { system: 'http://example.org/lab/testCodes', code: '000000' }] },
    effectiveDateTime: '2026-10-21T08:00:00-04:00', issued: '2026-10-22T09:00:00-04:00',
    valueQuantity: { value: 2.6, unit: 'mmol/L', system: 'http://unitsofmeasure.org' },
    ...fields,
  };
}

function rec(json: object, extra: Partial<ClinicalRecordInput> = {}): ClinicalRecordInput {
  return { sourceId: SOURCE, resourceType: 'Observation', fhirVersion: '1.0.2', json: JSON.stringify(json), ...extra };
}

function run(file: RoadmapFile, records: ClinicalRecordInput[], now = NOW) {
  return importHealthRecords(file, records, { now });
}

describe('US-72 AC17: a result HealthKit took out of a panel', () => {
  it('lands, under AC15\'s identity for that result (source, DiagnosticReport, report id, result id)', () => {
    const { file, counts } = run(empty(), [rec(result('DiagnosticReport/12345678901.2026.LAB.00000001.2026-10-21.000001#c0ffee00-0000-4000-8000-000000000001'))]);
    expect(counts).toEqual({ ...NONE, added: 1 });
    expect(file.labValues.map((l) => [l.metricName, l.value, l.source, l.status, l.recordedAt])).toEqual([
      ['ldl', 2.6, 'health_records', 'active', '2026-10-21T08:00:00.000-04:00'],
    ]);
    expect(String(file.labValues[0].externalId).split('#')[0])
      .toBe(`${SOURCE}|DiagnosticReport|12345678901.2026.LAB.00000001.2026-10-21.000001|c0ffee00-0000-4000-8000-000000000001`);
  });

  it('read again, or arriving as the panel itself, it is the same result: nothing new lands', () => {
    const split = rec(result('DiagnosticReport/panel-1#r1'));
    const first = run(empty(), [split]).file;
    expect(run(first, [split], LATER).counts).toEqual({ ...NONE, alreadyInRecord: 1 });
    const { meta: _m, ...inner } = result('r1');
    const panel = rec({
      resourceType: 'DiagnosticReport', id: 'panel-1', status: 'final', contained: [inner], result: [{ reference: '#r1' }],
    }, { resourceType: 'DiagnosticReport' });
    const after = run(first, [panel], LATER);
    expect(after.counts.added + after.counts.corrected).toBe(0);
    expect(after.file.labValues.filter((l) => l.status === 'active')).toHaveLength(1);
  });

  // The two copies carry different version stamps: the contained one takes its report's
  // `meta` (dom-4), the split copy keeps its own profile-only meta.
  describe('arriving both ways with different version stamps', () => {
    const split = rec(result('DiagnosticReport/panel-1#r1'));
    const { meta: _m, ...inner } = result('r1');
    const panel = rec({
      resourceType: 'DiagnosticReport', id: 'panel-1', status: 'final', meta: { lastUpdated: '2026-10-22T13:00:00Z' },
      contained: [inner], result: [{ reference: '#r1' }],
    }, { resourceType: 'DiagnosticReport' });
    const rows = (f: RoadmapFile) => f.labValues.map((l) => [l.metricName, l.value, l.status, l.recordedAt, String(l.externalId).endsWith('|m')]);

    for (const [order, first, second] of [['panel first', panel, split], ['split copy first', split, panel]] as const) {
      it(`${order}: no second reading; the second copy counts as already in the record and lands one entered-in-error version marker`, () => {
        const a = run(empty(), [first]);
        expect(a.counts).toEqual({ ...NONE, added: 1 });
        const b = run(a.file, [second], LATER);
        expect(b.counts).toEqual({ ...NONE, alreadyInRecord: 1 });
        expect(rows(b.file)).toEqual([
          ['ldl', 2.6, 'active', '2026-10-21T08:00:00.000-04:00', false],
          ['ldl', 2.6, 'entered-in-error', '2026-10-21T08:00:00.000-04:00', true],
        ]);
      });
    }
  });

  it('two panels with the same result id are two results', () => {
    const { counts } = run(empty(), [rec(result('DiagnosticReport/panel-1#r1')), rec(result('DiagnosticReport/panel-2#r1', {
      code: { coding: [{ system: 'http://loinc.org', code: '2085-9' }] }, valueQuantity: { value: 1.3, unit: 'mmol/L' },
    }))]);
    expect(counts).toEqual({ ...NONE, added: 2 });
  });

  it('a later version of the result corrects it', () => {
    const first = run(empty(), [rec(result('DiagnosticReport/panel-1#r1'))]).file;
    const { file, counts } = run(first, [rec(result('DiagnosticReport/panel-1#r1', { status: 'amended', valueQuantity: { value: 2.3, unit: 'mmol/L' } }))], LATER);
    expect(counts).toEqual({ ...NONE, corrected: 1 });
    expect(file.labValues.filter((l) => l.status === 'active').map((l) => l.value)).toEqual([2.3]);
  });

  it('not read: any other id with a "/" or "#", either part empty or over 64 characters, or a bad character', () => {
    const bad = [
      'Observation/panel-1#r1', 'DiagnosticReport/#r1', 'DiagnosticReport/panel-1#', 'DiagnosticReport/panel-1',
      'DiagnosticReport/a#b#c', 'DiagnosticReport/a/b#c', 'diagnosticreport/panel-1#r1', 'panel-1#r1',
      `DiagnosticReport/${'a'.repeat(65)}#r1`, `DiagnosticReport/panel-1#${'a'.repeat(65)}`, 'DiagnosticReport/panel 1#r1',
    ];
    expect(run(empty(), bad.map((id) => rec(result(id)))).counts).toEqual({ ...NONE, notRead: bad.length });
  });

  it('64-character parts are read; a plain id still reads as before', () => {
    const { counts, file } = run(empty(), [rec(result(`DiagnosticReport/${'a'.repeat(64)}#${'b'.repeat(64)}`)), rec(result('obs-1', {
      code: { coding: [{ system: 'http://loinc.org', code: '2085-9' }] }, valueQuantity: { value: 1.3, unit: 'mmol/L' },
    }))]);
    expect(counts).toEqual({ ...NONE, added: 2 });
    expect(file.labValues.map((l) => String(l.externalId).split('#')[0])).toEqual([
      `${SOURCE}|DiagnosticReport|${'a'.repeat(64)}|${'b'.repeat(64)}`, `${SOURCE}|Observation|obs-1`,
    ]);
  });

  it('inside a panel, a contained result keeps the plain id rule: Apple\'s form is not read there', () => {
    const { meta: _m, ...inner } = result('DiagnosticReport/panel-1#r1');
    const panel = rec({
      resourceType: 'DiagnosticReport', id: 'panel-1', status: 'final', contained: [inner], result: [{ reference: '#DiagnosticReport/panel-1#r1' }],
    }, { resourceType: 'DiagnosticReport' });
    expect(run(empty(), [panel]).counts).toEqual({ ...NONE, notRead: 1 });
  });

  it('a record that is not an object is not read', () => {
    const odd = ['null', '"DiagnosticReport/panel-1#r1"', '[]', '7'].map((json) => ({ sourceId: SOURCE, resourceType: 'Observation', fhirVersion: '1.0.2', json }));
    expect(run(empty(), odd).counts).toEqual({ ...NONE, notRead: 4 });
  });
});
