// US-07 AC1h (the colorectal start card, form note, FIT line, evidence, algorithm doc and page):
// screening Change 2 (D1, D2), Brad 2026-11-12. Colorectal screening from 35
// is Dr Brad's recommendation (the ACS starts at 45); FIT every year until 55, then colonoscopy.
//
// The expected words are read from the approved spec, docs/drafts/screening-words-2026-11-12.md,
// section "## Change 2" (lines 42-84). A mismatch goes back to Brad; the words are never reworded here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSuggestions } from './suggestions';
import { SUGGESTION_EVIDENCE } from './evidence';
import { screeningForm } from './input-form';
import { computeNextDueDates } from './reminder-schedule';
import type { HealthResults, ScreeningInputs } from './types';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SPEC = read('docs/drafts/screening-words-2026-11-12.md');
const SECTION = SPEC.slice(SPEC.indexOf('## Change 2 '), SPEC.indexOf('## Change 3 ')).split('\n');
const HTML = read('roadmap_text.html');
const ALGO = read('health_roadmap_algorithm.md');

/** The first line starting with `prefix` at or after the line starting with `header`. */
function specLine(header: string, prefix: string): string {
  const from = SECTION.findIndex((l) => l.startsWith(header));
  const line = from < 0 ? undefined : SECTION.slice(from).find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`spec line not found: ${header} / ${prefix}`);
  return line;
}
const quotes = (line: string) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
/** The quoted strings after "After:" on a before/after line. */
const afterQuotes = (line: string) => quotes(line.slice(line.indexOf('After:')));

// Spec line 52.
const NOTE = afterQuotes(specLine('**Form note under 45**', '- After:'))[0];
// Spec lines 54, 56-58.
const START_TITLE = quotes(specLine('**Start card**', '**Start card**'))[0];
const START = {
  '35-44': quotes(specLine('**Start card**', '- After, 35 to 44:'))[0],
  '45-54': quotes(specLine('**Start card**', '- After, 45 to 54:'))[0],
  '55-75': quotes(specLine('**Start card**', '- After, 55 to 75:'))[0],
};
// Spec lines 61-62: [title, before, after].
const UP = quotes(specLine('**FIT cards from 55**', '- "Colorectal screening up to date"'));
const OVER = quotes(specLine('**FIT cards from 55**', '- "Colorectal screening overdue"'));
const FIT_LINE = UP[2].slice(UP[1].length + 1);
// Spec lines 71-72.
const REASON = afterQuotes(specLine('**evidence.ts `screening-colorectal`**', '- After:'))[0];
const WOLF_LABEL = quotes(specLine('**evidence.ts `screening-colorectal`**', '- References:'))[0];
const WOLF_URL = 'https://doi.org/10.3322/caac.21457';

const NOW = new Date('2026-10-15T12:00:00Z');
const RECENT = '2026-03'; // FIT due Mar 2027: up to date
const OLD = '2025-01'; // FIT due Jan 2026: overdue

function plan(age: number, scr: ScreeningInputs = {}) {
  const results: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age, suggestions: [] };
  return generateSuggestions({ heightCm: 175, sex: 'male' }, results, 'si', {}, scr, undefined, NOW)
    .filter((s) => s.id.startsWith('screening-colorectal'));
}
const colorectalNotes = (age: number) =>
  screeningForm(age, 'male', {}).flatMap((s) => s.groups).find((g) => g.id === 'colorectal')?.notes;

describe('US-07 AC1h: the colorectal start card by age band (spec lines 54-58)', () => {
  it('reads the spec words it checks (guard: a parse miss would pass vacuously)', () => {
    expect(START_TITLE).toBe('Start colorectal cancer screening');
    for (const t of [NOTE, ...Object.values(START), UP[2], OVER[2], REASON, WOLF_LABEL]) expect(t.length).toBeGreaterThan(40);
    expect(FIT_LINE.startsWith('From 55, Dr Brad suggests moving to a colonoscopy')).toBe(true);
  });

  it('34 and 76 get no card; 35/44, 45/54 and 55/75 get their band\'s text, at attention', () => {
    expect(plan(34)).toEqual([]);
    expect(plan(76)).toEqual([]);
    const bands: Array<[number, keyof typeof START]> = [
      [35, '35-44'], [44, '35-44'], [45, '45-54'], [54, '45-54'], [55, '55-75'], [75, '55-75'],
    ];
    for (const [age, band] of bands) {
      expect(plan(age, { colorectalMethod: 'not_yet_started' }), `age ${age}`).toEqual([
        expect.objectContaining({ id: 'screening-colorectal', priority: 'attention', title: START_TITLE, description: START[band] }),
      ]);
    }
  });
});

