// US-07 AC22 (bone density for all women from 50 and all men from 60): screening Change 9 (D5),
// Brad 2026-11-12, restated 2026-11-28. Dr Brad's ages are earlier than the guidelines
// (USPSTF 2025: women 65 and over; BHOF 2022: men 70 and over).
//
// The expected words are read from the approved spec, docs/drafts/screening-words-2026-11-12.md,
// section "## Change 9 (D5)". A mismatch goes back to Brad; the words are never reworded here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSuggestions } from './suggestions';
import { SUGGESTION_EVIDENCE } from './evidence';
import { dexaEligible, screeningForm } from './input-form';
import { computeNextDueDates } from './reminder-schedule';
import type { HealthResults, ScreeningInputs } from './types';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SPEC = read('docs/drafts/screening-words-2026-11-12.md');
const SECTION = SPEC.slice(SPEC.indexOf('## Change 9 (D5)'), SPEC.indexOf('## Change 10 ')).split('\n');
const HTML = read('roadmap_text.html');
const ALGO = read('health_roadmap_algorithm.md');

/** The first line starting with `prefix` (after trimming) at or after the line starting with `header`. */
function specLine(header: string, prefix: string): string {
  const from = SECTION.findIndex((l) => l.startsWith(header));
  const line = from < 0 ? undefined : SECTION.slice(from).find((l) => l.trim().startsWith(prefix));
  if (!line) throw new Error(`spec line not found: ${header} / ${prefix}`);
  return line.trim();
}
const quotes = (line: string) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const afterQuotes = (line: string) => quotes(line.slice(line.indexOf('After:')));

const START_TITLE = quotes(specLine('**Start card**', '**Start card**'))[0];
const START = {
  early: quotes(specLine('**Start card**', '- After, women 50 to 64 and men 60 to 69:'))[0],
  women65: quotes(specLine('**Start card**', '- After, women 65 and over:'))[0],
  men70: quotes(specLine('**Start card**', '- After, men 70 and over:'))[0],
};
const REASON = afterQuotes(specLine('**evidence.ts `screening-dexa`**', '- After:'))[0];
const REF_LABELS = quotes(specLine('**evidence.ts `screening-dexa`**', '- References:'));

const NOW = new Date('2026-10-15T12:00:00Z');

function plan(sex: 'female' | 'male', age: number, scr: ScreeningInputs = {}) {
  const results: HealthResults = { heightCm: 170, idealBodyWeight: 65, proteinTarget: 80, age, suggestions: [] };
  return generateSuggestions({ heightCm: 170, sex }, results, 'si', {}, scr, undefined, NOW)
    .filter((s) => s.id.startsWith('screening-dexa'));
}

describe('US-07 AC22: who gets the bone density card, questions and reminder', () => {
  it('reads the spec words it checks (guard: a parse miss would pass vacuously)', () => {
    expect(START_TITLE).toBe('Consider a DEXA bone density scan');
    for (const t of [...Object.values(START), REASON]) expect(t.length).toBeGreaterThan(40);
    expect(REF_LABELS).toHaveLength(2);
  });

  it('the card: women from 50, men from 60 (was 70), at attention', () => {
    expect([49, 50].map((a) => plan('female', a).length)).toEqual([0, 1]);
    expect([59, 60, 69, 70].map((a) => plan('male', a).length)).toEqual([0, 1, 1, 1]);
    expect(plan('male', 60)[0]).toMatchObject({ id: 'screening-dexa', priority: 'attention', title: START_TITLE });
  });

  it('the questions: the bone density section opens for a man at 60, not at 59', () => {
    expect([59, 60].map((a) => dexaEligible(a, 'male'))).toEqual([false, true]);
    const hasBone = (age: number) => screeningForm(age, 'male', {}).some((s) => s.id === 'bone-density');
    expect([59, 60].map(hasBone)).toEqual([false, true]);
  });

  it('the reminder: a man of 60 with a DEXA on record gets it; 59 does not', () => {
    const scr: ScreeningInputs = { dexaScreening: 'dexa_scan', dexaLastDate: '2025-01', dexaResult: 'normal' };
    const has = (age: number) => computeNextDueDates({ sex: 'male', age }, scr, {}, []).some((i) => i.category === 'screening_dexa');
    expect([59, 60].map(has)).toEqual([false, true]);
  });
});

describe('US-07 AC22: the start card text by age and sex (spec "Start card")', () => {
  it('women 50 to 64 and men 60 to 69 read Dr Brad\'s earlier start', () => {
    for (const [sex, age] of [['female', 50], ['female', 64], ['male', 60], ['male', 69]] as const) {
      expect(plan(sex, age)[0].description, `${sex} ${age}`).toBe(START.early);
    }
  });

  it('women from 65 and men from 70 read the guideline text', () => {
    expect(plan('female', 65)[0].description).toBe(START.women65);
    expect(plan('female', 90)[0].description).toBe(START.women65);
    expect(plan('male', 70)[0].description).toBe(START.men70);
    expect(plan('male', 90)[0].description).toBe(START.men70);
  });
});

