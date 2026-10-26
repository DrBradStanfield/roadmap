// US-58: the "about this measure" guides are display-only text bound by the
// clinical files. AC1 (which guides), AC2 (no new citation, no new number).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_GUIDES } from './metric-guides';
import { GUIDE_REFERENCES, SUGGESTION_EVIDENCE, STAT_CARD_EVIDENCE, getBmiEvidence, getIbwEvidence, getProteinEvidence } from './evidence';
import { BLOOD_TEST_METRICS, VITAL_METRICS } from './mappings';
import { ESCALATION_KEY_OF, MEDICATION_KEYS } from './validation';

const ROOT = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const FILES = {
  algorithm: read('health_roadmap_algorithm.md'),
  evidence: read('packages/health-core/src/evidence.ts'),
  html: read('roadmap_text.html'),
  // The app's own drug list, already shown to the user in the medication question.
  types: read('packages/health-core/src/types.ts'),
};

/** Brad's decisions on the draft (2026-10-25 and 2026-10-26), the source of a `brad` entry below. */
const draft = read('docs/drafts/metric-guides.md');
const bradStart = draft.indexOf("## Brad's decisions (2026-10-25)"), bradEnd = draft.indexOf('## Proposed shape');
if (bradStart < 0 || bradEnd < bradStart) throw new Error("metric-guides.md lost its Brad's decisions or Proposed shape heading");
const BRAD = draft.slice(bradStart, bradEnd);
if (!BRAD.includes("## Brad's decisions (2026-10-26)")) throw new Error("metric-guides.md lost its Brad's decisions (2026-10-26) heading");

/**
 * Every quantity a guide states, in digits or in words, with where it is already said:
 * `as` is that file's own wording, and it must state the same quantities (`quantities`).
 * `brad` is Brad's decisions on the draft; `types` is the app's drug list, already shown
 * in the medication question.
 */
type Source = keyof typeof FILES | 'brad';
const SOURCED: Record<string, Array<{ says: string; in: Source; as: string }>> = {
  waist: [{ says: 'below half your height', in: 'algorithm', as: 'normal WHtR (< 0.5)' }],
  blood_pressure: [
    { says: 'for 30 minutes before', in: 'brad', as: 'smoking for 30 minutes before' },
    { says: 'Sit quietly for 5 minutes', in: 'brad', as: 'Sit quietly for 5 minutes' },
    { says: 'Take two readings a minute apart', in: 'brad', as: 'Take two readings a minute apart' },
    { says: 'Every 2 to 4 weeks', in: 'html', as: 'once every 2-4 weeks' },
  ],
  hba1c: [{ says: 'past 2 to 3 months', in: 'algorithm', as: 'HbA1c captures 2–3 months' }],
  creatinine: [{ says: 'CKD-EPI 2021', in: 'algorithm', as: 'CKD-EPI 2021' }],
  psa: [
    { says: 'for 48 hours', in: 'brad', as: '48 hours without ejaculation or hard cycling' },
    { says: 'roughly by half', in: 'brad', as: 'roughly halve PSA' },
  ],
  apob: [{ says: 'sits once on every particle', in: 'evidence', as: 'carries exactly one ApoB molecule' }],
  lpa: [
    { says: 'The 2026 ACC/AHA guideline advises measuring it at least once in every adult', in: 'algorithm',
      as: '2026 ACC/AHA Dyslipidemia Guideline (Class I: measure Lp(a) at least once in all adults)' },
    { says: 'One test is usually enough for life', in: 'evidence', as: 'A single lifetime measurement is usually sufficient' },
  ],
  ezetimibe: [
    { says: 'A daily 10 mg tablet', in: 'algorithm', as: 'ezetimibe 10mg' },
    { says: 'by a further 15 to 20%', in: 'evidence', as: 'additional 15–20%' },
  ],
  bempedoic_acid: [
    { says: 'A daily 180 mg tablet (Nexletol)', in: 'types', as: 'Nexletol (bempedoic acid 180mg)' },
    { says: '13% fewer major heart and blood vessel events', in: 'evidence', as: '13% reduction in major adverse cardiovascular events' },
  ],
  pcsk9i: [
    { says: 'They come in three kinds', in: 'brad', as: 'the entry names all three kinds' },
    { says: 'usually every 2 or 4 weeks', in: 'brad', as: 'usually every 2 or 4 weeks' },
    { says: 'twice a year once started', in: 'brad', as: 'twice a year once started' },
    { says: 'by a further 50 to 60%', in: 'evidence', as: 'additional 50–60%' },
    { says: 'by about 25 to 30%', in: 'evidence', as: 'approximately 25–30%' },
  ],
};

/** Words that state no quantity of their own: names with a digit, and counts of what the sentence lists. */
const NOT_QUANTITIES: Record<string, string[]> = {
  '*': ['GLP-1', 'SGLT2', 'PCSK9', 'HbA1c', 'B12', 'type 2 diabetes'],
  weight: ['not single days'],
  height: ['You enter it once in your profile'],
  apob: ['Two people with the same LDL'],
  lpa: ['The app accepts all three'],
  glp1: ['acts on two hormones, GLP-1 and GIP'],
};