describe('US-07 AC1h: the colorectal form note under 45 (spec line 52)', () => {
  it('shows the approved note at 35 and 44, none at 45, and no colorectal group at 34', () => {
    expect(colorectalNotes(34)).toBeUndefined();
    expect(colorectalNotes(35)).toEqual([NOTE]);
    expect(colorectalNotes(44)).toEqual([NOTE]);
    expect(colorectalNotes(45)).toEqual([]);
    expect(colorectalNotes(75)).toEqual([]);
  });
});

describe('US-07 AC1h: the FIT line from 55 (spec lines 60-63)', () => {
  const fit = (last: string): ScreeningInputs => ({ colorectalMethod: 'fit_annual', colorectalLastDate: last, colorectalResult: 'normal' });

  it('on yearly FIT at 55 and at 75, the up-to-date and overdue cards carry the approved words', () => {
    for (const age of [55, 75]) {
      expect(plan(age, fit(RECENT)), `age ${age} up to date`).toEqual([expect.objectContaining({
        id: 'screening-colorectal-upcoming', priority: 'info', title: UP[0], description: UP[2].replace('{due}', 'Mar 2027'),
      })]);
      expect(plan(age, fit(OLD)), `age ${age} overdue`).toEqual([expect.objectContaining({
        id: 'screening-colorectal-overdue', priority: 'attention', title: OVER[0], description: OVER[2].replace('{due}', 'Jan 2026'),
      })]);
    }
  });

  it('no line at 54 on FIT, nor at 60 on colonoscopy or another method', () => {
    expect(plan(54, fit(RECENT))[0].description).toBe(UP[1].replace('{due}', 'Mar 2027'));
    expect(plan(54, fit(OLD))[0].description).toBe(OVER[1].replace('{due}', 'Jan 2026'));
    for (const method of ['colonoscopy_10yr', 'other'] as const) {
      for (const last of [RECENT, '2010-01']) {
        const cards = plan(60, { colorectalMethod: method, colorectalLastDate: last, colorectalResult: 'normal' });
        expect(cards, `${method} ${last}`).toHaveLength(1);
        expect(cards[0].description, `${method} ${last}`).not.toContain(FIT_LINE);
        expect([UP[1], OVER[1]].map((t) => t.replace('{due}', ''))).toContain(cards[0].description.replace(/[A-Z][a-z]{2} \d{4}/, ''));
      }
    }
  });

  it('never on an abnormal result\'s follow-up cards, at 60 on FIT', () => {
    const states: ScreeningInputs[] = [
      { colorectalFollowupStatus: 'not_organized' },
      { colorectalFollowupStatus: 'scheduled' },
      { colorectalFollowupStatus: 'completed', colorectalFollowupDate: '2026-06' },
      { colorectalFollowupStatus: 'completed', colorectalFollowupDate: '2022-01' },
    ];
    for (const s of states) {
      const cards = plan(60, { ...fit(OLD), colorectalLastDate: s.colorectalFollowupDate ?? OLD, colorectalResult: 'abnormal', ...s });
      expect(cards.map((c) => c.id), JSON.stringify(s)).toEqual(['screening-colorectal-followup']);
      // The 3-year card names Dr Brad since Change 2b (US-07 AC1j); the FIT line never shows.
      expect(cards[0].description, JSON.stringify(s)).not.toContain(FIT_LINE);
    }
  });

  it('never after an abnormal result whose follow-up is completed with no usable date (Brad 2026-11-12)', () => {
    // Since Change 2b (US-07 AC1j) these get the "Add your colonoscopy date" card, not the routine card.
    for (const date of [undefined, '', '2026']) {
      for (const last of [RECENT, OLD]) {
        const cards = plan(60, { ...fit(last), colorectalResult: 'abnormal', colorectalFollowupStatus: 'completed', colorectalFollowupDate: date });
        expect(cards.map((c) => c.title), `${date} ${last}`).toEqual(['Add your colonoscopy date']);
        expect(cards[0].description, `${date} ${last}`).not.toContain(FIT_LINE);
      }
    }
    // A normal result, or none, still gets the line.
    for (const colorectalResult of ['normal', undefined] as const) {
      expect(plan(60, { ...fit(RECENT), colorectalResult })[0].description).toContain(FIT_LINE);
    }
  });

  it('the 60-year-old\'s yearly FIT reminder and due date are unchanged (spec line 63)', () => {
    const items = computeNextDueDates({ sex: 'male', age: 60 }, { ...fit('2025-07'), updatedAt: '2026-01-01T00:00:00Z' } as ScreeningInputs, {}, []);
    expect(items.find((i) => i.category === 'screening_colorectal')).toMatchObject({ label: 'Colorectal screening', dueAt: '2026-07-01' });
    expect(plan(60, fit('2025-07'))[0].description.startsWith('Your next colorectal screening was due Jul 2026.')).toBe(true);
  });
});

