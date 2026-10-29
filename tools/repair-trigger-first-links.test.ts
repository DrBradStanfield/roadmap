import { describe, expect, it } from 'vitest';
import { verdict } from './repair-trigger-first-links';

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
