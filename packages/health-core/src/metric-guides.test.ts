// US-58: the "about this measure" guides are display-only text bound by the
// clinical files. AC1 (which guides), AC2 (no new citation, no new number), AC7 (the
// Apple Health guides, Brad 2026-10-31: Apple cited only for device facts).
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
/** Brad's decisions on the Apple Health guides' draft (2026-10-31). */
const live = read('docs/drafts/live-metric-guides.md');
const liveStart = live.indexOf("## Brad's decisions (2026-10-31)"), liveEnd = live.indexOf('## What Apple does');
if (liveStart < 0 || liveEnd < liveStart) throw new Error("live-metric-guides.md lost its Brad's decisions or What Apple does heading");
const BRAD_LIVE = live.slice(liveStart, liveEnd);

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
  // Knowler 2002 (DPP): 31% fewer cases with metformin, 58% with lifestyle (Brad 2026-10-27, option A).
  metformin: [{ says: 'by about a third', in: 'evidence', as: 'by about a third versus placebo; lifestyle change did more' }],
  // The Apple Health guides (AC7): roadmap_text.html states each new number with its citation.
  resting_heart_rate: [
    { says: '46 studies, each 10 bpm higher was linked with about 9% higher risk of death', in: 'html',
      as: '46 studies, each 10 beats per minute higher was linked with about 9% higher risk of death' },
  ],
  sleep: [
    { says: '7 to 9 hours a night', in: 'algorithm', as: '7-9 hours nightly' },
    { says: 'over 1.3 million people', in: 'evidence', as: 'over 1.3 million participants' },
    { says: '(under 6 hours)', in: 'evidence', as: 'short sleep (<6 hours)' },
    { says: '(over 8 to 9 hours)', in: 'evidence', as: 'long sleep (>8–9 hours)' },
    { says: 'at least 30 minutes of daylight', in: 'html', as: 'at least 30 minutes of natural sunlight' },
    { says: '3 to 4 hours after waking', in: 'html', as: 'more than 3 to 4 hours after waking' },
    { says: 'in the 4 to 6 hours before bed', in: 'html', as: 'at least 4-6 hours before going to bed' },
    { says: 'around 18 to 20 °C', in: 'html', as: 'around 18-20 degrees Celsius' },
  ],
  vo2_max: [
    { says: 'a meta-analysis of 33 studies, people with low fitness had a higher risk of death and heart disease', in: 'html',
      as: 'a meta-analysis of 33 studies, people with low fitness had a higher risk of death and heart disease' },
    { says: 'from age 60, Low', in: 'html', as: 'From age 60, Low uses' },
  ],
  steps: [
    { says: '15 studies of about 47,000 adults', in: 'html', as: '15 studies of about 47,000 adults' },
    { says: 'about 6,000 to 8,000 steps a day in people aged 60 and over, and 8,000 to 10,000 in younger adults', in: 'html',
      as: 'about 6,000 to 8,000 steps a day in people aged 60 and over, and 8,000 to 10,000 in younger adults' },
    { says: '150 minutes of moderate activity', in: 'algorithm', as: 'At least 150 min moderate cardio' },
    { says: 'walk the last 10 minutes', in: 'html', as: 'allowing for a 10-minute walk' },
  ],
};

