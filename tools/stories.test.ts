/**
 * tools/stories.mjs reads the user stories as one text from either shape: the monolith
 * docs/user-stories.md, or the split index with one file per story (the stories-split plan, PR 1).
 * These pin both shapes, on disk and at a git ref, and the reassembly rule in the module header.
 * US-64 AC11: the story-loss gate reads through this loader, so it must fail closed (a missing part,
 * an unreadable stories tree, an index with no stories/ folder); US-64 AC13: a story listed twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromPart, isStoriesPath, loadStories, readStories, toPart } from './stories.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = readFileSync(join(ROOT, 'docs/user-stories.md'), 'utf8');

// The monolith a split must give back, byte for byte. Its quirks are on purpose: a story with no blank
// line before the next heading, a blank line inside a story, a `---` between stories, and links of
// every kind (relative, already `../`, absolute, anchor).
const CONSTITUTION = '## The product constitution\nRule one, see [plan](drafts/plan.md).';
const US01 = '### US-01 · One — **shipped**\n- AC1 see [ios](../ios/architecture.md), [web](https://x.test/a) and [top](#us-02).';
const US02 = '### US-02 · Two\n- AC1 two [g](git-workflow.md)\n\n- AC2 after a blank';
const US03 = '### US-03 · Three\n- AC1 three';
const MONOLITH = [
  '# User Stories', '', 'Intro, see [arch](architecture-v2.md).', '', CONSTITUTION, '', '---', '',
  '## Epic A — Things', '', US01, US02, '', '---', '', US03, '', '## Coverage priorities', '1. done', '',
].join('\n');
const INDEX = [
  '# User Stories', '', 'Intro, see [arch](architecture-v2.md).', '', '- [The product constitution](stories/_constitution.md)', '', '---', '',
  '## Epic A — Things', '', '- [US-01 · One](stories/US-01.md)', '- [US-02 · Two](stories/US-02.md)', '', '---', '',
  '- [US-03 · Three](stories/US-03.md)', '', '## Coverage priorities', '1. done', '',
].join('\n');
// What the split writes: each part ends in one newline, and its relative links gain `../`.
const PARTS: Record<string, string> = {
  '_constitution.md': 'see [plan](../drafts/plan.md)',
  'US-01.md': '[ios](../../ios/architecture.md), [web](https://x.test/a) and [top](#us-02)',
  'US-02.md': '[g](../git-workflow.md)',
  'US-03.md': '- AC1 three',
};
const SOURCES: Record<string, string> = { '_constitution.md': CONSTITUTION, 'US-01.md': US01, 'US-02.md': US02, 'US-03.md': US03 };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 });
const commit = (cwd: string, msg: string) => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stories-loader-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes the split fixture under `root`/docs, each part made by toPart from the monolith's own text. */
function writeSplit(root: string) {
  mkdirSync(join(root, 'docs/stories'), { recursive: true });
  writeFileSync(join(root, 'docs/user-stories.md'), INDEX);
  for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(root, 'docs/stories', name), `${toPart(text)}\n`);
}

describe('the monolith (today\'s shape)', () => {
  it('loads the real docs/user-stories.md byte for byte, on disk and at HEAD', () => {
    expect(loadStories()).toBe(REAL);
    expect(loadStories(ROOT, { ref: 'HEAD' })).toBe(git(ROOT, 'show', 'HEAD:docs/user-stories.md'));
  });

  it('toPart then fromPart gives the real file back: the link transform is its own exact inverse', () => {
    expect(toPart(REAL)).not.toBe(REAL); // the file has relative links, so the transform does something
    expect(fromPart(toPart(REAL))).toBe(REAL);
  });

  it('returns a monolith as is when no stories/ folder sits beside it', () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/user-stories.md'), MONOLITH);
    expect(loadStories(dir)).toBe(MONOLITH);
  });
});

