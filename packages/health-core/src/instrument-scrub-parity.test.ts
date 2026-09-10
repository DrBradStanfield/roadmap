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
import { foldName, LAB_CATALOG } from './lab-catalog';
import { scrubEvent } from '../../../widget-src/src/lib/sentry';
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
  unsubscribe_token: 'tok', accessToken: 'tok', authorization: 'Bearer x',
  bearerToken: 'b', apiKey: 'k', api_key: 'k',
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
      // every param NAMED after a token redacts, whatever its case or prefix
      'https://drstanfield.com/api/lab-import?batchId=b&pollToken=SECRET',
      'not a url',
    ];
    for (const u of urls) {
      expect(copy.scrubUrl(u)).toBe(source.scrubUrl(u));
    }
    for (const impl of [source, copy]) {
      const out = impl.scrubUrl('https://drstanfield.com/api/lab-import?batchId=b&pollToken=SECRET');
      expect(out).not.toContain('SECRET');
      expect(out).toContain('batchId=b');
    }
  });

  it('scrubBreadcrumbData keeps the origin and nothing else, identically', () => {
    const data = {
      url: 'https://content.dropboxapi.com/2/files/download?path=/Apps/roadmap/Brad%20lipids.pdf',
      body: 'health payload',
      request_body: 'x', request_body_size: 10, response_body_size: 20,
      status_code: 200,
    };
    const out = source.scrubBreadcrumbData(data);
    expect(out).toEqual({ url: 'https://content.dropboxapi.com', status_code: 200 });
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
];

describe('free-text scrub parity', () => {
  // sentry-scrub.ts DERIVES both lists from UNIT_DEFS, METRIC_LABELS and the
  // lab catalogue; the .mjs cannot import, so it carries them as literals. When
  // the catalogue moves, these two fail and print the array to paste back.
  const paste = (name: string, words: readonly string[]) =>
    `${name} drifted — paste this array into instrument-scrub.mjs:\n[\n  ${
      words.map(w => (w.includes("'") ? JSON.stringify(w) : `'${w}'`)).join(', ')}\n]`;

  it('instrument-scrub.mjs carries the derived SCRUB_UNITS verbatim', () => {
    expect(copy.SCRUB_UNITS, paste('SCRUB_UNITS', source.SCRUB_UNITS)).toEqual(source.SCRUB_UNITS);
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
      const units = new Set(impl.SCRUB_UNITS.map(u => u.toLowerCase()));
      for (const entry of LAB_CATALOG) {
        expect(units, `unit "${entry.unit}" (${entry.key}) missing`).toContain(entry.unit.toLowerCase());
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

// ---------------------------------------------------------------------------
// Pipeline parity: the browser and the server must scrub the SAME event alike
// ---------------------------------------------------------------------------
// The two hooks are separate code (the browser drops third-party noise, the
// server drops console breadcrumbs), so behaviour drifted once already: the
// browser reduced breadcrumb URLs to their origin and the server kept the full
// path; the server dropped long strings and the browser kept them. One event
// through both is the guard that neither half loses a step again.

const syntheticEvent = () => ({
  message: 'My LDL is 3.2 mmol/L and cortisol 550',
  exception: {
    values: [{
      type: 'Error',
      value: 'Upload failed for HbA1c 42 mmol/mol',
      stacktrace: { frames: [{ filename: 'app/routes/upload.ts', lineno: 12 }] },
    }],
  },
  extra: {
    accessToken: 'sl.ABC-secret',
    note: 'waist 101 cm',
    paste: 'x'.repeat(300),
    status: 200,
  },
  tags: { area: 'chat' },
  breadcrumbs: [{
    category: 'fetch',
    data: {
      url: 'https://content.dropboxapi.com/2/files/download?path=/Apps/roadmap/Brad%20lipids.pdf',
      body: 'health payload',
      status_code: 200,
    },
  }],
  request: { url: 'https://drstanfield.com/apps/health-tool-1/api/chat?token=abc', headers: {} },
});

describe('beforeSend pipeline parity (browser ↔ server)', () => {
  it('scrubs one synthetic event to the same output on both sides', () => {
    const browser = scrubEvent(syntheticEvent() as never) as unknown as Record<string, unknown>;
    const server = copy.scrubServerEvent(syntheticEvent()) as Record<string, unknown>;

    expect(browser).toEqual(server);
    // …and what that output must actually be: no token, no value, no path, no paste.
    expect(browser.extra).toEqual({ accessToken: '[Filtered]', note: 'waist [value]', status: 200 });
    expect(browser.message).toBe('My LDL is [value] and cortisol [value]');
    expect((browser.breadcrumbs as Array<{ data: Record<string, unknown> }>)[0].data)
      .toEqual({ url: 'https://content.dropboxapi.com', status_code: 200 });
    expect((browser.request as { url: string }).url)
      .toBe('https://drstanfield.com/apps/health-tool-1/api/chat?token=%5BFiltered%5D');
    // Stack frames are not extra: a filename is never a key, so it survives whole.
    const frames = (browser.exception as { values: Array<{ stacktrace: { frames: Array<{ filename: string }> } }> })
      .values[0].stacktrace.frames;
    expect(frames[0].filename).toBe('app/routes/upload.ts');
  });
});
