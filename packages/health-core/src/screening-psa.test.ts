// US-07 AC1i, US-06 AC14, AC17, AC18 (screening Change 3, D14 and D19, Brad 2026-11-12):
// a PSA of 4.0 ng/mL or above is raised, and "Elevated PSA" then shows alone; the
// "Discuss prostate cancer screening" card returns once a newer PSA below 4.0 is saved.
//
// The expected words are read from the approved spec, docs/drafts/screening-words-2026-11-12.md,
// section "## Change 3" (lines 86-112). A mismatch goes back to Brad; the words are never reworded here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSuggestions } from './suggestions';
import { SUGGESTION_EVIDENCE } from './evidence';
import { computePlan, planPayload } from './plan';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import { HBA1C_THRESHOLDS, LPA_THRESHOLDS, formatGradedReading } from './units';
import { bandDecides, LIMIT_CUTOFFS, limitLabelValue, limitRepresentative, type Comparator } from './lab-limits';
import { savedStatus } from './row-grade';
import type { HealthResults, ScreeningInputs } from './types';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SPEC = read('docs/drafts/screening-words-2026-11-12.md');
const SECTION = SPEC.slice(SPEC.indexOf('## Change 3 '), SPEC.indexOf('## Change 4 ')).split('\n');
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
const afterQuotes = (line: string) => quotes(line.slice(line.indexOf('After:')));

// Spec line 94. "(The 3-month sentence ships with Change 4.)": Change 3 ships the After text
// without that one sentence, so the expected card is built from the spec line with it removed.
const CHANGE_4_SENTENCE = ' Dr Brad suggests repeating the test every 3 months while it stays at 4.0 or higher.';
const CARD_SPEC = afterQuotes(specLine('**Elevated PSA card**', '- After:'))[0];
const CARD = CARD_SPEC.replace(CHANGE_4_SENTENCE, '');
const card = (shown: string) => CARD.replace('{value} ng/mL', shown);
// Spec line 105.
const REASON = afterQuotes(specLine('**evidence.ts `screening-prostate-elevated`**', '- After:'))[0];

const NOW = new Date('2026-11-12T12:00:00Z');

function plan(scr: ScreeningInputs, age = 60) {
  const results: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age, suggestions: [] };
  return generateSuggestions({ heightCm: 175, sex: 'male' }, results, 'si', undefined, scr)
    .filter((s) => s.id.startsWith('screening-prostate'));
}
const ids = (scr: ScreeningInputs) => plan(scr).map((s) => s.id);

type Row = { value: number; day: string; comparator?: Comparator };
function fileWith(rows: Row[], discussion?: string): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'psa_c3', now: NOW.toISOString() });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, weightKg: 75, birthYear: 1966, birthMonth: 1 } as RoadmapFile['profile'],
    screenings: { ...f.screenings, ...(discussion ? { prostateDiscussion: discussion } : {}) } as RoadmapFile['screenings'],
    measurements: rows.map((r, i) => createMeasurement({
      id: `p${i}`, metricType: 'psa', value: r.value, recordedAt: `${r.day}T00:00:00.000Z`, createdAt: `${r.day}T00:00:00.000Z`,
      ...(r.comparator ? { comparator: r.comparator } : {}),
    })),
  };
}
const filePlan = (file: RoadmapFile) =>
  computePlan(file, NOW).results.suggestions.filter((s) => s.id.startsWith('screening-prostate'));
const fileIds = (file: RoadmapFile) => filePlan(file).map((s) => s.id);

