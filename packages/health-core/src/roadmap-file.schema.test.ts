/**
 * US-29 — the published record-file schema must describe the file the app
 * actually writes. docs/health-roadmap-file.schema.json is what third-party
 * agents read, so it is only useful if a record built through the REAL code
 * paths (createEmptyFile → createMeasurement → mergeFiles → migrateFile,
 * JSON round-tripped exactly as an agent would read it off disk) validates
 * against it — and a malformed one does not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import {
  MEASUREMENT_SOURCES,
  MEDICATION_KEYS,
  DOCUMENT_TYPES,
  METRIC_TYPES,
} from './validation';
import { mergeFiles } from './merge';
import { migrateFile } from './migrate';
import {
  createEmptyFile,
  createMeasurement,
  type RoadmapFile,
  type FileDocument,
  type FileLabValue,
  type FileMedication,
  type FileReminderPreference,
  type FileSupplement,
} from './roadmap-file';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/health-roadmap-file.schema.json',
);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// `format` is documentation here, not a constraint (the code enforces no
// timestamp format), so formats stay off rather than pulling in ajv-formats.
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const validate = ajv.compile(schema);

/** Validate exactly what an agent sees: the parsed bytes, not the in-memory object. */
function check(file: unknown): { ok: boolean; errors: string } {
  const ok = validate(JSON.parse(JSON.stringify(file))) as boolean;
  return { ok, errors: ajv.errorsText(validate.errors) };
}

const OPTS = { deviceId: 'dev_schema', now: '2026-09-01T10:00:00Z' };

function medication(p: Partial<FileMedication> & { id: string; medicationKey: string }): FileMedication {
  return {
    drugName: 'atorvastatin',
    doseValue: 20,
    doseUnit: 'mg',
    updatedAt: '2026-05-02T00:00:00Z',
    lamport: 1,
    ...p,
  };
}

function supplement(p: Partial<FileSupplement> & { id: string; supplementKey: string }): FileSupplement {
  return {
    supplementName: 'MicroVitamin',
    doseValue: null,
    doseUnit: null,
    status: 'active',
    startedAt: '2026-04-01',
    updatedAt: '2026-05-02T00:00:00Z',
    lamport: 1,
    ...p,
  };
}

function labValue(p: Partial<FileLabValue> & { id: string; metricName: string; value: number }): FileLabValue {
  return {
    unit: 'ug/L',
    referenceLow: 30,
    referenceHigh: 400,
    recordedAt: '2026-05-01',
    createdAt: '2026-05-01T08:00:00Z',
    source: 'lab_import',
    status: 'active',
    correctsId: null,
    ...p,
  };
}

function document(p: Partial<FileDocument> & { id: string }): FileDocument {
  return {
    title: 'Lipid panel',
    type: 'pathology_report',
    date: '2026-05-01',
    fileRef: 'Lab results/2026-05-01 Lipid panel.pdf',
    contentHash: 'sha256-abc',
    mimeType: 'application/pdf',
    extractedText: '# Lipid panel\n\nLDL 2.1 mmol/L',
    addedAt: '2026-05-01T09:00:00Z',
    sourceFileName: 'lipids.pdf',
    ...p,
  };
}

function reminderPreference(category: string): FileReminderPreference {
  return { category, enabled: true, updatedAt: '2026-05-02T00:00:00Z', lamport: 1 };
}

/**
 * A record covering every section, assembled the way the app assembles one:
 * two devices' files merged (which demotes the older same-day row to
 * `entered-in-error`), then read back through the untrusted-JSON gate.
 */
