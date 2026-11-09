// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { labEgfrFrom } from '@roadmap/health-core/plan';
import { loadFromLocalStorage, saveToLocalStorage, MIRROR_KEY } from './storage';

// Adversary review of 0a2b89b0 (R2): the mirror never holds the plan's hidden
// representative for a lab eGFR printed as a limit; an older embed would read it as exact.
describe('US-12 AC20: the mirror keeps a lab eGFR limit, never its representative', () => {
  it('writes the limit and day only, and reads them back graded by the plan\'s rule', async () => {
    const lab = labEgfrFrom(90, '2026-08-01', '>');
    expect(lab.labEgfr).toBeGreaterThan(90);
    saveToLocalStorage({ heightCm: 180 }, [], [], [], [], lab);
    const stored = JSON.parse(localStorage.getItem(MIRROR_KEY)!).labEgfr;
    expect(stored).toEqual({ labEgfrDate: '2026-08-01', labEgfrLimit: { comparator: '>', bound: 90, graded: true } });
    expect(loadFromLocalStorage()?.labEgfr).toEqual(lab);
  });
});
