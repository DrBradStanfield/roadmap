// US-06 AC21 (screening Change 4, D15 and D21, Brad 2026-11-12): the next PSA test follows the
// newest usable PSA (US-06 AC14): 24 months below 2.5 ng/mL and 12 months from 2.5 for men who
// will screen; 3 months at 4.0 or above for every man in the prostate ages, whatever he answered,
// until a newer PSA below 4.0 is saved. A man who declined, or recorded no answer, sees
// "Repeat PSA test" once 3 months have passed.
//
// The expected words are read from the approved spec, docs/drafts/screening-words-2026-11-12.md,
// section "## Change 4". A mismatch goes back to Brad; the words are never reworded here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSuggestions } from './suggestions';
import { SUGGESTION_EVIDENCE } from './evidence';
import { computePlan } from './plan';
import { computeReminderSchedule, followupKinds } from './reminder-schedule';
import { createEmptyFile, createMeasurement, type RoadmapFile } from './roadmap-file';
import type { Comparator } from './lab-limits';
import type { HealthResults, ScreeningInputs } from './types';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SPEC = read('docs/drafts/screening-words-2026-11-12.md');
const SECTION = SPEC.slice(SPEC.indexOf('## Change 4 '), SPEC.indexOf('## Change 5 ')).split('\n');
const CHANGE_3 = SPEC.slice(SPEC.indexOf('## Change 3 '), SPEC.indexOf('## Change 4 ')).split('\n');
// Brad 2026-11-14: the ACS revised its guideline; the amendment replaces Change 4's attribution sentences.
const AMENDED = SPEC.slice(SPEC.indexOf('## Amendment, Brad 2026-11-14')).split('\n');
const HTML = read('roadmap_text.html');
const ALGO = read('health_roadmap_algorithm.md');

/** The first line starting with `prefix` at or after the line starting with `header`. */
function specLine(header: string, prefix: string, lines = SECTION): string {
  const from = lines.findIndex((l) => l.startsWith(header));
  const line = from < 0 ? undefined : lines.slice(from).find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`spec line not found: ${header} / ${prefix}`);
  return line;
}
const quotes = (line: string) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
/** The text between a line's first and last double quote (for quoted text that quotes a title). */
const outerQuote = (line: string) => line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'));

const DECLINED = '**A man who declined screening';
const REPEAT_TITLE = quotes(specLine(DECLINED, '- Title:'))[0];
const REPEAT_TEXT = quotes(specLine(DECLINED, '- Text:'))[0];
const FIRST_SENTENCE = 'You chose not to have routine prostate screening, and that choice stands. ';
const REPEAT_NO_ANSWER = REPEAT_TEXT.replace(FIRST_SENTENCE, '');
const [EMAIL_LABEL, PHONE_NAME] = quotes(specLine('**Reminders.**', '**Reminders.**'));
// Change 3's card, with the sentence that "ships with Change 4" (spec line 94).
const ELEVATED_LINE = specLine('**Elevated PSA card**', '- After:', CHANGE_3);
const ELEVATED = quotes(ELEVATED_LINE.slice(ELEVATED_LINE.indexOf('After:')))[0];

const NOW = new Date('2026-11-12T12:00:00Z');

function plan(scr: ScreeningInputs, now = NOW, age = 60) {
  const results: HealthResults = { heightCm: 175, idealBodyWeight: 73.8, proteinTarget: 89, age, suggestions: [] };
  return generateSuggestions({ heightCm: 175, sex: 'male' }, results, 'si', undefined, scr, undefined, now)
    .filter((s) => s.id.startsWith('screening-prostate'));
}
const ids = (scr: ScreeningInputs, now = NOW) => plan(scr, now).map((s) => s.id);
const card = (scr: ScreeningInputs, id: string, now = NOW) => plan(scr, now).find((s) => s.id === id);

