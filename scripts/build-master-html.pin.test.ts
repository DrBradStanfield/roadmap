import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain .mjs script, no types
import * as mod from './build-master-html.mjs';

// Story: US-50 AC9. Golden pins for the file-size split of build-master-html.mjs (US-64 AC23): the export list,
// every export's output on one synthetic master and live body, and the CLI's output, exit codes and written file.
// Invented "zeta" text only: no real master, guide or source text. No network. Temp paths are normalised.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'build-master-html.mjs');

const MASTER = `---
title: "Zeta: Pin Fixture"
url: "https://drstanfield.com/blogs/articles/zeta-pin"
commerceUrl: "https://microvitamin.com/blogs/articles/zeta-pin-shop/"
reviewed: "2026-01-01"
---

*Read the full article at [drstanfield.com/blogs/articles/zeta-pin](https://drstanfield.com/blogs/articles/zeta-pin)*

## Current view (reviewed 1 January 2026)

Brad takes **zeta** daily [1].

## 1. Overview (short)

Zeta is an invented nutrient [1][2]. Its dose is 2.5 mg (see the Current view above).
Zeta comes as \`zeta-x\` and *zeta-y* [3,4] and [5-6].
- first point
  - nested point
    with a continuation
- second point
1. step one
2. step two

> A quoted line [1].
> A second quoted line.

---

## 2. Evidence

### Blood Flow

| Form | Uptake |
|------|------|
| Alpha | Low [1] |
| Beta \\| Gamma | High |

Zeta was tested in mice [2]. It suits [MicroVitamin](https://drstanfield.com/products/microvitamin-powder) users. Zeta was never tested in a randomised human trial. It may help. The capsule was not shown to work.

- A list item names [Sleep](https://drstanfield.com/products/sleep) here.
  It continues on.

Zeta pairs well with rest; Brad's view is in the Current view. MicroVitamin includes zeta. Disclosure: Brad sells MicroVitamin. Zeta is third-party tested in MicroVitamin. Other zeta is third-party tested.

### Sleep

#### Deep Detail

Bare link https://example.org/zeta-study. Safe [link](/pages/zeta) and unsafe [link](javascript:alert(1)) and <b>raw</b>.

## Product Context

Zeta in a product.

## Brad's videos on this topic

A video list.

## Key safety points

- Zeta is invented.

## References

[1] Author A. "Zeta one." doi: [10.1/abc(17)x](https://doi.org/10.1/abc(17)x)

[2] Author B. Zeta two. https://pubmed.ncbi.nlm.nih.gov/1/

1. Author C. Zeta three.
2. Author D. Zeta four.
`;

const LIVE = [
  '<div class="roadmap-embed"></div>',
  '<h2 dir="ltr"><strong>Table of Contents</strong></h2><ul><li>x</li></ul>',
  '<h2 id="Overview"><strong>Overview</strong></h2><p>old &amp; stale</p><!-- <div class="cta-pf"></div> -->',
  '<div data-x="a>b" class="cta-roadmap"></div>',
  '<h2 id="Evidence"><strong>Evidence</strong></h2>',
  '<h3><strong>Blood Flow</strong></h3><p>old</p>',
  '<div style="border:1px solid #dde7e3;"><p><b>From</b> the MicroVitamin range</p><p>old card</p></div>',
  '<div class=\'x roadmap-embed\'></div>',
  '<h3>Old Renamed</h3><div class="roadmap-embed"></div>',
  '<h3><strong>Sleep</strong></h3><div class=cta-pf></div>',
  '<h2>Gone Section</h2><div class="roadmap-embed"></div>',
  '<h2 id="References"><strong>References</strong></h2><ol><li>old</li></ol>',
].join('\n');

const CALLOUTS = [
  { handle: 'zeta-pin-shop', heading: ['2. Evidence', 'Blood Flow'], text: 'Zeta card text & more.', linkText: 'Shop it', product: 'microvitamin-plus' },
  { handle: 'zeta-pin', heading: ['Evidence', 'Sleep'], text: 'Fibre card.', linkText: 'Drink', product: 'potassium-fiber-drink' },
  { handle: 'other-article', heading: ['Sleep'], text: 'Not this article.', linkText: 'No', product: 'sleep' },
];

