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

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'build-guide-html.mjs');
const GUIDES = join(here, '..', 'docs', 'guides');

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

  it('refuses a file with no front matter, by name rather than by TypeError', () => {
    const { ok, stderr } = build('No front matter here.\n');
    expect(ok).toBe(false);
    expect(stderr).toMatch(/front matter/i);
    expect(stderr).not.toContain('TypeError');
  });
});

describe('build-guide-html.mjs — the guides actually shipped', () => {
  it('builds every guide in docs/guides, prompt box and all', () => {
    const guides = readdirSync(GUIDES).filter((n) => n.endsWith('.md') && n !== 'README.md');
    expect(guides.length).toBeGreaterThan(0);
    for (const guide of guides) {
      const path = join(GUIDES, guide);
      const run = spawnSync('node', [SCRIPT, path], { encoding: 'utf8' });
      expect(run.status, `${guide}: ${run.stderr}`).toBe(0);
      expect(run.stdout, guide).toContain('<div class="rmguide">');
      expect(run.stdout, guide).not.toContain('@@');
      // The prompt box exists to carry the prompt: only a guide that has one.
      const carriesPrompt = readFileSync(path, 'utf8').includes('```bootstrap-prompt');
      expect(run.stdout.includes('<div class="rmg-promptbox">'), guide).toBe(carriesPrompt);
    }
  });
});