describe('US-07 AC22: evidence, algorithm doc and page', () => {
  it('the screening-dexa reason, guideline tags and references are the approved ones', () => {
    const e = SUGGESTION_EVIDENCE['screening-dexa'];
    expect(e.reason).toBe(REASON);
    expect(e.guidelines).toEqual(['USPSTF 2025', 'BHOF 2022']);
    expect(e.references).toEqual([
      { label: REF_LABELS[0], url: 'https://doi.org/10.1001/jama.2024.27154' },
      { label: 'USPSTF – Osteoporosis Screening Recommendation', url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/osteoporosis-screening' },
      { label: REF_LABELS[1], url: 'https://doi.org/10.1007/s00198-021-05900-y' },
    ]);
    expect(plan('male', 60)[0].reason).toBe(e.reason);
  });

  it('the algorithm doc has the new eligibility row', () => {
    const before = quotes(specLine('**Algorithm doc**', '- Before:'))[0];
    const after = quotes(specLine('**Algorithm doc**', '- After:'))[0];
    expect(after.startsWith('| DEXA | Female >= 50, Male >= 60 |')).toBe(true);
    expect(ALGO).toContain(`\n${after}\n`);
    expect(ALGO).not.toContain(before);
  });

  it('the chatbot\'s bone health guideline gives the tool\'s ages: women from 50, men from 60 (Brad 2026-11-28)', () => {
    const guide = read('docs/guideline/bone-health.md');
    expect(guide).toContain('\n- The Health Roadmap suggests a bone density scan for women from 50 and men from 60 (the health tool).\n');
    expect(guide).toContain('\n- It suggests a DEXA scan for women from 50 and men from 60. With no sex on record, the card does not show.\n');
    expect(guide).toContain('\n| Scan men | From 60 (the health tool) |');
    expect(guide).not.toMatch(/men from 70|From 70 \(the health tool\)/);
  });

  const REF_LIST = HTML.slice(HTML.indexOf('<h2 id="references">'), HTML.indexOf('<h2 id="changelog">')).match(/^<li>.*$/gm) ?? [];
  const strip = (h: string) => h.replace(/<[^>]+>/g, '');
  const dexa = HTML.slice(HTML.indexOf('<strong data-mce-fragment="1">Osteoporosis Screening</strong>'), HTML.indexOf('<h2 id="medication-options">'));

  it('the page gives the approved women, men and risk-factor lines, in order', () => {
    const want = [
      'Women:', quotes(specLine('**Page**', '- "Women:"'))[1],
      'Men:', quotes(specLine('**Page**', '- "Men:"'))[1],
      quotes(specLine('**Page**', '- "Common risk factors'))[0],
    ];
    const got = [...dexa.matchAll(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/g)].map((m) => strip(m[1]).trim()).filter((t) => t.length > 0);
    expect(got).toEqual(['Dual-energy x-ray absorptiometry (DXA) scan', ...want]);
  });

  it('[161] is USPSTF 2025 and [162] is LeBoff 2022, appended after [160]; nothing before them shifts', () => {
    expect(REF_LIST).toHaveLength(163); // [163] was appended later (US-07 AC24)
    expect(REF_LIST[159]).toContain('dermnetnz.org/topics/topical-retinoids');
    for (const [n, doi] of [[161, '10.1001/jama.2024.27154'], [162, '10.1007/s00198-021-05900-y']] as const) {
      const md = specLine('**Page**', '- New references').split(`[${n}] `)[1].split(/ \[\d+\] /)[0];
      const [citation] = md.split(' doi:');
      const html = citation.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
      expect(REF_LIST[n - 1].startsWith(`<li>${html} DOI: `), `[${n}]`).toBe(true);
      expect(REF_LIST[n - 1]).toContain(`href="https://doi.org/${doi}"`);
    }
  });

  it('the Changelog has the approved line, dated 28 November 2026, below the retinoid line of that date', () => {
    // The spec's line with one word changed, approved by Brad 2026-11-28: "Dr Brad's recommendation", not "Dr Stanfield's".
    const spec = quotes(specLine('**Page**', '- Changelog:'))[0];
    const line = 'Bone density: the tool now suggests a DXA scan for all men from 60 (was 70), and the page says that all women from 50 and all men from 60 is Dr Brad\'s recommendation, earlier than the guidelines [161], [162].';
    expect(line).toBe(spec.replace("Dr Stanfield's", "Dr Brad's"));
    const items = HTML.slice(HTML.indexOf('<h2 id="changelog">')).match(/<li>[^\n]*/g)!;
    expect(items[1]).toBe(`<li>28<sup>th</sup> November 2026: ${line}</li>`);
  });
});
