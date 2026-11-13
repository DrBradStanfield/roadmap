// US-06 AC22 (prostate screening), the American Cancer Society's 2026-11-12 revision: the rectal exam
// leaves the page (Item 1B) and the 45-49 words name the men the Society advises to start at 45
// (Item 2B, words only). The plan's logic does not change.
//
// The expected words are read from docs/drafts/screening-words-2026-11-12.md, section
// "## Amendment: the rectal exam and Change 5". A mismatch goes back to Brad; never reword here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCREENING_REFS, SCREENING_RULES } from './screening-rules';
import { SUGGESTION_EVIDENCE } from './evidence';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SPEC = read('docs/drafts/screening-words-2026-11-12.md');
const SECTION = SPEC.slice(SPEC.indexOf('## Amendment: the rectal exam and Change 5')).split('\n');
const HTML = read('roadmap_text.html');
const ALGO = read('health_roadmap_algorithm.md');

function specLine(header: string, prefix: string): string {
  const from = SECTION.findIndex((l) => l.startsWith(header));
  const line = from < 0 ? undefined : SECTION.slice(from).find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`spec line not found: ${header} / ${prefix}`);
  return line;
}
const quotes = (line: string) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const strip = (h: string) => h.replace(/<[^>]+>/g, '');
const prostate = HTML.slice(HTML.indexOf('<strong data-mce-fragment="1">Prostate Cancer:</strong>'), HTML.indexOf('Endometrial Cancer:</strong>'));
const bulletsAfter = (heading: string) => {
  const band = prostate.slice(prostate.indexOf(heading));
  const list = band.slice(0, band.indexOf('</ul>'));
  return [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => strip(m[1]));
};

describe('US-06 AC22: the form note under 50 names the ACS 2026 groups', () => {
  const [before, after] = quotes(specLine('**Form note under 50**', '- Before:')).concat(quotes(specLine('**Form note under 50**', '- After:')));
  it('ages 45 and 49 show the new note; 50 keeps its own', () => {
    expect(SCREENING_REFS.prostateByAge(45)).toBe(after);
    expect(SCREENING_REFS.prostateByAge(49)).toBe(after);
    expect(SCREENING_REFS.prostateByAge(50)).toBe('PSA testing is an option after an informed discussion with your doctor.');
    expect(after).not.toBe(before);
  });
  it('the start card keeps its text, and the rule keeps its ages (no logic change)', () => {
    const rule = SCREENING_RULES.find((r) => r.id === 'prostate')!;
    expect(rule.cards.start.description).toBe('PSA testing is an option after an informed discussion with your doctor. Benefits and risks vary by individual.');
    expect(rule.cardAges).toEqual([45]);
  });
});

describe('US-06 AC22: the evidence and algorithm files follow the amendment', () => {
  it('evidence: the sentence follows the first sentence of screening-prostate', () => {
    const [added] = quotes(specLine('**evidence.ts `screening-prostate`**', '**evidence.ts'));
    const reason = SUGGESTION_EVIDENCE['screening-prostate'].reason;
    expect(reason).toContain(`between patient and doctor. ${added} The benefits`);
    // Codex R1: the reason shows at every age from 45, so the ACS intervals carry the Society's upper age.
    expect(added).toContain('from 45 to 69');
    expect(added).toContain('Within those ages');
  });
  it('algorithm: the eligibility row', () => {
    const [before] = quotes(specLine('**Algorithm doc**', '- Before:'));
    const [after] = quotes(specLine('**Algorithm doc**', '- After:'));
    expect(ALGO).not.toContain(`\n${before}\n`);
    expect(ALGO).toContain(`\n${after}\n`);
  });
});

describe('US-06 AC22: roadmap_text.html, the prostate section', () => {
  it('the band reads 45-49, with the amended bullets', () => {
    const [oldHeading, heading] = quotes(specLine('**Page, the 45-49 band**', '- Band heading.'));
    expect(prostate).not.toContain(`>${oldHeading}<`);
    expect(prostate).toContain(`<p data-mce-fragment="1">${heading}</p>`);
    const first = quotes(specLine('**Page, the 45-49 band**', '- First bullet.'))[1];
    const second = quotes(specLine('**Page, the 45-49 band**', '- Second bullet.'))[1];
    const third = quotes(specLine('**Page, the 45-49 band**', '- New third bullet:'))[0];
    expect(bulletsAfter(heading)).toEqual([first, second, third]);
  });
  it('no rectal exam as a screening test: the PSA bullet\'s new first sentence', () => {
    const [before, after] = quotes(specLine('**Page, the PSA bullet**', '- First sentence.'));
    expect(prostate).not.toContain(before);
    expect(bulletsAfter('Age 50 and above:')[1].startsWith(`${after} How often you're tested`)).toBe(true);
  });
  it('the prostate section cites no reference number, so none can dangle', () => {
    expect(strip(prostate)).not.toMatch(/\[\d+\]/);
  });
  it('the Changelog opens with the new 13 November entry', () => {
    const [entry] = quotes(specLine('**Page, the PSA bullet**', '- New changelog entry'));
    const log = HTML.slice(HTML.indexOf('<h2 id="changelog">'));
    expect(log).toContain(`<ul>\n<li>13<sup>th</sup> November 2026: ${entry}</li>\n`);
  });
});
