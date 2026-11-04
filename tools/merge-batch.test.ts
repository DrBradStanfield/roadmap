/**
 * US-64 AC13: tools/merge-batch.mjs builds a contributor batch. Every test runs the real script
 * in a scratch clone whose bare "origin" holds refs/pull/<n>/head, and checks what the caller
 * sees: exit code, stderr, the files and the history left behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'merge-batch.mjs');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

const STORIES = ['# Stories', '', '### US-1', '- AC1 one', '- AC2 two', '- Tests: none', ''].join('\n');
const HTML_V1 = '<p>v1</p>\n';

let root: string;
let origin: string;
let batch: string;
let n: number;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd: string, file: string, text: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
};

/** A PR: a branch off `base` that edits files, published as origin's refs/pull/<pr>/head. */
function pr(pr: number, base: string, edit: (dir: string) => void): string {
  const dir = join(root, `pr-${pr}-${n++}`);
  git(root, 'clone', '-q', origin, dir);
  git(dir, 'checkout', '-q', '-b', `pr${pr}`, base);
  edit(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `pr ${pr}`);
  git(dir, 'push', '-q', '-f', 'origin', `HEAD:refs/pull/${pr}/head`);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Moves origin/main on and refreshes the batch clone. */
function advanceMain(edit: (dir: string) => void): void {
  const dir = join(root, `main-${n++}`);
  git(root, 'clone', '-q', origin, dir);
  edit(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main moves');
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
}

function runBatch(lines: string[], keep = false) {
  if (!keep) {
    git(batch, 'fetch', '-q', 'origin', 'main');
    git(batch, 'reset', '-q', '--hard', 'origin/main');
  }
  const list = join(root, 'list.txt');
  writeFileSync(list, lines.join('\n') + '\n');
  const r = spawnSync('node', [SCRIPT, list], { cwd: batch, env: ENV, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let baseSha: string;

beforeEach(() => {
  n = 0;
  root = mkdtempSync(join(tmpdir(), 'merge-batch-'));
  origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  write(seed, 'docs/user-stories.md', STORIES);
  write(seed, 'docs/user-stories.html', HTML_V1);
  write(seed, 'src/a.txt', 'a1\na2\na3\n');
  write(seed, 'src/b.txt', 'b\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'main');
  baseSha = git(seed, 'rev-parse', 'HEAD');
  batch = join(root, 'batch');
  git(root, 'clone', '-q', origin, batch);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const addAc = (line: string) => (d: string) => {
  const p = join(d, 'docs/user-stories.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('- Tests: none', `${line}\n- Tests: none`));
};

describe('merge-batch.mjs (US-64 AC13)', () => {
  it('merges each reviewed head as is, with the batch message', () => {
    const a = pr(11, baseSha, (d) => write(d, 'src/b.txt', 'b changed\n'));
    const c = pr(12, baseSha, (d) => write(d, 'src/new.txt', 'new\n'));
    const r = runBatch([`11 ${a}`, `12 ${c}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PR #11');
    expect(r.out).toContain(`HEAD ${git(batch, 'rev-parse', 'HEAD')}`);
    expect(readFileSync(join(batch, 'src/b.txt'), 'utf8')).toBe('b changed\n');
    expect(existsSync(join(batch, 'src/new.txt'))).toBe(true);
    // The reviewed heads themselves are in the history, so GitHub marks the PRs merged.
    expect(() => git(batch, 'merge-base', '--is-ancestor', a, 'HEAD')).not.toThrow();
    expect(() => git(batch, 'merge-base', '--is-ancestor', c, 'HEAD')).not.toThrow();
    expect(git(batch, 'log', '--format=%s', '-n', '8')).toContain(`Merge PR #11 (${a.slice(0, 8)}) into the batch`);
  });

  it('drops docs/user-stories.html when main deleted it and the PR modified it', () => {
    const sha = pr(21, baseSha, (d) => {
      write(d, 'docs/user-stories.html', '<p>v2</p>\n');
      write(d, 'src/b.txt', 'b by 21\n');
    });
    advanceMain((d) => rmSync(join(d, 'docs/user-stories.html')));
    const r = runBatch([`21 ${sha}`]);
    expect(r.code).toBe(0);
    expect(existsSync(join(batch, 'docs/user-stories.html'))).toBe(false);
    expect(git(batch, 'ls-files', 'docs/user-stories.html')).toBe('');
    expect(readFileSync(join(batch, 'src/b.txt'), 'utf8')).toBe('b by 21\n');
    expect(git(batch, 'status', '--porcelain')).toBe('');
  });

  it('removes a tracked docs/user-stories.html a clean merge left behind', () => {
    // Main already dropped the file; this PR adds it back with no conflict.
    advanceMain((d) => rmSync(join(d, 'docs/user-stories.html')));
    const sha = pr(22, git(batch, 'rev-parse', 'origin/main'), (d) => {
      write(d, 'docs/user-stories.html', '<p>again</p>\n');
      write(d, 'src/b.txt', 'b by 22\n');
    });
    const r = runBatch([`22 ${sha}`]);
    expect(r.code).toBe(0);
    expect(git(batch, 'ls-files', 'docs/user-stories.html')).toBe('');
    expect(readFileSync(join(batch, 'src/b.txt'), 'utf8')).toBe('b by 22\n');
  });

  it('keeps the ACs of two PRs added at the same line, in AC order, and proves the diff', () => {
    const late = pr(31, baseSha, addAc('- AC4 from thirty-one'));
    const early = pr(32, baseSha, addAc('- AC3 from thirty-two'));
    const r = runBatch([`32 ${early}`, `31 ${late}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('proof ok');
    const md = readFileSync(join(batch, 'docs/user-stories.md'), 'utf8');
    expect(md).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(md.indexOf('- AC2 two')).toBeLessThan(md.indexOf('- AC3 from thirty-two'));
    expect(md.indexOf('- AC3 from thirty-two')).toBeLessThan(md.indexOf('- AC4 from thirty-one'));
    expect(md.indexOf('- AC4 from thirty-one')).toBeLessThan(md.indexOf('- Tests: none'));
    expect(git(batch, 'status', '--porcelain')).toBe('');
    expect(() => git(batch, 'merge-base', '--is-ancestor', early, 'HEAD')).not.toThrow();
  });

  it('orders the same two PRs the same way in the other merge order', () => {
    const late = pr(36, baseSha, addAc('- AC4 from thirty-six'));
    const early = pr(37, baseSha, addAc('- AC3 from thirty-seven'));
    expect(runBatch([`36 ${late}`, `37 ${early}`]).code).toBe(0);
    const md = readFileSync(join(batch, 'docs/user-stories.md'), 'utf8');
    expect(md.indexOf('- AC3 from thirty-seven')).toBeLessThan(md.indexOf('- AC4 from thirty-six'));
  });

  it('orders a letter suffix after its number', () => {
    const a = pr(33, baseSha, addAc('- AC3b second'));
    const b = pr(34, baseSha, addAc('- AC3a first'));
    expect(runBatch([`33 ${a}`, `34 ${b}`]).code).toBe(0);
    const md = readFileSync(join(batch, 'docs/user-stories.md'), 'utf8');
    expect(md.indexOf('- AC3a first')).toBeLessThan(md.indexOf('- AC3b second'));
  });

  it('stops with exit 3 when the resolved stories change is not exactly the PR own lines, and undoes the merge', () => {
    // Both PRs add "- AC3 x" in different company: keeping each line once makes the merge add
    // fewer lines than the second PR's own diff, so the proof must refuse.
    const a = pr(38, baseSha, addAc('- AC3 x\n- AC5 y'));
    const b = pr(39, baseSha, addAc('- AC4 z\n- AC3 x'));
    const list = [`38 ${a}`, `39 ${b}`];
    const r = runBatch(list);
    expect(r.code).toBe(3);
    expect(r.err).toContain('#39');
    // Nothing of the unproven merge stays: no merge in progress, clean tree, PR 39 not in history.
    expect(existsSync(join(batch, '.git/MERGE_HEAD'))).toBe(false);
    expect(git(batch, 'status', '--porcelain')).toBe('');
    expect(() => git(batch, 'merge-base', '--is-ancestor', b, 'HEAD')).toThrow();
    expect(() => git(batch, 'merge-base', '--is-ancestor', a, 'HEAD')).not.toThrow();
    // A rerun refuses again rather than reporting "Already up to date".
    const before = git(batch, 'rev-parse', 'HEAD');
    expect(runBatch([`39 ${b}`], true).code).toBe(3);
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('stops with exit 2 when two PRs take the same next AC number in one story', () => {
    const a = pr(43, baseSha, addAc('- AC3 from forty-three'));
    const b = pr(44, baseSha, addAc('- AC3 from forty-four'));
    const r = runBatch([`43 ${a}`, `44 ${b}`]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('#44');
    expect(r.err).toContain('AC3');
  });

  it('stops with exit 2 when a PR adds an AC number its story already has', () => {
    const a = pr(45, baseSha, addAc('- AC3 from forty-five'));
    advanceMain((d) => {
      const p = join(d, 'docs/user-stories.md');
      writeFileSync(p, readFileSync(p, 'utf8').replace('- AC2 two', '- AC2 two\n- AC3 on main\n- AC4 on main'));
    });
    const r = runBatch([`45 ${a}`]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('#45');
  });

  it('refuses to start mid-merge or in an unclean worktree (exit 1)', () => {
    const sha = pr(47, baseSha, (d) => write(d, 'src/new.txt', 'new\n'));
    runBatch([`47 ${sha}`]);
    write(batch, 'src/b.txt', 'local edit\n');
    const dirty = runBatch([`47 ${sha}`], true);
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain('not clean');
    const a = pr(48, baseSha, (d) => write(d, 'src/a.txt', 'a1\nfrom 48\na3\n'));
    const b = pr(49, baseSha, (d) => write(d, 'src/a.txt', 'a1\nfrom 49\na3\n'));
    expect(runBatch([`48 ${a}`, `49 ${b}`]).code).toBe(2);
    const mid = runBatch([`48 ${a}`], true);
    expect(mid.code).toBe(1);
    expect(mid.err).toContain('in progress');
  });

  it('exits 4 when a git command fails, apart from a moved head', () => {
    const r = runBatch([`70 ${'a'.repeat(40)}`]); // origin has no refs/pull/70/head
    expect(r.code).toBe(4);
    expect(r.err).toContain('git failed');
  });

  it('stops with exit 2 when the stories conflict is not only added AC lines', () => {
    const a = pr(41, baseSha, (d) => {
      const p = join(d, 'docs/user-stories.md');
      writeFileSync(p, readFileSync(p, 'utf8').replace('# Stories', '# Stories by 41'));
    });
    const b = pr(42, baseSha, (d) => {
      const p = join(d, 'docs/user-stories.md');
      writeFileSync(p, readFileSync(p, 'utf8').replace('# Stories', '# Stories by 42'));
    });
    const r = runBatch([`41 ${a}`, `42 ${b}`]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('docs/user-stories.md');
    expect(r.err).toContain('#42');
    expect(existsSync(join(batch, '.git/MERGE_HEAD'))).toBe(true);
  });

  it('stops with exit 2 on a code conflict, naming the file and leaving the merge', () => {
    const a = pr(51, baseSha, (d) => write(d, 'src/a.txt', 'a1\nfrom 51\na3\n'));
    const b = pr(52, baseSha, (d) => write(d, 'src/a.txt', 'a1\nfrom 52\na3\n'));
    const r = runBatch([`51 ${a}`, `52 ${b}`]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('src/a.txt');
    expect(r.err).toContain('#52');
    expect(existsSync(join(batch, '.git/MERGE_HEAD'))).toBe(true);
  });

  it('refuses a head that moved since the review (exit 1) and merges nothing from it', () => {
    const reviewed = pr(61, baseSha, (d) => write(d, 'src/b.txt', 'reviewed\n'));
    pr(61, baseSha, (d) => write(d, 'src/b.txt', 'pushed after review\n')); // overwrites refs/pull/61/head
    const r = runBatch([`61 ${reviewed}`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('#61');
    expect(r.err).toContain('head moved');
    expect(readFileSync(join(batch, 'src/b.txt'), 'utf8')).toBe('b\n');
  });
});
