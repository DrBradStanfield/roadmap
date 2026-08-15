/**
 * US-15 AC2 — `chat_opened` must actually emit on every Shopify chat surface.
 *
 * Regression pinned (2026-W33, product-health loop): the 2026-08-10
 * ChatSection fix put the emit call in shared component code, but the
 * site-wide chat FAB ships as its OWN bundle (vite.config.site-chat.ts),
 * and that config never defined VITE_SHOPIFY_SURFACE — so trackProductEvent
 * no-oped in the bundle carrying most chat traffic and chat_opened stayed at
 * zero for a second week. Surface flags are per-bundle `define`s: a bundle
 * that mounts an emitting component MUST declare its surface here or the
 * events silently vanish.
 *
 * vite.config.chatbot.ts (the microvitamin chatbot embed) is deliberately
 * absent: whether that surface should count toward chat_opened is an open
 * product decision (2026-W32 report, backlog #1).
 */
import { describe, expect, it } from 'vitest';

const SHOPIFY_SURFACE_BUNDLES = [
  'vite.config.shopify-prod.ts',
  'vite.config.site-chat.ts',
] as const;

describe('Shopify-surface bundles declare VITE_SHOPIFY_SURFACE (US-15 AC2)', () => {
  for (const configFile of SHOPIFY_SURFACE_BUNDLES) {
    it(`${configFile} defines import.meta.env.VITE_SHOPIFY_SURFACE = "true"`, async () => {
      const config = (await import(`./${configFile}`)).default;
      expect(config.define?.['import.meta.env.VITE_SHOPIFY_SURFACE']).toBe(
        JSON.stringify('true'),
      );
    });
  }
});