type Row = { value: number; day: string; comparator?: Comparator };
function fileWith(rows: Row[], discussion?: string, birthYear = 1966): RoadmapFile {
  const f = createEmptyFile({ deviceId: 'psa_c4', now: NOW.toISOString() });
  return {
    ...f,
    profile: { ...f.profile, sex: 'male', heightCm: 175, weightKg: 75, birthYear, birthMonth: 1 } as RoadmapFile['profile'],
    screenings: { ...f.screenings, ...(discussion ? { prostateDiscussion: discussion } : {}) } as RoadmapFile['screenings'],
    measurements: rows.map((r, i) => createMeasurement({
      id: `p${i}`, metricType: 'psa', value: r.value, recordedAt: `${r.day}T00:00:00.000Z`, createdAt: `${r.day}T00:00:00.000Z`,
      ...(r.comparator ? { comparator: r.comparator } : {}),
    })),
  };
}
const fileCards = (file: RoadmapFile, now = NOW) =>
  computePlan(file, now).results.suggestions.filter((s) => s.id.startsWith('screening-prostate'));
const fileIds = (file: RoadmapFile, now = NOW) => fileCards(file, now).map((s) => s.id);
const prostateItems = (file: RoadmapFile, now = NOW) =>
  computeReminderSchedule(file, now).filter((i) => i.category === 'screening_prostate');
const due = (file: RoadmapFile, now = NOW) => prostateItems(file, now).map((i) => i.dueAt);

