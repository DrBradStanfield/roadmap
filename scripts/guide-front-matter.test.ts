// US-38 AC3a: publish-guides.mjs (the title, summary and article it would PUT) and build-guide-html.mjs (the page)
// read a guide's front matter through one reader and must agree. publish-guides runs as a dry run only, from a
// scratch folder holding only the synthetic guides below; fetch is replaced before it loads, one fake shop host
// answers, any other URL throws, and no --publish is ever passed.
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
];

const dirs: string[] = [];
const stub = () => join(dirs[0], 'fetch-stub.mjs');
// A scratch repo whose scripts/ and tools/ link to the real ones, holding only these guides.
const scratch = (guides: [string, string][]) => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-front-'));
  dirs.push(dir);
  symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
  symlinkSync(join(ROOT, 'tools'), join(dir, 'tools'));
  mkdirSync(join(dir, 'docs', 'guides'), { recursive: true });
  for (const [name, md] of guides) writeFileSync(join(dir, 'docs', 'guides', name), md);
  return dir;
};
// Its dry-run report. Every article exists with an old title and summary, so the dry run prints what it would write.
// It carries the handle asked for, but moved-guide's is other-guide and bare-guide's has none. Requests go to stderr.
const dryRun = (guides: [string, string][]) => {
  const dir = scratch(guides);
  if (dirs.length === 1) writeFileSync(stub(), `globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.hostname !== 'fake-shop.example') throw new Error('blocked: ' + url);
  process.stderr.write('fetch ' + (init?.method ?? 'GET') + ' ' + u.pathname + u.search + '\\n');
  const h = u.searchParams.get('handle');
  const body = u.pathname.endsWith('/blogs.json') ? { blogs: [{ id: 1, handle: 'guides' }] }
    : { articles: [{ id: 9, ...(h !== 'bare-guide' && { handle: h === 'moved-guide' ? 'other-guide' : h }), title: 'old', summary_html: '<p>old</p>', body_html: '<p>old</p>' }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};\n`);
  const env = { PATH: process.env.PATH ?? '', SHOPIFY_EDU_SHOP: 'fake-shop.example', SHOPIFY_EDU_ACCESS_TOKEN: 'test-token-good' };
  return { dir, run: spawnSync(process.execPath, ['--preserve-symlinks-main', '--import', pathToFileURL(stub()).href, join(dir, 'scripts', 'publish-guides.mjs')], { cwd: dir, encoding: 'utf8', timeout: 120_000, env }) };
};
const build = (mdPath: string, script = join(ROOT, 'scripts', 'build-guide-html.mjs')) => spawnSync(process.execPath, ['--preserve-symlinks-main', script, mdPath], { encoding: 'utf8' });

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
  const run = build(mdPath);
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

  it('a block line with no colon is left out, so "titles" and "slugs" leave the title and slug as written', () => {
    const { dir, run } = dryRun([['case.md', '---\ntitle: "Colon test"\nslug: "real-guide"\ntitles\nslugs\n---\n\nBody text.\n']]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.split('\n').slice(0, 5)).toEqual(['blog "guides" id 1', '', 'case.md -> /blogs/guides/real-guide', expect.stringMatching(/^ {2}article id 9, /), '  title live:     "old"']);
    expect(run.stdout).toContain('\n  title rendered: "Colon test"\n');
    expect(build(join(dir, 'docs', 'guides', 'case.md')).stderr).toBe('title: Colon test\nslug:  real-guide\n');
    expect(jsonLd(join(dir, 'docs', 'guides', 'case.md')).mainEntityOfPage).toBe('https://drstanfield.com/blogs/guides/real-guide');
  });
});

// The run stops at case.md with this error, having printed only the blog line and made only these requests.
const BLOG = 'fetch GET /admin/api/2025-07/blogs.json';
const LOOKUP = 'fetch GET /admin/api/2025-07/blogs/1/articles.json?handle=';
const stops = (run: ReturnType<typeof spawnSync>, error: string, made = [BLOG]) => expect({
  status: run.status, error: /^Error: (.*)$/m.exec(String(run.stderr))?.[1], stdout: run.stdout, requests: String(run.stderr).split('\n').filter((l) => l.startsWith('fetch ')),
}).toEqual({ status: 1, error: `case.md: ${error}`, stdout: 'blog "guides" id 1\n', requests: made });

// Brad's example: metadata in the body, before a --- rule. None of it may become the guide's.
const EXAMPLE = '\nAn example:\n\ntitle: "Body title"\nslug: "other-guide"\n\n---\n\nMore text.\n';
const REAL = '---\ntitle: "Real"\nslug: "real-guide"\n';