describe('US-07 AC1i: a PSA of 4.0 or above is raised (spec line 90)', () => {
  it('3.99 is not raised; 4.0 and 4.01 are', () => {
    const elevated = (v: number) => ids({ prostateDiscussion: 'will_screen', prostatePsaValue: v }).includes('screening-prostate-elevated');
    expect([3.99, 4.0, 4.01].map(elevated)).toEqual([false, true, true]);
  });

  it('while raised, "Discuss prostate cancer screening" never shows: "Elevated PSA" shows alone', () => {
    for (const d of [undefined, 'not_yet', 'elected_not_to'] as const) {
      expect(ids({ prostateDiscussion: d, prostatePsaValue: 4.0 })).toEqual(['screening-prostate-elevated']);
      expect(ids({ prostateDiscussion: d, prostatePsaValue: 9.5 })).toEqual(['screening-prostate-elevated']);
    }
    // US-06 AC17: no "up to date" beside it either.
    expect(fileIds(fileWith([{ value: 4.0, day: '2026-10-01' }], 'will_screen'))).toEqual(['screening-prostate-elevated']);
  });

  it('below 4.0, with no discussion recorded, "Discuss" shows and "Elevated PSA" does not', () => {
    expect(ids({ prostatePsaValue: 3.99 })).toEqual(['screening-prostate']);
    expect(ids({ prostateDiscussion: 'not_yet', prostatePsaValue: 3.99 })).toEqual(['screening-prostate']);
  });

  it('a newer PSA below 4.0, no discussion recorded: "Discuss" returns', () => {
    const raised = fileWith([{ value: 6.5, day: '2026-03-01' }]);
    expect(fileIds(raised)).toEqual(['screening-prostate-elevated']);
    expect(fileIds(fileWith([{ value: 6.5, day: '2026-03-01' }, { value: 3.2, day: '2026-09-01' }]))).toEqual(['screening-prostate']);
    expect(fileIds(fileWith([{ value: 6.5, day: '2026-03-01' }, { value: 3.2, day: '2026-09-01' }], 'not_yet'))).toEqual(['screening-prostate']);
    // An older PSA below 4.0 does not bring it back: the newest decides.
    expect(fileIds(fileWith([{ value: 3.2, day: '2026-03-01' }, { value: 4.0, day: '2026-09-01' }]))).toEqual(['screening-prostate-elevated']);
  });
});

describe('US-07 AC1i: the Elevated PSA card and its reason (spec lines 92-106)', () => {
  it('the card is the approved text without the Change 4 sentence, at attention', () => {
    expect(CARD_SPEC).toContain(CHANGE_4_SENTENCE.trim());
    expect(CARD).not.toContain('3 months');
    const [elevated] = plan({ prostatePsaValue: 4.0 });
    expect(elevated).toMatchObject({ title: 'Elevated PSA', priority: 'attention', description: card('4.0 ng/mL') });
    expect(plan({ prostatePsaValue: 6.53 })[0].description).toBe(card('6.5 ng/mL'));
  });

  it('a limit prints as printed (US-12 AC20)', () => {
    expect(filePlan(fileWith([{ value: 100, day: '2026-10-01', comparator: '>' }]))[0].description).toBe(card('> 100.0 ng/mL'));
    expect(filePlan(fileWith([{ value: 4.0, day: '2026-10-01', comparator: '>=' }]))[0].description).toBe(card('≥ 4.0 ng/mL'));
  });

  it('the reason is the approved text, on the card too', () => {
    expect(SUGGESTION_EVIDENCE['screening-prostate-elevated'].reason).toBe(REASON);
    expect(plan({ prostatePsaValue: 4.0 })[0].reason).toBe(REASON);
    // The page the reason's claims were checked against (spec line 106; Brad 2026-11-12, PR 1358 R2).
    expect(SUGGESTION_EVIDENCE['screening-prostate-elevated'].references.map((r) => r.url))
      .toContain('https://www.cancer.org/cancer/types/prostate-cancer/detection-diagnosis-staging/tests.html');
  });
});

describe('US-06 AC14: a PSA printed as a limit (spec line 96)', () => {
  it('">= 4.0" counts as raised; "<= 4.0" and "< 5" still do not decide', () => {
    expect(fileIds(fileWith([{ value: 4.0, day: '2026-10-01', comparator: '>=' }]))).toEqual(['screening-prostate-elevated']);
    expect(fileIds(fileWith([{ value: 4.0, day: '2026-10-01', comparator: '<=' }]))).toEqual(['screening-prostate']);
    expect(fileIds(fileWith([{ value: 5, day: '2026-10-01', comparator: '<' }]))).toEqual(['screening-prostate']);
    expect(limitRepresentative('psa', '>=', 4.0)).not.toBeNull();
    expect(limitRepresentative('psa', '>=', 3.9)).toBeNull();
    expect(limitRepresentative('psa', '<=', 4.0)).toBeNull();
    expect(limitRepresentative('psa', '<', 5)).toBeNull();
  });

  it('the row status word moves with it: ">= 4.0" is coloured as a raised PSA; "<= 4.0" is not', () => {
    expect(limitLabelValue('psa', '>=', 4.0)).not.toBeNull();
    expect(savedStatus('psa', 4.0, '>=', { sex: 'male' })).toBe('warn');
    expect(savedStatus('psa', 4.0, '<=', { sex: 'male' })).toBeNull();
    expect(savedStatus('psa', 3.99, undefined, { sex: 'male' })).toBe('ok');
    expect(savedStatus('psa', 4.0, undefined, { sex: 'male' })).toBe('warn');
  });

  it('only PSA changes: any other field\'s ">=" at its line stays undecided', () => {
    expect(bandDecides(LIMIT_CUTOFFS.hba1c, '>=', HBA1C_THRESHOLDS.diabetes)).toBe(false);
    expect(limitRepresentative('hba1c', '>=', HBA1C_THRESHOLDS.diabetes)).toBeNull();
    expect(limitRepresentative('lpa', '>=', LPA_THRESHOLDS.elevated)).toBeNull();
  });
});

