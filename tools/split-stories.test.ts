/**
 * US-64 AC33: tools/split-stories.mjs is the exact inverse of tools/stories.mjs (the stories-split plan, PR 2).
 * The round trip runs on the real stories text; the refusals on small fixtures.
 * The standing checks run on whichever layout the repo holds: the split tree itself once docs/stories/ exists,
 * or, while docs/user-stories.md is still the monolith, a split of it made in a temporary folder.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStories } from './stories.mjs';
import { planSplit, shapeReport, splitStories, SplitRefusal, verifyPlan } from './split-stories.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'tools/split-stories.mjs');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const HTML = join(ROOT, 'scripts/build-user-stories-html.ts');
// The index today is 8.6 KB for 73 stories (about 115 bytes a line). 16 KB leaves room for some 65 more stories
// before anyone has to look again. The cap catches a large leaked body; a small story (US-08 is 283 bytes, with no
// `- AC` line) would slip under it, so the index is also checked for any `### US-` heading.
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
const NORMALIZE = 'run `node tools/split-stories.mjs --normalize`';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Small fixtures: a monolith with the constitution, one epic and the given stories.
const US01 = '### US-01 · One — **shipped**\n- AC1 see [web](https://x.test) and [g](git-workflow.md).';
const US02 = '### US-02 · Two\n- AC1 two\n\n- AC2 after a blank';
const monolith = (...stories: string[]) =>
  ['# Stories', '', '## The product constitution (rules)', 'Rule one.', '', '---', '', '## Epic A — Things', '', ...stories, '', '## Coverage', '1. done', ''].join('\n');

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
    const c = join(scratch, 'idem-c');
    splitStories({ root: mono, out: a });
    const first = files(a);
    // loadStories of the output, split again into a fresh folder.
    mkdirSync(join(b, 'docs'), { recursive: true });
    writeFileSync(join(b, 'docs/user-stories.md'), loadStories(a));
    splitStories({ root: b, out: c });
    expect(files(c)).toEqual(first);
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

  it(`the index holds no story heading, no "- AC" line, and stays under ${INDEX_CAP} bytes`, () => {
    expect(index()).not.toMatch(/^### US-/m);
    expect(index()).not.toMatch(/^- AC/m);
    expect(statSync(join(tree, 'docs/user-stories.md')).size).toBeLessThan(INDEX_CAP);
  });

  it('every relative link in the parts resolves from docs/stories/', () => {
    const broken: string[] = [];
    const seen = new Set<string>();
    for (const f of parts()) {
      // A `[text](target)` inside a code span is an example, not a link.
      const text = readFileSync(join(tree, 'docs/stories', f), 'utf8').replace(/`[^`\n]*`/g, '');
      for (const [, t] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^([a-z][a-z0-9+.-]*:|[#/])/i.test(t)) continue;
        const target = t.split('#')[0];
        seen.add(target);
        if (!existsSync(join(ROOT, 'docs/stories', target)) && !KNOWN_BROKEN.has(target)) broken.push(`${f}: ${t}`);
      }
    }
    expect(broken).toEqual([]);
    for (const t of KNOWN_BROKEN) {
      expect(existsSync(join(ROOT, 'docs/stories', t)), `${t} now resolves: drop it from KNOWN_BROKEN`).toBe(false);
      expect(seen.has(t), `no part links ${t} any more: drop it from KNOWN_BROKEN`).toBe(true);
    }
  });

  // On the split layout this is the committed tree: a part edited out of the split's shape (a trailing blank line,
  // a link without its `../`) fails here, naming the first such file and the repair. On the monolith layout it checks
  // the temporary split.
  it('the parts and index are the split of loadStories, byte for byte', () => {
    const report = shapeReport(tree);
    if (report !== undefined) expect.fail(report);
  });

  // Both inputs carry the same text, so this proves only that the Pages build reads the split layout as it reads
  // the monolith (scripts/build-user-stories-html.ts goes through readStories).
  it('the Pages build reads both layouts the same: the HTML from the split equals the HTML from the monolith', () => {
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
    const r = cli(dir, '--from', 'HEAD', '--out', `${dir}-out`); // outside the repo, as a dry run must be
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused, nothing written: cannot read the stories at HEAD/);
    expect(existsSync(`${dir}-out`)).toBe(false);
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
    expect(cli(dir, '--normalize', '--out', 'x').status).toBe(64);
  });
});

describe('--normalize fixes the shape of a split tree, never its content (US-64 AC33)', () => {
  let dir: string;
  const part = (name: string) => join(dir, 'docs/stories', name);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'split-stories-norm-'));
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/user-stories.md'), monolith(US01, '', US02, '', '### US-03 · Three\n- AC1 three'));
    expect(cli(dir).status).toBe(0);
    git(dir, 'init', '-q');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the standing check names the first file out of shape, the rule and the repair, with a short diff', () => {
    expect(shapeReport(dir)).toBeUndefined();
    writeFileSync(part('US-02.md'), readFileSync(part('US-02.md'), 'utf8').slice(0, -1));
    const report = shapeReport(dir)!;
    expect(report).toContain(`docs/stories/US-02.md is not in the split's exact form (one heading, its body to its last non-blank line, one final newline): ${NORMALIZE}`);
    expect(report).toMatch(/line 5\n\s+have: \(end of file\)\n\s+want: ""/);
    expect(report.split('\n').length).toBeLessThan(6);
  });

  it('repairs a part with no final newline and a part with a trailing blank line, the stories text unchanged', () => {
    const want = files(dir);
    writeFileSync(part('US-01.md'), want['US-01.md'].slice(0, -1));
    writeFileSync(part('US-02.md'), `${want['US-02.md']}\n`);
    const text = loadStories(dir);
    const r = cli(dir, '--normalize');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('docs/stories/US-01.md');
    expect(shapeReport(dir)).toBeUndefined();
    expect(loadStories(dir)).toBe(text);
    expect(readFileSync(part('US-01.md'), 'utf8')).toBe(want['US-01.md']);
    expect(readFileSync(part('US-02.md'), 'utf8')).toBe(want['US-02.md']);
    // A second run finds nothing to do.
    const again = cli(dir, '--normalize');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already in the split');
  });

  it('refuses, naming the line, when re-splitting would change a story: a `---` line inside a part', () => {
    writeFileSync(part('US-02.md'), readFileSync(part('US-02.md'), 'utf8').replace('- AC1 two\n', '- AC1 two\n---\n'));
    const before = files(dir);
    const r = cli(dir, '--normalize');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^split-stories: refused, nothing written: normalizing would change the text of docs\/stories\/US-02\.md, not only its shape, from its line 3: "---"/);
    expect(files(dir)).toEqual(before);
  });

  it('refuses, naming the line the part would gain, when re-splitting would lengthen a part (US-64 AC33)', () => {
    const index = readFileSync(join(dir, 'docs/user-stories.md'), 'utf8');
    writeFileSync(join(dir, 'docs/user-stories.md'), index.replace('(stories/US-02.md)\n', '(stories/US-02.md)\nstray text\n'));
    const before = files(dir);
    const r = cli(dir, '--normalize');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('normalizing would change the text of docs/stories/US-02.md, not only its shape: it would gain its line 5, "stray text"');
    expect(r.stderr).not.toContain('undefined');
    expect(files(dir)).toEqual(before);
  });

  it('refuses outside a git repo (US-64 AC33)', () => {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    const before = files(dir);
    const r = cli(dir, '--normalize');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^split-stories: refused, nothing written: --normalize runs only in a git repo/);
    expect(files(dir)).toEqual(before);
  });

  // A conflicted part: none of these lines ends a part, so the loader and the round trip accept it.
  const conflicted = '### US-02 · Two\n<<<<<<< HEAD\n- AC1 two\n=======\n- AC1 deux\n>>>>>>> main\n';

  it('refuses during a merge (MERGE_HEAD exists), writing nothing (US-64 AC33)', () => {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'split');
    writeFileSync(join(dir, '.git/MERGE_HEAD'), git(dir, 'rev-parse', 'HEAD'));
    writeFileSync(part('US-02.md'), conflicted);
    const before = files(dir);
    const r = cli(dir, '--normalize');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^split-stories: refused, nothing written: a merge is in progress/);
    expect(files(dir)).toEqual(before);
  });

  it('refuses, and the standing check fails, on a conflict marker in a part or the index, naming file and line (US-64 AC33)', () => {
    writeFileSync(part('US-02.md'), conflicted);
    const before = files(dir);
    const r = cli(dir, '--normalize');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/stories/US-02.md line 2 is a conflict marker: "<<<<<<< HEAD"');
    expect(files(dir)).toEqual(before);
    expect(shapeReport(dir)).toContain('docs/stories/US-02.md line 2 is a conflict marker: "<<<<<<< HEAD"');
    writeFileSync(part('US-02.md'), `${US02}\n`);
    writeFileSync(join(dir, 'docs/user-stories.md'), `${before.index}\n=======\n`);
    expect(shapeReport(dir)).toMatch(/^docs\/user-stories\.md line \d+ is a conflict marker: "======="/);
  });

  it('catches a diff3 base marker (`|||||||`) in a part, in --normalize and the standing check (US-64 AC33)', () => {
    writeFileSync(part('US-02.md'), '### US-02 · Two\n- AC1 two\n||||||| merged common ancestors\n- AC1 zwei\n');
    const before = files(dir);
    const r = cli(dir, '--normalize');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/stories/US-02.md line 3 is a conflict marker: "||||||| merged common ancestors"');
    expect(files(dir)).toEqual(before);
    expect(shapeReport(dir)).toContain('docs/stories/US-02.md line 3 is a conflict marker: "||||||| merged common ancestors"');
  });

  it('names the marker first, though the conflict leaves the heading twice in a part (US-64 AC33)', () => {
    writeFileSync(part('US-02.md'), '<<<<<<< HEAD\n### US-02 · Two\n=======\n### US-02 · Deux\n>>>>>>> main\n- AC1 two\n');
    const before = files(dir);
    const r = cli(dir, '--normalize');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/stories/US-02.md line 1 is a conflict marker: "<<<<<<< HEAD"');
    expect(files(dir)).toEqual(before);
    expect(shapeReport(dir)).toContain('docs/stories/US-02.md line 1 is a conflict marker: "<<<<<<< HEAD"');
  });
});

describe('writing into a repo that already holds parts (the PR 3 rebase path)', () => {
  // A repo whose main went: the monolith (base), PR 3's own split run (split), then a post-split commit (post).
  // An open branch (feat) made from base edits US-02 in the monolith.
  let repo: string;
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  const commit = (m: string) => (run('add', '-A'), run('commit', '-q', '-m', m));
  const text = ['# Stories', '', '## Epic A — Things', '', '### US-01 · One', '- AC1 one', '', '### US-02 · Two', '- AC1 two', ''].join('\n');
  const featText = text.replace('- AC1 two', '- AC1 two, edited on the branch');
  const tree = () => files(repo);
  // The branch merges `ref` and stops before committing, as a conflicted merge does.
  const mergeIntoFeat = (ref: string) => {
    run('checkout', '-q', 'feat');
    spawnSync('git', ['merge', '--no-commit', '--no-ff', '-q', ref], { cwd: repo, env });
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(true);
  };
  // An --out inside any git work tree refuses before anything is read or written.
  const refusesOut = (cwd: string, out: string, ...extra: string[]) => {
    const at = resolve(cwd, out);
    const look = () => [tree(), existsSync(join(at, 'docs/stories')) ? files(at) : existsSync(at)];
    const before = look();
    const r = cli(cwd, '--from', 'pre-split', '--out', out, ...extra);
    expect(r.status, out).toBe(1);
    expect(r.stderr).toMatch(/^split-stories: refused, nothing written: --out .* is inside a git work tree .*: a dry run writes only to a scratch folder outside any git work tree; the real split writes only through the default path \(no --out\), from the toplevel of the checkout it runs in/);
    expect(look()).toEqual(before);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'split-stories-repo-'));
    run('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs/user-stories.md'), text);
    commit('base');
    run('tag', 'pre-split');
    run('checkout', '-q', '-b', 'feat');
    writeFileSync(join(repo, 'docs/user-stories.md'), featText);
    commit('feat');
    run('checkout', '-q', 'main');
    // PR 3's own run: on main, no docs/stories/ yet, no merge, no flag.
    const r = cli(repo);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    commit('split');
    run('tag', 'split');
    writeFileSync(join(repo, 'docs/stories/US-01.md'), '### US-01 · One\n- AC1 one\n- AC2 added after the split\n');
    writeFileSync(join(repo, 'docs/stories/US-03.md'), '### US-03 · Three\n- AC1 three\n');
    writeFileSync(join(repo, 'docs/user-stories.md'), `${readFileSync(join(repo, 'docs/user-stories.md'), 'utf8')}\n- [US-03 · Three](stories/US-03.md)\n`);
    commit('post');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('PR 3: the first split on main, with no docs/stories/ yet, needs no flag', () => {
    expect(loadStories(repo, { ref: 'split' })).toBe(text);
  });

  it('a branch merging exactly the split commit re-splits its own monolith', () => {
    mergeIntoFeat('split');
    const r = cli(repo, '--from', 'HEAD');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(loadStories(repo)).toBe(featText);
  });

  it('refuses, writing nothing, when the merge brings commits after the split (US-64 AC33)', () => {
    mergeIntoFeat('main');
    const before = tree();
    const r = cli(repo, '--from', 'HEAD');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused, nothing written: a merge is in progress.*docs\/stories\/US-01\.md differs.*merge exactly the split commit/s);
    expect(tree()).toEqual(before);
  });

  it('outside a merge, refuses to overwrite docs/stories/ that differs from the split, unless --replace (US-64 AC33)', () => {
    const before = tree();
    const r = cli(repo, '--from', 'pre-split');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused, nothing written: docs\/stories\/ already holds parts that differ from the split: docs\/stories\/US-01\.md differs.*--replace/s);
    expect(tree()).toEqual(before);
    const ok = cli(repo, '--from', 'pre-split', '--replace');
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(loadStories(repo)).toBe(text);
    expect(existsSync(join(repo, 'docs/stories/US-03.md'))).toBe(false);
  });

  it('names the commit before the split when main edited the monolith before splitting, and its steps work (US-64 AC33)', () => {
    run('checkout', '-q', '-b', 'main2', 'pre-split');
    writeFileSync(join(repo, 'docs/user-stories.md'), text.replace('- AC1 one', '- AC1 one, edited on main before the split'));
    commit('main edit');
    expect(cli(repo).status).toBe(0);
    commit('split2');
    const split2 = run('rev-parse', 'HEAD').trim();
    const prev = run('rev-parse', 'HEAD^').trim();
    mergeIntoFeat(split2);
    const before = tree();
    const r = cli(repo, '--from', 'HEAD');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused, nothing written: a merge is in progress.*docs\/stories\/US-01\.md differs/s);
    expect(r.stderr).toContain(`merge ${prev.slice(0, 12)} (the commit before the split) first, commit, then merge ${split2.slice(0, 12)}, then run this again`);
    expect(tree()).toEqual(before);
    // Following its steps keeps main's pre-split edit and the branch's own.
    run('merge', '--abort');
    run('merge', '-q', '--no-edit', prev);
    mergeIntoFeat(split2);
    const ok = cli(repo, '--from', 'HEAD');
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(loadStories(repo)).toContain('- AC1 one, edited on main before the split');
    expect(loadStories(repo)).toContain('- AC1 two, edited on the branch');
  });

  it('an --out inside the repo refuses, by symlink, other letter case, `..` or a missing subfolder, even with --replace (US-64 AC33)', () => {
    const link = `${repo}-link`;
    symlinkSync(repo, link);
    try {
      refusesOut(repo, link);
      refusesOut(repo, repo, '--replace');
      refusesOut(repo, join(repo, 'not/yet'));
      refusesOut(join(repo, 'docs'), '..');
      const upper = join(dirname(repo), basename(repo).toUpperCase());
      if (existsSync(upper)) refusesOut(repo, upper); // only where the disk ignores case
    } finally {
      rmSync(link);
    }
  });

  it('from a subfolder, with no --out, it refuses rather than write a stray docs/ tree there (US-64 AC33)', () => {
    const before = tree();
    const r = cli(join(repo, 'docs'), '--from', 'pre-split');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^split-stories: refused, nothing written: writing into the repo runs from its toplevel, /);
    expect(r.stderr).toContain(realpathSync.native(repo));
    expect(existsSync(join(repo, 'docs/docs'))).toBe(false);
    expect(tree()).toEqual(before);
  });

  it('a git failure in the merge check refuses with exit 1, never a stack trace (US-64 AC33)', () => {
    run('checkout', '-q', 'split');
    const bin = mkdtempSync(join(tmpdir(), 'split-stories-git-'));
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nif [ "$1 $2 $3 $4" = "rev-parse -q --verify MERGE_HEAD" ]; then echo "fatal: simulated failure" >&2; exit 128; fi\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    try {
      const before = tree();
      const r = spawnSync('node', [SCRIPT, '--from', 'pre-split'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe('split-stories: refused, nothing written: cannot tell whether a merge is in progress: fatal: simulated failure\n');
      expect(tree()).toEqual(before);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('from a worktree, an --out at the main checkout refuses, with or without --replace, mid-merge or not (US-64 AC33)', () => {
    const wt = join(repo, '.claude/wt');
    run('worktree', 'add', '-q', '--detach', wt, 'split');
    refusesOut(wt, repo);
    refusesOut(wt, repo, '--replace');
    mergeIntoFeat('main');
    refusesOut(wt, repo, '--replace');
    refusesOut(repo, wt, '--replace');
  });

  // Git reads these before it looks at the folder it runs in; a run must answer for its own folder whatever they say.
  const wtEnv = (wt: string, extra: Record<string, string>) => spawnSync('node', [SCRIPT, '--from', 'pre-split', '--replace'], { cwd: wt, encoding: 'utf8', env: { ...process.env, ...extra } });

  const UNSET = '; unset GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR and GIT_INDEX_FILE and run from the checkout\n';

  it('refuses at once when GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR or GIT_INDEX_FILE is set, naming them, mid-merge or with --out (US-64 AC33)', () => {
    const wt = join(repo, '.claude/wt');
    run('worktree', 'add', '-q', '--detach', wt, 'split');
    const gitdir = join(repo, '.git/worktrees/wt');
    const vars = { GIT_DIR: gitdir, GIT_WORK_TREE: wt, GIT_COMMON_DIR: join(repo, '.git'), GIT_INDEX_FILE: join(gitdir, 'index') };
    mergeIntoFeat('main');
    const before = tree();
    const r = wtEnv(repo, vars);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`split-stories: refused, nothing written: GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR and GIT_INDEX_FILE are set${UNSET}`);
    expect(tree()).toEqual(before);
    const out = spawnSync('node', [SCRIPT, '--from', 'pre-split', '--replace', '--out', repo], { cwd: wt, encoding: 'utf8', env: { ...process.env, ...vars } });
    expect(out.status).toBe(1);
    expect(out.stderr).toBe(`split-stories: refused, nothing written: GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR and GIT_INDEX_FILE are set${UNSET}`);
    expect(tree()).toEqual(before);
  });

  it("in a worktree with GIT_DIR naming the main checkout's gitdir, it refuses and writes nothing (US-64 AC33)", () => {
    const wt = join(repo, '.claude/wt');
    run('worktree', 'add', '-q', '--detach', wt, 'split');
    mergeIntoFeat('main');
    const before = files(wt);
    const r = wtEnv(wt, { GIT_DIR: join(repo, '.git') });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`split-stories: refused, nothing written: GIT_DIR is set${UNSET}`);
    expect(files(wt)).toEqual(before);
  });

  it('a work tree reached only through GIT_DIR and GIT_WORK_TREE, mid-merge, with --replace, refuses (adv7 sep, US-64 AC33)', () => {
    mergeIntoFeat('main');
    const wt = mkdtempSync(join(tmpdir(), 'split-stories-sep-'));
    try {
      mkdirSync(join(wt, 'docs'));
      writeFileSync(join(wt, 'docs/user-stories.md'), featText);
      const before = readdirSync(join(wt, 'docs'));
      const r = spawnSync('node', [SCRIPT, '--replace'], { cwd: wt, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: wt } });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(`split-stories: refused, nothing written: GIT_DIR and GIT_WORK_TREE are set${UNSET}`);
      expect(readdirSync(join(wt, 'docs'))).toEqual(before);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  // Rule 1: --out must not exist or be an empty real folder, so nothing below it (a symlinked or nested docs/) is written through.
  const refusesShape = (out: string, why: RegExp) => {
    const at = () => {
      const st = lstatSync(out);
      return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? readdirSync(out).sort() : readFileSync(out, 'utf8');
    };
    const [beforeRepo, beforeOut] = [tree(), at()];
    const r = cli(repo, '--from', 'pre-split', '--out', out);
    expect(r.status, out).toBe(1);
    expect(r.stderr.split('\n'), out).toHaveLength(2); // one line, then the final newline: no stack
    expect(r.stderr, out).toMatch(why);
    expect(tree()).toEqual(beforeRepo);
    expect(at()).toEqual(beforeOut);
  };
  const NEW_OR_EMPTY = 'a dry run needs a new or empty scratch folder outside any git work tree';

  it('--out refuses a non-empty folder, a symlink (dangling or not) and a file; an empty folder works (adv7 sA, sB, US-64 AC33)', () => {
    const s = mkdtempSync(join(tmpdir(), 'split-stories-shape-'));
    try {
      const notEmpty = new RegExp(`^split-stories: refused, nothing written: --out .* is not empty: ${NEW_OR_EMPTY}`);
      mkdirSync(join(s, 'sA'));
      symlinkSync(join(repo, 'docs'), join(s, 'sA/docs')); // sA: docs/ is a symlink into the repo
      refusesShape(join(s, 'sA'), notEmpty);
      mkdirSync(join(s, 'sB/docs'), { recursive: true });
      git(join(s, 'sB/docs'), 'init', '-q'); // sB: docs/ is a git repo of its own
      refusesShape(join(s, 'sB'), notEmpty);
      mkdirSync(join(s, 'full'));
      writeFileSync(join(s, 'full/note'), 'x');
      refusesShape(join(s, 'full'), notEmpty);
      mkdirSync(join(s, 'empty'));
      symlinkSync(join(s, 'empty'), join(s, 'link'));
      refusesShape(join(s, 'link'), new RegExp(`^split-stories: refused, nothing written: --out .* is a symlink: ${NEW_OR_EMPTY}`));
      expect(readdirSync(join(s, 'empty'))).toEqual([]);
      symlinkSync(join(s, 'nowhere'), join(s, 'dangling'));
      refusesShape(join(s, 'dangling'), new RegExp(`^split-stories: refused, nothing written: --out .* is a symlink: ${NEW_OR_EMPTY}`));
      expect(existsSync(join(s, 'nowhere'))).toBe(false);
      writeFileSync(join(s, 'file'), 'x');
      refusesShape(join(s, 'file'), new RegExp(`^split-stories: refused, nothing written: --out .* is not a folder: ${NEW_OR_EMPTY}`));
      expect(readFileSync(join(s, 'file'), 'utf8')).toBe('x');
      const ok = cli(repo, '--from', 'pre-split', '--out', join(s, 'empty'));
      expect(ok.stderr).toBe('');
      expect(ok.status).toBe(0);
      expect(loadStories(join(s, 'empty'))).toBe(text);
    } finally {
      rmSync(s, { recursive: true, force: true });
    }
  });

  it('`--out /` and an --out under an ancestor it cannot search refuse in one line, never a stack (US-64 AC33)', () => {
    refusesShape('/', new RegExp(`^split-stories: refused, nothing written: --out / is not empty: ${NEW_OR_EMPTY}`));
    if (process.getuid?.() === 0) return; // root searches any folder
    const locked = mkdtempSync(join(tmpdir(), 'split-stories-locked-'));
    chmodSync(locked, 0o000);
    try {
      const r = cli(repo, '--from', 'pre-split', '--out', join(locked, 'sub'));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^split-stories: refused, nothing written: cannot check --out .*: EACCES[^\n]*\n$/);
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  it('a write that fails says what it already changed, or that nothing was written, in one line (US-64 AC33)', () => {
    // Partway: US-03.md (stale) is removed and US-01.md written before US-02.md, a folder, cannot be.
    rmSync(join(repo, 'docs/stories/US-02.md'));
    mkdirSync(join(repo, 'docs/stories/US-02.md'));
    const r = cli(repo, '--from', 'pre-split', '--replace');
    expect(r.status).toBe(1);
    expect(r.stderr.startsWith(`split-stories: refused partway: 1 file written, 1 removed under ${realpathSync.native(repo)}: `)).toBe(true);
    expect(r.stderr).toMatch(/^[^\n]*EISDIR[^\n]*\n$/);
    expect(r.stderr).not.toContain('nothing written');
    if (process.getuid?.() === 0) return;
    // Nothing: a read-only docs/stories/ fails on the first removal, so nothing changed.
    rmSync(join(repo, 'docs/stories/US-02.md'), { recursive: true });
    writeFileSync(join(repo, 'docs/stories/US-03.md'), 'stale\n');
    const before = tree();
    chmodSync(join(repo, 'docs/stories'), 0o555);
    try {
      const n = cli(repo, '--from', 'pre-split', '--replace');
      expect(n.status).toBe(1);
      expect(n.stderr).toMatch(/^split-stories: refused, nothing written: cannot write under .*: [^\n]*EACCES[^\n]*\n$/);
    } finally {
      chmodSync(join(repo, 'docs/stories'), 0o755);
    }
    expect(tree()).toEqual(before);
  });

  it('when git cannot run, it refuses and writes nothing, with and without --replace (US-64 AC33)', () => {
    mergeIntoFeat('main');
    writeFileSync(join(repo, 'docs/user-stories.md'), featText); // the branch's monolith, as a hand resolution leaves it
    const noGit = mkdtempSync(join(tmpdir(), 'split-stories-nogit-'));
    try {
      for (const args of [[], ['--replace']]) {
        const before = tree();
        const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: noGit } });
        expect(r.status, args.join(' ')).toBe(1);
        expect(r.stderr).toMatch(/^split-stories: refused, nothing written: cannot find the repo's toplevel: .*ENOENT/);
        expect(tree()).toEqual(before);
      }
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  it('when the split commit is not a pure split of its parent, the merge refusal names the file and says to port the edit by hand (US-64 AC33)', () => {
    run('checkout', '-q', '-b', 'main3', 'pre-split');
    expect(cli(repo).status).toBe(0);
    writeFileSync(join(repo, 'docs/stories/US-01.md'), '### US-01 · One\n- AC1 one\n- AC2 slipped into the split commit\n');
    commit('impure split');
    const impure = run('rev-parse', 'HEAD').trim();
    mergeIntoFeat(impure);
    const before = tree();
    const r = cli(repo, '--from', 'HEAD');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`at the merge base ${run('merge-base', 'HEAD', impure).trim().slice(0, 12)}: docs/stories/US-01.md differs. So the incoming commit ${impure.slice(0, 12)} itself differs from a pure split of its parent.`);
    expect(r.stderr.match(/US-01\.md differs/g)).toHaveLength(1);
    expect(r.stderr).toContain('port its own story edits into the parts by hand');
    expect(r.stderr).not.toContain('merge exactly the split commit');
    expect(tree()).toEqual(before);
  });

  it('when the incoming commit holds no docs/stories/, the merge refusal gives the general advice, not the impure-split one (US-64 AC33)', () => {
    run('checkout', '-q', '-b', 'main4', 'pre-split');
    writeFileSync(join(repo, 'docs/user-stories.md'), text.replace('- AC1 one', '- AC1 one, edited on main'));
    commit('main edit, no split');
    mergeIntoFeat('main4');
    const before = readFileSync(join(repo, 'docs/user-stories.md'), 'utf8');
    const r = cli(repo, '--from', 'HEAD');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/stories/US-01.md is missing');
    expect(r.stderr).toContain('merge exactly the split commit');
    expect(r.stderr).not.toContain('port its own story edits');
    expect(readFileSync(join(repo, 'docs/user-stories.md'), 'utf8')).toBe(before);
    expect(existsSync(join(repo, 'docs/stories'))).toBe(false);
  });

  // macOS reaches every folder of the data volume a second way, under this firmlink prefix; git's toplevel never uses it.
  const DATA = '/System/Volumes/Data';
  const viaData = (p: string) => `${DATA}${realpathSync.native(p)}`;
  const onMac = process.platform === 'darwin' && existsSync(DATA);

  it.skipIf(!onMac)('an --out at a checkout through /System/Volumes/Data refuses, from its own repo, a subfolder or a worktree (US-64 AC33)', () => {
    const wt = join(repo, '.claude/wt');
    run('worktree', 'add', '-q', '--detach', wt, 'split');
    expect(existsSync(viaData(repo))).toBe(true);
    refusesOut(repo, viaData(repo));
    refusesOut(join(repo, 'docs'), viaData(repo));
    refusesOut(wt, viaData(repo));
    mergeIntoFeat('main');
    refusesOut(repo, viaData(repo), '--replace');
  });

  it('outside a merge, a rerun whose output equals docs/stories/ needs no flag', () => {
    run('checkout', '-q', 'split');
    const before = tree();
    const r = cli(repo, '--from', 'pre-split');
    expect(r.status).toBe(0);
    expect(tree()).toEqual(before);
  });
});
