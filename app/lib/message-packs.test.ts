import { describe, it, expect } from 'vitest';
import { VARIANT_CREDIT_MAP, buildPackUrls } from './message-packs';

describe('VARIANT_CREDIT_MAP', () => {
  it('maps variant IDs to credit amounts when env vars are set', () => {
    // In test environment, env vars may not be set — that's fine
    // This test verifies the shape and values when they exist
    for (const [variantId, amount] of Object.entries(VARIANT_CREDIT_MAP)) {
      expect(typeof variantId).toBe('string');
      expect(variantId.length).toBeGreaterThan(0);
      expect([25, 60, 150]).toContain(amount);
    }
  });

  it('only contains valid credit amounts', () => {
    const validAmounts = [25, 60, 150];
    for (const amount of Object.values(VARIANT_CREDIT_MAP)) {
      expect(validAmounts).toContain(amount);
    }
  });
});

describe('buildPackUrls', () => {
  it('returns array of pack objects', () => {
    const packs = buildPackUrls();
    for (const pack of packs) {
      expect(pack).toHaveProperty('name');
      expect(pack).toHaveProperty('price');
      expect(pack).toHaveProperty('amount');
      expect(pack).toHaveProperty('url');
      expect(pack.url).toMatch(/^\/cart\/.+:1$/);
      expect([25, 60, 150]).toContain(pack.amount);
    }
  });

  it('returns packs in ascending order by amount', () => {
    const packs = buildPackUrls();
    for (let i = 1; i < packs.length; i++) {
      expect(packs[i].amount).toBeGreaterThan(packs[i - 1].amount);
    }
  });

  it('has correct prices', () => {
    const packs = buildPackUrls();
    const priceMap: Record<number, string> = { 25: '$5', 60: '$10', 150: '$20' };
    for (const pack of packs) {
      expect(pack.price).toBe(priceMap[pack.amount]);
    }
  });
});