const WORDS: Record<string, number> = {
  once: 1, single: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  dozen: 12, hundred: 100, thousand: 1000, double: 2, triple: 3, third: 1 / 3, quarter: 0.25,
  half: 0.5, halve: 0.5, 'a few': -1,
};
const QUANTITY = new RegExp(`\\d+(?:\\.\\d+)?|\\b(?:${Object.keys(WORDS).join('|')})\\b`, 'gi');
/** The quantities a text states, digits and words alike, sorted. */
const quantities = (text: string) =>
  (text.match(QUANTITY) ?? []).map((q) => WORDS[q.toLowerCase()] ?? Number(q)).sort((a, b) => a - b);

const textOf = (key: string) => {
  const g = METRIC_GUIDES[key];
  return [g.title, g.whatItIs, g.whyItMatters, g.howTo.heading, ...g.howTo.points].join('\n');
};

/** Every reference evidence.ts holds, from its maps and its builders. */
const EVIDENCE_REFS = [
  ...Object.values(SUGGESTION_EVIDENCE), ...Object.values(STAT_CARD_EVIDENCE),
  getIbwEvidence('male'), getBmiEvidence(27, 'male'), getProteinEvidence(70, 1.2),
].flatMap((e) => e.references).concat(GUIDE_REFERENCES);

describe('METRIC_GUIDES (US-58)', () => {
  it('AC1: one guide per vital and blood test, blood pressure as one, height, and each medicine but the escalation answers', () => {
    const escalations: string[] = Object.values(ESCALATION_KEY_OF);
    const expected = [
      ...VITAL_METRICS.filter((m) => m !== 'systolic_bp' && m !== 'diastolic_bp'), 'blood_pressure', 'height',
      ...BLOOD_TEST_METRICS,
      ...MEDICATION_KEYS.filter((k) => !escalations.includes(k)),
    ];
    expect(Object.keys(METRIC_GUIDES).sort()).toEqual([...expected].sort());
    expect(Object.keys(METRIC_GUIDES)).toHaveLength(20);
  });

  it('AC1: every guide has its parts, with no draft marker and no em dash', () => {
    for (const [key, g] of Object.entries(METRIC_GUIDES)) {
      expect(g.title, key).not.toBe('');
      expect(g.whatItIs, key).not.toBe('');
      expect(g.whyItMatters, key).not.toBe('');
      expect(g.howTo.heading, key).not.toBe('');
      expect(g.howTo.points.length, key).toBeGreaterThanOrEqual(2);
      expect(g.sources.length, key).toBeGreaterThanOrEqual(1);
      const text = textOf(key);
      expect(text, key).not.toMatch(/NEEDS BRAD|new text|—/);
    }
  });

  it('AC1: each medicine\'s list ends with "talk to your doctor" (Brad\'s decision 5)', () => {
    for (const key of ['statin', 'ezetimibe', 'pcsk9i', 'bempedoic_acid', 'glp1', 'sglt2i', 'metformin']) {
      expect(METRIC_GUIDES[key].howTo.points.at(-1), key).toMatch(/talk to your doctor\.$/);
    }
  });

  it('AC2: every source is a reference evidence.ts already holds, never a new citation', () => {
    for (const [key, g] of Object.entries(METRIC_GUIDES)) {
      for (const source of g.sources) {
        expect(EVIDENCE_REFS.some((r) => r.label === source.label && r.url === source.url), `${key}: ${source.label}`).toBe(true);
      }
    }
  });

  it('AC2: a guide states only the quantities on its list, each tied to the same quantities in its source', () => {
    const sources = { ...FILES, brad: BRAD };
    for (const key of Object.keys(METRIC_GUIDES)) {
      let text = textOf(key);
      for (const phrase of NOT_QUANTITIES[key] ?? []) {
        expect(text, `${key}: "${phrase}"`).toContain(phrase);
        text = text.split(phrase).join('');
      }
      for (const n of SOURCED[key] ?? []) {
        expect(text, `${key} lists "${n.says}" but does not say it`).toContain(n.says);
        expect(sources[n.in], `${key}: "${n.as}" in ${n.in}`).toContain(n.as);
        expect(quantities(n.as), `${key}: "${n.says}" against "${n.as}"`).toEqual(expect.arrayContaining(quantities(n.says)));
        expect(quantities(n.says).length, `${key}: "${n.says}" states a quantity`).toBeGreaterThan(0);
        text = text.split(n.says).join('');
      }
      for (const name of NOT_QUANTITIES['*']) text = text.split(name).join('');
      expect(quantities(text), `${key} states a quantity not on its list`).toEqual([]);
    }
  });

  it('AC2: the audit sees quantities in words as well as digits', () => {
    expect(quantities('twice a year, every 2 weeks, half, a few months, one test')).toEqual([-1, 0.5, 1, 2, 2]);
  });

  it('AC2: the references added for the guides are roadmap_text.html\'s own, and each one is cited', () => {
    for (const r of GUIDE_REFERENCES) {
      const [author, year] = r.label.split(' ');
      // roadmap_text.html's reference list: "<li>Author, A., et al., <em>Title.</em> Journal, Year."
      expect(FILES.html, r.label).toMatch(new RegExp(`<li>${author}, [^\\n]*?, ${year}\\.`));
      expect(Object.values(METRIC_GUIDES).some((g) => g.sources.includes(r)), r.label).toBe(true);
    }
  });

  it('AC2: the algorithm names the guides as display-only text', () => {
    expect(FILES.algorithm).toContain('metric-guides.ts');
  });
});
