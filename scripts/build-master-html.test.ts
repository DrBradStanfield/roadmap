/**
 * US-50 AC9: a topic master replaces the body of its existing Shopify article
 * on drstanfield.com (edu) and microvitamin.com (commerce).
 *
 * `build-master-html.mjs` turns the master into that body. These pin what it
 * strips, what it renders, what it refuses to pass through, and what it carries
 * over from the live body (theme markers, commerce product callouts).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs script, no types
import { buildMasterHtml } from './build-master-html.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'build-master-html.mjs');

const MASTER = `---
title: "Magnesium: Test"
url: "https://drstanfield.com/blogs/articles/magnesium-test"
commerceUrl: "https://microvitamin.com/blogs/articles/magnesium-test-shop"
reviewed: "2026-10-20"
---

*Read the full article at [drstanfield.com/blogs/articles/magnesium-test](https://drstanfield.com/blogs/articles/magnesium-test)*

## Current view (reviewed 20 October 2026)

Brad favours **glycinate** and *taurate* [1][2]. See [MicroVitamin](https://drstanfield.com/products/microvitamin).

## 1. Overview

Magnesium matters, p < 0.05 [1].
- first point
- second point

## 2. Evidence

### Blood Pressure

| Form | Absorption |
|------|------|
| Oxide | Poor [1] |
| Citrate | Higher |

### Sleep

**Which form is best?**
No single form.

## 3. References

[1] Author A. "Title one." doi: [10.1/abc(17)x](https://doi.org/10.1/abc(17)x)

[2] Author B. Title two. https://pubmed.ncbi.nlm.nih.gov/123/
`;

const CALLOUT = (text: string, handle: string, name: string) =>
  `<div style="border:1px solid #dde7e3;">\n<p style="margin:0 0 6px;font-weight:700;">From the MicroVitamin range</p>\n<p style="margin:0;">${text} [9] <a href="/products/${handle}" target="_blank" rel="noopener">${name}</a>.</p>\n</div>`;

const LIVE = [
  '<h2 dir="ltr"><strong>Table of Contents</strong></h2><ul><li>x</li></ul>',
  '<h2 id="Overview" dir="ltr"><strong>Overview</strong></h2><p>old</p>',
  '<div class="roadmap-embed"></div>',
  '<h3 dir="ltr"><strong>Blood Pressure</strong></h3><p>old</p>',
  CALLOUT('MicroVitamin includes magnesium taurate &amp; more.', 'microvitamin', 'MicroVitamin'),
  '<h3><strong>Sleep</strong></h3><p>old</p>',
  '<div class="cta-pf"><br></div>',
  '<h2 id="References"><strong>References</strong></h2><ol><p>1. old</p></ol>',
].join('\n');

describe('build-master-html (US-50 AC9)', () => {
  it('US-50 AC9: strips the frontmatter and the leading self-link line', () => {
    const { html, meta } = buildMasterHtml(MASTER, { store: 'edu' });
    expect(meta.title).toBe('Magnesium: Test');
    expect(html).not.toMatch(/reviewed:|commerceUrl|^---/m);
    expect(html).not.toContain('Read the full article');
    expect(html).not.toContain('blogs/articles/magnesium-test');
  });

  it('US-50 AC9: renders headings, a list, a table, emphasis, citations and the reference list', () => {
    const { html } = buildMasterHtml(MASTER, { store: 'edu' });
    expect(html).toContain('<h2 id="Overview">1. Overview</h2>');
    expect(html).toContain('<h3>Blood Pressure</h3>');
    expect(html).toContain('<ul>\n<li>first point</li>\n<li>second point</li>\n</ul>');
    expect(html).toContain('<thead><tr><th>Form</th><th>Absorption</th></tr></thead>');
    expect(html).toContain('<tr><td>Oxide</td><td>Poor <a href="#ref-1">[1]</a></td></tr>');
    expect(html).toContain('<strong>glycinate</strong> and <em>taurate</em> <a href="#ref-1">[1]</a><a href="#ref-2">[2]</a>');
    expect(html).toContain('<p><strong>Which form is best?</strong><br>No single form.</p>');
    expect(html).toMatch(/<p id="ref-1"><a href="#ref-1">\[1\]<\/a> Author A\. &quot;Title one\.&quot; doi: <a href="https:\/\/doi\.org\/10\.1\/abc\(17\)x">10\.1\/abc\(17\)x<\/a><\/p>/);
    expect(html).toContain('<p id="ref-2"><a href="#ref-2">[2]</a> Author B. Title two. <a href="https://pubmed.ncbi.nlm.nih.gov/123/">https://pubmed.ncbi.nlm.nih.gov/123/</a></p>');
    // A table of contents from the H2s, anchors in the live bodies' shape.
    expect(html).toMatch(/^<h2>Table of Contents<\/h2>\n<ul>\n<li><a href="#Current-view">/);
    expect(html).toContain('<li><a href="#References">References</a></li>');
  });

  it('US-50 AC9: numbered reference lists keep their numbers and anchors', () => {
    const md = MASTER.replace(/\[1\] Author A/, '1. Author A').replace(/\n\n\[2\] Author B/, '\n2. Author B');
    const { html } = buildMasterHtml(md, { store: 'edu' });
    expect(html).toContain('<ol>\n<li value="1" id="ref-1">Author A.');
    expect(html).toContain('<li value="2" id="ref-2">Author B.');
  });

  it('US-50 AC9: HTML in the markdown is escaped, never passed through', () => {
    const md = MASTER.replace(
      'Magnesium matters',
      '<script>alert(1)</script> <img src=x onerror="alert(2)"> [bad](javascript:alert(3)) Magnesium matters',
    ).replace('| Citrate | Higher |', '| <b onclick=x>Citrate</b> | Higher |');
    const { html } = buildMasterHtml(md, { store: 'edu' });
    expect(html).not.toMatch(/<script|<img|<b |onerror="|href="javascript/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;');
    expect(html).toContain('[bad](javascript:alert(3))');
    expect(html).toContain('p &lt; 0.05');
  });

  it('US-50 AC9: commerce adds the live callouts at the end of their sections; edu adds none', () => {
    const commerce = buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE });
    expect(commerce.unplaced).toEqual([]);
    expect(commerce.html.match(/From the MicroVitamin range/g)).toHaveLength(1);
    // After the Blood Pressure table, before the Sleep heading.
    expect(commerce.html).toMatch(/<\/table>\n<div style="[^"]*">\n<p [^>]*>From the MicroVitamin range<\/p>\n<p style="margin:0;">MicroVitamin includes magnesium taurate &amp; more\. <a href="\/products\/microvitamin" target="_blank" rel="noopener">MicroVitamin<\/a>\.<\/p>\n<\/div>\n<h3>Sleep<\/h3>/);
    // The old [9] pointed into the old reference list.
    expect(commerce.html).not.toContain('[9]');

    const edu = buildMasterHtml(MASTER, { store: 'edu', liveHtml: LIVE });
    expect(edu.html).not.toContain('From the MicroVitamin range');
    expect(edu.html).not.toContain('href="/products/');
  });

  it('US-50 AC9: theme markers carry over per store (roadmap-embed edu only, cta-pf both)', () => {
    const edu = buildMasterHtml(MASTER, { store: 'edu', liveHtml: LIVE }).html;
    expect(edu).toMatch(/second point<\/li>\n<\/ul>\n<div class="roadmap-embed"><\/div>\n<h2 id="Evidence">/);
    expect(edu).toMatch(/No single form\.<\/p>\n<div class="cta-pf"><\/div>\n<h2 id="References">/);
    const commerce = buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE }).html;
    expect(commerce).not.toContain('roadmap-embed');
    expect(commerce).toContain('<div class="cta-pf"></div>');
  });

  it('US-50 AC9: commerce points drstanfield.com product links at the on-store product; edu keeps them', () => {
    expect(buildMasterHtml(MASTER, { store: 'commerce' }).html).toContain('<a href="/products/microvitamin">MicroVitamin</a>');
    expect(buildMasterHtml(MASTER, { store: 'edu' }).html).toContain('<a href="https://drstanfield.com/products/microvitamin">MicroVitamin</a>');
    const powder = MASTER.replace('products/microvitamin)', 'products/microvitamin-powder)');
    expect(buildMasterHtml(powder, { store: 'commerce' }).html).toContain('href="/products/microvitamin-plus"');
  });

  it('US-50 AC9: a carried block whose heading the master lacks is reported and fails the CLI', () => {
    const live = LIVE.replace('<strong>Sleep</strong></h3><p>old</p>', '<strong>Insomnia</strong></h3><p>old</p>');
    const { unplaced } = buildMasterHtml(MASTER, { store: 'edu', liveHtml: live });
    expect(unplaced.map((c: { kind: string }) => c.kind)).toEqual(['cta-pf']);

    const dir = mkdtempSync(join(tmpdir(), 'master-'));
    try {
      writeFileSync(join(dir, 'm.md'), MASTER);
      writeFileSync(join(dir, 'live.html'), live);
      const bad = spawnSync('node', [SCRIPT, join(dir, 'm.md'), '--store', 'edu', '--live', join(dir, 'live.html'), '--out', join(dir, 'o.html')], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('UNPLACED cta-pf: the master has no heading "Insomnia"');
      const good = spawnSync('node', [SCRIPT, join(dir, 'm.md'), '--store', 'commerce', '--out', join(dir, 'o.html')], { encoding: 'utf8' });
      expect(good.status).toBe(0);
      expect(readFileSync(join(dir, 'o.html'), 'utf8')).toContain('<h3>Blood Pressure</h3>');
      expect(spawnSync('node', [SCRIPT, join(dir, 'm.md')], { encoding: 'utf8' }).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