function representativeFile(): RoadmapFile {
  const phone = createEmptyFile({ deviceId: 'dev_phone', now: '2026-01-01T00:00:00Z' });
  const laptop = createEmptyFile({ deviceId: 'dev_laptop', now: '2026-01-01T00:00:00Z' });

  phone.profile = {
    ...phone.profile,
    sex: 'female',
    birthYear: 1978,
    birthMonth: 4,
    heightCm: 165,
    unitSystem: 'si',
    unitOverrides: { weight: 'conventional' },
    reportEmailCaptured: true,
    lamport: 3,
    updatedAt: '2026-05-02T00:00:00Z',
  };
  phone.screenings = {
    ...phone.screenings,
    colorectalMethod: 'fit_annual',
    colorectalLastDate: '2026-03',
    colorectalResult: 'normal',
    breastFrequency: 'biennial',
    lungSmokingHistory: 'never_smoked',
    lungPackYears: 0,
    dexaScreening: 'not_yet_started',
    lamport: 2,
    updatedAt: '2026-05-02T00:00:00Z',
  };
  phone.measurements = [
    createMeasurement({
      id: 'm_phone', metricType: 'ldl', value: 2.1,
      recordedAt: '2026-05-01', createdAt: '2026-05-01T08:00:00Z',
    }),
    createMeasurement({
      id: 'm_health_kit', metricType: 'weight', value: 68.4,
      recordedAt: '2026-05-03T07:00:00Z', createdAt: '2026-05-03T07:00:00Z',
      source: 'apple_health', externalId: 'HK-1234',
    }),
  ];
  phone.medications = [medication({ id: 'med_1', medicationKey: 'statin' })];
  phone.medicationHistory = [
    medication({ id: 'med_h1', medicationKey: 'statin', changeType: 'started' }),
    medication({ id: 'med_h2', medicationKey: 'statin', doseValue: 40, changeType: 'dose_changed' }),
  ];
  phone.supplements = [supplement({ id: 'sup_1', supplementKey: 'micro_vitamin' })];
  phone.supplementHistory = [
    supplement({ id: 'sup_h1', supplementKey: 'micro_vitamin', changeType: 'started' }),
  ];
  phone.labValues = [labValue({ id: 'lab_1', metricName: 'ferritin', value: 85 })];
  phone.documents = [
    document({ id: 'doc_1' }),
    document({ id: 'doc_2', type: 'other', fileRef: '', contentHash: '', mimeType: '', date: null, sourceFileName: null, deleted: true }),
  ];
  phone.reminderPreferences = [reminderPreference('bloods'), reminderPreference('screening')];
  phone.recommendationSnapshots = [{
    date: '2026-05-02',
    suggestions: [{
      id: 'ldl_high',
      category: 'bloodwork',
      priority: 'attention',
      title: 'Discuss LDL with your doctor',
      description: 'Your LDL is above the target for your risk profile.',
      reason: 'Evidence suggests lower LDL reduces cardiovascular events.',
      guidelines: ['NZ CVD 2018'],
      references: [{ label: 'BPAC statins', url: 'https://bpac.org.nz/2021/statins.aspx' }],
    }],
  }];
  phone.reminderOptIn = {
    status: 'active',
    token: 'tok_opaque',
    email: 'user@example.com',
    provider: 'dropbox',
    updatedAt: '2026-05-02T00:00:00Z',
    lamport: 1,
  };

  // The laptop entered a SECOND LDL for the same day; merge keeps both rows and
  // demotes the older one — so the merged file carries a real
  // `entered-in-error` row plus a correction, not a hand-written one.
  laptop.measurements = [
    createMeasurement({
      id: 'm_laptop', metricType: 'ldl', value: 2.3,
      recordedAt: '2026-05-01', createdAt: '2026-05-01T09:30:00Z',
      source: 'manual_correction', correctsId: 'm_phone',
    }),
  ];

  return migrateFile(mergeFiles(phone, laptop, OPTS), OPTS);
}

describe('docs/health-roadmap-file.schema.json (US-29)', () => {
  it('is a compilable draft 2020-12 schema published at the raw GitHub URL', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(
      'https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/health-roadmap-file.schema.json',
    );
  });

  it('pins its enums to the code, so enum drift breaks the build', () => {
    expect(schema.$defs.MetricType.enum).toEqual([...METRIC_TYPES]);
    expect(schema.$defs.MeasurementSource.enum).toEqual([...MEASUREMENT_SOURCES]);
    expect(schema.$defs.FileMedication.properties.medicationKey.enum).toEqual([...MEDICATION_KEYS]);
    expect(schema.$defs.FileDocument.properties.type.enum).toEqual([...DOCUMENT_TYPES]);
  });

  it('validates a brand-new empty record', () => {
    const result = check(createEmptyFile(OPTS));
    expect(result.errors).toBe('No errors');
    expect(result.ok).toBe(true);
  });

  it('validates a full record built through merge + migrate', () => {
    const file = representativeFile();
    // Guard the fixture itself: merge really did produce the correction pair.
    expect(file.measurements.filter((m) => m.status === 'entered-in-error')).toHaveLength(1);
    const result = check(file);
    expect(result.errors).toBe('No errors');
    expect(result.ok).toBe(true);
  });

  it('preserves unknown fields, so a newer app version still validates', () => {
    const file = { ...representativeFile(), brandNewSection: [1, 2, 3] };
    expect(check(file).ok).toBe(true);
  });

  it('rejects a malformed record', () => {
    // Required `screenings` omitted, plus a row with no id, an invented status,
    // and a string where a number belongs.
    const { screenings, ...withoutScreenings } = representativeFile();
    const file = {
      ...withoutScreenings,
      measurements: [
        { metricType: 'ldl', value: '2.1', recordedAt: '2026-05-01', createdAt: '2026-05-01T08:00:00Z', source: 'manual', status: 'deleted', correctsId: null, externalId: null },
      ],
    };
    const result = check(file);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('required property');
  });

  it('rejects each individual invariant break', () => {
    const cases: Array<[string, (f: RoadmapFile) => void]> = [
      ['schemaVersion 2', (f) => { (f as { schemaVersion: number }).schemaVersion = 2; }],
      ['missing meta.lamport', (f) => { delete (f.meta as { lamport?: number }).lamport; }],
      ['unknown measurement source', (f) => { f.measurements[0].source = 'guessed' as never; }],
      ['typo\'d metricType', (f) => { f.measurements[0].metricType = 'ldl_c'; }],
      ['unknown medication key', (f) => { f.medications[0].medicationKey = 'aspirin'; }],
      ['unknown document type', (f) => { f.documents[0].type = 'xray' as never; }],
      ['supplement status typo', (f) => { f.supplements[0].status = 'stoped' as never; }],
      ['screening enum typo', (f) => { f.screenings.colorectalResult = 'fine' as never; }],
      ['reminderOptIn without a token', (f) => { delete (f.reminderOptIn as { token?: string }).token; }],
      ['lab value missing its unit', (f) => { delete (f.labValues[0] as { unit?: string }).unit; }],
    ];
    for (const [label, corrupt] of cases) {
      const file = representativeFile();
      corrupt(file);
      expect(check(file).ok, label).toBe(false);
    }
  });
});