describe('US-38 AC3a: the fence lines around the block', () => {
  // Refused by both with their existing messages: the dry run looks up no article, the builder prints nothing.
  it.each([
    ['an empty block (two --- lines)', '---\n---\n' + EXAMPLE],
    ...['--- ', '---\t', '---\r', '----'].map((fence) => [`an empty block closed by ${JSON.stringify(fence)}`, `---\n${fence}\n` + EXAMPLE]),
    ['an empty block in a CRLF file', ('---\n---\n' + EXAMPLE).replace(/\n/g, '\r\n')],
    ['a block in a CRLF file', (REAL + '---\n' + EXAMPLE).replace(/\n/g, '\r\n')],
    ['a block after a byte-order mark', '\uFEFF' + REAL + '---\n' + EXAMPLE],
    ...['----', '---\r'].map((fence) => [`a block closed by ${JSON.stringify(fence)}`, `${REAL}${fence}\n` + EXAMPLE]),
    ['a block opened by "----"', '-' + REAL + '---\n' + EXAMPLE],
    ['a block with no closing fence', REAL + EXAMPLE],
    ['a block closed at the end of the file, with no newline', REAL + '---'],
    ['a block that gives a key twice', '---\ntitle: "First"\ntitle: "Last"\nslug: "s"\n---\n\nBody text.\n'],
  ])('%s is no front matter: the dry run and the builder refuse it', (_shows, md) => {
    const { dir, run } = dryRun([['case.md', md]]);
    stops(run, 'no slug or title in front matter');
    const mdPath = join(dir, 'docs', 'guides', 'case.md');
    const b = build(mdPath);
    expect({ status: b.status, stdout: b.stdout, stderr: b.stderr }).toEqual({ status: 1, stdout: '', stderr: `${mdPath}: no front matter. A guide starts with a --- block carrying at least title: and slug:.\n` });
  });

  // A fence with trailing spaces or a tab opens or closes the block, and YAML's ... closes it: the slug is the
  // block's, and the page is the one the same guide with plain --- fences builds.
  it.each([['---', '--- '], ['---', '---\t'], ['---', '...'], ['---', '...  '], ['--- ', '---']])('a block opened by %j and closed by %j gives the block\'s slug and title, never the body\'s', (open, fence) => {
    const { dir, run } = dryRun([['case.md', REAL.replace('---', open) + fence + '\n' + EXAMPLE]]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr.split('\n').filter((l) => l.startsWith('fetch '))).toEqual([BLOG, `${LOOKUP}real-guide`]);
    expect(run.stdout.split('\n').slice(0, 7)).toEqual(['blog "guides" id 1', '', 'case.md -> /blogs/guides/real-guide', expect.stringMatching(/^ {2}article id 9, /), '  title live:     "old"', '  title rendered: "Real"', expect.stringMatching(/^ {2}first body difference/)]);
    const b = build(join(dir, 'docs', 'guides', 'case.md'));
    const plain = build(join(scratch([['case.md', REAL + '---\n' + EXAMPLE]]), 'docs', 'guides', 'case.md'));
    expect({ status: b.status, stderr: b.stderr, stdout: b.stdout }).toEqual({ status: 0, stderr: 'title: Real\nslug:  real-guide\n', stdout: plain.stdout });
  });
});

describe('US-38 AC3a: the slug', () => {
  // The slug picks the article publish-guides.mjs overwrites. It looks the article up by that handle; a slug that is
  // not a handle's shape is refused before the lookup, and an article that does not carry the handle after it.
  const shape = (slug: string) => `slug ${JSON.stringify(slug)} is not lowercase letters, digits and hyphens`;
  it.each([
    ['a\\"b', shape('a"b'), []],
    ['Other-guide', shape('Other-guide'), []],
    ['../connect-claude', shape('../connect-claude'), []],
    ['moved-guide', 'the article Shopify returned for slug "moved-guide" (id 9) has handle "other-guide"', [`${LOOKUP}moved-guide`]],
    ['bare-guide', 'the article Shopify returned for slug "bare-guide" (id 9) has handle undefined', [`${LOOKUP}bare-guide`]],
  ])('publish-guides stops at the slug %s: %s', (written, error, lookups) => {
    stops(dryRun([['case.md', `---\ntitle: "T"\nslug: "${written}"\n---\n\nBody text.\n`]]).run, error, [BLOG, ...lookups]);
  });

  // With REPO_PUBLIC false the builder links the published guide by its slug. A scratch repo holds a plan.ts that says so.
  it.each([['real-guide', 'real-guide'], ['a\\"b<c&d\'e', 'a&quot;b&lt;c&amp;d&#39;e']])('with REPO_PUBLIC false, the builder\'s link for the slug %s is escaped as %s', (written, inHtml) => {
    const dir = scratch([['case.md', `---\ntitle: "T"\nslug: "${written}"\n---\n\nBody text.\n`]]);
    symlinkSync(join(ROOT, 'docs', 'guides', 'assets'), join(dir, 'docs', 'guides', 'assets'));
    mkdirSync(join(dir, 'packages', 'health-core', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'health-core', 'src', 'plan.ts'), 'export const REPO_PUBLIC = false;\n');
    const b = build(join(dir, 'docs', 'guides', 'case.md'), join(dir, 'scripts', 'build-guide-html.mjs'));
    expect(b.status, b.stderr).toBe(0);
    expect(/<p class="rmg-md">.*<\/p>/.exec(b.stdout)?.[0]).toBe(
      `<p class="rmg-md">This page is built from docs/guides/case.md, which is not public while the project’s GitHub is not. The published guide is <a href="https://drstanfield.com/blogs/guides/${inHtml}">drstanfield.com/blogs/guides/${inHtml}</a>.</p>`,
    );
  });
});
