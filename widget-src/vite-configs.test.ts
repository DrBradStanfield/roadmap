/**
 * US-15 AC2 — chat_opened must actually emit on every Shopify chat surface.
 * Regression story: see the VITE_SHOPIFY_SURFACE comment in
 * vite.config.site-chat.ts (2026-W33 product-health report). Surface flags
 * are per-bundle `define`s, so a bundle that mounts an emitting shared
 * component MUST declare its surface here or the events silently vanish —
 * the triage test below forces every config file (current and future)
 * through that decision explicitly, in BOTH directions: Shopify-surface
 * bundles must define the flag, and non-surface bundles (above all the
 * GitHub Pages build, marketed as "no Brad server") must never gain it.
 */
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import shopifyProd from './vite.config.shopify-prod';
import siteChat from './vite.config.site-chat';
import chatbot from './vite.config.chatbot';
import upload from './vite.config.upload';
import standaloneFactory from './vite.config.standalone';

const SURFACE_KEY = 'import.meta.env.VITE_SHOPIFY_SURFACE';

const SHOPIFY_SURFACE_BUNDLES = {
  'vite.config.shopify-prod.ts': shopifyProd,
  'vite.config.site-chat.ts': siteChat,
};

// Bundles that must NEVER declare the flag. Every vite.config.*.ts must
// appear in exactly one of the two lists, so a new bundle cannot skip triage.
const NON_SURFACE_BUNDLES = {
  // microvitamin embed — no trackProductEvent call sites today; whether it
  // should count toward chat_opened is an open product decision (2026-W32).
  'vite.config.chatbot.ts': chatbot,
  // GitHub Pages self-host build — "no Brad server": must never be a
  // Shopify surface, or events would post the user's traffic to the one
  // backend that build promises to avoid.
  'vite.config.standalone.ts': standaloneFactory({
    command: 'build',
    mode: 'production',
  }),
  // Extraction worker bundle — no React, no event emit sites.
  'vite.config.upload.ts': upload,
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
    it(`${name} defines ${SURFACE_KEY} = "true"`, () => {
      expect(config.define?.[SURFACE_KEY]).toBe(JSON.stringify('true'));
    });
  }

  for (const [name, config] of Object.entries(NON_SURFACE_BUNDLES)) {
    it(`${name} does NOT define ${SURFACE_KEY}`, () => {
      expect(config.define?.[SURFACE_KEY]).toBeUndefined();
    });
  }
});
