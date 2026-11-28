// US-07 AC21 (Brad 2026-11-28): the page's retinoid irritation sentence cites DermNet, words unchanged,
// and the 2018 Bagatin trial is no longer called "large".
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
    expect(REF_LIST).toHaveLength(160);
    expect(REF_LIST[159]).toContain('<em>Topical retinoids.</em> DermNet');
    expect(REF_LIST[159]).toContain('href="https://dermnetnz.org/topics/topical-retinoids"');
    expect(REF_LIST[158]).toContain('Global patterns and trends in colorectal cancer incidence in young adults');
  });

  it('the 2018 trial [44] is "a study", not "a large study", and [44] is still Bagatin 2018', () => {
    expect(HTML).toContain('adapalene and tretinoin. A study in 2018 found that both creams');
    expect(HTML).not.toContain('A large study in 2018');
    expect(REF_LIST[43]).toContain('Comparable efficacy of adapalene 0.3% gel and tretinoin 0.05% cream');
  });
});
