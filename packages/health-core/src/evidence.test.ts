// US-07 AC1: each expandable reason carries "references I can verify". A citation's
// label and DOI must name the same paper (checked against Crossref).
import { describe, it, expect } from 'vitest';
import { STAT_CARD_EVIDENCE, SUGGESTION_EVIDENCE } from './evidence';

describe('WHtR tile citation (US-07 AC1)', () => {
  it('cites Ashwell 2012, Browning 2010 and Ashwell & Hsieh 2005, label and DOI together (Brad 2026-10-25)', () => {
    const refs = STAT_CARD_EVIDENCE['whtr'].references;
    expect(refs.map(r => r.url)).toEqual([
      'https://doi.org/10.1111/j.1467-789X.2011.00952.x',
      'https://doi.org/10.1017/S0954422410000144',
      'https://doi.org/10.1080/09637480500195066',
    ]);
    expect(refs[0].label).toMatch(/^Ashwell 2012 /);
    expect(refs[1].label).toMatch(/^Browning 2010 /);
    expect(refs[1].label).toContain('possible');
    expect(refs[2].label).toMatch(/^Ashwell 2005 /);
  });

  it('never cites 10.1111/j.1467-789X.2005.00165.x (Baskin 2005, US obesity prevalence)', () => {
    const urls = Object.values(STAT_CARD_EVIDENCE).flatMap(e => e.references.map(r => r.url));
    expect(urls).not.toContain('https://doi.org/10.1111/j.1467-789X.2005.00165.x');
  });
});

// US-07 AC1: ESC/EAS 2019's ApoB goal for very high risk is <65 mg/dL (Table 7), not 50.
// The tool's 50 rests on Ez-PAVE and PESA (Brad 2026-10-25).
describe('ApoB target attribution (US-07 AC1)', () => {
  it.each(['apob-very-high', 'apob-high'])('%s credits ESC/EAS with 65 and the tool with 50, citing Ez-PAVE', (id) => {
    const e = SUGGESTION_EVIDENCE[id];
    expect(e.reason).toContain('ESC/EAS 2019 recommends ApoB below 65 mg/dL for very high risk; based on the Ez-PAVE trial of LDL-C targets and the PESA study, this tool aims lower, for ApoB below 50 mg/dL (0.5 g/L).');
    expect(e.reason).not.toMatch(/50 mg\/dL \(0\.5 g\/L\) based on (the )?ESC\/EAS/);
    expect(e.references.map(r => r.url)).toContain('https://doi.org/10.1056/NEJMoa2600283');
    expect(e.reason).not.toContain('—');
  });

  it('apob-borderline credits Ez-PAVE and PESA, not PESA alone', () => {
    const e = SUGGESTION_EVIDENCE['apob-borderline'];
    expect(e.reason).toContain('the Ez-PAVE trial of LDL-C targets and the PESA study');
    expect(e.references.map(r => r.url)).toContain('https://doi.org/10.1056/NEJMoa2600283');
  });
});
