/**
 * tools/escape-html.mjs is the one HTML escaper for scripts/ and tools/ (untangle T-7). Ten scripts
 * and tools each carried their own copy, some escaping & < > only, so a quote in an attribute broke
 * out in some and not others. The last test fails when a new local copy appears.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from './escape-html.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('escapeHtml (US-64 AC30)', () => {
  it('escapes the five characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('escapes & first, so the entities it makes are not escaped again', () => {
    expect(escapeHtml('"<')).toBe('&quot;&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves other text alone', () => {
    expect(escapeHtml('plain text, 5 mg — ok')).toBe('plain text, 5 mg — ok');
  });

  it('turns null and undefined into an empty string and other values into text', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(0)).toBe('0');
  });
});

describe('no local HTML escaper in scripts/ or tools/ (US-64 AC30)', () => {
  // A replace of & with &amp; is an HTML escaper: a regex (/&/g, /&/gu, /[&]/g), replaceAll('&', ...) or a lookup map.
  const ESCAPER = /\/(?:&|\[&\])\/[a-z]*\s*,\s*['"`]&amp;|replaceAll\(\s*['"`]&['"`]\s*,\s*['"`]&amp;|['"]&['"]\s*:\s*['"`]&amp;/;

  it('recognises each spelling of an escaper, and not an unescaper', () => {
    for (const src of ["s.replace(/&/g, '&amp;')", 's.replace(/&/gu, "&amp;")', "s.replace(/[&]/g, '&amp;')",
      "s.replaceAll('&', '&amp;')", "({ '&': '&amp;', '<': '&lt;' })[c]"]) expect(src).toMatch(ESCAPER);
    for (const src of ["s.replace(/&amp;/g, '&')", "s.replaceAll('&amp;', '&')"]) expect(src).not.toMatch(ESCAPER);
  });

  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules') return [];
      const p = join(dir, e.name);
      return e.isDirectory() ? files(p) : /\.(m|c)?[jt]s$/.test(e.name) && !/\.test\.[mc]?[jt]s$/.test(e.name) ? [p] : [];
    });

  it('imports tools/escape-html.mjs instead of defining its own', () => {
    const scanned = [...files(join(ROOT, 'scripts')), ...files(join(ROOT, 'tools'))];
    expect(scanned.length).toBeGreaterThan(20);
    const copies = scanned
      .filter((f) => !f.endsWith('escape-html.mjs') && ESCAPER.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(copies).toEqual([]);
  });
});