describe('US-06 AC18: a PSA below 4.0 never prints as 4.0 (spec line 96)', () => {
  it('3.96 prints 3.96; below the line rounds down, never to 4.0', () => {
    expect(formatGradedReading('psa', 3.96, 'si')).toBe('3.96');
    expect(formatGradedReading('psa', 3.95, 'si')).toBe('3.95');
    expect(formatGradedReading('psa', 3.999, 'si')).toBe('3.99');
    expect(formatGradedReading('psa', 3.9999999999, 'si')).toBe('3.99');
  });

  it('every other PSA prints to one decimal: 4.0 and above, and below 3.95', () => {
    expect(formatGradedReading('psa', 4.0, 'si')).toBe('4.0');
    expect(formatGradedReading('psa', 4.04, 'si')).toBe('4.0');
    expect(formatGradedReading('psa', 6.53, 'si')).toBe('6.5');
    expect(formatGradedReading('psa', 3.94, 'si')).toBe('3.9');
    expect(formatGradedReading('psa', 1.23, 'si')).toBe('1.2');
  });

  it("get_plan's currentValues prints 3.96", () => {
    const value = planPayload(computePlan(fileWith([{ value: 3.96, day: '2026-10-01' }], 'will_screen'), NOW))
      .currentValues.find((v) => v.metric === 'psa')?.value;
    expect(value).toBe('3.96');
  });
});

describe('US-07 AC1i: the algorithm doc (spec lines 98-101)', () => {
  it('section 609 and the prostate rule have the approved words', () => {
    const [before609, after609] = quotes(specLine('**Algorithm doc**', '- `:609`'));
    expect(ALGO).toContain(`\n${after609}\n`);
    expect(ALGO).not.toContain(before609);
    const [before1172, after1172] = quotes(specLine('**Algorithm doc**', '- `:1172`'));
    expect(ALGO).toContain(`\n- ${after1172}\n`);
    expect(ALGO).not.toContain(before1172);
  });

  it('the prostate rules never say raised means above 4.0', () => {
    const prostate = ALGO.slice(ALGO.indexOf('### Prostate-Specific'), ALGO.indexOf('### DEXA-Specific'));
    expect(prostate).not.toMatch(/above 4\.0|> 4\.0|>= 4\.0" leave/);
    expect(prostate).toContain('"> 100" and ">= 4.0" are elevated');
    expect(prostate).toContain('3.96 reads 3.96');
  });
});

describe('US-07 AC1i: roadmap_text.html (spec lines 108-109)', () => {
  const refsAt = HTML.indexOf('<h2 id="references">');
  const REF_LIST = HTML.slice(refsAt, HTML.indexOf('<h2 id="changelog">')).match(/^<li>.*$/gm) ?? [];
  const strip = (h: string) => h.replace(/<[^>]+>/g, '');
  const prostate = HTML.slice(HTML.indexOf('<strong data-mce-fragment="1">Prostate Cancer:</strong>'), HTML.indexOf('Endometrial Cancer:</strong>'));
  const age50 = prostate.slice(prostate.indexOf('Age 50 and above:'));
  const bullets = [...age50.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1]));

  it('"Age 50 and above" gains the approved bullet, last', () => {
    const bullet = quotes(specLine('**Page**', '**Page**'))[1];
    expect(bullets).toHaveLength(3);
    expect(bullets[2]).toBe(bullet);
  });

  it('the Changelog has the approved line, dated 12 November 2026', () => {
    const line = quotes(specLine('**Page**', '- Changelog:'))[0];
    const log = HTML.slice(HTML.indexOf('<h2 id="changelog">'));
    expect(log).toContain(`\n<li>12<sup>th</sup> November 2026: ${line}</li>\n`);
  });

  it('no new reference: the list still ends at [159], Siegel 2019', () => {
    expect(REF_LIST).toHaveLength(159);
    expect(REF_LIST[158]).toContain('Global patterns and trends in colorectal cancer incidence in young adults');
  });
});
