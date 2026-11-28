/**
 * US-38 AC3a: a guide's front-matter title and description reach the Shopify
 * article and the page's JSON-LD the same way. publish-guides.mjs (the title and
 * summary it compares and would PUT) and build-guide-html.mjs (headline and
 * description) read them through one reader and must agree.
 *
 * publish-guides runs as a dry run only, from a scratch folder whose scripts/ and
 * tools/ link to the real ones, so its docs/guides/ holds only the synthetic
 * guides below. fetch is replaced before it loads: one fake shop host answers,
 * any other URL throws, and no --publish is ever passed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeHtml } from '../tools/escape-html.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// [front-matter value as written, the text both readers give]
const CASES: [string, string][] = [
  ['"The \\"local-first\\" guide"', 'The "local-first" guide'],
  ['"C:\\\\guides\\\\"', 'C:\\guides\\'],
  ['"a \\\\\\" b"', 'a \\" b'],
  ['"Plain title"', 'Plain title'],
  ['A \\"bare\\" title', 'A \\"bare\\" title'],
  ["'Single \\\"quoted\\\"'", "'Single \\\"quoted\\\"'"],
  ['"Half quoted', '"Half quoted'],
  ['Say "hi"', 'Say "hi"'],
  // Limits: a comment after a value stays part of it, and no YAML escape but \" and \\ is undone.
  ['"Commented" # note', '"Commented" # note'],
  ['"Tab \\t and caf\\u00e9"', 'Tab \\t and caf\\u00e9'],
  // Unquoted only when the first unescaped quote after the opening one ends the value.
  ['"Commented" # say "hi"', '"Commented" # say "hi"'],
  ['"Ends in \\"', '"Ends in \\"'],
];
// The description is the same value, so both fields are read through the same rule.
const guide = (value: string, slug: string) => `---\ntitle: ${value}\ndescription: ${value}\nslug: "${slug}"\n---\n\n# Synthetic\n\nBody text.\n`;

// [what the guide shows, its whole front matter and body, the title and description both readers give]
const BLOCKS: [string, string, string, string | undefined][] = [
  ['indented keys', '---\n  title: "Indented title"\n\tdescription: "Indented description"\nslug: "s"\n---\n\nBody text.\n', 'Indented title', 'Indented description'],
  ['a body line that looks like metadata', '---\ntitle: "Body test"\nslug: "s"\n---\n\nBody text.\n\n---\ndescription: Not front matter\n---\n\nMore text.\n', 'Body test', undefined],
  ['a key given twice', '---\ntitle: "First"\ntitle: "Last"\nslug: "s"\n---\n\nBody text.\n', 'Last', undefined],
];

const dirs: string[] = [];
const stub = () => join(dirs[0], 'fetch-stub.mjs');
// A scratch repo holding only these guides, and its dry-run report.
const dryRun = (guides: [string, string][]) => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-front-'));
  dirs.push(dir);
  symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
  symlinkSync(join(ROOT, 'tools'), join(dir, 'tools'));
  mkdirSync(join(dir, 'docs', 'guides'), { recursive: true });
  for (const [name, md] of guides) writeFileSync(join(dir, 'docs', 'guides', name), md);
  // Every article exists with an old title and summary, so the dry run prints what it would write.
  // Each request is logged to stderr, so a test can show which ones were made.
  if (dirs.length === 1) writeFileSync(stub(), `globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname !== 'fake-shop.example') throw new Error('blocked: ' + url);
  process.stderr.write('fetch ' + (init?.method ?? 'GET') + ' ' + u.pathname + u.search + '\\n');
  const body = u.pathname.endsWith('/blogs.json') ? { blogs: [{ id: 1, handle: 'guides' }] }
    : { articles: [{ id: 9, title: 'old', summary_html: '<p>old</p>', body_html: '<p>old</p>' }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};\n`);
  const run = spawnSync(process.execPath, ['--preserve-symlinks-main', '--import', pathToFileURL(stub()).href, join(dir, 'scripts', 'publish-guides.mjs')], {
    cwd: dir, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env.PATH ?? '', SHOPIFY_EDU_SHOP: 'fake-shop.example', SHOPIFY_EDU_ACCESS_TOKEN: 'test-token-good' },
  });
  return { dir, run };
};

const published = new Map<string, { title: string; summary: string }>();
let casesDir = '';

beforeAll(() => {
  const { dir, run } = dryRun(CASES.map(([value], i) => [`case-${i}.md`, guide(value, `case-${i}`)]));
  casesDir = dir;
  expect(run.status, run.stderr).toBe(0);
  for (const m of run.stdout.matchAll(/^(case-\d+)\.md -> [\s\S]*?^ {2}title rendered: (.*)$[\s\S]*?^ {2}summary rendered: (.*)$/gm)) {
    published.set(m[1], { title: JSON.parse(m[2]), summary: JSON.parse(m[3]) });
  }
});
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const jsonLd = (mdPath: string) => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-guide-html.mjs'), mdPath], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(run.stdout)![1]);
};

describe('US-38 AC3a: the text both readers give for a front-matter value', () => {
  it.each(CASES.map(([written, given], i) => [i, written, given] as const))('case %i: for %s, the text both readers give is %s', (i, _written, given) => {
    // Soft, so a failure names each reader that got it wrong.
    expect.soft(published.get(`case-${i}`), 'publish-guides dry run').toEqual({ title: given, summary: `<p>${escapeHtml(given)}</p>` });
    expect.soft(jsonLd(join(casesDir, 'docs', 'guides', `case-${i}.md`)), 'build-guide-html JSON-LD').toMatchObject({ headline: given, description: given });
  });
});

describe('US-38 AC3a: one front-matter block, read by both the same way', () => {
  it.each(BLOCKS)('%s: both readers give the same title and description', (_shows, md, title, description) => {
    const { dir, run } = dryRun([['case.md', md]]);
    expect(run.status, run.stderr).toBe(0);
    const line = (field: string) => new RegExp(`^ {2}${field} rendered: (.*)$`, 'm').exec(run.stdout)?.[1];
    expect.soft(line('title'), 'publish-guides title').toBe(JSON.stringify(title));
    expect.soft(line('summary'), 'publish-guides summary').toBe(description && JSON.stringify(`<p>${escapeHtml(description)}</p>`));
    const ld = jsonLd(join(dir, 'docs', 'guides', 'case.md'));
    expect.soft(ld.headline, 'build-guide-html headline').toBe(title);
    expect.soft(ld.description, 'build-guide-html description').toBe(description);
  });
});

// The message an uncaught throw in publish-guides.mjs prints, and the requests the stub logged.
const thrown = (stderr: string) => /^Error: (.*)$/m.exec(stderr)?.[1];
const requests = (stderr: string) => stderr.split('\n').filter((l) => l.startsWith('fetch '));
const build = (mdPath: string, flags: string[] = []) => spawnSync(process.execPath, [...flags, mdPath], { encoding: 'utf8' });
const NO_FRONT_MATTER = 'no front matter. A guide starts with a --- block carrying at least title: and slug:.';

describe('US-38 AC3a: what the reader leaves out of a guide\'s metadata', () => {
  it('an empty block (two --- lines) is no front matter, so an example in the body before a --- rule gives no title or slug', () => {
    const md = '---\n---\n\nAn example:\n\ntitle: "Body title"\nslug: "other-guide"\n\n---\n\nMore text.\n';
    const { dir, run } = dryRun([['case.md', md]]);
    expect({ status: run.status, error: thrown(run.stderr), stdout: run.stdout }).toEqual({ status: 1, error: 'case.md: no slug or title in front matter', stdout: 'blog "guides" id 1\n' });
    const mdPath = join(dir, 'docs', 'guides', 'case.md');
    const b = build(mdPath, [join(ROOT, 'scripts', 'build-guide-html.mjs')]);
    expect({ status: b.status, stdout: b.stdout, stderr: b.stderr }).toEqual({ status: 1, stdout: '', stderr: `${mdPath}: ${NO_FRONT_MATTER}\n` });
  });

  it('a block line with no colon is left out, so "titles" and "slugs" leave the title and slug as written', () => {
    const md = '---\ntitle: "Colon test"\nslug: "real-guide"\ntitles\nslugs\n---\n\nBody text.\n';
    const { dir, run } = dryRun([['case.md', md]]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.split('\n').slice(0, 5)).toEqual(['blog "guides" id 1', '', 'case.md -> /blogs/guides/real-guide', expect.stringMatching(/^ {2}article id 9, /), '  title live:     "old"']);
    expect(run.stdout).toContain('\n  title rendered: "Colon test"\n');
    const b = build(join(dir, 'docs', 'guides', 'case.md'), [join(ROOT, 'scripts', 'build-guide-html.mjs')]);
    expect(b.stderr).toBe('title: Colon test\nslug:  real-guide\n');
    expect(JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(b.stdout)![1]).mainEntityOfPage).toBe('https://drstanfield.com/blogs/guides/real-guide');
  });
});

describe('US-38 AC3a: the slug', () => {
  // publish-guides.mjs looks the article up by its handle and overwrites the one it gets back.
  it.each([['a\\"b', 'a"b'], ['Other-guide', 'Other-guide'], ['../connect-claude', '../connect-claude']])(
    'publish-guides refuses the slug %s before any article is looked up', (written, slug) => {
      const { run } = dryRun([['case.md', `---\ntitle: "T"\nslug: "${written}"\n---\n\nBody text.\n`]]);
      expect({ status: run.status, error: thrown(run.stderr), stdout: run.stdout, requests: requests(run.stderr) }).toEqual({
        status: 1, error: `case.md: slug ${JSON.stringify(slug)} is not lowercase letters, digits and hyphens`,
        stdout: 'blog "guides" id 1\n', requests: ['fetch GET /admin/api/2025-07/blogs.json'],
      });
    });

  // With REPO_PUBLIC false the builder links the published guide by its slug. A scratch repo holds a plan.ts that says so.
  it.each([
    ['real-guide', 'real-guide'],
    ['a\\"b<c&d\'e', 'a&quot;b&lt;c&amp;d&#39;e'],
  ])('with REPO_PUBLIC false, the builder\'s link for the slug %s is escaped as %s', (written, inHtml) => {
    const dir = mkdtempSync(join(tmpdir(), 'guide-front-'));
    dirs.push(dir);
    symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
    symlinkSync(join(ROOT, 'tools'), join(dir, 'tools'));
    mkdirSync(join(dir, 'docs', 'guides'), { recursive: true });
    symlinkSync(join(ROOT, 'docs', 'guides', 'assets'), join(dir, 'docs', 'guides', 'assets'));
    mkdirSync(join(dir, 'packages', 'health-core', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'health-core', 'src', 'plan.ts'), 'export const REPO_PUBLIC = false;\n');
    const mdPath = join(dir, 'docs', 'guides', 'case.md');
    writeFileSync(mdPath, `---\ntitle: "T"\nslug: "${written}"\n---\n\nBody text.\n`);
    const b = build(mdPath, ['--preserve-symlinks-main', join(dir, 'scripts', 'build-guide-html.mjs')]);
    expect(b.status, b.stderr).toBe(0);
    expect(/<p class="rmg-md">.*<\/p>/.exec(b.stdout)?.[0]).toBe(
      `<p class="rmg-md">This page is built from docs/guides/case.md, which is not public while the project’s GitHub is not. The published guide is <a href="https://drstanfield.com/blogs/guides/${inHtml}">drstanfield.com/blogs/guides/${inHtml}</a>.</p>`,
    );
  });
});
