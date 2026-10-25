// US-07 AC1: each expandable reason carries "references I can verify". A citation's
// label and DOI must name the same paper (checked against Crossref).
import { describe, it, expect } from 'vitest';
import { STAT_CARD_EVIDENCE } from './evidence';

describe('WHtR tile citation (US-07 AC1)', () => {
  it('cites the Ashwell, Gunn & Gibson 2012 meta-analysis, label and DOI together', () => {
    const refs = STAT_CARD_EVIDENCE['whtr'].references;
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe('https://doi.org/10.1111/j.1467-789X.2011.00952.x');
    expect(refs[0].label).toMatch(/^Ashwell 2012 /);
  });

  it('never cites 10.1111/j.1467-789X.2005.00165.x (Baskin 2005, US obesity prevalence)', () => {
    const urls = Object.values(STAT_CARD_EVIDENCE).flatMap(e => e.references.map(r => r.url));
    expect(urls).not.toContain('https://doi.org/10.1111/j.1467-789X.2005.00165.x');
  });
});
