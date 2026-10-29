import { describe, expect, it } from 'vitest';
import { allPages, verdict } from './repair-trigger-first-links';

// US-09 AC27a (issue #309): the repair links only an empty profile whose auth
// user carries admin-written proof, and never a customer another profile holds.
describe('US-09 AC27a repair verdict', () => {
  it('links an empty profile with proof that no other profile holds', () => {
    expect(verdict({ profileCustomerId: null, proof: 'c1', proofTaken: false })).toBe('link');
  });
  it('never links without admin-written proof', () => {
    expect(verdict({ profileCustomerId: null, proof: null, proofTaken: false })).toBe('no_proof');
  });
  it('never takes a customer id another profile already holds', () => {
    expect(verdict({ profileCustomerId: null, proof: 'c1', proofTaken: true })).toBe('customer_taken');
  });
  it('leaves a linked profile, and a missing one, alone', () => {
    expect(verdict({ profileCustomerId: 'c1', proof: 'c1', proofTaken: true })).toBe('already_linked');
    expect(verdict({ profileCustomerId: undefined, proof: 'c1', proofTaken: false })).toBe('no_profile');
  });
});

describe('US-09 AC27a repair scan', () => {
  it('reads past a full page, so an orphan on the second page is found', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => `p${i}`);
    const calls: Array<[number, number]> = [];
    const ids = await allPages(async (from, to) => { calls.push([from, to]); return rows.slice(from, to + 1); });
    expect(ids).toEqual(rows);
    expect(calls).toEqual([[0, 499], [500, 999]]);
  });
  it('stops after a short first page', async () => {
    expect(await allPages(async () => ['only'])).toEqual(['only']);
  });
});