describe('the split shape', () => {
  it('each part holds its story with `../` on every relative link', () => {
    writeSplit(dir);
    for (const [name, bit] of Object.entries(PARTS)) expect(readFileSync(join(dir, 'docs/stories', name), 'utf8')).toContain(bit);
  });

  it('reassembles the index and its parts into the exact monolith', () => {
    writeSplit(dir);
    expect(loadStories(dir)).toBe(MONOLITH);
    expect(readStories(join(dir, 'docs/user-stories.md'))).toBe(MONOLITH);
  });

  it('reads both shapes at a git ref, whatever the working tree holds', () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/user-stories.md'), MONOLITH);
    git(dir, 'init', '-q');
    commit(dir, 'monolith');
    writeSplit(dir);
    commit(dir, 'split');
    rmSync(join(dir, 'docs'), { recursive: true });
    expect(loadStories(dir, { ref: 'HEAD' })).toBe(MONOLITH);
    expect(loadStories(dir, { ref: 'HEAD~1' })).toBe(MONOLITH);
    expect(git(dir, 'show', 'HEAD:docs/user-stories.md')).toBe(INDEX);
  });

  it('a missing part is a plain error naming it, on disk and at a ref, never git\'s "no such path"', () => {
    writeSplit(dir);
    git(dir, 'init', '-q');
    rmSync(join(dir, 'docs/stories/US-02.md'));
    commit(dir, 'part missing');
    for (const ref of [undefined, 'HEAD']) {
      let err: unknown;
      try {
        loadStories(dir, { ref });
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toContain('stories/US-02.md');
      expect((err as { stderr?: unknown }).stderr).toBeUndefined();
    }
  });

  it('an absent index at a ref keeps git\'s own error, so a caller can tell a first build', () => {
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'other.txt'), 'x');
    commit(dir, 'base');
    expect(() => loadStories(dir, { ref: 'HEAD' })).toThrow();
    try {
      loadStories(dir, { ref: 'HEAD' });
    } catch (e) {
      expect(String((e as { stderr?: unknown }).stderr)).toMatch(/does not exist in|exists on disk, but not in/);
    }
  });

  it('expands only exact index lines: a story line whose two ids differ is kept as text', () => {
    writeSplit(dir);
    const odd = '- [US-01 · One](stories/US-02.md)';
    writeFileSync(join(dir, 'docs/user-stories.md'), `${odd}\n`);
    expect(loadStories(dir)).toBe(`${odd}\n`);
  });
});

describe('fails closed rather than return a raw index that defines no story (US-64 AC11)', () => {
  it('an index that links parts, with no stories/ folder, throws on disk and at a ref', () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs/user-stories.md'), INDEX);
    git(dir, 'init', '-q');
    commit(dir, 'index alone');
    for (const ref of [undefined, 'HEAD']) expect(() => loadStories(dir, { ref }), String(ref)).toThrow(/no stories\/ folder/);
  });

  it('a stories tree git cannot read at the ref throws, never falls back to the index', () => {
    writeSplit(dir);
    git(dir, 'init', '-q');
    commit(dir, 'split');
    const tree = git(dir, 'rev-parse', 'HEAD:docs/stories').trim();
    rmSync(join(dir, '.git/objects', tree.slice(0, 2), tree.slice(2)), { force: true }); // a broken tree: `cat-file -e` exits 1, silent
    rmSync(join(dir, 'docs'), { recursive: true });
    expect(() => loadStories(dir, { ref: 'HEAD' })).toThrow();
  });
});

describe('a story listed twice (US-64 AC13)', () => {
  it('the loader refuses an index that lists one story twice, naming it, on disk and at a ref', () => {
    writeSplit(dir);
    writeFileSync(join(dir, 'docs/user-stories.md'), `${INDEX}- [US-02 · Two](stories/US-02.md)\n`);
    git(dir, 'init', '-q');
    commit(dir, 'listed twice');
    for (const ref of [undefined, 'HEAD']) expect(() => loadStories(dir, { ref }), String(ref)).toThrow(/US-02 twice/);
  });
});

describe('isStoriesPath', () => {
  it('names the index and the parts, and nothing else', () => {
    for (const p of ['docs/user-stories.md', 'docs/stories/US-15.md', 'docs/stories/_constitution.md']) expect(isStoriesPath(p), p).toBe(true);
    for (const p of ['docs/user-stories.html', 'docs/stories/sub/US-1.md', 'docs/reference.md', 'stories/US-1.md']) expect(isStoriesPath(p), p).toBe(false);
  });
});
