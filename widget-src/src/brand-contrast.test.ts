/**
 * Web redesign phase 1 (docs/drafts/web-redesign.md §1): the two greens.
 * #00a38b is the brand, for marks only; green text, links and buttons with a
 * white label use the deeper --color-brand-text. Ratios are computed from the
 * values in styles.css, so a hex edit that drops below 4.5:1 fails here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');
const standaloneCss = readFileSync(resolve(__dirname, '../standalone/standalone.css'), 'utf8');

function token(name: string): string {
  const root = /:root\s*\{([^}]*)\}/.exec(css)![1];
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`).exec(root);
  if (!m) throw new Error(`--${name} is not a hex colour in :root`);
  return m[1];
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';
/** The iPhone's grouped background, which the redesign brings to the web. */
const GREY = '#f2f2f7';

describe('web redesign §1 — the green token pair', () => {
  it('keeps #00a38b as the brand and #007c6a as the text green', () => {
    expect(token('color-brand').toLowerCase()).toBe('#00a38b');
    expect(token('color-brand-text').toLowerCase()).toBe('#007c6a');
  });

  it('the text green reaches 4.5:1 as text on white and on grey, and under white text', () => {
    const text = token('color-brand-text');
    expect(ratio(text, WHITE)).toBeGreaterThanOrEqual(4.5); // 5.13, also white-on-green
    expect(ratio(text, GREY)).toBeGreaterThanOrEqual(4.5); // 4.60
  });

  it('the hover shade is deeper still, so hover never drops contrast', () => {
    const hover = token('color-brand-text-hover');
    expect(ratio(hover, WHITE)).toBeGreaterThan(ratio(token('color-brand-text'), WHITE));
    expect(ratio(hover, GREY)).toBeGreaterThanOrEqual(4.5);
  });

  it('the secondary grey reaches 4.5:1 on white and on grey', () => {
    const secondary = token('color-text-secondary');
    expect(ratio(secondary, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(secondary, GREY)).toBeGreaterThanOrEqual(4.5);
  });

  it('the brand itself fails as text, which is why it is kept for marks', () => {
    const brand = token('color-brand');
    expect(ratio(brand, WHITE)).toBeLessThan(4.5); // 3.18
    expect(ratio(brand, GREY)).toBeLessThan(4.5); // 2.85
    // A dark label on a brand fill passes (the active unit segment uses one).
    expect(ratio('#1c2b33', brand)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('web redesign §1 — each use is on the right token', () => {
  const rules = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.replace(/\s+/g, ' '));

  it.each([['styles.css', css], ['standalone.css', standaloneCss]])('%s never sets text in the brand green', (_, sheet) => {
    const textInBrand = rules(sheet).filter((r) => /(^|[;{ ])color:\s*(var\(--color-brand\)|#00a38b)/i.test(r));
    expect(textInBrand).toEqual([]);
  });

  // Opacity blends the text green into its background: 0.7 over white is about 3:1.
  it.each([['styles.css', css], ['standalone.css', standaloneCss]])('%s never fades brand-green text with opacity', (_, sheet) => {
    const selectorsOf = (test: (body: string) => boolean) => new Set(rules(sheet)
      .map((r) => r.split('{'))
      .filter(([, body]) => body !== undefined && test(body))
      .flatMap(([sel]) => sel.split(',').map((x) => x.trim())));
    const green = selectorsOf((b) => /(^|[; ])color:\s*var\(--color-brand-text/.test(b));
    const faded = selectorsOf((b) => /(^|[; ])opacity:\s*0?\.\d/.test(b));
    expect([...green].filter((sel) => faded.has(sel))).toEqual([]);
  });

  it.each([['styles.css', css], ['standalone.css', standaloneCss]])('%s never puts a white label on the brand green', (_, sheet) => {
    const whiteOnBrand = rules(sheet).filter((r) =>
      /background(-color)?:\s*(var\(--color-brand\)|#00a38b)/i.test(r) && /(^|[;{ ])color:\s*(#fff\b|#ffffff|white)/i.test(r));
    expect(whiteOnBrand).toEqual([]);
  });
});
