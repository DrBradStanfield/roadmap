/**
 * Drift guard: the Sentry scrub logic is duplicated in the repo-root
 * `instrument-scrub.mjs` (a self-contained plain-ESM copy that `instrument.server.mjs`
 * imports, because it runs outside the bundle in Docker where the @roadmap/health-core
 * workspace/dist isn't available — see that file's header). This test asserts the copy
 * behaves IDENTICALLY to the health-core source. If you change scrub behaviour or the
 * sensitive-key lists in either file, update BOTH or this fails.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as source from './sentry-scrub';
import { UNIT_DEFS } from './units';
import { METRIC_TYPES } from './validation';
import { METRIC_LABELS } from './mappings';
import { foldName, LAB_CATALOG, normalizeLabUnit } from './lab-catalog';
// @ts-expect-error -- plain .mjs script with no declarations; this parity test
// only needs its runtime exports.
import * as copy from '../../../instrument-scrub.mjs';

// One field per sensitive key currently redacted by the source. If health-core's list grows,
// add the key here AND to instrument-scrub.mjs (the in-code comments say so).
const SENSITIVE_SAMPLE: Record<string, unknown> = {
  content_md: 'document text', document_type: 'lab_report',
  weightKg: 80, weight_kg: 80, weight: 80,
  waistCm: 90, waist_cm: 90, waist: 90,
  heightCm: 180, height_cm: 180, height: 180,
  hba1c: 33,
  ldlC: 1.2, ldl_c: 1.2, ldl: 1.2,
  totalCholesterol: 3.2, total_cholesterol: 3.2,
  hdlC: 1.4, hdl_c: 1.4, hdl: 1.4,
  triglycerides: 0.9,
  apoB: 0.5, apo_b: 0.5,
  creatinine: 90,
  psa: 1.0, lpa: 200,
  systolicBp: 120, systolic_bp: 120,
  diastolicBp: 80, diastolic_bp: 80,
  metricType: 'ldl', metric_type: 'ldl',
  idealBodyWeight: 78, ideal_body_weight: 78,
  proteinTarget: 94, protein_target: 94,
  bmi: 24.7,
  waistToHeightRatio: 0.5, waist_to_height_ratio: 0.5,
  nonHdlCholesterol: 1.8, non_hdl_cholesterol: 1.8,
  egfr: 90,
  drugName: 'atorvastatin', drug_name: 'atorvastatin',
  doseValue: 40, dose_value: 40,
  doseUnit: 'mg', dose_unit: 'mg',
  firstName: 'Brad', first_name: 'Brad',
  lastName: 'Stanfield', last_name: 'Stanfield',
  email: 'brad@example.com',
  birthYear: 1960, birth_year: 1960,
  birthMonth: 3, birth_month: 3,
  sex: 'male', gender: 'female',
  dob: '1984-06-01', dateOfBirth: '1984-06-01', date_of_birth: '1984-06-01',
  birthDate: '1984-06-01',
  patientName: 'Jane Roe', patient_name: 'Jane Roe',
  shopify_customer_id: '123', customerId: '123',
  userId: 'u1', user_id: 'u1',
  nhi: 'ABC1234', mrn: '00921',
  value: 3.2, values: [3.2], result: 'positive', results: ['positive'],
  title: 'Lipid panel', note: 'fasting', notes: ['fasting'],
  summary: 'LDL up since March',
  displayValue: 4.2, display_value: 4.2,
  valueSI: 3.1, value_si: 3.1,
  contentMarkdown: 'synthetic note', content_markdown: 'note',
  metric: 'ferritin', metricName: 'ferritin', metric_name: 'ferritin',
  printedName: 'Ferritin (serum)',
  referenceLow: 30, reference_low: 30, referenceHigh: 400, reference_high: 400,
  unrecognized: ['Synthetic marker 12 U'], question: 'Is this 12 or 1.2?',
  extractedText: 'Synthetic Person, ferritin 12',
  recordedAt: '2026-03-01', recorded_at: '2026-03-01',
  documentDate: '2026-03-01', document_date: '2026-03-01',
  classification: 'lab_report',
  supplementName: 'Synthetic iron', supplement_name: 'Synthetic iron',
  metadata: { patient: 'Synthetic Person' },
  reportDate: '2026-03-01', report_date: '2026-03-01',
  collectedOn: '2026-03-01', collected_on: '2026-03-01',
  existingValue: 4.1, documentType: 'lab_report', documentContent: 'synthetic document text',
  unsubscribe_token: 'tok', accessToken: 'tok', authorization: 'Bearer x',
  bearerToken: 'b', apiKey: 'k', api_key: 'k',
  cookie: 'c', 'http.request.header.cookie.theme': 'c',
  sourceFileName: 'Brad lipids.pdf', filename: 'Brad lipids.pdf',
  prostatePsaValue: 1, prostate_psa_value: 1,
  lungPackYears: 0, lung_pack_years: 0,
  // substring matches
  colorectal_screening_date: '2025-01-01',
  statinDrug: 'x', medicationList: ['a'],
  password: 'p', apiSecret: 's', awsCredential: 'c',
  // safe keys (must be preserved)
  shopDomain: 'x.myshopify.com', requestId: 'r1', status: 200, count: 3,
};

describe('instrument-scrub.mjs ↔ health-core sentry-scrub parity', () => {
  it('scrubSensitiveData produces identical output', () => {
    const nested = { user: SENSITIVE_SAMPLE, list: [SENSITIVE_SAMPLE], note: 'safe' };
    expect(copy.scrubSensitiveData(nested)).toEqual(source.scrubSensitiveData(nested));
  });

  // US-09 AC7c: the sets themselves, not a sample of them — a key added to one
  // copy and missing from SENSITIVE_SAMPLE still fails here.
  it('US-09 AC7c — both copies carry the same exact-key set', () => {
    expect([...copy.SENSITIVE_EXACT_KEYS].sort()).toEqual([...source.SENSITIVE_EXACT_KEYS].sort());
  });

  it('redacts every known sensitive key and preserves safe keys (both impls)', () => {
    for (const impl of [source, copy]) {
      const out = impl.scrubSensitiveData(SENSITIVE_SAMPLE) as Record<string, unknown>;
      for (const key of Object.keys(SENSITIVE_SAMPLE)) {
        if (['shopDomain', 'requestId', 'status', 'count'].includes(key)) {
          expect(out[key]).toEqual(SENSITIVE_SAMPLE[key]);
        } else {
          expect(out[key]).toBe('[Filtered]');
        }
      }
    }
  });

  it('scrubUrl produces identical output', () => {
    const urls = [
      '/apps/health-tool-1/api/measurements?token=abc&metric_type=ldl',
      'https://drstanfield.com/x?logged_in_customer_id=999&email=a@b.com&keep=1',
      'https://example.com/no-sensitive-params?page=2',
      '/callback?code=SECRET&state=BLOB&access_token=X&safe=1',
      'https://drstanfield.com/cb?code_verifier=v&client_secret=s&refresh_token=r&page=2',
      'https://drstanfield.com/api/lab-import?batchId=b&pollToken=SECRET',
      'not a url',
    ];
    for (const u of urls) {
      expect(copy.scrubUrl(u)).toBe(source.scrubUrl(u));
    }
    // The query goes whole: a provider names a clinical document in it, and an
    // allowlist of param names never survives the next provider.
    const download = 'https://content.dropboxapi.com/2/files/download?path=/Apps/roadmap/Jane%20Roe%20lipids.pdf';
    for (const impl of [source, copy]) {
      const out = impl.scrubUrl(download);
      expect(out).toBe('https://content.dropboxapi.com/2/files/download');
      expect(out).not.toContain('?');
      expect(out).not.toContain('Jane');
      expect(impl.scrubUrl('/apps/health-tool-1/api/measurements?token=abc'))
        .toBe('/apps/health-tool-1/api/measurements');
    }
  });

  it('filters every field of a lab row and a patient profile (both impls)', () => {
    const payload = {
      row: { metricType: 'ldl', value: 3.2, unit: 'mmol/L' },
      profile: { dob: '1984-06-01', gender: 'female', patientName: 'Jane Roe', nhi: 'ABC1234' },
    };
    for (const impl of [source, copy]) {
      const out = impl.scrubSensitiveData(payload) as {
        row: Record<string, unknown>; profile: Record<string, unknown>;
      };
      expect(out.row.metricType).toBe('[Filtered]');
      expect(out.row.value).toBe('[Filtered]');
      expect(out.profile.dob).toBe('[Filtered]');
      expect(out.profile.gender).toBe('[Filtered]');
      expect(out.profile.patientName).toBe('[Filtered]');
      expect(out.profile.nhi).toBe('[Filtered]');
      // The unit alone is not the value, and it is what an alert is read by.
      expect(out.row.unit).toBe('mmol/L');
    }
  });

  it('keeps only method, origin and status — an unlisted field does not survive', () => {
    const data = {
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/download?path=/Apps/roadmap/Brad%20lipids.pdf',
      body: 'health payload',
      request_body: 'x', request_body_size: 10, response_body_size: 20,
      status_code: 200,
      // Nothing lists this key, and it is the whole point of the allowlist:
      // an integration (or a future `addBreadcrumb` call) can hang anything
      // off `data`, and a denylist keeps whatever it failed to predict.
      input: { hba1c: 41 },
      'Dropbox-API-Arg': '{"path":"/Apps/roadmap/Brad lipids.pdf"}',
    };
    const out = source.scrubBreadcrumbData(data);
    expect(out).toEqual({ method: 'POST', url: 'https://content.dropboxapi.com', status_code: 200 });
    expect(copy.scrubBreadcrumbData(data)).toEqual(out);
    // A relative URL has no origin to keep, so it keeps nothing.
    expect(copy.scrubBreadcrumbData({ url: '/apps/health-tool-1/api/chat' }))
      .toEqual(source.scrubBreadcrumbData({ url: '/apps/health-tool-1/api/chat' }));
    expect(source.scrubBreadcrumbData({ url: '/apps/x' })).toEqual({ url: '[Filtered]' });
    expect(copy.scrubBreadcrumbData(undefined)).toBe(source.scrubBreadcrumbData(undefined));
  });
});

// ---------------------------------------------------------------------------
// Free-text scrub (2026-09-10 audit)
// ---------------------------------------------------------------------------

const TEXTS = [
  'My LDL is 3.2 mmol/L and I have diabetes, what should I do?',
  'cholesterol 200 on the last panel',
  'contact brad@example.com about 80 kg and 120 mmHg',
  'took 250 ms, status 500, request_id 7f3a',
  'HbA1c was 42 mmol/mol; weight 96.4kg; waist 101 cm',
  'BP 140/90 and blood pressure 138/88 on metformin 500mg',
  'my ldl on the panel read 4.2 today',  // 19-char gap: inside the window
  'ran 5 in the morning, status 500 in 12ms, took 250 in total',
  // US-09 AC7f: a name that starts or ends without a word character.
  '120 Lp(a)', 'came back 120 lp(a)', '33 γ-GT',
  '41 GGT', 'Lp(a) 120', 'γ-GT 33', '120 nmol/L Lp(a)', '4.2 k+', '7.1 a1c',
  '12 bananas', '2 cholesterols',
  // US-09 AC7f: a value never starts inside a digit run; the winner is unchanged.
  '1.2.3 ldl', '12.34.5 ldl', '1,2,3 ldl', '120/80/60 bp', '1.2/3.4/5 bp', '12345 ldl',
  '2026.11.04 ldl', 'v1.2.3 ldl', '1/2/3 hba1c', '3.2.1 Lp(a)', '5 17-ohp', '12 25(oh)d',
  // US-09 AC7f: bounded email parts; two adjacent addresses both go.
  'mail x.y+z@ex.co.uk now', 'a@b.com@c.org', '..a@b.co', '(brad@example.com)', 'é-brad@example.com', 'brad@@example.com',
  'mailto:a@b.com%2Cc@d.com', 'a@b.com+joe@x.com', 'a@b.com-joe@x.com', 'a@b.com_joe@x.com', 'a@b.com1x@y.com',
  'a@b.co.uk-x@y.com', 'first@example.com+second@example.org', 'a@b.com%20c@d.com', `${'x'.repeat(100)}@example.com`,
  // US-09 AC7f: a name ending in a symbol ends there, whatever follows.
  '120 lp(a)s', '120 lp(a)x',
  // US-09 AC7f: a name starting with a symbol starts there, whatever precedes it.
  '33 xγ-GT', '1xγ-gt', ')25(oh)dγ-gt',
];

describe('free-text scrub parity', () => {
  // scrub-vocabulary.ts DERIVES both lists from UNIT_DEFS, METRIC_LABELS and the
  // lab catalogue; the .mjs cannot import, so it carries them as literals. When
  // the catalogue moves, these two fail and print the array to paste back.
  const paste = (name: string, words: readonly string[]) =>
    `${name} drifted — paste this array into instrument-scrub.mjs:\n[\n  ${
      words.map(w => (w.includes("'") ? JSON.stringify(w) : `'${w}'`)).join(', ')}\n]`;

  it('instrument-scrub.mjs carries the derived SCRUB_UNITS verbatim', () => {
    expect(copy.SCRUB_UNITS, paste('SCRUB_UNITS', source.SCRUB_UNITS)).toEqual(source.SCRUB_UNITS);
  });

  it('US-09 AC7e — instrument-scrub.mjs builds the same unit regex', () => {
    expect(copy.SCRUB_UNIT_PATTERN).toBe(source.SCRUB_UNIT_PATTERN);
  });

  it('instrument-scrub.mjs carries the derived SCRUB_METRIC_WORDS verbatim', () => {
    expect(copy.SCRUB_METRIC_WORDS, paste('SCRUB_METRIC_WORDS', source.SCRUB_METRIC_WORDS))
      .toEqual(source.SCRUB_METRIC_WORDS);
  });

  it('the vocabularies cover the lab catalogue, not just the core metrics', () => {
    for (const impl of [source, copy]) {
      const words = impl.SCRUB_METRIC_WORDS as string[];
      for (const entry of LAB_CATALOG) {
        // "Total protein" is two generic English words and nothing else, so the
        // vocabulary deliberately cannot name it — a scrub word "total" would
        // redact "3 of the total". Its unit (g/L) still catches the value.
        if (entry.key === 'total_protein') continue;
        const names = [foldName(entry.label), entry.key.replace(/_/g, ' ')];
        expect(names.some(name => words.some(w => name.includes(w))),
          `no scrub word for lab "${entry.label}"`).toBe(true);
      }
      const units = new Set(impl.SCRUB_UNITS.map((u: string) => u.toLowerCase()));
      for (const entry of LAB_CATALOG) {
        expect(units, `unit "${entry.unit}" (${entry.key}) missing`).toContain(entry.unit.toLowerCase());
      }
    }
  });

  it('US-09 AC7e — a number beside a unit spelling the catalogue accepts is scrubbed, on both copies', () => {
    for (const impl of [source, copy]) {
      expect(impl.scrubText('potassium 4.1 mEq/L')).toBe('potassium [value]');
      expect(impl.scrubText('result 4.1 mEq/L')).toBe('result [value]');
      expect(impl.scrubText('read 2.5 µIU/mL today')).toBe('read [value] today');
      expect(impl.scrubText('read 2.5 uIU/mL today')).toBe('read [value] today');
      expect(impl.scrubText('count 250 thou/µL')).toBe('count [value]');
      expect(impl.scrubText('count 250 thou/uL')).toBe('count [value]');
      expect(impl.scrubText('count 6.1 x10^9/L')).toBe('count [value]');
      expect(impl.scrubText('count 6.1 ×10^9/L')).toBe('count [value]');
      expect(impl.scrubText('count 4.5 ×10³/µL')).toBe('count [value]');
      expect(impl.scrubText('result 14 g/dL')).toBe('result [value]');
      expect(impl.scrubText('result 12 mm/h')).toBe('result [value]');
      // A unit alias that is an English word is never a unit here.
      expect(impl.scrubText('retry 3 ratio')).toBe('retry 3 ratio');
      expect(impl.scrubText('shard 2 fraction')).toBe('shard 2 fraction');
      const units = new Set(impl.SCRUB_UNITS.map((u: string) => u.toLowerCase()));
      for (const entry of LAB_CATALOG) {
        for (const spelling of [...(entry.unitAliases ?? []), ...Object.keys(entry.conversions ?? {})]) {
          if (/^[a-z]+$/i.test(spelling)) continue;
          expect(units, `unit alias "${spelling}" (${entry.key}) missing`).toContain(spelling);
        }
      }
    }
  });

  it('US-09 AC7e — every spelling normalizeLabUnit folds into a catalogue unit is scrubbed, on both copies', () => {
    // One or more raw spellings per normaliser branch (lab-catalog.ts normalizeLabUnit).
    const branches: Record<string, string[]> = {
      'Greek mu': ['μmol/L', 'μIU/mL', 'μg/L'],
      'cell-count exponent': ['10^9/L', '10e9/L', 'x 10e9/L', 'X10E9/L', '10*3/uL', '10**9/L', 'x10(3)/uL',
        '10^(9)/L', '10³/µL', 'x10³/uL', '×10^12/L', 'x10^6/uL'],
      'ASCII micro': ['umol/L', 'ug/L', 'uIU/mL', 'uU/mL'],
      'mcg and mcL': ['mcg/L', 'cells/mcL', 'thou/mcL'],
      'uL and ul': ['cells/uL', 'k/ul'],
      'lowercase litre': ['mmol/l', 'nmol/l'],
      'squared metre': ['mL/min/1.73m2', 'mL/min/1.73m^2', 'mL/min/1.73 m2'],
      'gm/dL': ['gm/dL'],
      'Unit and Units': ['Units/L', 'Unit/L'],
      'cubic millimetre token': ['cells/cmm', 'cells/cumm', 'cells/cu mm', 'cells/cu.mm', 'cells/c.mm'],
      'mm3 denominator': ['cells/mm3', 'cells/mm³', 'x10^3/mm3'],
    };
    const accepted = new Set(LAB_CATALOG.flatMap((entry) => [
      entry.unit, ...(entry.unitAliases ?? []), ...Object.keys(entry.conversions ?? {})]).map((u) => u.toLowerCase()));
    for (const [branch, spellings] of Object.entries(branches)) {
      for (const raw of spellings) {
        // The spelling really is one the catalogue reads, once normalised.
        expect(accepted, `${branch}: "${raw}" → "${normalizeLabUnit(raw)}"`).toContain(normalizeLabUnit(raw).toLowerCase());
        for (const impl of [source, copy]) {
          expect(impl.scrubText(`result 4.2 ${raw} today`), `${branch}: "${raw}"`).toBe('result [value] today');
        }
      }
    }
  });

  it('scrubs a catalogued lab sentence and leaves engineering text alone', () => {
    for (const impl of [source, copy]) {
      expect(impl.scrubText('cortisol 550')).toBe('cortisol [value]');
      expect(impl.scrubText('ALT 62 U/L')).toBe('ALT [value]');
      expect(impl.scrubText('CRP 4.1')).toBe('CRP [value]');
      expect(impl.scrubText('Platelets 180')).toBe('Platelets [value]');
      expect(impl.scrubText('500 in 12ms')).toBe('500 in 12ms');
      // A metric word must END where the word ends: "alt" is not "alternative".
      expect(impl.scrubText('bundle size exceeded 3 MB')).toBe('bundle size exceeded 3 MB');
      expect(impl.scrubText('alternative 2 failed')).toBe('alternative 2 failed');
      expect(impl.scrubText('ironclad 3 rows')).toBe('ironclad 3 rows');
      expect(impl.scrubText('iron 3')).toBe('iron [value]');
    }
  });

  it('US-21 AC17 — a short alias is a name, and a name ending in a digit keeps its digit while the value goes', () => {
    for (const impl of [source, copy]) {
      // Short aliases skip the 3-letter floor, as short keys do.
      expect(impl.scrubText('Ca 2.4')).toBe('Ca [value]');
      expect(impl.scrubText('LD 180')).toBe('LD [value]');
      expect(impl.scrubText('CK 120')).toBe('CK [value]');
      // The name's own trailing digit is the name, not the value.
      expect(impl.scrubText('IGF-1 200')).toBe('IGF-1 [value]');
      expect(impl.scrubText('Apo A1 1.2')).toBe('Apo A1 [value]');
      expect(impl.scrubText('Vitamin B12 300')).toBe('Vitamin B12 [value]');
      // A catalogue name ending in a digit after a space or a hyphen is one phrase.
      expect(impl.scrubText('IGF 1 200')).toBe('IGF 1 [value]');
      expect(impl.scrubText('apoa-1 1.3')).toBe('apoa-1 [value]');
      expect(impl.scrubText('Free T4 15')).toBe('Free T4 [value]');
      expect(impl.scrubText('insulin-like growth factor 1 was 200')).toBe('insulin-like growth factor 1 was [value]');
      // A plain value is still the value, decimal or not, and a lone name stays.
      expect(impl.scrubText('LDL 3.2')).toBe('LDL [value]');
      expect(impl.scrubText('ldl 3 then 4')).toBe('ldl [value] then 4');
      expect(impl.scrubText('B12')).toBe('B12');
      expect(impl.scrubText('B12 low')).toBe('B12 low');
    }
  });

  it('US-21 AC17 — a name never absorbs a value: digits after a name are the value unless the name itself ends in them', () => {
    for (const impl of [source, copy]) {
      for (const [text, scrubbed] of [
        ['LDL-140', 'LDL-[value]'], ['ldl140', 'ldl[value]'], ['glucose-140', 'glucose-[value]'], ['glucose 140', 'glucose [value]'],
        ['IGF-1 200', 'IGF-1 [value]'], ['IGF 1 200', 'IGF 1 [value]'], ['Apo A1 1.2', 'Apo A1 [value]'],
        ['Vitamin B12 300', 'Vitamin B12 [value]'], ['Free T4 15', 'Free T4 [value]'],
        // A number inside a word (a letter on both sides, the 1 of "A1c") is
        // never the value; a number after a letter, or before a unit, still is.
        ['Hb A1c 7.2', 'Hb A1c [value]'], ['HbA1c 48', 'HbA1c [value]'], ['Hb A1c was 48', 'Hb A1c was [value]'],
        ['ld a1c 6', 'ld a1c [value]'], ['sodium a140', 'sodium a[value]'], ['ferritin was210', 'ferritin was[value]'],
        ['LDL 3.2mmol/L', 'LDL [value]'], ['BP-140/90', 'BP-[value]'],
      ]) {
        expect(impl.scrubText(text), text).toBe(scrubbed);
      }
    }
  });

  it('US-09 AC7g — a name is never a value: a name with no value before another name never takes the second name\'s digits, on both copies', () => {
    for (const impl of [source, copy]) {
      for (const [text, scrubbed] of [
        // A first name with no value: the value after the second name goes.
        ['Ferritin pending, B12 300', 'Ferritin pending, B12 [value]'], ['Vitamin D pending, B12 300', 'Vitamin D pending, B12 [value]'],
        ['LDL n/a, HbA1c 6.1', 'LDL n/a, HbA1c [value]'], ['Ferritin unknown; Vitamin B12 300 pmol/L', 'Ferritin unknown; Vitamin B1[value] [value]'],
        ['Ferritin B12 300', 'Ferritin B12 [value]'], ['LDL HbA1c 6.1', 'LDL HbA1c [value]'], ['LDL 25(oh)d 80', 'LDL 25(oh)d [value]'],
        // A name the vocabulary does not hold, ending in digits: a number after it is the value, and both go.
        ['TSH: -, T4 15', 'TSH: -, T[value]'], ['LDL D3 45', 'LDL D[value]'], ['ldl T3 4.1', 'ldl T[value]'],
        ['ldl b6 40', 'ldl b[value]'], ['ferritin CA-125 30', 'ferritin CA-[value]'], ['LDL Omega-3 8', 'LDL Omega-[value]'],
        ['ldl140 160', 'ldl[value]'],
      ]) {
        expect(impl.scrubText(text), text).toBe(scrubbed);
      }
    }
  });

  it('US-09 AC7g — "vit", the typed short form of vitamin, is a name, and never takes the next name\'s digits, on both copies', () => {
    for (const impl of [source, copy]) {
      for (const [text, scrubbed] of [
        ['Vit D 45', 'Vit D [value]'], ['vit. d 45', 'vit. d [value]'], ['Vit B12 300', 'Vit B12 [value]'],
        ['Vit. B12 300', 'Vit. B12 [value]'], ['Vit D pending, B12 300', 'Vit D pending, B12 [value]'], ['vit d3 45', 'vit d[value]'],
        // "vit" inside a longer word is not the name.
        ['vitals ok', 'vitals ok'], ['vitals 3', 'vitals 3'], ['multivit 2 daily', 'multivit 2 daily'],
        ['vital signs 3 of 4', 'vital signs 3 of 4'],
      ]) {
        expect(impl.scrubText(text), text).toBe(scrubbed);
      }
    }
  });

  // Codex and adversary review of f866201a: a digit name's value went when a space stood
  // between, and stayed behind any other separator the name-then-value gap accepts.
  it('US-09 AC7g — a digit name\'s value goes behind a comparator or any separator, on both copies', () => {
    for (const impl of [source, copy]) {
      for (const [text, value] of [
        ['TSH: -, T4 <15', '15'], ['LDL n/a, T3 >4.1', '4.1'], ['ferritin CA-125 <30', '30'], ['LDL D3 ≥ 45', '45'],
        ['Ferritin pending, B12 <300', '300'], ['LDL T4 - 15', '15'], ['LDL T4, 15', '15'], ['LDL T4 (15)', '15'],
        ['Vit D3 - 45', '45'], ['vit d3, 45', '45'],
        // Codex re-check: a long run of spaces still joins the two numbers, as before the shared gap.
        ['TSH: -, T4' + ' '.repeat(21) + '15', '15'], ['LDL n/a, T3' + '\t'.repeat(30) + '4.1', '4.1'],
      ]) {
        expect(impl.scrubText(text), text).not.toContain(value);
      }
    }
  });

  it('US-21 AC17 — every catalogue key, label and alias, followed by a value, loses the value', () => {
    for (const impl of [source, copy]) {
      for (const entry of LAB_CATALOG) {
        for (const name of [entry.key, entry.label, ...entry.aliases]) {
          for (const text of [`${name} 123`, `${name} was 123`, `${name} is 123.5`, `${name}: 123`, `${name}=123`]) {
            expect(impl.scrubText(text), `${entry.key}: ${text}`).not.toContain('123');
          }
        }
      }
    }
  });

  it('US-09 AC7f — a value before a name that starts or ends without a word character is scrubbed, on both copies', () => {
    for (const impl of [source, copy]) {
      for (const [text, scrubbed] of [
        ['120 Lp(a)', '[value] Lp(a)'], ['came back 120 lp(a)', 'came back [value] lp(a)'], ['33 γ-GT', '[value] γ-GT'],
        // A name ending in a symbol ends there, whatever follows, as with \b.
        ['120 lp(a)s', '[value] lp(a)s'], ['120 lp(a)x', '[value] lp(a)x'],
        // A name starting with a symbol starts there, whatever precedes it, as with \b.
        ['33 xγ-GT', '[value] xγ-GT'], ['1xγ-gt', '[value]xγ-gt'], [')25(oh)dγ-gt', ')[value](oh)dγ-gt'],
        // Controls that already behaved: either order, a unit between, a symbol name.
        ['41 GGT', '[value] GGT'], ['Lp(a) 120', 'Lp(a) [value]'], ['γ-GT 33', 'γ-GT [value]'],
        ['120 nmol/L Lp(a)', '[value] Lp(a)'], ['4.2 k+', '[value] k+'], ['7.1 a1c', '[value] a1c'],
        // A name inside a longer word is not the name.
        ['12 bananas', '12 bananas'], ['2 cholesterols', '2 cholesterols'],
      ]) {
        expect(impl.scrubText(text), text).toBe(scrubbed);
      }
    }
  });

  it('US-09 AC7f — a value starts at the head of its digit run, so the match that wins is unchanged, on both copies', () => {
    for (const impl of [source, copy]) {
      for (const [text, scrubbed] of [
        ['1.2.3 ldl', '1.[value] ldl'], ['12.34.5 ldl', '12.[value] ldl'], ['1,2,3 ldl', '1,[value] ldl'],
        ['120/80/60 bp', '120/[value] bp'], ['1.2/3.4/5 bp', '1.2/[value] bp'], ['12345 ldl', '[value] ldl'],
        ['2026.11.04 ldl', '2026.[value] ldl'], ['v1.2.3 ldl', 'v1.[value] ldl'], ['1/2/3 hba1c', '1/[value] hba1c'],
        ['3.2.1 Lp(a)', '3.[value] Lp(a)'],
        // A name that starts with digits is the name, not part of the value.
        ['5 17-ohp', '[value] 17-ohp'], ['12 25(oh)d', '[value] 25(oh)d'],
      ]) {
        expect(impl.scrubText(text), text).toBe(scrubbed);
      }
    }
  });

  it('US-09 AC7f — bounded email parts scrub both of two adjacent addresses, on both copies', () => {
    for (const impl of [source, copy]) {
      for (const [text, scrubbed] of [
        ['mail x.y+z@ex.co.uk now', 'mail [email] now'], ['a@b.com@c.org', '[email]@c.org'], ['..a@b.co', '[email]'],
        ['(brad@example.com)', '([email])'], ['é-brad@example.com', 'é[email]'], ['brad@@example.com', 'brad@@example.com'],
        // A second address straight after the first, joined by a character an address can hold.
        ['mailto:a@b.com%2Cc@d.com', 'mailto:[email][email]'], ['a@b.com+joe@x.com', '[email][email]'],
        ['a@b.com-joe@x.com', '[email][email]'], ['a@b.com_joe@x.com', '[email][email]'], ['a@b.com1x@y.com', '[email][email]'],
        ['a@b.co.uk-x@y.com', '[email][email]'], ['first@example.com+second@example.org', '[email][email]'],
        ['a@b.com%20c@d.com', '[email][email]'],
        // A local part over 64 characters keeps all but its last 64 (a stated residual).
        [`${'x'.repeat(100)}@example.com`, `${'x'.repeat(36)}[email]`],
      ]) {
        expect(impl.scrubText(text), text).toBe(scrubbed);
      }
    }
  });

  // The value and email rules backtracked from every position inside a long
  // run: about 0.8 s for 40,000 digits or letters. Linear now; the bound is
  // generous for a slow CI runner.
  it('US-09 AC7f — 40,000 digits or letters scrub in well under a second, on both copies', () => {
    for (const impl of [source, copy]) {
      for (const run of ['1'.repeat(40_000), 'a'.repeat(40_000)]) {
        const start = performance.now();
        expect(impl.scrubText(run)).toBe(run);
        expect(performance.now() - start, `${impl === copy ? 'copy' : 'source'} ${run[0]}`).toBeLessThan(300);
      }
    }
  });

  it('US-09 AC7f — the server hook scrubs the value from the message and the exception value', () => {
    const event = copy.scrubServerEvent({
      message: 'came back 120 lp(a)',
      exception: { values: [{ type: 'Error', value: 'import failed at 33 γ-GT for mailto:a@b.com%2Cc@d.com' }] },
      extra: { to: 'first@example.com+second@example.org', level: '120 lp(a)s' },
    });
    expect(event.message).toBe('came back [value] lp(a)');
    expect(event.exception.values[0].value).toBe('import failed at [value] γ-GT for mailto:[email][email]');
    expect(event.extra).toEqual({ to: '[email][email]', level: '[value] lp(a)s' });
  });

  it('scrubText produces identical output', () => {
    for (const t of TEXTS) expect(copy.scrubText(t)).toBe(source.scrubText(t));
  });

  it('scrubStrings and dropLongStrings produce identical output', () => {
    const nested = { a: TEXTS[0], b: [TEXTS[1], 2, null], c: { d: 'x'.repeat(300) } };
    expect(copy.scrubStrings(nested)).toEqual(source.scrubStrings(nested));
    expect(copy.dropLongStrings(nested)).toEqual(source.dropLongStrings(nested));
  });

  it('scrubEventText produces identical output', () => {
    const build = () => ({
      message: TEXTS[0],
      exception: { values: [{ type: 'Error', value: TEXTS[0], stacktrace: { frames: [{ filename: 'app/routes/chat.ts' }] } }] },
      extra: { message: TEXTS[0] },
      tags: { area: 'chat', note: TEXTS[1] },
      breadcrumbs: [{ category: 'console', message: TEXTS[0], data: { arguments: [TEXTS[2]] } }],
    });
    const a = build(); const b = build();
    source.scrubEventText(a); copy.scrubEventText(b);
    expect(b).toEqual(a);
  });

  // US-09 AC7h: the trace context's ids survive in their exact shape and are
  // scrubbed in any other, the same way on both copies.
  it('US-09 AC7h — trace and span ids: kept in their exact shape at their exact paths, on both copies', () => {
    const TRACE_ID = 'e2123456789abcdef0123456789abcde';
    const SPAN_ID = 'e212345678abcdef';
    const trace = (trace_id: string, span_id: string, parent_span_id: string) => ({
      trace_id, span_id, parent_span_id, links: [{ trace_id, span_id, sampled: false }],
    });
    const ID_CASES = [
      trace(TRACE_ID, SPAN_ID, SPAN_ID),
      trace('LDL 3.2 mmol/L', 'e2 45', 'e2 45'),
      trace(TRACE_ID.toUpperCase(), SPAN_ID.toUpperCase(), SPAN_ID.toUpperCase()),
      trace(TRACE_ID.slice(1), `${SPAN_ID}0`, TRACE_ID),
    ];
    const build = (t: ReturnType<typeof trace>) => ({
      event_id: TRACE_ID,
      contexts: { trace: t, other: { trace_id: TRACE_ID, span_id: SPAN_ID } },
      spans: [{ span_id: SPAN_ID, parent_span_id: SPAN_ID, trace_id: TRACE_ID }],
      extra: { trace_id: TRACE_ID, span_id: SPAN_ID },
      tags: { trace_id: TRACE_ID },
    });
    for (const [i, t] of ID_CASES.entries()) {
      const a = build(t); const b = build(t);
      source.scrubEventText(a); copy.scrubEventText(b);
      expect(b).toEqual(a);
      const kept = i === 0;
      expect(a.contexts.trace).toEqual(kept ? t : trace(
        source.scrubText(t.trace_id), source.scrubText(t.span_id), source.scrubText(t.parent_span_id)));
      expect(a.event_id).toBe(TRACE_ID);
      expect(a.spans).toEqual(build(t).spans);
      expect(a.contexts.other).toEqual({ trace_id: source.scrubText(TRACE_ID), span_id: source.scrubText(SPAN_ID) });
      expect(a.extra).toEqual({ trace_id: source.scrubText(TRACE_ID), span_id: source.scrubText(SPAN_ID) });
      expect(a.tags).toEqual({ trace_id: source.scrubText(TRACE_ID) });
    }
  });

  // Adversary R2 of PR #1300: attacker-shaped inputs at and near the id paths
  // keep nothing they should not, and add no key, the same way on both copies.
  it('US-09 AC7h — odd shapes at the id paths: scrubbed or untouched, never kept as text, on both copies', () => {
    const TRACE_ID = 'e2123456789abcdef0123456789abcde';
    const SPAN_ID = 'e212345678abcdef';
    const TEXT = 'LDL 3.2 mmol/L e2 45';
    const t = source.scrubText(TRACE_ID); const s = source.scrubText(SPAN_ID); const x = source.scrubText(TEXT);
    expect(t).not.toBe(TRACE_ID);
    expect(x).not.toBe(TEXT);
    const both = (make: () => Record<string, unknown>) => {
      const a = { contexts: make() }; const b = { contexts: make() };
      source.scrubEventText(a); copy.scrubEventText(b);
      expect(b).toEqual(a);
      return a.contexts as Record<string, unknown>;
    };

    // links as a plain object, not an array: no exemption, everything scrubbed.
    expect(both(() => ({ trace: { links: { 0: { trace_id: TRACE_ID, span_id: SPAN_ID, note: TEXT } } } })))
      .toEqual({ trace: { links: { 0: { trace_id: t, span_id: s, note: x } } } });

    // A trace nested one level deeper, under trace or any other context: scrubbed.
    expect(both(() => ({ other: { trace: { trace_id: TRACE_ID } }, trace: { trace: { trace_id: TEXT } } })))
      .toEqual({ other: { trace: { trace_id: t } }, trace: { trace: { trace_id: x } } });

    // Inside a link only trace_id and span_id are kept; parent_span_id and note are scrubbed.
    expect(both(() => ({ trace: { links: [{ trace_id: TRACE_ID, span_id: SPAN_ID, parent_span_id: SPAN_ID, note: TEXT }] } })))
      .toEqual({ trace: { links: [{ trace_id: TRACE_ID, span_id: SPAN_ID, parent_span_id: s, note: x }] } });
    expect(both(() => ({ trace: { links: [{ parent_span_id: TEXT }] } })))
      .toEqual({ trace: { links: [{ parent_span_id: x }] } });

    // An empty link, or a trace with no ids: no key is added.
    expect(both(() => ({ trace: { links: [{}] } }))).toEqual({ trace: { links: [{}] } });
    expect(both(() => ({ trace: { op: 'http.server' } }))).toEqual({ trace: { op: 'http.server' } });

    // A non-string id gets what the same value gets at any other path; an id inside it is scrubbed.
    for (const make of [() => [TRACE_ID], () => 12345, () => new String(TRACE_ID)]) {
      const out = both(() => ({ trace: { trace_id: make(), links: [{ span_id: make() }] }, other: { trace_id: make() } }));
      const elsewhere = (out.other as Record<string, unknown>).trace_id;
      expect(out.trace).toEqual({ trace_id: elsewhere, links: [{ span_id: elsewhere }] });
      expect(JSON.stringify(out.trace)).not.toContain(TRACE_ID);
    }
    expect(both(() => ({ trace: { trace_id: [TRACE_ID] } }))).toEqual({ trace: { trace_id: [t] } });

    // A getter that returns text on its first read and an id on its second: the text never leaves.
    const flipping = () => {
      let reads = 0;
      return { trace: { get trace_id() { return reads++ ? TRACE_ID : TEXT; } } };
    };
    const out = both(flipping);
    expect(JSON.stringify(out)).not.toContain('3.2');
    expect(JSON.stringify(out)).not.toContain('LDL');
  });

  // The .mjs cannot import units.ts (it loads before the bundle, outside the
  // workspace), so the vocabulary is a literal in both files. This is the guard
  // that fails when units.ts or mappings.ts gains an entry the lists miss.
  it('SCRUB_UNITS covers every unit label in UNIT_DEFS (both impls)', () => {
    const norm = (u: string) => u.toLowerCase().replace(/\s+/g, '');
    for (const impl of [source, copy]) {
      const known = new Set(impl.SCRUB_UNITS.map(norm));
      for (const metric of METRIC_TYPES) {
        const def = UNIT_DEFS[metric];
        for (const unit of [def.canonical, def.label.si, def.label.conventional]) {
          expect(known, `unit "${unit}" (${metric}) missing from SCRUB_UNITS`).toContain(norm(unit));
        }
      }
    }
  });

  it('SCRUB_METRIC_WORDS covers every metric name (both impls)', () => {
    const norm = (s: string) => s.toLowerCase().replace(/_/g, ' ');
    for (const impl of [source, copy]) {
      const words = impl.SCRUB_METRIC_WORDS as string[];
      for (const metric of METRIC_TYPES) {
        for (const name of [norm(metric), norm(METRIC_LABELS[metric] ?? metric)]) {
          expect(words.some(w => name.includes(w)), `no scrub word for "${name}"`).toBe(true);
        }
      }
    }
  });

  it('the server never keeps console breadcrumbs', () => {
    const server = readFileSync(new URL('../../../instrument.server.mjs', import.meta.url), 'utf8');
    expect(server).toMatch(/defaults\.filter\(\(i\) => i\.name !== "Console"\)/);
    expect(server).toMatch(/category === "console"\) return null/);
  });
});

// ---------------------------------------------------------------------------
// Pipeline parity: the browser and the server must scrub the SAME event alike
