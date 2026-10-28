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

// US-56 AC8: the VO2 max bands' reason and source, the FRIEND 2022 update (Crossref-checked
// 2026-10-26: Kaminsky et al., Mayo Clin Proc 97(2):285-293).
describe('VO2 max bands evidence (US-56 AC8)', () => {
  it('cites FRIEND 2022 and states the percentile bands without claiming they are Apple\'s', () => {
    const e = STAT_CARD_EVIDENCE['vo2max'];
    expect(e.references).toEqual([
      { label: 'Kaminsky 2022 – Updated FRIEND reference standards for cardiorespiratory fitness (Mayo Clin Proc)', url: 'https://doi.org/10.1016/j.mayocp.2021.08.020' },
      { label: 'Apple 2021 – Using Apple Watch to Estimate Cardio Fitness with VO2 max (white paper)', url: 'https://www.apple.com/healthcare/docs/site/Using_Apple_Watch_to_Estimate_Cardio_Fitness_with_VO2_max.pdf' },
    ]);
    expect(e.reason).toContain('From age 60, Low uses Apple\'s Low Cardio Fitness alert line (below 18 mL/kg/min for men, 15 for women).');
    expect(e.reason).toContain('at older ages Low is a functional line rather than a percentile');
    expect(e.reason).not.toContain('Apple Health\'s line');
    expect(e.reason).toContain('20th, 50th and 80th percentiles');
    expect(e.reason).toContain('lab treadmill tests');
    expect(e.reason).not.toMatch(/Apple's (bands|levels|cut)/);
    expect(e.reason).not.toContain('—');
  });
});

// US-07 AC1 (Brad 2026-10-27, option A): metformin's prevention claim cites the DPP trial
// itself (Knowler 2002, NEJM 346(6):393-403, Crossref-checked); Lee 2021 stays for deaths.
describe('metformin cites the Diabetes Prevention Program trial (US-07 AC1)', () => {
  it('cites Knowler 2002 beside Lee 2021 and says about a third, less than lifestyle', () => {
    const e = SUGGESTION_EVIDENCE['weight-med-metformin'];
    expect(e.references.map(r => r.url)).toEqual(['https://doi.org/10.1056/NEJMoa012512', 'https://doi.org/10.2337/dc21-1046']);
    expect(e.reason).toContain('reduced the move from prediabetes to diabetes by about a third versus placebo; lifestyle change did more');
  });
});
