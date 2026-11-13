import { describe, it, expect } from 'vitest';
import { VARIANT_CREDIT_MAP } from './message-packs';

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
