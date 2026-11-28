// US-07 AC21 (Brad 2026-11-28): the page's retinoid irritation sentence cites DermNet, words unchanged,
// and the 2018 Bagatin trial is no longer called "large" and says "both treatments" (a gel and a cream).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HTML = readFileSync(join(__dirname, '../../../roadmap_text.html'), 'utf8');
const REF_LIST = HTML.slice(HTML.indexOf('<h2 id="references">'), HTML.indexOf('<h2 id="changelog">')).match(/^<li>.*$/gm) ?? [];

describe('retinoid section citations (US-07 AC21)', () => {
  it('the irritation sentence keeps its words and cites [160], DermNet topical retinoids', () => {
    expect(HTML).toContain(
      "<p>However, it's worth noting that adapalene is generally the least irritating topical retinoid, while tretinoin can be more irritating.[160]</p>",
    );
    expect(REF_LIST).toHaveLength(162); // [161], [162] were appended later (US-07 AC22)
    expect(REF_LIST[159].startsWith('<li>Samaranayaka, S. and P. Jarrett, <em>Topical retinoids.</em> DermNet, 2021. ')).toBe(true);
    expect(REF_LIST[159]).toContain('href="https://dermnetnz.org/topics/topical-retinoids"');
    expect(REF_LIST[158]).toContain('Global patterns and trends in colorectal cancer incidence in young adults');
  });

  it('the 2018 trial [44] is "a study", not "a large study", and [44] is still Bagatin 2018', () => {
    const trial = HTML.match(/<p>There are two main types of retinoid creams: adapalene and tretinoin\. (A study in 2018 found [^<]*)<\/p>/)?.[1] ?? '';
    expect(trial.endsWith('.[44]')).toBe(true);
    expect(HTML).not.toContain('A large study in 2018');
    // The trial compared adapalene 0.3% gel with tretinoin 0.05% cream, so "both treatments", not "both creams".
    expect(trial.startsWith('A study in 2018 found that both treatments significantly improved wrinkles')).toBe(true);
    expect(trial).not.toContain('both creams');
    expect(REF_LIST[43]).toContain('Comparable efficacy of adapalene 0.3% gel and tretinoin 0.05% cream');
  });

  it('the Changelog opens with the 28 November 2026 line', () => {
    const log = HTML.slice(HTML.indexOf('<h2 id="changelog">'));
    expect(log.match(/<li>[^\n]*/)?.[0]).toBe(
      '<li>28<sup>th</sup> November 2026: The Young Skin section now cites DermNet for adapalene being generally the least irritating topical retinoid (reference [160] added; none renumbered), and no longer calls the 2018 retinoid study [44] "large", and says "both treatments" where it said "both creams" (the 2018 study compared a gel with a cream).</li>',
    );
  });
});
