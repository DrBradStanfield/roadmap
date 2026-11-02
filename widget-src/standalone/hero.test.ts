// US-20 AC3: on phones the hero is one compact row (small round photo left of
// the headline, one short line), and the Shopify block and the Pages page carry
// the same hero. Measured layout (heights, overflow) is checked in a browser;
// this pins the markup and the rules that produce it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');
const hero = (html: string) => {
  const header = /<header class="hr-hero">[\s\S]*?<\/header>/.exec(html);
  expect(header).not.toBeNull();
  // The image source and intrinsic size differ by host (CDN vs local file).
  return flat(header![0]).replace(/ (src|width|height)="[^"]*"/g, '');
};
const liquid = read('../../extensions/health-tool-widget/blocks/app-block.liquid');
const page = read('index.html');
const phone = (css: string) => {
  const start = css.indexOf('@media (max-width: 700px) {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0, end = start;
  do { if (css[end] === '{') depth++; else if (css[end] === '}') depth--; end++; }
  while (depth > 0 || css[end - 1] !== '}');
  return flat(css.slice(start, end));
};

const PHONE_RULES = [
  '.hr-hero { flex-direction: row-reverse; gap: 12px; }',
  '.hr-hero-img { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; }',
  '.hr-hero-long { display: none; }',
  '.hr-hero-short { display: inline; }',
];

describe('US-20 AC3 — compact phone hero', () => {
  it('the Shopify block and the Pages page carry the same hero', () => {
    expect(hero(liquid)).toBe(hero(page));
  });

  it('keeps the full paragraph for desktop and adds the short phone line', () => {
    const h = hero(page);
    expect(h).toContain('<h1>Get Your Personalized Health Plan</h1>');
    expect(h).toContain('<span class="hr-hero-long">Enter your health information below');
    expect(h).toContain('<span class="hr-hero-short">Personalized suggestions to discuss with your doctor.</span>');
    expect(h).toContain('alt="Dr Brad Stanfield"');
    expect(h).toContain('loading="eager"');
  });

  it('standalone.css: short line hidden by default; phones get a row with a 56px round photo and only the short line', () => {
    const css = read('standalone.css');
    expect(flat(css)).toContain('.hr-hero-short { display: none; }');
    const block = phone(css);
    for (const rule of PHONE_RULES) expect(block).toContain(rule);
  });

  it('index.html inline first-paint rules match, so the phone hero never paints stacked first', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)![1];
    expect(flat(style)).toContain('.hr-hero-short { display: none; }');
    const inline = phone(style);
    const css = phone(read('standalone.css'));
    for (const rule of PHONE_RULES) {
      expect(inline).toContain(rule);
      expect(css).toContain(rule);
    }
  });
});
