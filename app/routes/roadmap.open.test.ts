import { describe, it, expect } from 'vitest';
import { resolveRoadmapUrl } from './roadmap.open';

/**
 * US-22 AC5 — the plan-ready email's CTA.
 *
 * These tests exist because the first live version shipped two real defects in
 * one line: it built the URL from SHOPIFY_STORE_URL, which on the edu app is a
 * bare myshopify host with no scheme (producing a RELATIVE redirect to a 404 on
 * our own domain), and appending /pages/roadmap 404s on microvitamin.com.
 */
describe('US-22 resolveRoadmapUrl', () => {
  it('defaults to the verified live roadmap page', () => {
    expect(resolveRoadmapUrl({})).toBe('https://drstanfield.com/pages/roadmap');
  });

  it('uses an explicit absolute ROADMAP_URL as-is', () => {
    expect(resolveRoadmapUrl({ ROADMAP_URL: 'https://example.com/pages/plan' }))
      .toBe('https://example.com/pages/plan');
  });

  it('repairs a scheme-less host — the edu-app failure that shipped', () => {
    // Without this, the Location header is relative and the reader lands on
    // health-tool-edu.fly.dev/roadmap/open/sz5utw-1r.myshopify.com (404).
    const url = resolveRoadmapUrl({ ROADMAP_URL: 'sz5utw-1r.myshopify.com/pages/roadmap' });
    expect(url.startsWith('https://')).toBe(true);
    expect(url).toBe('https://sz5utw-1r.myshopify.com/pages/roadmap');
  });

  it('strips trailing slashes so the URL never doubles up', () => {
    expect(resolveRoadmapUrl({ ROADMAP_URL: 'https://example.com/plan///' }))
      .toBe('https://example.com/plan');
  });

  it('ignores an empty or whitespace-only value rather than emitting a bare https://', () => {
    expect(resolveRoadmapUrl({ ROADMAP_URL: '   ' })).toBe('https://drstanfield.com/pages/roadmap');
    expect(resolveRoadmapUrl({ ROADMAP_URL: '' })).toBe('https://drstanfield.com/pages/roadmap');
  });

  it('always returns an absolute URL — the property that prevents the bug class', () => {
    for (const value of ['example.com', 'http://example.com', 'https://example.com', undefined]) {
      const url = resolveRoadmapUrl(value === undefined ? {} : { ROADMAP_URL: value });
      expect(url, `ROADMAP_URL=${value}`).toMatch(/^https?:\/\//);
    }
  });
});
