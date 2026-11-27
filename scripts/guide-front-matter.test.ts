/**
 * US-38 AC3a: a guide's front-matter title and description reach the Shopify
 * article and the page's JSON-LD as their YAML means them. publish-guides.mjs (the
 * title and summary it compares and would PUT) and build-guide-html.mjs (headline
 * and description) must agree.
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

// [front-matter value as written, the text YAML means]
const CASES: [string, string][] = [
  ['"The \\"local-first\\" guide"', 'The "local-first" guide'],
  ['"C:\\\\guides\\\\"', 'C:\\guides\\'],
  ['"a \\\\\\" b"', 'a \\" b'],
  ['"Plain title"', 'Plain title'],
  ['A \\"bare\\" title', 'A \\"bare\\" title'],
  ["'Single \\\"quoted\\\"'", "'Single \\\"quoted\\\"'"],
  ['"Half quoted', '"Half quoted'],
  ['Say "hi"', 'Say "hi"'],
  // Limits: a comment after a quoted value is not taken off, and no YAML escape but \" and \\ is undone.
  ['"Commented" # note', '"Commented" # note'],
  ['"Tab \\t and caf\\u00e9"', 'Tab \\t and caf\\u00e9'],
];
// The description is the same value, so both fields are read through the same rule.
const guide = (value: string, slug: string) => `---\ntitle: ${value}\ndescription: ${value}\nslug: "${slug}"\n---\n\n# Synthetic\n\nBody text.\n`;

let dir = '';
const published = new Map<string, { title: string; summary: string }>();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'guide-front-'));
  symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
  symlinkSync(join(ROOT, 'tools'), join(dir, 'tools'));
  mkdirSync(join(dir, 'docs', 'guides'), { recursive: true });
  CASES.forEach(([title], i) => writeFileSync(join(dir, 'docs', 'guides', `case-${i}.md`), guide(title, `case-${i}`)));
  // Every article exists with an old title and summary, so the dry run prints what it would write.
  const stub = join(dir, 'fetch-stub.mjs');
  writeFileSync(stub, `globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'fake-shop.example') throw new Error('blocked: ' + url);
  const body = u.pathname.endsWith('/blogs.json') ? { blogs: [{ id: 1, handle: 'guides' }] }
    : { articles: [{ id: 9, title: 'old', summary_html: '<p>old</p>', body_html: '<p>old</p>' }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};\n`);
  const run = spawnSync(process.execPath, ['--preserve-symlinks-main', '--import', pathToFileURL(stub).href, join(dir, 'scripts', 'publish-guides.mjs')], {
    cwd: dir, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env.PATH ?? '', SHOPIFY_EDU_SHOP: 'fake-shop.example', SHOPIFY_EDU_ACCESS_TOKEN: 'test-token-good' },
  });
  expect(run.status, run.stderr).toBe(0);
  for (const m of run.stdout.matchAll(/^(case-\d+)\.md -> [\s\S]*?^ {2}title rendered: (.*)$[\s\S]*?^ {2}summary rendered: (.*)$/gm)) {
    published.set(m[1], { title: JSON.parse(m[2]), summary: JSON.parse(m[3]) });
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const jsonLd = (i: number) => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-guide-html.mjs'), join(dir, 'docs', 'guides', `case-${i}.md`)], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(run.stdout)![1]);
};

describe('US-38 AC3a: a front-matter title and description as YAML means them', () => {
  it.each(CASES.map(([written, meant], i) => [i, written, meant] as const))('case %i: %s is published and in the JSON-LD as its text', (i, _written, meant) => {
    // Soft, so a failure names each reader that got it wrong.
    expect.soft(published.get(`case-${i}`), 'publish-guides dry run').toEqual({ title: meant, summary: `<p>${escapeHtml(meant)}</p>` });
    expect.soft(jsonLd(i), 'build-guide-html JSON-LD').toMatchObject({ headline: meant, description: meant });
  });
});
