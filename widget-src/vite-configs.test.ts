/**
 * US-15 AC2 — chat_opened must actually emit on every Shopify chat surface.
 * Regression story: see the VITE_SHOPIFY_SURFACE comment in
 * vite.config.site-chat.ts (2026-W33 product-health report). Surface flags
 * are per-bundle `define`s, so a bundle that mounts an emitting shared
 * component MUST declare its surface here or the events silently vanish —
 * the triage test below forces every config file (current and future)
 * through that decision explicitly.
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import shopifyProd from './vite.config.shopify-prod';
import siteChat from './vite.config.site-chat';

const SHOPIFY_SURFACE_BUNDLES = {
  'vite.config.shopify-prod.ts': shopifyProd,
  'vite.config.site-chat.ts': siteChat,
};

// Bundles deliberately NOT declaring the flag — every vite.config.*.ts must
// appear in exactly one of the two lists, so a new bundle cannot skip triage.
const NON_SURFACE_BUNDLES: Record<string, string> = {
  'vite.config.chatbot.ts':
    'microvitamin embed — whether it counts toward chat_opened is an open product decision (2026-W32 report)',
  'vite.config.standalone.ts':
    'GitHub Pages self-host build — no Brad server; events must stay off',
  'vite.config.upload.ts':
    'extraction worker bundle — no React, no event emit sites',
};

describe('vite bundle surface-flag triage (US-15 AC2)', () => {
  it('every vite config is classified Shopify-surface or not', () => {
    const configs = readdirSync(new URL('.', import.meta.url))
      .filter((f) => /^vite\.config\..+\.ts$/.test(f))
      .sort();
    const classified = [
      ...Object.keys(SHOPIFY_SURFACE_BUNDLES),
      ...Object.keys(NON_SURFACE_BUNDLES),
    ].sort();
    expect(configs).toEqual(classified);
  });

  for (const [name, config] of Object.entries(SHOPIFY_SURFACE_BUNDLES)) {
    it(`${name} defines import.meta.env.VITE_SHOPIFY_SURFACE = "true"`, () => {
      expect(config.define?.['import.meta.env.VITE_SHOPIFY_SURFACE']).toBe(
        JSON.stringify('true'),
      );
    });
  }
});