describe('build-master-html pins (US-64 AC23 split, US-50 AC9)', () => {
  it('exports the same names', () => {
    expect(Object.keys(mod).sort()).toEqual([
      'buildMasterHtml', 'extractCarried', 'headingKey', 'placeCarried', 'renderBlocks',
      'renderCallout', 'splitMaster', 'stripForCommerce', 'tokenizeTags',
    ]);
  });

  it('edu build: full result', () => {
    expect(mod.buildMasterHtml(MASTER, { store: 'edu', liveHtml: LIVE })).toMatchSnapshot();
  });

  it('commerce build: full result', () => {
    expect(mod.buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE, callouts: CALLOUTS })).toMatchSnapshot();
  });

  it('each helper export on the fixture', () => {
    const { meta, body } = mod.splitMaster(MASTER);
    const blocks = mod.renderBlocks(body, { store: 'commerce' });
    const edu = mod.extractCarried(LIVE, 'edu');
    expect({
      meta,
      body,
      key: mod.headingKey('3. Blood <b>Flow</b> &amp; (x)'),
      blocks,
      tags: mod.tokenizeTags('<a href="x>y" class=b CLASS="c"><!-- <i> --></a><br/>'),
      carriedCommerce: mod.extractCarried(LIVE, 'commerce'),
      placed: mod.placeCarried(blocks, edu.carried),
      callout: mod.renderCallout(CALLOUTS[0]),
      stripped: mod.stripForCommerce(body),
    }).toMatchSnapshot();
  });

  it('refusals keep their messages', () => {
    const msg = (f: () => unknown) => { try { f(); return 'no error'; } catch (e) { return (e as Error).message; } };
    expect([
      msg(() => mod.buildMasterHtml(MASTER, { store: 'x', liveHtml: '' })),
      msg(() => mod.buildMasterHtml(MASTER, { store: 'edu' })),
      msg(() => mod.buildMasterHtml('no fm', { store: 'edu', liveHtml: '' })),
      msg(() => mod.buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE })),
      msg(() => mod.buildMasterHtml(MASTER, { store: 'commerce', liveHtml: LIVE, callouts: CALLOUTS.slice(2) })),
      msg(() => mod.buildMasterHtml(MASTER, { store: 'commerce', liveHtml: '', callouts: [{ handle: 'zeta-pin', heading: [], text: 't', linkText: 'l', product: 'sleep' }] })),
      msg(() => mod.buildMasterHtml(MASTER, { store: 'edu', liveHtml: '', callouts: [] })),
      msg(() => mod.buildMasterHtml(MASTER, { store: 'edu', liveHtml: '<h2 class="cta-pf">A</h2>' })),
      msg(() => mod.renderCallout({ text: 't', linkText: 'l', product: 'nope' })),
      msg(() => mod.renderCallout({ text: ' ', linkText: 'l', product: 'sleep' })),
    ]).toMatchSnapshot();
  });

  it('CLI: output, exit codes and the written file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bmh-pin-'));
    try {
      writeFileSync(join(dir, 'zeta-pin.md'), MASTER);
      writeFileSync(join(dir, 'live.html'), LIVE);
      writeFileSync(join(dir, 'callouts.json'), JSON.stringify(CALLOUTS));
      writeFileSync(join(dir, 'unplaced.html'), '<h2>Nowhere</h2><div class="cta-pf"></div>');
      const run = (...args: string[]) => {
        const r = spawnSync('node', [SCRIPT, ...args.map((a) => a.replace('@', `${dir}/`))], { encoding: 'utf8', cwd: dir });
        return { status: r.status, stdout: r.stdout.split(dir).join('<tmp>'), stderr: r.stderr.split(dir).join('<tmp>') };
      };
      const edu = run('@zeta-pin.md', '--store', 'edu', '--live', '@live.html', '--out', '@out/edu.html');
      const commerce = run('@zeta-pin.md', '--store', 'commerce', '--live', '@live.html', '--callouts', '@callouts.json');
      expect({
        edu,
        written: readFileSync(join(dir, 'out/edu.html'), 'utf8'),
        commerce,
        usage: run('@zeta-pin.md', '--store', 'edu'),
        error: run('@zeta-pin.md', '--store', 'commerce', '--live', '@live.html'),
        unplaced: run('@zeta-pin.md', '--store', 'edu', '--live', '@unplaced.html', '--out', '@out/u.html'),
      }).toMatchSnapshot();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
