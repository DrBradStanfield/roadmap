/**
 * US-50 AC9: a topic master replaces the body of its existing Shopify article
 * on drstanfield.com (edu) and microvitamin.com (commerce).
 *
 * `build-master-html.mjs` turns the master into that body. These pin what it
 * strips, what it renders, what it refuses to pass through, and what it carries
 * over from the live body (theme markers) and what commerce takes only from
 * Brad-approved callout text.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs script, no types
import { buildMasterHtml } from './build-master-html.mjs';

const build = (md: string, opts: Record<string, unknown>) => buildMasterHtml(md, { liveHtml: '', ...opts });

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
  '<h2 id="Evidence"><strong>Evidence</strong></h2>',
  '<h3 dir="ltr"><strong>Blood Pressure</strong></h3><p>old</p>',
  CALLOUT('MicroVitamin includes magnesium taurate &amp; more.', 'microvitamin', 'MicroVitamin'),
  '<h3><strong>Sleep</strong></h3><p>old</p>',
  '<div class="cta-pf"><br></div>',
  '<h2 id="References"><strong>References</strong></h2><ol><p>1. old</p></ol>',
].join('\n');

describe('build-master-html (US-50 AC9)', () => {
  it('US-50 AC9: strips the frontmatter and the leading self-link line', () => {
    const { html, meta } = build(MASTER, { store: 'edu' });
    expect(meta.title).toBe('Magnesium: Test');
    expect(html).not.toMatch(/reviewed:|commerceUrl|^---/m);
    expect(html).not.toContain('Read the full article');
    expect(html).not.toContain('blogs/articles/magnesium-test');
  });

  it('US-50 AC9: renders headings, a list, a table, emphasis, citations and the reference list', () => {
    const { html } = build(MASTER, { store: 'edu' });
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
    const { html } = build(md, { store: 'edu' });
    expect(html).toContain('<ol>\n<li value="1" id="ref-1">Author A.');
    expect(html).toContain('<li value="2" id="ref-2">Author B.');
  });

  it('US-50 AC9: HTML in the markdown is escaped, never passed through', () => {
    const md = MASTER.replace(
      'Magnesium matters',
      '<script>alert(1)</script> <img src=x onerror="alert(2)"> [bad](javascript:alert(3)) Magnesium matters',
    ).replace('| Citrate | Higher |', '| <b onclick=x>Citrate</b> | Higher |');
    const { html } = build(md, { store: 'edu' });
    expect(html).not.toMatch(/<script|<img|<b |onerror="|href="javascript/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;');
    expect(html).toContain('[bad](javascript:alert(3))');
    expect(html).toContain('p &lt; 0.05');
  });

  it('US-50 AC9: commerce never carries old callout text; it places only the approved cards, at their heading path', () => {
    // The live card's text holds old product claims, so it must not reach the page.
    expect(() => buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE })).toThrow(/1 product callout\(s\).*--callouts/);
    const approved = [{ handle: 'magnesium-test-shop', heading: ['2. Evidence', 'Blood Pressure'], text: 'Approved card text.', linkText: 'See MicroVitamin', product: 'microvitamin' }];
    const commerce = buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE, callouts: approved });
    expect(commerce.unplaced).toEqual([]);
    expect(commerce.html.match(/From the MicroVitamin range/g)).toHaveLength(1);
    expect(commerce.html).not.toContain('taurate &amp; more');
    expect(commerce.html).not.toContain('[9]');
    // After the Blood Pressure table, before the Sleep heading.
    expect(commerce.html).toMatch(/<\/table>\n<div style="[^"]*">\n<p [^>]*>From the MicroVitamin range<\/p>\n<p style="margin:0;">Approved card text\. <a href="\/products\/microvitamin" target="_blank" rel="noopener">See MicroVitamin<\/a><\/p>\n<\/div>\n<h3>Sleep<\/h3>/);
    // The master's own handle names it too; an approved card is escaped.
    const own = [{ ...approved[0], handle: 'magnesium-test', text: '<b>x</b>' }];
    expect(buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE, callouts: own }).html).toContain('&lt;b&gt;x&lt;/b&gt;');
    // Fewer approved cards than live ones, an unknown product, a wrong store: refused.
    expect(() => buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE, callouts: [{ ...approved[0], handle: 'other' }] })).toThrow(/approves 0/);
    expect(() => buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE, callouts: [{ ...approved[0], product: 'evil' }] })).toThrow(/unknown product/);
    expect(() => buildMasterHtml(MASTER, { store: 'edu', liveHtml: LIVE, callouts: approved })).toThrow(/commerce builds only/);
    // An approved card whose heading path the master lacks is unplaced.
    const lost = buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE, callouts: [{ ...approved[0], heading: ['Blood Pressure'] }] });
    expect(lost.unplaced.map((c: { reason: string }) => c.reason)).toEqual(['the master has no heading "Blood Pressure"']);

    const edu = buildMasterHtml(MASTER, { store: 'edu', liveHtml: LIVE });
    expect(edu.html).not.toContain('From the MicroVitamin range');
    expect(edu.html).not.toContain('href="/products/');
  });

  it('US-50 AC9: theme markers carry over per store (roadmap-embed edu only, cta-pf both)', () => {
    const edu = buildMasterHtml(MASTER, { store: 'edu', liveHtml: LIVE }).html;
    expect(edu).toMatch(/second point<\/li>\n<\/ul>\n<div class="roadmap-embed"><\/div>\n<h2 id="Evidence">/);
    expect(edu).toMatch(/No single form\.<\/p>\n<div class="cta-pf"><\/div>\n<h2 id="References">/);
    const commerce = buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE.replace(/<div style[\s\S]*?<\/div>/, '') }).html;
    expect(commerce).not.toContain('roadmap-embed');
    expect(commerce).toContain('<div class="cta-pf"></div>');
  });

  it('US-50 AC9: commerce points drstanfield.com product links at the on-store product; edu keeps them', () => {
    // A table cell is the one place a product link survives the commerce product drop.
    const md = MASTER.replace('| Citrate | Higher |', '| Citrate | Higher, see [MicroVitamin](https://drstanfield.com/products/microvitamin) |');
    expect(build(md, { store: 'commerce' }).html).toContain('<a href="/products/microvitamin">MicroVitamin</a>');
    expect(build(md, { store: 'edu' }).html).toContain('<a href="https://drstanfield.com/products/microvitamin">MicroVitamin</a>');
    const powder = md.replaceAll('products/microvitamin)', 'products/microvitamin-powder)');
    expect(build(powder, { store: 'commerce' }).html).toContain('href="/products/microvitamin-plus"');
  });

  it("US-50 AC9: commerce drops Brad's current view, evidence position and videos sections; edu keeps them", () => {
    const md = MASTER.replace('## 1. Overview', "## Key safety points\n\n- Check with your doctor.\n\n## Brad's videos on this topic\n\n- 1 Oct 2026, [A video](https://drstanfield.com/blogs/articles/a-video): Brad's take.\n\n### Older videos\n\n- older\n\n## 1. Overview");
    const c = build(md, { store: 'commerce' });
    expect(c.html).not.toMatch(/Current view|Brad favours|videos on this topic|A video|Older videos|older/);
    expect(c.html).toContain('<li>Check with your doctor.</li>');
    expect(c.html).toMatch(/^<h2>Table of Contents<\/h2>\n<ul>\n<li><a href="#Key-safety-points">/);
    expect(c.stripped.map((x: { heading: string[] }) => x.heading.join(' > '))).toEqual(['Current view (reviewed 20 October 2026)', "Brad's videos on this topic"]);
    const position = build(md.replace('## Current view (reviewed 20 October 2026)', '## Current evidence position'), { store: 'commerce' });
    expect(position.html).not.toContain('Brad favours');
    const edu = build(md, { store: 'edu' });
    expect(edu.html).toContain('Brad favours');
    expect(edu.html).toContain('Older videos');
    expect(edu.stripped).toEqual([]);
  });

  it("US-50 AC9: commerce drops the master's own product paragraphs and product sections; the approved card does that job", () => {
    const P = '[MicroVitamin](https://drstanfield.com/products/microvitamin)';
    const md = MASTER.replace('Magnesium matters, p < 0.05 [1].', [
      `Dr Brad Stanfield's ${P} includes 126 mg of magnesium. It is taken daily.`,
      '',
      `**Absorption differs by form.** One trial found higher uptake [1]. Dr Brad Stanfield's ${P} uses taurate. That is all.`,
      '',
      'Magnesium matters, p < 0.05 [1].',
    ].join('\n')).replace('- second point', `- second point [2]. ${P} has it too.`)
      .replace('### Sleep', `### Product Note: MicroVitamin\n\nIt has magnesium.\n\n#### Detail\n\nMore.\n\n### Magnesium in Dr Brad Stanfield's Products\n\nNot in Sleep.\n\n### Sleep`);
    const c = build(md, { store: 'commerce' });
    expect(c.html).not.toMatch(/126 mg|taken daily|uses taurate|That is all|has it too|Product Note|It has magnesium|Detail|More\.|Not in Sleep|products\//);
    // Sentences before the product link stay, in a paragraph and in a list item.
    expect(c.html).toContain('<p><strong>Absorption differs by form.</strong> One trial found higher uptake <a href="#ref-1">[1]</a>.</p>');
    expect(c.html).toContain('<li>second point <a href="#ref-2">[2]</a>.</li>');
    expect(c.html).toContain('<p>Magnesium matters, p &lt; 0.05 <a href="#ref-1">[1]</a>.</p>');
    expect(c.html).toContain('<h3>Sleep</h3>');
    expect(c.stripped.map((x: { kind: string }) => x.kind)).toEqual(['section', 'paragraph', 'sentences', 'sentences', 'section', 'section']);
    expect(c.stripped[4].heading).toEqual(['2. Evidence', 'Product Note: MicroVitamin']);
    const edu = build(md, { store: 'edu' });
    expect(edu.html).toContain('includes 126 mg of magnesium');
    expect(edu.html).toContain('<h3>Product Note: MicroVitamin</h3>');
  });

  it('US-50 AC9: a quoted attribute holding ">" or "class=" neither hides nor fakes a marker (Codex R1)', () => {
    const live = [
      '<h2>Overview</h2>',
      '<div title="a > b" class="cta-pf"></div>',
      `<p data-note='x>y class=cta-roadmap'>text</p>`,
      '<!-- <div class="cta-roadmap"></div> -->',
      '<h2 title="Evidence > Sleep">Evidence</h2><h3>Sleep</h3>',
      '<span title=">" class=roadmap-embed></span>',
    ].join('\n');
    const r = buildMasterHtml(MASTER, { store: 'edu', liveHtml: live });
    expect(r.carried.map((c: { kind: string; path: { text: string }[] }) => `${c.kind}@${c.path.map((h) => h.text).join('>')}`)).toEqual(['cta-pf@Overview', 'roadmap-embed@Evidence>Sleep']);
    expect(r.unplaced).toEqual([]);
    // A marker hidden behind a quoted ">" inside a heading still refuses the build.
    expect(() => buildMasterHtml(MASTER, { store: 'edu', liveHtml: '<h2>Overview <span title="a>b" class="cta-pf"></span></h2>' })).toThrow(/1 theme markers but only 0/);
  });

  it('US-50 AC9: a live card is counted on its visible text, so markup or entities in the eyebrow still need approved text (Codex R2)', () => {
    for (const eyebrow of ['From the MicroVitamin <strong>range</strong>', 'From the MicroVitamin&nbsp;range', 'From&#160;the <em>Micro</em>Vitamin&#x20;range', 'From the MicroVitamin\n  range']) {
      const live = `<h2>Evidence</h2><h3>Blood Pressure</h3><div><p>${eyebrow}</p><p>Old claim.</p></div>`;
      expect(() => buildMasterHtml(MASTER, { store: 'commerce', liveHtml: live }), eyebrow).toThrow(/1 product callout\(s\).*--callouts/);
    }
    // The phrase inside an attribute is not a card.
    expect(buildMasterHtml(MASTER, { store: 'commerce', liveHtml: '<p title="From the MicroVitamin range">x</p>' }).unplaced).toEqual([]);
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
      expect(bad.stderr).toContain('UNPLACED cta-pf: the master has no heading "Evidence > Insomnia"');
      writeFileSync(join(dir, 'empty.html'), '');
      const good = spawnSync('node', [SCRIPT, join(dir, 'm.md'), '--store', 'commerce', '--live', join(dir, 'empty.html'), '--out', join(dir, 'o.html')], { encoding: 'utf8' });
      expect(good.status).toBe(0);
      expect(readFileSync(join(dir, 'o.html'), 'utf8')).toContain('<h3>Blood Pressure</h3>');
      expect(spawnSync('node', [SCRIPT, join(dir, 'm.md')], { encoding: 'utf8' }).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('US-50 AC9: --live is required, so no build can skip the marker check', () => {
    expect(() => buildMasterHtml(MASTER, { store: 'edu' })).toThrow(/--live/);
    const dir = mkdtempSync(join(tmpdir(), 'master-'));
    try {
      writeFileSync(join(dir, 'm.md'), MASTER);
      const r = spawnSync('node', [SCRIPT, join(dir, 'm.md'), '--store', 'edu', '--out', join(dir, 'o.html')], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--live');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('US-50 AC9: markers are found by class token, whatever the attribute order, quoting or extra classes', () => {
    const live = [
      '<h2>Overview</h2>',
      `<p data-x="1" class='note cta-pf'>&nbsp;</p>`,
      '<div class=roadmap-embed><br/></div>',
      '<h2>Evidence</h2><h3>Sleep</h3>',
      '<div id="a" class="x  cta-roadmap y"></div>',
      '<span data-class="cta-pf">not a marker</span>',
    ].join('\n');
    const r = buildMasterHtml(MASTER, { store: 'edu', liveHtml: live });
    expect(r.carried.map((c: { kind: string }) => c.kind)).toEqual(['cta-pf', 'roadmap-embed', 'cta-roadmap']);
    expect(r.unplaced).toEqual([]);
    expect(r.html).toMatch(/second point<\/li>\n<\/ul>\n<div class="cta-pf"><\/div>\n<div class="roadmap-embed"><\/div>\n<h2 id="Evidence">/);
    expect(r.html).toMatch(/No single form\.<\/p>\n<div class="cta-roadmap"><\/div>\n<h2 id="References">/);
    // Commerce drops the two its theme renders as nothing, and says so.
    const c = buildMasterHtml(MASTER, { store: 'commerce', liveHtml: live });
    expect(c.dropped.map((d: { kind: string }) => d.kind)).toEqual(['roadmap-embed', 'cta-roadmap']);
    // A marker the converter cannot place (inside a heading) refuses the build.
    expect(() => buildMasterHtml(MASTER, { store: 'edu', liveHtml: '<h2>Overview <span class="cta-pf"></span></h2>' })).toThrow(/1 theme markers but only 0/);
  });

  it('US-50 AC9: a carried marker is placed by its heading path, so a repeated subsection name lands in the right section', () => {
    // As in the quercetin master: "### Blood Pressure" under two different H2s.
    const md = MASTER.replace('## 3. References', '## 3. Safety\n\n### Blood Pressure\n\nLow blood pressure note.\n\n## 4. References');
    const live = '<h2>Evidence</h2><h3>Blood Pressure</h3><div class="cta-pf"></div><h2>Safety</h2><h3>Blood Pressure</h3><div class="roadmap-embed"></div>';
    const { html, unplaced } = buildMasterHtml(md, { store: 'edu', liveHtml: live });
    expect(unplaced).toEqual([]);
    expect(html).toMatch(/<\/table>\n<div class="cta-pf"><\/div>\n<h3>Sleep<\/h3>/);
    expect(html).toMatch(/Low blood pressure note\.<\/p>\n<div class="roadmap-embed"><\/div>\n<h2 id="References">/);
    // The same heading level matters: an h4 is not the master's ###.
    expect(buildMasterHtml(md, { store: 'edu', liveHtml: '<h2>Safety</h2><h4>Blood Pressure</h4><div class="cta-pf"></div>' }).unplaced).toHaveLength(1);
    // Two master headings with the same path: ambiguous, refused.
    const twice = md.replace('### Sleep', '### Blood Pressure');
    const amb = buildMasterHtml(twice, { store: 'edu', liveHtml: live });
    expect(amb.unplaced.map((c: { reason: string }) => c.reason)).toEqual(['"Evidence > Blood Pressure" matches 2 master headings']);
  });

  it('US-50 AC9: a roadmap-embed under a renamed subsection falls back to the end of its parent section', () => {
    const live = '<h2>Evidence</h2><h3>Insomnia</h3><div class="roadmap-embed"></div>';
    const r = buildMasterHtml(MASTER, { store: 'edu', liveHtml: live });
    expect(r.unplaced).toEqual([]);
    expect(r.fallbacks.map((c: { placed: string }) => c.placed)).toEqual(['end of "2. Evidence"']);
    expect(r.html).toMatch(/No single form\.<\/p>\n<div class="roadmap-embed"><\/div>\n<h2 id="References">/);
  });

  it('US-50 AC9: a roadmap-embed whose subsection changed level falls back to the parent section', () => {
    const r = buildMasterHtml(MASTER, { store: 'edu', liveHtml: '<h2>Evidence</h2><h4>Blood Pressure</h4><div class="roadmap-embed"></div>' });
    expect(r.unplaced).toEqual([]);
    expect(r.html).toMatch(/No single form\.<\/p>\n<div class="roadmap-embed"><\/div>\n<h2 id="References">/);
    // A deeper surviving ancestor wins over the H2.
    const deep = buildMasterHtml(MASTER.replace('### Sleep', '### Sleep\n\n#### Onset\n\nOnset text.\n\n#### Depth'), {
      store: 'edu', liveHtml: '<h2>Evidence</h2><h3>Sleep</h3><h4>Latency</h4><div class="roadmap-embed"></div>',
    });
    expect(deep.fallbacks.map((c: { placed: string }) => c.placed)).toEqual(['end of "2. Evidence > Sleep"']);
  });

  it('US-50 AC9: a roadmap-embed before the first live heading goes after the table of contents', () => {
    const r = buildMasterHtml(MASTER, { store: 'edu', liveHtml: '<div class="roadmap-embed"></div><h2>Overview</h2>' });
    expect(r.unplaced).toEqual([]);
    expect(r.html).toMatch(/<\/ul>\n<div class="roadmap-embed"><\/div>\n<h2 id="Current-view">/);
  });

  it('US-50 AC9: a roadmap-embed whose H2 is gone goes before References, and the CLI logs each fallback', () => {
    const live = '<h2>Dosing</h2><h3>Timing</h3><div class="roadmap-embed"></div>';
    const r = buildMasterHtml(MASTER, { store: 'edu', liveHtml: live });
    expect(r.unplaced).toEqual([]);
    expect(r.html).toMatch(/No single form\.<\/p>\n<div class="roadmap-embed"><\/div>\n<h2 id="References">/);
    const dir = mkdtempSync(join(tmpdir(), 'master-'));
    try {
      writeFileSync(join(dir, 'magnesium-test.md'), MASTER);
      writeFileSync(join(dir, 'live.html'), live);
      const run = spawnSync('node', [SCRIPT, join(dir, 'magnesium-test.md'), '--store', 'edu', '--live', join(dir, 'live.html'), '--out', join(dir, 'o.html')], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stderr).toContain('FALLBACK magnesium-test roadmap-embed: live "Dosing > Timing" -> before "References"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('US-50 AC9: only roadmap-embed falls back; other markers and ambiguous ancestors still fail', () => {
    for (const kind of ['cta-pf', 'cta-roadmap']) {
      for (const live of [`<h2>Evidence</h2><h3>Insomnia</h3><div class="${kind}"></div>`, `<div class="${kind}"></div><h2>Overview</h2>`, `<h2>Dosing</h2><div class="${kind}"></div>`]) {
        const r = buildMasterHtml(MASTER, { store: 'edu', liveHtml: live });
        expect(r.unplaced.map((c: { kind: string }) => c.kind)).toEqual([kind]);
        expect(r.fallbacks).toEqual([]);
      }
    }
    // Two master sections named Evidence: the fallback ancestor is ambiguous, so it fails.
    const twice = MASTER.replace('## 3. References', '## Evidence\n\nMore.\n\n## 3. References');
    const amb = buildMasterHtml(twice, { store: 'edu', liveHtml: '<h2>Evidence</h2><h3>Insomnia</h3><div class="roadmap-embed"></div>' });
    expect(amb.unplaced.map((c: { reason: string }) => c.reason)).toEqual(['the master has no heading "Evidence > Insomnia"; its ancestor "Evidence" matches 2 master headings']);
  });

  it('US-50 AC9: indented list items render as a nested list', () => {
    const md = MASTER.replace('- first point\n- second point', '- **Results:**\n  - weight fell [7]\n  - lipids improved\n    continued line\n- **Limitations:** small\n1. not part of the list');
    const { html } = build(md, { store: 'edu' });
    expect(html).toContain('<ul>\n<li><strong>Results:</strong>\n<ul>\n<li>weight fell <a href="#ref-7">[7]</a></li>\n<li>lipids improved continued line</li>\n</ul>\n</li>\n<li><strong>Limitations:</strong> small</li>\n</ul>\n<ol>');
  });

  it('US-50 AC9: a protocol-relative //host link is not a site path and is not linked', () => {
    const { html } = build(MASTER.replace('Magnesium matters', '[x](//evil.example/a) [ok](/pages/roadmap) Magnesium matters'), { store: 'edu' });
    expect(html).not.toContain('href="//');
    expect(html).toContain('[x](//evil.example/a)');
    expect(html).toContain('<a href="/pages/roadmap">ok</a>');
  });

  it('US-50 AC9: grouped citations link each number, or a range to its start', () => {
    const { html } = build(MASTER.replace('Magnesium matters', 'A [51-54], B [3,5], C [3, 6\u20138], D [3][5].'), { store: 'edu' });
    expect(html).toContain('A <a href="#ref-51">[51-54]</a>');
    expect(html).toContain('B [<a href="#ref-3">3</a>,<a href="#ref-5">5</a>]');
    expect(html).toContain('C [<a href="#ref-3">3</a>, <a href="#ref-6">6\u20138</a>]');
    expect(html).toContain('D <a href="#ref-3">[3]</a><a href="#ref-5">[5]</a>');
  });

  it('US-50 AC9: code inside link text renders, and no placeholder leaks', () => {
    const { html } = build(MASTER.replace('Magnesium matters', 'See [the `tool` page](https://example.com/t) and `x`.'), { store: 'edu' });
    expect(html).toContain('<a href="https://example.com/t">the <code>tool</code> page</a> and <code>x</code>.');
    expect(html).not.toMatch(/@@M/);
  });

  it('US-50 AC9: the script says the master renumbers references, so old #ref-n bookmarks can move', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(/References are renumbered[\s\S]*#ref-n bookmark can now point at a different source/);
  });
});