describe('US-06 AC21: the next PSA by level, for men who will screen (spec table)', () => {
  const at = (value: number, comparator?: Comparator) => fileWith([{ value, day: '2026-04-10', comparator }], 'will_screen');

  it('2.4 -> 24 months; 2.5 and 3.9 -> 12; 4.0 and 4.1 -> 3', () => {
    expect([2.4, 2.5, 3.9, 4.0, 4.1].map((v) => due(at(v)))).toEqual([
      ['2028-04-01'], ['2027-04-01'], ['2027-04-01'], ['2026-07-01'], ['2026-07-01'],
    ]);
  });

  it('a date with no PSA value -> 12 months, as before', () => {
    expect(ids({ prostateDiscussion: 'will_screen', prostateLastDate: '2026-04' })).toEqual(['screening-prostate-upcoming']);
    expect(card({ prostateDiscussion: 'will_screen', prostateLastDate: '2026-04' }, 'screening-prostate-upcoming')?.description)
      .toBe('Next PSA test due Apr 2027.');
  });

  it('a limit counts only when it decides the band: "< 1.0" is below 2.5; "< 3" decides nothing; ">= 4.0" is raised', () => {
    expect(due(at(1.0, '<'))).toEqual(['2028-04-01']);
    expect(due(at(2.5, '<'))).toEqual(['2028-04-01']);
    expect(due(at(2.5, '<='))).toEqual(['2027-04-01']);
    expect(due(at(3, '<'))).toEqual(['2027-04-01']);
    expect(due(at(1, '>'))).toEqual(['2027-04-01']);
    expect(due(at(4.0, '>='))).toEqual(['2026-07-01']);
  });

  it('"Who sees what": 1.2 -> Apr 2028; 3.1 -> Apr 2027; 4.1 -> Jul 2026, then overdue', () => {
    const will = (v: number) => ({ prostateDiscussion: 'will_screen' as const, prostateLastDate: '2026-04', prostatePsaValue: v });
    const before = new Date('2026-06-20T12:00:00Z');
    expect(plan(will(1.2), before)).toEqual([expect.objectContaining({ id: 'screening-prostate-upcoming', description: 'Next PSA test due Apr 2028.' })]);
    expect(plan(will(3.1), before)).toEqual([expect.objectContaining({ id: 'screening-prostate-upcoming', description: 'Next PSA test due Apr 2027.' })]);
    // Before Jul 2026: "Elevated PSA" alone; "up to date" stays hidden beside it (US-06 AC17).
    expect(ids(will(4.1), before)).toEqual(['screening-prostate-elevated']);
    expect(plan(will(4.1), new Date('2026-08-05T12:00:00Z'))).toEqual([
      expect.objectContaining({ id: 'screening-prostate-overdue', title: 'PSA test overdue', description: 'Your next PSA test was due Jul 2026. Please schedule your test.' }),
      expect.objectContaining({ id: 'screening-prostate-elevated' }),
    ]);
  });

  it('below 2.5: up to date at 23 months, overdue at 24 and 25', () => {
    const last = (n: number) => { const t = 2026 * 12 + 10 - n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
    const status = (n: number) => ids({ prostateDiscussion: 'will_screen', prostateLastDate: last(n), prostatePsaValue: 1.2 });
    expect([23, 24, 25].map(status)).toEqual([['screening-prostate-upcoming'], ['screening-prostate-overdue'], ['screening-prostate-overdue']]);
    // From 2.5 the 12-month line holds: overdue at 12 months, not 24.
    expect(ids({ prostateDiscussion: 'will_screen', prostateLastDate: last(12), prostatePsaValue: 2.5 })).toEqual(['screening-prostate-overdue']);
  });
});

describe('US-06 AC21: 4.0 or above, a man who declined or recorded no answer (spec lines 140-146)', () => {
  const raised = (d: ScreeningInputs['prostateDiscussion'], last: string, v = 4.5) =>
    ({ ...(d ? { prostateDiscussion: d } : {}), prostateLastDate: last, prostatePsaValue: v });

  it('once 3 months have passed: "Repeat PSA test" (attention), then "Elevated PSA"', () => {
    expect(plan(raised('elected_not_to', '2026-08'))).toEqual([
      expect.objectContaining({ id: 'screening-prostate-repeat', category: 'screening', priority: 'attention', title: REPEAT_TITLE, description: REPEAT_TEXT }),
      expect.objectContaining({ id: 'screening-prostate-elevated' }),
    ]);
  });

  it('the repeat card carries the Elevated PSA card\'s reason and references', () => {
    const repeat = card(raised('elected_not_to', '2026-08'), 'screening-prostate-repeat');
    expect(repeat?.reason).toBe(SUGGESTION_EVIDENCE['screening-prostate-elevated'].reason);
    expect(repeat?.references).toEqual(SUGGESTION_EVIDENCE['screening-prostate-elevated'].references);
  });

  it('with no discussion answer recorded, the first sentence is left out', () => {
    expect(REPEAT_NO_ANSWER).not.toBe(REPEAT_TEXT);
    expect(card(raised(undefined, '2026-08'), 'screening-prostate-repeat')).toMatchObject({ title: REPEAT_TITLE, description: REPEAT_NO_ANSWER });
  });

  it('before the 3 months are up: "Elevated PSA" alone', () => {
    expect(ids(raised('elected_not_to', '2026-09'))).toEqual(['screening-prostate-elevated']);
    expect(ids(raised(undefined, '2026-09'))).toEqual(['screening-prostate-elevated']);
  });

  it('"Who sees what": declined, PSA 4.5 on 2026-04-10: Elevated alone in June; "Repeat PSA test" from July; reminder July', () => {
    const file = fileWith([{ value: 4.5, day: '2026-04-10' }], 'elected_not_to');
    expect(fileIds(file, new Date('2026-06-20T12:00:00Z'))).toEqual(['screening-prostate-elevated']);
    expect(fileIds(file, new Date('2026-07-15T12:00:00Z'))).toEqual(['screening-prostate-repeat', 'screening-prostate-elevated']);
    expect(prostateItems(file)).toEqual([{ category: 'screening_prostate', group: 'screening', label: EMAIL_LABEL, dueAt: '2026-07-01' }]);
  });

  it('"not yet" (Brad 2026-11-13), PSA 4.5 on 2026-04-10: Elevated alone in June; "Repeat PSA test" from July, no first sentence; reminder July', () => {
    const file = fileWith([{ value: 4.5, day: '2026-04-10' }], 'not_yet');
    expect(fileIds(file, new Date('2026-06-20T12:00:00Z'))).toEqual(['screening-prostate-elevated']);
    expect(fileIds(file, new Date('2026-07-15T12:00:00Z'))).toEqual(['screening-prostate-repeat', 'screening-prostate-elevated']);
    expect(card(raised('not_yet', '2026-08'), 'screening-prostate-repeat')).toMatchObject({ title: REPEAT_TITLE, description: REPEAT_NO_ANSWER });
    expect(prostateItems(file)).toEqual([{ category: 'screening_prostate', group: 'screening', label: EMAIL_LABEL, dueAt: '2026-07-01' }]);
  });

  it('a will-screen man never sees the repeat card: his overdue card takes its place', () => {
    expect(ids(raised('will_screen', '2026-08'))).toEqual(['screening-prostate-overdue', 'screening-prostate-elevated']);
  });

  it('outside the prostate ages, nothing', () => {
    expect(computeReminderSchedule(fileWith([{ value: 4.5, day: '2026-04-10' }], 'elected_not_to', 1990), NOW)
      .filter((i) => i.category === 'screening_prostate')).toEqual([]);
  });

  it('a newer PSA below 4.0 ends the 3-month rule', () => {
    const rows = [{ value: 4.5, day: '2026-04-10' }, { value: 3.0, day: '2026-06-01' }];
    expect(fileIds(fileWith(rows, 'elected_not_to'))).toEqual([]);
    expect(prostateItems(fileWith(rows, 'elected_not_to'))).toEqual([]);
    expect(due(fileWith(rows, 'will_screen'))).toEqual(['2027-06-01']);
    expect(followupKinds(fileWith(rows, 'will_screen'), NOW).screening_prostate).toBeUndefined();
  });
});

describe('US-06 AC21: reminders (spec lines 148)', () => {
  it('category screening_prostate; the emailed label stays "PSA test" for every man', () => {
    expect(EMAIL_LABEL).toBe('PSA test');
    for (const d of [undefined, 'not_yet', 'elected_not_to', 'will_screen']) {
      expect(prostateItems(fileWith([{ value: 4.1, day: '2026-04-10' }], d)), String(d))
        .toEqual([{ category: 'screening_prostate', group: 'screening', label: EMAIL_LABEL, dueAt: '2026-07-01' }]);
    }
  });

  it('a man who declined gets no reminder while his newest PSA is below 4.0; nor does one with no answer', () => {
    for (const v of [1.2, 3.9]) {
      expect(prostateItems(fileWith([{ value: v, day: '2026-04-10' }], 'elected_not_to'))).toEqual([]);
      expect(prostateItems(fileWith([{ value: v, day: '2026-04-10' }]))).toEqual([]);
    }
  });

  it('the iPhone list names the 4.0-or-above case "Repeat PSA (your last result)"; below 4.0, no name', () => {
    expect(PHONE_NAME).toBe('Repeat PSA (your last result)');
    for (const d of [undefined, 'elected_not_to', 'will_screen']) {
      expect(followupKinds(fileWith([{ value: 4.0, day: '2026-04-10' }], d), NOW).screening_prostate, String(d))
        .toEqual({ kind: 'repeat', name: PHONE_NAME });
    }
    expect(followupKinds(fileWith([{ value: 3.9, day: '2026-04-10' }], 'will_screen'), NOW).screening_prostate).toBeUndefined();
  });

  it('other screenings are unchanged by the PSA level', () => {
    const others = (v: number) => {
      const f = fileWith([{ value: v, day: '2026-04-10' }], 'will_screen');
      f.screenings = { ...f.screenings, colorectalMethod: 'fit_annual', colorectalLastDate: '2026-02' } as RoadmapFile['screenings'];
      return computeReminderSchedule(f, NOW).filter((i) => i.category !== 'screening_prostate');
    };
    expect(others(4.5)).toEqual(others(1.2));
    expect(others(1.2).some((i) => i.category === 'screening_colorectal')).toBe(true);
  });
});

describe('US-06 AC21: the Elevated PSA card gains the 3-month sentence (spec Change 3 line 94)', () => {
  it('the card is Change 3\'s approved text in full', () => {
    expect(ELEVATED).toContain('Dr Brad suggests repeating the test every 3 months while it stays at 4.0 or higher.');
    expect(card({ prostatePsaValue: 4.0 }, 'screening-prostate-elevated')?.description).toBe(ELEVATED.replace('{value}', '4.0'));
  });
});

describe('US-06 AC21: the three files (spec lines 150-171)', () => {
  it('evidence: both sentences, and the ACS recommendations page on screening-prostate', () => {
    const [oldProstate] = quotes(specLine('**evidence.ts**', '- `screening-prostate`, add:'));
    const [oldElevated] = quotes(specLine('**evidence.ts**', '- `screening-prostate-elevated`, add:'));
    const [prostate] = quotes(specLine('**evidence.ts**', '- `screening-prostate`, replace:', AMENDED));
    const [elevated] = quotes(specLine('**evidence.ts**', '- `screening-prostate-elevated`, replace:', AMENDED));
    const url = specLine('**evidence.ts**', '- `screening-prostate`, add:').match(/https:\/\/\S+\.html/)![0];
    expect(SUGGESTION_EVIDENCE['screening-prostate'].reason).toContain(prostate);
    expect(SUGGESTION_EVIDENCE['screening-prostate-elevated'].reason).toContain(elevated);
    expect(SUGGESTION_EVIDENCE['screening-prostate'].reason).not.toContain(oldProstate);
    expect(SUGGESTION_EVIDENCE['screening-prostate-elevated'].reason).not.toContain(oldElevated);
    expect(SUGGESTION_EVIDENCE['screening-prostate'].references.map((r) => r.url)).toContain(url);
  });

  it('the algorithm doc: the three interval rows replace the one, and the Prostate-Specific sentence', () => {
    const header = '**Algorithm doc**';
    const before = quotes(specLine(header, '**Algorithm doc**'))[0];
    expect(ALGO).not.toContain(before);
    const rows = SECTION.slice(SECTION.findIndex((l) => l.startsWith(header))).filter((l) => l.startsWith('- "| ')).map((l) => quotes(l)[0]);
    expect(rows).toHaveLength(3);
    expect(ALGO).toContain(`\n${rows.join('\n')}\n`);
    expect(ALGO).not.toContain(outerQuote(specLine('And under Prostate-Specific', 'And under Prostate-Specific')));
    expect(ALGO).toContain(`\n- ${outerQuote(specLine('And under Prostate-Specific', 'And under Prostate-Specific', AMENDED))}\n`);
  });

  it('the page paragraph and the Changelog line', () => {
    const [before, oldAfter] = quotes(specLine('**Page**', '- Before:')).concat(quotes(specLine('**Page**', '- After:')));
    const [after] = quotes(specLine('**Page**', '- After:', AMENDED));
    expect(HTML).not.toContain(before);
    expect(HTML).not.toContain(oldAfter);
    expect(HTML).toContain(`<li data-mce-fragment="1">${after}</li>`);
    const oldLine = quotes(specLine('**Page**', '- Changelog:'))[0];
    const line = quotes(specLine('**Page**', '- Changelog:', AMENDED))[0];
    const added = quotes(specLine('**Page**', '- New changelog entry, 13th November 2026:', AMENDED))[0];
    const log = HTML.slice(HTML.indexOf('<h2 id="changelog">'));
    expect(log).not.toContain(oldLine);
    expect(log).toContain(`\n<li>12<sup>th</sup> November 2026: ${line}</li>\n`);
    expect(log).toContain(`<ul>\n<li>13<sup>th</sup> November 2026: ${added}</li>\n`);
    // After the existing same-date lines, before the 5 November one.
    expect(log.indexOf(line)).toBeLessThan(log.indexOf('<li>5<sup>th</sup> November 2026'));
    expect(log.indexOf(line)).toBeGreaterThan(log.indexOf('Colorectal follow-up: after a positive test'));
  });
});

describe('US-06 AC21 item 6 (Brad 2026-11-13): a newer PSA that does not decide keeps the 3-month rule', () => {
  const VAGUE = '**A newer PSA that does not show the level';
  const replaced = quotes(specLine(VAGUE, '- A man who declined, or recorded no answer:'));
  const OLD_SENTENCE = replaced[replaced.length - 1];
  const NEW_SENTENCE = quotes(specLine(VAGUE, '- Sentence'))[0];
  const CARRIED = REPEAT_TEXT.replace(OLD_SENTENCE, NEW_SENTENCE);
  const RAISED = { value: 4.5, day: '2026-04-10' };
  const VAGUE_ROW = { value: 5, day: '2026-06-01', comparator: '<' as const };
  const AUG = new Date('2026-08-15T12:00:00Z');

  it('the spec quotes the old sentence from the approved card, and the new one replaces it', () => {
    expect(REPEAT_TEXT).toContain(OLD_SENTENCE);
    expect(CARRIED).not.toBe(REPEAT_TEXT);
    expect(CARRIED).toContain(NEW_SENTENCE);
  });

  it('declined, 4.5 then a newer "< 5": reminder 3 months after the newer test; then "Repeat PSA test" with the new sentence', () => {
    const file = fileWith([RAISED, VAGUE_ROW], 'elected_not_to');
    expect(prostateItems(file)).toEqual([{ category: 'screening_prostate', group: 'screening', label: EMAIL_LABEL, dueAt: '2026-09-01' }]);
    expect(fileIds(file, AUG)).toEqual([]);
    expect(fileCards(file)).toEqual([
      expect.objectContaining({ id: 'screening-prostate-repeat', priority: 'attention', title: REPEAT_TITLE, description: CARRIED }),
    ]);
    expect(CARRIED.startsWith(FIRST_SENTENCE)).toBe(true);
    expect(fileCards(file)[0].description).not.toContain('Your last PSA');
    // F4 (Brad 2026-11-13): still the repeat (first-seen, re-check R1), named plain, as the email names it.
    expect(followupKinds(file, NOW).screening_prostate).toEqual({ kind: 'repeat', name: EMAIL_LABEL });
  });

  it('no answer recorded: the same card without "You chose not to"; the discussion card still shows (F2, Brad 2026-11-13)', () => {
    const file = fileWith([RAISED, VAGUE_ROW]);
    expect(fileCards(file)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'screening-prostate-repeat', description: CARRIED.replace(FIRST_SENTENCE, '') }),
      expect.objectContaining({ id: 'screening-prostate' }),
    ]));
    expect(fileIds(file)).toHaveLength(2);
    expect(fileIds(file, AUG)).toEqual(['screening-prostate']);
    expect(fileIds(fileWith([RAISED, VAGUE_ROW], 'not_yet'), AUG)).toEqual(['screening-prostate']);
    expect(due(file)).toEqual(['2026-09-01']);
  });

  it('will screen: the 3-month date, no "up to date" before it (F3, Brad 2026-11-13), then the overdue card; never "Elevated PSA"', () => {
    const file = fileWith([RAISED, VAGUE_ROW], 'will_screen');
    expect(due(file)).toEqual(['2026-09-01']);
    expect(fileIds(file, AUG)).toEqual([]);
    expect(fileIds(file)).toEqual(['screening-prostate-overdue']);
  });

  it('"<= 4.0" holds the rule: it allows exactly 4.0', () => {
    const file = fileWith([RAISED, { value: 4.0, day: '2026-06-01', comparator: '<=' }], 'elected_not_to');
    expect(due(file)).toEqual(['2026-09-01']);
    expect(fileCards(file)).toEqual([expect.objectContaining({ id: 'screening-prostate-repeat', description: CARRIED })]);
  });

  it('"< 4.0", "< 3" and "< 1.0" end it; "< 1.0" gives 24 months for a man who will screen', () => {
    for (const bound of [4.0, 3, 1.0]) {
      const declined = fileWith([RAISED, { value: bound, day: '2026-06-01', comparator: '<' }], 'elected_not_to');
      expect(prostateItems(declined), String(bound)).toEqual([]);
      expect(fileIds(declined), String(bound)).toEqual([]);
    }
    const will = (bound: number) => due(fileWith([RAISED, { value: bound, day: '2026-06-01', comparator: '<' }], 'will_screen'));
    expect([4.0, 3, 1.0].map(will)).toEqual([['2027-06-01'], ['2027-06-01'], ['2028-06-01']]);
  });

  it('a newer "< 5" with no earlier raised PSA behaves as before', () => {
    for (const rows of [[VAGUE_ROW], [{ value: 3.0, day: '2026-04-10' }, VAGUE_ROW]]) {
      expect(due(fileWith(rows, 'will_screen'))).toEqual(['2027-06-01']);
      expect(prostateItems(fileWith(rows, 'elected_not_to'))).toEqual([]);
      expect(fileIds(fileWith(rows, 'elected_not_to'))).toEqual([]);
    }
  });

  it('a value below 4.0 after the vague result ends it', () => {
    const rows = [RAISED, VAGUE_ROW, { value: 3.0, day: '2026-07-01' }];
    expect(prostateItems(fileWith(rows, 'elected_not_to'))).toEqual([]);
    expect(fileIds(fileWith(rows, 'elected_not_to'))).toEqual([]);
  });

  it('two vague results in a row still hold it, due 3 months after the newest', () => {
    const file = fileWith([RAISED, VAGUE_ROW, { value: 4.0, day: '2026-07-15', comparator: '<=' }], 'elected_not_to');
    expect(due(file)).toEqual(['2026-10-01']);
    expect(fileCards(file)).toEqual([expect.objectContaining({ id: 'screening-prostate-repeat', description: CARRIED })]);
  });

  it('a newest PSA of 4.0 or above behaves as built', () => {
    const file = fileWith([{ value: 3.0, day: '2026-04-10' }, VAGUE_ROW, { value: 4.2, day: '2026-07-15' }], 'elected_not_to');
    expect(fileCards(file)).toEqual([
      expect.objectContaining({ id: 'screening-prostate-repeat', description: REPEAT_TEXT }),
      expect.objectContaining({ id: 'screening-prostate-elevated' }),
    ]);
  });

  it('followupKinds names the prostate follow-up only inside the prostate ages, as the schedule gates it (owner\'s ruling)', () => {
    // A woman of 60 and a man of 40 (below 45) fall outside; the prostate row has no upper age, so a man of 90 keeps it.
    const people: Array<[string, Partial<RoadmapFile['profile']>, boolean]> = [
      ['woman 60', { sex: 'female' }, false], ['man 40', { birthYear: 1986 }, false],
      ['man 60', {}, true], ['man 90', { birthYear: 1936 }, true],
    ];
    for (const [who, profile, kept] of people) {
      for (const vague of [false, true]) {
        const file = fileWith(vague ? [RAISED, VAGUE_ROW] : [RAISED], 'elected_not_to');
        file.profile = { ...file.profile, ...profile };
        const kind = followupKinds(file, NOW).screening_prostate;
        const name = `${who}${vague ? ', vague' : ''}`;
        if (kept) expect(kind, name).toEqual({ kind: 'repeat', name: vague ? EMAIL_LABEL : PHONE_NAME });
        else expect(kind, name).toBeUndefined();
      }
    }
  });

  it('the algorithm doc states the rule', () => {
    expect(ALGO).toContain(`\n- ${outerQuote(specLine('Item 6, under Prostate-Specific', 'Item 6, under Prostate-Specific'))}\n`);
  });
});
