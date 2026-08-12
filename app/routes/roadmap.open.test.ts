import { describe, it, expect } from 'vitest';
import { ROADMAP_URL } from './roadmap.open';

/**
 * US-22 AC5 — the plan-ready email's CTA destination.
 *
 * One assertion, because the destination is now a literal. It exists because
 * the first live version derived this URL from SHOPIFY_STORE_URL and shipped
 * two real defects in one line: a scheme-less value on the edu app produced a
 * RELATIVE redirect (404 on our own domain), and appending /pages/roadmap 404s
 * on microvitamin.com. If someone reintroduces a computed or relative value,
 * this fails.
 */
describe('US-22 roadmap CTA destination', () => {
  it('is an absolute https URL to the page that hosts the widget', () => {
    expect(ROADMAP_URL).toBe('https://drstanfield.com/pages/roadmap');
    expect(ROADMAP_URL).toMatch(/^https:\/\//);
  });
});
