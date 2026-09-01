/**
 * Drift guard: the Sentry scrub logic is duplicated in the repo-root
 * `instrument-scrub.mjs` (a self-contained plain-ESM copy that `instrument.server.mjs`
 * imports, because it runs outside the bundle in Docker where the @roadmap/health-core
 * workspace/dist isn't available — see that file's header). This test asserts the copy
 * behaves IDENTICALLY to the health-core source. If you change scrub behaviour or the
 * sensitive-key lists in either file, update BOTH or this fails.
 */
import { describe, it, expect } from 'vitest';
import * as source from './sentry-scrub';
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