/** Words that state no quantity of their own: names with a digit, and counts of what the sentence lists. */
const NOT_QUANTITIES: Record<string, string[]> = {
  '*': ['GLP-1', 'SGLT2', 'PCSK9', 'HbA1c', 'B12', 'type 2 diabetes', 'VO2'],
  weight: ['not single days'],
  height: ['You enter it once in your profile'],
  apob: ['Two people with the same LDL'],
  lpa: ['The app accepts all three'],
  glp1: ['acts on two hormones, GLP-1 and GIP'],
  heart_rate: ['any one reading'],
  vo2_max: ['one of the strongest predictors'],
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

/** The five Apple Health metrics' keys (AC7): the app's `LiveMetric.guideKey`, snake case (Brad's decision 1). */
const APPLE_HEALTH = ['heart_rate', 'resting_heart_rate', 'sleep', 'vo2_max', 'steps'];

/** roadmap_text.html's numbered references, in order, and the numbers its text cites. */
const refsAt = FILES.html.indexOf('<h2 id="references">');
const REF_LIST = FILES.html.slice(refsAt, FILES.html.indexOf('<h2 id="changelog">')).match(/^<li>.*$/gm) ?? [];
const BODY = FILES.html.slice(0, refsAt);
const MARKER = /\[(\d+(?:[-–]\d+)?(?:, \d+(?:[-–]\d+)?)*)\]/g;
const numbersIn = (marker: string) => marker.split(', ').flatMap((part) => {
  const [a, b = a] = part.split(/[-–]/).map(Number);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
});
/** The reference list's number for a GUIDE_REFERENCES entry, found by its DOI or URL. */
const numberOf = (url: string) => REF_LIST.findIndex((li) => li.includes(url.replace('https://doi.org/', ''))) + 1;
/**
 * What each citation of `n` supports (`span`: the text from the previous marker, or the start of
 * its paragraph or item, up to it) and its paragraph or item so far (`lead`).
 */
const spansCiting = (n: number) => {
  const spans: Array<{ span: string; lead: string }> = [];
  let from = 0;
  const strip = (html: string) => html.replace(/<[^>]+>/g, '');
  for (const m of BODY.matchAll(MARKER)) {
    const upTo = BODY.slice(0, m.index);
    const element = Math.max(upTo.lastIndexOf('<li'), upTo.lastIndexOf('<p'));
    if (numbersIn(m[1]).includes(n)) {
      spans.push({ span: strip(BODY.slice(Math.max(from, element), m.index)), lead: strip(BODY.slice(element, m.index)) });
    }
    from = m.index + m[0].length;
  }
  return spans;
};
const isApple = (label: string) => label.startsWith('Apple ');

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
      ...APPLE_HEALTH,
    ];
    expect(Object.keys(METRIC_GUIDES).sort()).toEqual([...expected].sort());
    expect(Object.keys(METRIC_GUIDES)).toHaveLength(25);
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
    const sources = { ...FILES, brad: BRAD + BRAD_LIVE };
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
      // roadmap_text.html's reference list: "<li>Author, A., et al., <em>Title.</em> Journal, Year." (Apple as "Apple Inc.")
      expect(FILES.html, r.label).toMatch(new RegExp(`<li>${author}(?: Inc\\.)?, [^\\n]*?, ${year}\\.`));
      expect(Object.values(METRIC_GUIDES).some((g) => g.sources.includes(r)), r.label).toBe(true);
    }
  });

  it('AC7: each reference added for the Apple Health guides is in the list and cited in the text by its number', () => {
    const added = GUIDE_REFERENCES.filter((r) => APPLE_HEALTH.some((k) => METRIC_GUIDES[k].sources.includes(r)));
    expect(added.map((r) => r.label.split(' ')[0])).toEqual(
      ['Zhang', 'Aune', 'Reimers', 'Paluch', 'Watson', 'Milanović', 'Apple', 'Apple', 'Apple', 'Apple']);
    const cited = new Set([...BODY.matchAll(MARKER)].flatMap((m) => numbersIn(m[1])));
    for (const r of added) {
      const n = numberOf(r.url);
      expect(n, `${r.label} is in the reference list`).toBeGreaterThan(0);
      expect(cited.has(n), `${r.label} [${n}] is cited`).toBe(true);
    }
    // Appended after [122], none renumbered (Brad's decision 7); Milanović was [108] already.
    expect(REF_LIST).toHaveLength(131);
    expect(numberOf('https://doi.org/10.1056/NEJMoa012512')).toBe(122);
    expect(numberOf('https://doi.org/10.1007/s40279-015-0365-0')).toBe(108);
    expect(Math.max(...cited)).toBe(131);
  });

  it('AC7: no clinical claim cites an Apple source (Brad\'s decision 2)', () => {
    const apple = GUIDE_REFERENCES.filter((r) => isApple(r.label));
    expect(apple).toHaveLength(4);
    for (const r of apple) {
      // Its label says it backs a device fact, and every sentence that cites it names the
      // device and claims no risk or benefit.
      expect(r.label, r.label).toMatch(/\((?:Apple Support|Apple Developer|white paper); (?:how the (?:watch measures|estimate is made)|what feeds the estimate)\)$/);
      const spans = spansCiting(numberOf(r.url));
      expect(spans.length, r.label).toBeGreaterThan(0);
      for (const { span, lead } of spans) {
        expect(lead, r.label).toContain('Apple Watch');
        expect(span, r.label).not.toMatch(/risk|linked|death|dying|mortality|disease|benefit|lower/i);
      }
    }
    // A guide that states a study finding cites a study, not only Apple.
    for (const key of APPLE_HEALTH) {
      const g = METRIC_GUIDES[key];
      if (/stud|trial|meta-analysis/.test(g.whyItMatters + g.howTo.points.join(' '))) {
        expect(g.sources.some((s) => !isApple(s.label)), key).toBe(true);
      }
    }
  });

  it('AC7: the Apple Health guides have their headings, parts and sources', () => {
    const headings = { heart_rate: 'How to read it', resting_heart_rate: 'How to read it', sleep: 'How to sleep well',
      vo2_max: 'How to get a good estimate', steps: 'How to add steps' };
    for (const [key, heading] of Object.entries(headings)) {
      const g = METRIC_GUIDES[key];
      expect(g.howTo.heading, key).toBe(heading);
      expect(g.howTo.points.length, key).toBeGreaterThanOrEqual(3);
    }
    expect(METRIC_GUIDES.resting_heart_rate.sources.map((s) => s.label.split(' ')[0])).toEqual(['Zhang', 'Aune', 'Reimers', 'Apple']);
    expect(METRIC_GUIDES.sleep.sources.map((s) => s.label.split(' ')[0])).toEqual(['Cappuccio', 'Watson', 'Apple']);
    expect(METRIC_GUIDES.vo2_max.sources.map((s) => s.label.split(' – ')[0])).toEqual(['Kodama 2009', 'Kaminsky 2022', 'Apple 2021', 'Milanović 2015', 'Apple 2026']);
    expect(METRIC_GUIDES.steps.sources.map((s) => s.label.split(' ')[0])).toEqual(['Paluch', 'Bull', 'Piercy']);
    expect(METRIC_GUIDES.heart_rate.sources.map((s) => s.url)).toEqual(['https://support.apple.com/en-us/120277']);
    // No "60 to 100 bpm" normal range (Brad's decision 4).
    expect(textOf('heart_rate') + textOf('resting_heart_rate')).not.toMatch(/60 to 100|60-100/);
  });

  it('AC2: the algorithm names the guides as display-only text', () => {
    expect(FILES.algorithm).toContain('metric-guides.ts');
  });
});
