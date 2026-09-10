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
// @ts-expect-error -- plain .mjs script with no declarations; this parity test
// only needs its runtime exports.
import * as copy from '../../../instrument-scrub.mjs';

// One field per sensitive key currently redacted by the source. If health-core's list grows,
// add the key here AND to instrument-scrub.mjs (the in-code comments say so).
const SENSITIVE_SAMPLE: Record<string, unknown> = {
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
  sex: 'male',
  shopify_customer_id: '123', customerId: '123',
  userId: 'u1', user_id: 'u1',
  unsubscribe_token: 'tok',
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
      // OAuth/PKCE params (both impls must redact all of these, keep `safe`)
      '/callback?code=SECRET&state=BLOB&access_token=X&safe=1',
      'https://drstanfield.com/cb?code_verifier=v&code_challenge=c&client_secret=s&refresh_token=r&id_token=i&assertion=a&page=2',
      // exact-match semantics: lookalike params must survive untouched
      'https://example.com/x?estate=maple&statement=ok&postcode=1010',
      'not a url',
    ];
    for (const u of urls) {
      expect(copy.scrubUrl(u)).toBe(source.scrubUrl(u));
    }
  });

  it('scrubBreadcrumbData produces identical output', () => {
    const data = {
      url: 'https://x.com/a?token=t',
      body: 'health payload',
      request_body: 'x', request_body_size: 10, response_body_size: 20,
      status_code: 200,
    };
    expect(copy.scrubBreadcrumbData(data)).toEqual(source.scrubBreadcrumbData(data));
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
];

describe('free-text scrub parity', () => {
  it('both impls carry the SAME vocabularies', () => {
    expect(copy.SCRUB_UNITS).toEqual(source.SCRUB_UNITS);
    expect(copy.SCRUB_METRIC_WORDS).toEqual(source.SCRUB_METRIC_WORDS);
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
