// US-21 AC28: lab-catalog-shares.ts and lab-catalog.ts import each other. Loaded
// from this side first, the catalogue must still carry the shares and route by them.
import { describe, expect, it } from 'vitest';
import { labNameForUnit, shareEntries } from './lab-catalog-shares';
import { LAB_CATALOG, LAB_PLAUSIBLE_RANGES } from './lab-catalog';

describe('US-21 AC28 — the shares load first without breaking the catalogue', () => {
  it('US-21 AC28 — the catalogue holds every share, and a count name in % routes to it', () => {
    expect(shareEntries().map((e) => LAB_CATALOG.some((c) => c.key === e.key))).toEqual(Array(8).fill(true));
    expect(labNameForUnit('Neutrophils', '%')).toBe('neutrophils_pct');
    expect(LAB_PLAUSIBLE_RANGES.nrbc_per_100_wbc).toEqual({ min: 0, max: 1000 });
    expect(LAB_PLAUSIBLE_RANGES.neutrophils_pct).toEqual({ min: 0, max: 100 });
  });
});
