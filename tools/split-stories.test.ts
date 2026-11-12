/**
 * US-64 AC33: tools/split-stories.mjs is the exact inverse of tools/stories.mjs (the stories-split plan, PR 2).
 * The round trip runs on the real stories text; the refusals on small fixtures.
 * The standing checks run on whichever layout the repo holds: the split tree itself once docs/stories/ exists,
 * or, while docs/user-stories.md is still the monolith, a split of it made in a temporary folder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStories } from './stories.mjs';
import { planSplit, splitStories, SplitRefusal, verifyPlan } from './split-stories.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools/split-stories.mjs');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const HTML = join(ROOT, 'scripts/build-user-stories-html.ts');
// The index today is 8.6 KB for 73 stories (about 115 bytes a line). 16 KB leaves room for some 65 more stories
// before anyone has to look again, and an index that swallowed even one story body (several KB each) shows at once.
const INDEX_CAP = 16 * 1024;
// Relative links the stories already hold whose target is not in the repo; fixing one means deleting it here.
const KNOWN_BROKEN = new Set(['../drafts/my-health-build-plan.md']);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const files = (root: string) => {
  const dir = join(root, 'docs/stories');
  const out: Record<string, string> = { index: readFileSync(join(root, 'docs/user-stories.md'), 'utf8') };
  for (const f of readdirSync(dir).sort()) out[f] = readFileSync(join(dir, f), 'utf8');
  return out;
};
const cli = (cwd: string, ...args: string[]) => spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The real stories text, whichever layout holds it, as a monolith in a folder of its own.
const SOURCE = loadStories();
let scratch: string;
let mono: string; // a folder holding SOURCE as docs/user-stories.md
let tree: string; // the split tree the standing checks read
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'split-stories-real-'));
  mono = join(scratch, 'mono');
  mkdirSync(join(mono, 'docs'), { recursive: true });
  writeFileSync(join(mono, 'docs/user-stories.md'), SOURCE);
  if (existsSync(join(ROOT, 'docs/stories'))) tree = ROOT;
  else {
    tree = join(scratch, 'split');
    splitStories({ root: mono, out: tree });
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the round trip on the real stories', () => {
  it('a split then loadStories gives the original byte for byte, every story kept', () => {
    const out = join(scratch, 'roundtrip');
    const r = splitStories({ root: mono, out });
    const back = loadStories(out);
    expect(back).toBe(SOURCE);
    expect(sha(back)).toBe(sha(SOURCE));
    const ids = [...SOURCE.matchAll(/^### (US-\d+) · /gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(73);
    expect(r.stories).toBe(ids.length);
    expect(readdirSync(join(out, 'docs/stories')).filter((f) => f.startsWith('US-')).sort()).toEqual(ids.map((id) => `${id}.md`).sort());
  });

  it('is idempotent: splitting loadStories of its output writes the same bytes, and a rerun on it changes nothing', () => {
    const a = join(scratch, 'idem-a');
    const b = join(scratch, 'idem-b');
    splitStories({ root: mono, out: a });
    const first = files(a);
    // loadStories of the output, split again into a fresh folder.
    mkdirSync(join(b, 'docs'), { recursive: true });
    writeFileSync(join(b, 'docs/user-stories.md'), loadStories(a));
    splitStories({ root: b, out: b });
    expect(files(b)).toEqual(first);
    // Run on its own output: it refuses and leaves every file as it was.
    const r = cli(a);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already split');
    expect(files(a)).toEqual(first);
  });

  it('--from reads the monolith at a git ref, whatever the working tree holds', () => {
    const repo = join(scratch, 'from-ref');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/user-stories.md'), SOURCE);
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'monolith');
    writeFileSync(join(repo, 'docs/user-stories.md'), 'changed after the commit\n');
    const out = join(scratch, 'from-ref-out');
    const r = cli(repo, '--from', 'HEAD', '--out', out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(loadStories(out)).toBe(SOURCE);
  });
});

describe('the standing checks on the split tree', () => {
  const parts = () => readdirSync(join(tree, 'docs/stories')).filter((f) => f.endsWith('.md'));
  const index = () => readFileSync(join(tree, 'docs/user-stories.md'), 'utf8');

  it('each story part holds one `### US-` heading, first, matching its file name', () => {
    for (const f of parts().filter((p) => p !== '_constitution.md')) {
      const text = readFileSync(join(tree, 'docs/stories', f), 'utf8');
      const heads = text.match(/^### US-\d+\b/gm) ?? [];
      expect(heads, f).toEqual([`### ${f.replace(/\.md$/, '')}`]);
      expect(text.startsWith(`### ${f.replace(/\.md$/, '')}`), f).toBe(true);
    }
    expect(readFileSync(join(tree, 'docs/stories/_constitution.md'), 'utf8')).not.toMatch(/^### US-/m);
  });

  it('the story ids are unique, and the index and the folder list the same set', () => {
    const listed = [...index().matchAll(/^- \[(US-\d+) · .*\]\(stories\/\1\.md\)$/gm)].map((m) => `${m[1]}.md`);
    expect(new Set(listed).size).toBe(listed.length);
    expect(index()).toMatch(/^- \[[^\]]+\]\(stories\/_constitution\.md\)$/m);
    expect([...listed, '_constitution.md'].sort()).toEqual(parts().sort());
  });

  it(`the index holds no "- AC" line and stays under ${INDEX_CAP} bytes`, () => {
    expect(index()).not.toMatch(/^- AC/m);
    expect(statSync(join(tree, 'docs/user-stories.md')).size).toBeLessThan(INDEX_CAP);
  });

  it('every relative link in the parts resolves from docs/stories/', () => {
    const broken: string[] = [];
    for (const f of parts()) {
      // A `[text](target)` inside a code span is an example, not a link.
      const text = readFileSync(join(tree, 'docs/stories', f), 'utf8').replace(/`[^`\n]*`/g, '');
      for (const [, t] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^([a-z][a-z0-9+.-]*:|[#/])/i.test(t)) continue;
        const target = t.split('#')[0];
        if (!existsSync(join(ROOT, 'docs/stories', target)) && !KNOWN_BROKEN.has(target)) broken.push(`${f}: ${t}`);
      }
    }
    expect(broken).toEqual([]);
    for (const t of KNOWN_BROKEN) expect(existsSync(join(ROOT, 'docs/stories', t)), `${t} now resolves: drop it from KNOWN_BROKEN`).toBe(false);
  });

  it('the Pages HTML built from the split is the HTML built from the monolith, byte for byte', () => {
    const build = (src: string, out: string) => {
      const r = spawnSync(TSX, [HTML, src, out], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(out, 'utf8');
    };
    const before = build(join(mono, 'docs/user-stories.md'), join(scratch, 'before.html'));
    const after = build(join(tree, 'docs/user-stories.md'), join(scratch, 'after.html'));
    expect(before.match(/<h3 id="us-\d+/g)?.length).toBeGreaterThanOrEqual(73);
    expect(after).toBe(before);
  });
});

describe('refuses and writes nothing', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'split-stories-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const US01 = '### US-01 · One — **shipped**\n- AC1 see [web](https://x.test) and [g](git-workflow.md).';
  const US02 = '### US-02 · Two\n- AC1 two\n\n- AC2 after a blank';
  const monolith = (...stories: string[]) =>
    ['# Stories', '', '## The product constitution (rules)', 'Rule one.', '', '---', '', '## Epic A — Things', '', ...stories, '', '## Coverage', '1. done', ''].join('\n');
  const refuse = (text: string, why: RegExp) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/user-stories.md'), text);
    const out = join(dir, 'out');
    const r = cli(dir, '--out', out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^split-stories: refused, nothing written: /);
    expect(r.stderr).toMatch(why);
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(join(dir, 'docs/user-stories.md'), 'utf8')).toBe(text);
  };

  it('splits a fixture with its quirks (no blank before a story, a blank inside one) and round-trips it', () => {
    const text = monolith(US01, US02, '', '---', '', '### US-03 · Three\n- AC1 `[a](b)` in code');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/user-stories.md'), text);
    expect(cli(dir).status).toBe(0);
    expect(loadStories(dir)).toBe(text);
    expect(readFileSync(join(dir, 'docs/stories/US-02.md'), 'utf8')).toBe(`${US02}\n`);
    expect(readFileSync(join(dir, 'docs/stories/US-01.md'), 'utf8')).toContain('[g](../git-workflow.md)');
    expect(readFileSync(join(dir, 'docs/user-stories.md'), 'utf8')).toContain('- [US-01 · One](stories/US-01.md)\n- [US-02 · Two](stories/US-02.md)\n\n---');
  });

  it('when a story id repeats', () => refuse(monolith(US01, '', US01.replace('One', 'Again')), /US-01 appears twice/));

  it('when a title would break its index line', () => {
    refuse(monolith(US01, '', '### US-02 · Has [brackets] — **x**\n- AC1'), /title of US-02 would break its index line/);
  });

  it('when a title is empty', () => refuse(monolith(US01, '', '### US-02 ·  — **x**\n- AC1'), /title of US-02 would break/));

  it('when a story heading lacks its " · "', () => refuse(monolith(US01, '', '### US-02 Two\n- AC1'), /not "### US-NN · <title>"/));

  it('when the input is already split', () => {
    refuse(monolith('- [US-01 · One](stories/US-01.md)'), /the input is already split: it holds the index line "- \[US-01 · One\]/);
  });

  it('when the input cannot be read at the ref', () => {
    git(dir, 'init', '-q');
    const r = cli(dir, '--from', 'HEAD', '--out', join(dir, 'out'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused, nothing written: cannot read the stories at HEAD/);
  });

  it('when the round trip would not be exact', () => {
    const text = monolith(US01, '', US02);
    const plan = planSplit(text);
    expect(() => verifyPlan(text, plan)).not.toThrow();
    plan.parts.set('US-02.md', plan.parts.get('US-02.md')!.replace('two', 'tow'));
    expect(() => verifyPlan(text, plan)).toThrow(SplitRefusal);
    expect(() => verifyPlan(text, plan)).toThrow(/round trip is not exact: the reassembled text first differs at line 14/);
  });

  it('a bad flag is a usage error', () => {
    expect(cli(dir, '--into', 'x').status).toBe(64);
    expect(cli(dir, '--from').status).toBe(64);
  });
});