describe('US-07 AC1h: the evidence and the algorithm doc (spec lines 66-72)', () => {
  it('the screening-colorectal reason is the approved one, with Wolf 2018 beside the ACS page and Siegel 2019', () => {
    const e = SUGGESTION_EVIDENCE['screening-colorectal'];
    // Change 2b appends its follow-up sentence (US-07 AC1j, screening-colonoscopy.test.ts).
    expect(e.reason.startsWith(`${REASON} After a positive test and a colonoscopy`)).toBe(true);
    expect(e.guidelines).toEqual(['ACS 2018']);
    expect(e.references).toContainEqual({ label: WOLF_LABEL, url: WOLF_URL });
    expect(e.references.map((r) => r.url)).toEqual(expect.arrayContaining([
      'https://www.cancer.org/cancer/screening/american-cancer-society-guidelines-for-the-early-detection-of-cancer.html',
      'https://doi.org/10.1136/gutjnl-2019-319511',
    ]));
    // The card carries it.
    expect(plan(40)[0].reason).toBe(e.reason);
  });

  it('the algorithm doc has the new eligibility row and the section-8 paragraph', () => {
    const [before, after] = quotes(specLine('**Algorithm doc**', '- Eligibility row'));
    expect(ALGO).toContain(`\n${after}\n`);
    expect(ALGO).not.toContain(before);
    const para = quotes(specLine('**Algorithm doc**', '- New paragraph in section 8:'))[0];
    const s8 = ALGO.slice(ALGO.indexOf('## 8. Cancer Screening'), ALGO.indexOf('## 9. '));
    expect(s8).toContain(`\n${para}\n`);
  });
});

describe('US-07 AC1h: roadmap_text.html (spec lines 75-80)', () => {
  const refsAt = HTML.indexOf('<h2 id="references">');
  const REF_LIST = HTML.slice(refsAt, HTML.indexOf('<h2 id="changelog">')).match(/^<li>.*$/gm) ?? [];
  const strip = (h: string) => h.replace(/<[^>]+>/g, '');
  const colorectal = HTML.slice(HTML.indexOf('<strong data-mce-fragment="1">Colorectal Cancer:</strong>'), HTML.indexOf('Age 76-85:'));
  /** Each band's heading and its bullets, in page order. */
  const bands = [...colorectal.matchAll(/<em[^>]*>(Age [^<]+)<\/em><\/p>\s*<ul[^>]*>([\s\S]*?)<\/ul>/g)]
    .map((m) => [m[1], [...m[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((li) => strip(li[1]))] as const);

  it('the 35-44, 45-54 and 55-75 bands give the approved words, in order (band edges 35, 44, 45, 54, 55, 75)', () => {
    const band35 = quotes(specLine('**Page**', '- New band before'));
    const after = (prefix: string) => afterQuotes(specLine('**Page**', prefix));
    expect(bands).toEqual([
      [band35[1], [band35[2]]],
      ['Age 45-54:', after('- "Age 45-54"')],
      ['Age 55-75:', after('- "Age 55-75"')],
    ]);
  });

  it('[159] is Siegel 2019, appended last; nothing before it shifts, and it is cited', () => {
    expect(REF_LIST).toHaveLength(159);
    // Spec line 79, in the list's own markup: *x* as <em>, **x** as <strong>, the DOI as the list's "DOI: <a>" link.
    const md = specLine('**Page**', '- New reference [159]: ').slice('- New reference [159]: '.length);
    const [citation, doi] = md.split(' doi:');
    const html = citation.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
    expect(REF_LIST[158].startsWith(`<li>${html} DOI: `)).toBe(true);
    expect(REF_LIST[158]).toContain(`href="https://doi.org/${doi.replace(/\.$/, '')}"`);
    expect(REF_LIST[157]).toContain('NEXLETOL (bempedoic acid)');
    expect(colorectal).toContain('more common in younger adults [159].');
  });

  it('the Changelog has the approved line, first of its date', () => {
    const line = quotes(specLine('**Page**', '- Changelog:'))[0];
    const log = HTML.slice(HTML.indexOf('<h2 id="changelog">'));
    // Newer dates may sit above it (13 November, the PSA attribution, Brad 2026-11-14).
    expect(log.match(/<li>12<sup>th<\/sup> November 2026:[^\n]*/)![0]).toBe(`<li>12<sup>th</sup> November 2026: ${line}</li>`);
  });
});
