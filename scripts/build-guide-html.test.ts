/**
 * US-32 — the guide publishing pipeline.
 *
 * `build-guide-html.mjs` is the only thing between a guide master and what a
 * reader sees on the site, and nothing ran it but a human eye. These pin the
 * markdown it claims to render (a fenced block, a blockquote, a code span) and
 * the two ways a new guide can break it (no prompt fence, no front matter).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOL_NAMES } from '../packages/health-core/src/product-events';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'build-guide-html.mjs');
const GUIDES = join(here, '..', 'docs', 'guides');

const RAW = 'https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/docs/guides/';

/** Every guide the repo publishes. Each is built once, in the beforeAll below. */
const SHIPPED = readdirSync(GUIDES).filter((n) => n.endsWith('.md') && n !== 'README.md');
const built = new Map<string, string>();

/** Run the builder over a scratch guide. The scratch directory never survives. */
function build(markdown: string): { html: string; stderr: string; ok: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'guide-'));
  try {
    const path = join(dir, 'scratch.md');
    writeFileSync(path, markdown);
    const run = spawnSync('node', [SCRIPT, path], { encoding: 'utf8' });
    return { html: run.stdout, stderr: run.stderr, ok: run.status === 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FRONT_MATTER = '---\ntitle: "Scratch guide"\nslug: scratch\n---\n\n';

describe('build-guide-html.mjs — markdown it must render', () => {
  let html = '';
  beforeAll(() => {
    html = build(`${FRONT_MATTER}A paragraph with \`--out "plan.html"\` in it and a [link](https://example.com/a?b=1).

She said "keep it local" and meant it.

\`\`\`sh
npm run build & test "x"
\`\`\`

> Your record never leaves your machine.

Run this, no blank line first:
\`\`\`sh
npx tsx tools/get-plan.ts record.json
\`\`\`

\`\`\`bootstrap-prompt
Read my health record.
\`\`\`
`).html;
  });

  it('renders a generic fenced block as code, not a paragraph of backticks', () => {
    expect(html).toContain('<pre><code>npm run build &amp; test "x"</code></pre>');
    expect(html).not.toContain('```sh');
  });

  it('renders a fence that follows prose with no blank line, leaving no token behind', () => {
    expect(html).toContain('<pre><code>npx tsx tools/get-plan.ts record.json</code></pre>');
    expect(html).not.toContain('@@');
  });

  it('renders a blockquote, not a literal &gt;', () => {
    expect(html).toContain('<blockquote><p>Your record never leaves your machine.</p></blockquote>');
    expect(html).not.toContain('&gt; Your record');
  });

  it('leaves quotes inside an inline code span straight', () => {
    expect(html).toContain('<code>--out "plan.html"</code>');
    expect(html).not.toContain('“plan.html”');
  });

  it('still curls prose quotes and never curls an href', () => {
    expect(html).toContain('She said “keep it local” and meant it.');
    expect(html).toContain('href="https://example.com/a?b=1"');
  });
});

describe('build-guide-html.mjs — a guide that is missing something', () => {
  it('builds a guide with no bootstrap-prompt fence, dropping the prompt box and its script', () => {
    const { html } = build(`${FRONT_MATTER}Just prose, no prompt.\n`);
    expect(html).toContain('Just prose, no prompt.');
    expect(html).not.toContain('<div class="rmg-promptbox">');
    expect(html).not.toContain('<script>');
  });

  it('leaves prose that merely looks like a placeholder exactly as written', () => {
    // The builder parks generated HTML behind @@-tokens. A guide explaining
    // that is prose, and prose is never a token — even when the build is
    // holding a fragment under the very index the prose names.
    const { html } = build(
      `${FRONT_MATTER}The old builder emitted @@FENCE0@@ and @@T0@@ into the page.\n\n\`\`\`sh\nnpm test\n\`\`\`\n`,
    );
    expect(html).toContain('The old builder emitted @@FENCE0@@ and @@T0@@ into the page.');
    expect(html).toContain('<pre><code>npm test</code></pre>');
  });

  it('holds a fence that starts a line, never one quoted mid-line', () => {
    // An unanchored fence regex takes the backticks inside a blockquote for an
    // opener and swallows everything up to the next real fence.
    const { html } = build(
      `${FRONT_MATTER}> Run \`\`\`npm test\`\`\` before you push.\n\n\`\`\`sh\nnpm run build\n\`\`\`\n`,
    );
    expect(html).toContain('<pre><code>npm run build</code></pre>');
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('@@');
  });

  it('renders a named diagram from docs/guides/assets, and two of them on one page', () => {
    const { html } = build(`${FRONT_MATTER}Before.\n\n[diagram:local-first]\n\nBetween.\n\n[diagram:correction]\n\nAfter.\n`);
    expect(html.match(/<figure class="rmg-fig">/g)).toHaveLength(2);
    expect(html).toContain('id="rmg-lf-t"');
    expect(html).toContain('id="rmg-cr-t"');
    expect(html).not.toContain('[diagram:');
  });

  it('refuses an unknown diagram, naming the file it looked for', () => {
    const { ok, stderr } = build(`${FRONT_MATTER}[diagram:nope]\n`);
    expect(ok).toBe(false);
    expect(stderr).toContain('assets/nope.svg');
  });

  it('refuses a file with no front matter, by name rather than by TypeError', () => {
    const { ok, stderr } = build('No front matter here.\n');
    expect(ok).toBe(false);
    expect(stderr).toMatch(/front matter/i);
    expect(stderr).not.toContain('TypeError');
  });
});

describe('build-guide-html.mjs — the connector buttons and copy boxes', () => {
  // The buttons went live on 2026-09-02: they stopped being greyed "coming
  // soon" spans and became links to the step lists further down the page.
  const CONNECT = `${FRONT_MATTER}[connect:chatgpt]\n[connect:claude]

The address both assistants ask for:

\`\`\`copy-box
https://mcp.drstanfield.com/mcp
\`\`\`

## Connect Claude on the web

Steps.

## Connect ChatGPT on the web

Steps.
`;

  it('renders a live provider as a real link, not a disabled span', () => {
    const { html } = build(CONNECT);
    expect(html).toContain('<div class="rmg-btnrow">');
    // The greyed span is what "coming soon" looked like. Only the stylesheet
    // still names that class.
    expect(html).not.toContain('<span class="rmg-btn rmg-btn-soon"');
    expect(html).not.toContain('Coming soon');
    expect(html).toContain('<a class="rmg-btn" href="#connect-claude-on-the-web">');
    expect(html).toContain('<a class="rmg-btn" href="#connect-chatgpt-on-the-web">');
  });

  it('keeps an in-page button in the tab, so target=_blank is only for links off the site', () => {
    const { html } = build(CONNECT);
    expect(html).not.toContain('href="#connect-claude-on-the-web" target="_blank"');
  });

  it('renders the connector buttons in a guide with no bootstrap-prompt fence', () => {
    // The buttons used to be gated on the prompt fence, because they carried
    // the prompt in their href. They carry a link now, so the gate is gone.
    const { html, stderr } = build(CONNECT);
    expect(stderr).not.toMatch(/bootstrap-prompt/);
    expect(html).not.toContain('[connect:');
  });

  it('gives a copy-box fence its own copy button and its own text', () => {
    const { html } = build(`${FRONT_MATTER}One:

\`\`\`copy-box
https://mcp.drstanfield.com/mcp
\`\`\`

Two:

\`\`\`bootstrap-prompt
Read my health record.
\`\`\`
`);
    // Two boxes, two buttons, each holding its own text — the script copies a
    // button's own <pre>, so a second box cannot serve the first one's text.
    expect(html.match(/<div class="rmg-promptbox">/g)).toHaveLength(2);
    expect(html.match(/<button class="rmg-copy" type="button">Copy<\/button>/g)).toHaveLength(2);
    expect(html).toContain('<pre>https://mcp.drstanfield.com/mcp</pre>');
    expect(html).toContain('<pre>Read my health record.</pre>');
    // Nothing is baked into the script any more.
    expect(html).not.toContain('RMG_PROMPT');
  });
});

describe('build-guide-html.mjs — the link to the markdown master', () => {
  it('names the guide\'s own file, inside the wrapper and before the script', () => {
    const { html } = build(`${FRONT_MATTER}Prose.\n\n\`\`\`bootstrap-prompt\nRead my health record.\n\`\`\`\n`);
    // The scratch guide is scratch.md, so the link must say scratch.md.
    expect(html).toContain(
      `<p class="rmg-md">This guide is also published as plain Markdown for AI agents: <a href="${RAW}scratch.md">docs/guides/scratch.md</a>. The Markdown is the master; this page is built from it.</p>`,
    );
    // Inside the .rmguide wrapper (its close is the last </div>), before the script.
    expect(html.indexOf('rmg-md')).toBeLessThan(html.lastIndexOf('</div>'));
    expect(html.lastIndexOf('</div>')).toBeLessThan(html.indexOf('<script>'));
  });
});

describe('build-guide-html.mjs — the guides actually shipped', () => {
  beforeAll(() => {
    expect(SHIPPED.length).toBeGreaterThan(0);
    for (const guide of SHIPPED) {
      const run = spawnSync('node', [SCRIPT, join(GUIDES, guide)], { encoding: 'utf8' });
      expect(run.status, `${guide}: ${run.stderr}`).toBe(0);
      built.set(guide, run.stdout);
    }
  });

  it('builds every guide in docs/guides, prompt box and all', () => {
    for (const [guide, html] of built) {
      expect(html, guide).toContain('<div class="rmguide">');
      expect(html, guide).not.toContain('@@');
      expect(html, guide).not.toContain('[diagram:');
      // A copy box exists to carry a block: only a guide that has one.
      const source = readFileSync(join(GUIDES, guide), 'utf8');
      const carriesBox = source.includes('```bootstrap-prompt') || source.includes('```copy-box');
      expect(html.includes('<div class="rmg-promptbox">'), guide).toBe(carriesBox);
      // Every published guide points an agent at its own markdown master.
      expect(html, guide).toContain(`<a href="${RAW}${guide}">docs/guides/${guide}</a>`);
      // A button pointing at a step list on the same page is only honest if
      // that heading is really there: renaming the heading must fail here, not
      // leave a reader clicking a button that scrolls nowhere.
      for (const [, id] of html.matchAll(/<a class="rmg-btn" href="#([^"]+)"/g)) {
        expect(html, `${guide}: no heading with id ${id}`).toContain(`<h2 id="${id}">`);
      }
    }
  });

  it('places all four diagrams on the hub guide', () => {
    expect(built.get('getting-started.md')?.match(/<figure class="rmg-fig">/g) ?? []).toHaveLength(4);
  });

  it('gives every id on the page a single owner', () => {
    // Four SVGs on one page each carry a marker, a title and a desc. Unprefixed
    // ids collide silently: the arrowheads and the accessible name of every
    // figure would resolve to whichever copy came first.
    for (const [guide, html] of built) {
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i), `${guide}: duplicate id`).toEqual([]);
    }
  });

  it('resolves every in-page anchor to an id on the same page', () => {
    for (const [guide, html] of built) {
      const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id));
      for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
        expect(ids.has(target), `${guide}: href="#${target}" points at nothing`).toBe(true);
      }
    }
  });

  it('never links a reader at a .md file except the markdown master on raw.githubusercontent.com', () => {
    // A guide links guides, and a guide is published as HTML. A .md href sends
    // the reader to a file the browser offers to download.
    for (const [guide, html] of built) {
      for (const [, href] of html.matchAll(/href="([^"]+\.md)"/g)) {
        expect(href.startsWith('https://raw.githubusercontent.com/'), `${guide}: ${href}`).toBe(true);
      }
    }
  });
});

describe('tools.svg — the nine tools, and only the nine', () => {
  it('names every MCP tool and invents none', () => {
    const svg = readFileSync(join(GUIDES, 'assets', 'tools.svg'), 'utf8');
    const named = [...svg.matchAll(/<text class="rmg-f"[^>]*>([^<]+)<\/text>/g)].map(([, t]) => t);
    expect([...new Set(named)].sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });
});
