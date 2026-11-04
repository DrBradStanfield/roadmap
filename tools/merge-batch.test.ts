/**
 * US-64 AC13, AC15: tools/merge-batch.mjs builds a contributor batch. Every test runs the real script
 * in a scratch clone whose bare "origin" holds refs/pull/<n>/head, and checks what the caller
 * sees: exit code, stderr, the files and the history left behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function runBatch(lines: string[], keep = false, extra: string[] = []) {
  if (!keep) {
    git(batch, 'fetch', '-q', 'origin', 'main');
    git(batch, 'reset', '-q', '--hard', 'origin/main');
  }
  const list = join(root, 'list.txt');
  writeFileSync(list, lines.join('\n') + '\n');
  const t0 = Date.now();
  const r = spawnSync('node', [SCRIPT, list, ...extra], { cwd: batch, env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
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

  it('names git\'s own error when a merge fails with no conflicted file (US-64 AC17)', () => {
    const sha = pr(80, baseSha, (d) => write(d, 'src/new.txt', 'new\n'));
    runBatch([`80 ${sha}`]);
    git(batch, 'reset', '-q', '--hard', 'origin/main');
    // A held index lock fails the merge with nothing unmerged: the only evidence is git's message.
    writeFileSync(join(git(batch, 'rev-parse', '--absolute-git-dir'), 'index.lock'), '');
    const r = runBatch([`80 ${sha}`], true);
    expect(r.code).toBe(2);
    expect(r.err).toContain('merge failed with no conflicted file');
    expect(r.err).toContain('index.lock');
  });

  it('merges over an ignored local docs/user-stories.html the PR tracks and drops it (US-64 AC17)', () => {
    const sha = pr(81, baseSha, (d) => write(d, 'docs/user-stories.html', '<p>pr</p>\n'));
    advanceMain((d) => git(d, 'rm', '-q', 'docs/user-stories.html'));
    git(batch, 'fetch', '-q', 'origin', 'main');
    git(batch, 'reset', '-q', '--hard', 'origin/main');
    write(batch, '.gitignore', 'docs/user-stories.html\n');
    git(batch, 'add', '.gitignore');
    git(batch, 'commit', '-q', '-m', 'ignore it');
    write(batch, 'docs/user-stories.html', '<p>local build</p>\n');
    const r = runBatch([`81 ${sha}`], true);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(git(batch, 'ls-files', 'docs/user-stories.html')).toBe('');
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

  it('refuses a moved head on a later PR before any earlier PR merges (exit 1)', () => {
    const first = pr(62, baseSha, (d) => write(d, 'src/new.txt', 'new by 62\n'));
    const reviewed = pr(63, baseSha, (d) => write(d, 'src/b.txt', 'reviewed\n'));
    pr(63, baseSha, (d) => write(d, 'src/b.txt', 'pushed after review\n'));
    const r = runBatch([`62 ${first}`, `63 ${reviewed}`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('#63');
    expect(r.err).toContain('head moved');
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(git(batch, 'rev-parse', 'origin/main'));
  });

  it('keeps its exit code when stderr cannot be written (exit 4, not a crash in stop)', async () => {
    const list = join(root, 'list.txt');
    writeFileSync(list, `70 ${'a'.repeat(40)}\n`); // origin has no refs/pull/70/head: a git failure, exit 4
    const child = spawn('node', [SCRIPT, list], { cwd: batch, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.destroy(); // the reader is gone, so the script's stderr write fails with EPIPE
    const code = await new Promise((done) => child.on('exit', done));
    expect(code).toBe(4);
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

describe('merge-batch.mjs --skip and pre-flight (US-64 AC15)', () => {
  it('--skip builds the list without the skipped PR', () => {
    const a = pr(81, baseSha, (d) => write(d, 'src/b.txt', 'b by 81\n'));
    const c = pr(82, baseSha, (d) => write(d, 'src/new.txt', 'new by 82\n'));
    const r = runBatch([`81 ${a}`, `82 ${c}`], false, ['--skip', '81']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('PR #81');
    expect(readFileSync(join(batch, 'src/b.txt'), 'utf8')).toBe('b\n');
    expect(existsSync(join(batch, 'src/new.txt'))).toBe(true);
    expect(() => git(batch, 'merge-base', '--is-ancestor', a, 'HEAD')).toThrow();
    expect(() => git(batch, 'merge-base', '--is-ancestor', c, 'HEAD')).not.toThrow();
  });

  it('--skip refuses a PR number that is not in the list (exit 1) and merges nothing', () => {
    const a = pr(83, baseSha, (d) => write(d, 'src/b.txt', 'b by 83\n'));
    const r = runBatch([`83 ${a}`], false, ['--skip', '83,99']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('#99');
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(git(batch, 'rev-parse', 'origin/main'));
  });

  // Fixtures are assembled at run time, so this file is never secret-shaped itself.
  const pat = ['github', '_pat_', 'SYNT', 'HETIC0123456789'].join('');
  const q = (s: string) => `'${s}'`;
  const authKeyLine = `  ${q('ios/Auth' + 'Key_ABC123.p8')}, ${q('dist' + '-cert.p12')},`;

  it('pre-flight stops with exit 5 on a PAT-shaped string, naming file:line and rule but not the value', () => {
    const sha = pr(84, baseSha, (d) => write(d, 'src/fixture.ts', `// fixture\nconst sample = '${pat}';\n`));
    const r = runBatch([`84 ${sha}`]);
    expect(r.code).toBe(5);
    expect(r.err).toContain('src/fixture.ts:2 github_pat');
    expect(r.err).not.toContain(pat);
    // The batch commits stay for a human to fix the fixture.
    expect(() => git(batch, 'merge-base', '--is-ancestor', sha, 'HEAD')).not.toThrow();
  });

  it('pre-flight stops with exit 5 on the generic-api-key shape (the AuthKey line CI\'s gitleaks caught)', () => {
    const sha = pr(85, baseSha, (d) => write(d, 'src/files.ts', `const files = [\n${authKeyLine}\n];\n`));
    const r = runBatch([`85 ${sha}`]);
    expect(r.code).toBe(5);
    expect(r.err).toContain('src/files.ts:2 generic-api-key');
    expect(r.err).not.toContain('dist-cert');
  });

  it('pre-flight passes a plain test string', () => {
    const sha = pr(86, baseSha, (d) => write(d, 'src/plain.ts', "const label = 'plain test string';\nconst key = 'unitChoices.v1';\n"));
    const r = runBatch([`86 ${sha}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('pre-flight ok');
  });

  it('--skip refuses a kept PR whose head contains the skipped one (exit 1), naming both, before merging', () => {
    const a = pr(87, baseSha, (d) => write(d, 'src/b.txt', 'b by 87\n'));
    const c = pr(88, a, (d) => write(d, 'src/new.txt', 'new by 88\n')); // built on 87
    const r = runBatch([`87 ${a}`, `88 ${c}`], false, ['--skip', '87']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('#88');
    expect(r.err).toContain('#87');
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(git(batch, 'rev-parse', 'origin/main'));
  });

  it('--skip refuses a kept PR built on a skipped PR\'s middle commit (exit 1), naming both, before anything merges', () => {
    const free = pr(93, baseSha, (d) => write(d, 'src/free.txt', 'free\n')); // unrelated, listed first
    const a1 = pr(87, baseSha, (d) => write(d, 'src/b.txt', 'b by 87, first\n'));
    const a2 = pr(87, a1, (d) => write(d, 'src/b.txt', 'b by 87, second\n')); // 87's head is A2
    const c = pr(88, a1, (d) => write(d, 'src/new.txt', 'new by 88\n')); // built on A1, not on 87's head
    const r = runBatch([`93 ${free}`, `87 ${a2}`, `88 ${c}`], false, ['--skip', '87']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('#88');
    expect(r.err).toContain('#87');
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(git(batch, 'rev-parse', 'origin/main'));
  });

  /** Skipped PR 87 reviewed at A2 (on A1), then force-pushed onto an unrelated commit; kept PR 88 is built on A1. */
  function forcePushedSkip() {
    const a1 = pr(87, baseSha, (d) => write(d, 'src/b.txt', 'b by 87, first\n'));
    const a2 = pr(87, a1, (d) => write(d, 'src/b.txt', 'b by 87, second\n'));
    const c = pr(88, a1, (d) => write(d, 'src/new.txt', 'new by 88\n'));
    pr(87, baseSha, (d) => write(d, 'src/other.txt', 'rewritten 87\n')); // A2 is now on no PR ref
    return { a2, c };
  }

  it('--skip stops (exit 4, naming the PR) when a skipped PR\'s reviewed head cannot be fetched', () => {
    const { a2, c } = forcePushedSkip();
    git(origin, 'reflog', 'expire', '--expire=now', '--all');
    git(origin, 'gc', '-q', '--prune=now'); // A2 is gone from origin too
    const r = runBatch([`87 ${a2}`, `88 ${c}`], false, ['--skip', '87']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('#87');
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(git(batch, 'rev-parse', 'origin/main'));
  });

  it('--skip fetches a skipped PR\'s force-pushed reviewed head and still catches the shared commit', () => {
    const { a2, c } = forcePushedSkip();
    const r = runBatch([`87 ${a2}`, `88 ${c}`], false, ['--skip', '87']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('#88');
    expect(r.err).toContain('#87');
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(git(batch, 'rev-parse', 'origin/main'));
  });

  it('--skip still checks a skipped PR\'s current head after fetching its reviewed one by sha', () => {
    const reviewed = pr(87, baseSha, (d) => write(d, 'src/b.txt', 'b by 87, reviewed\n'));
    const now = pr(87, baseSha, (d) => write(d, 'src/other.txt', 'rewritten 87\n')); // reviewed is now on no ref
    const c = pr(88, now, (d) => write(d, 'src/new.txt', 'new by 88\n')); // built on 87's current head
    const r = runBatch([`87 ${reviewed}`, `88 ${c}`], false, ['--skip', '87']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('#88');
    expect(git(batch, 'rev-parse', 'HEAD')).toBe(git(batch, 'rev-parse', 'origin/main'));
  });

  it('--skip that leaves nothing to build exits 1', () => {
    const a = pr(89, baseSha, (d) => write(d, 'src/b.txt', 'b by 89\n'));
    const r = runBatch([`89 ${a}`], false, ['--skip', '89']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('nothing to build');
  });

  it('pre-flight finds a private key whose body is on the next line, at the header line', () => {
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----', '\n', 'MIIE', 'abcd'.repeat(10), '\n'].join('');
    const sha = pr(90, baseSha, (d) => write(d, 'src/key.txt', `intro\n${pem}`));
    const r = runBatch([`90 ${sha}`]);
    expect(r.code).toBe(5);
    expect(r.err).toContain('src/key.txt:2 private_key');
    expect(r.err).not.toContain('abcd');
  });

  it('pre-flight reports each credential at its own line, a private key starting mid-hunk included', () => {
    const pem = ['-----BEGIN ', 'PRIVATE KEY-----', '\n', 'MIIE', 'abcd'.repeat(10)].join('');
    // src/a.txt has three lines, so the added hunk starts at line 4.
    const body = ['plain', `const one = '${pat}';`, 'plain', pem, 'plain', `const two = '${pat}';`].join('\n');
    const sha = pr(94, baseSha, (d) => write(d, 'src/a.txt', `a1\na2\na3\n${body}\n`));
    const r = runBatch([`94 ${sha}`]);
    expect(r.code).toBe(5);
    const hits = r.err.split('\n').filter((l) => l.startsWith('src/a.txt:')).sort();
    expect(hits).toEqual(['src/a.txt:10 github_pat', 'src/a.txt:5 github_pat', 'src/a.txt:7 private_key']);
    expect(r.err).not.toContain(pat);
    expect(r.err).not.toContain('abcd');
  });

  it('pre-flight scans a 150,000-line hunk of credential shapes in linear time', () => {
    const lines = Array.from({ length: 150000 }, (_, i) => `v${i} ${pat}`).join('\n');
    const sha = pr(95, baseSha, (d) => write(d, 'src/big.txt', `${lines}\n`));
    const r = runBatch([`95 ${sha}`]);
    expect(r.code).toBe(5);
    expect(r.err).toContain('src/big.txt:1 github_pat');
    expect(r.err).toContain('src/big.txt:150000 github_pat'); // the whole report, not cut short at exit
    expect(r.err).not.toContain(pat);
    // Linear takes about a second here; the old per-match search took about 9x the 50,000-line case's 5 s.
    expect(r.ms).toBeLessThan(4000);
  }, 120000);

  /** The batch as a linked worktree of a main clone whose own hook is `hook`; main has two package folders. */
  function inWorktree(hook: string): { main: string; got: string } {
    const main = join(root, 'main-clone');
    git(root, 'clone', '-q', origin, main);
    write(main, '.claude/hooks/worktree-guard.cjs', hook);
    writeFileSync(join(main, '.git/info/exclude'), '.claude/hooks/\nnode_modules\n');
    mkdirSync(join(main, 'node_modules'));
    mkdirSync(join(main, 'widget-src/node_modules'), { recursive: true });
    batch = join(main, '.claude/worktrees/b');
    git(main, 'worktree', 'add', '-q', '--detach', batch, 'origin/main');
    return { main, got: join(main, '.claude/hooks/got.json') };
  }
  const RECORD = "const fs = require('fs'); const path = require('path'); const i = fs.readFileSync(0, 'utf8'); fs.writeFileSync(path.join(__dirname, 'got.json'), i);\n";

  it('pre-flight runs the main checkout hook for the worktree, never the batch tree copy', () => {
    const made = "for (const d of ['node_modules', 'widget-src/node_modules']) fs.mkdirSync(path.join(JSON.parse(i).cwd, d), { recursive: true });\n";
    const { got } = inWorktree(RECORD + made);
    const trap = join(root, 'trapped');
    const sha = pr(91, baseSha, (d) =>
      write(d, '.claude/hooks/worktree-guard.cjs', `require('fs').writeFileSync(${JSON.stringify(trap)}, 'ran');\n`),
    );
    const r = runBatch([`91 ${sha}`]);
    expect(r.code).toBe(0);
    expect(existsSync(trap)).toBe(false);
    const event = JSON.parse(readFileSync(got, 'utf8'));
    expect(event).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: realpathSync(batch) });
    expect(existsSync(join(batch, 'widget-src/node_modules'))).toBe(true);
    expect(r.out).not.toContain('run:');
  });

  it('pre-flight calls the hook when only some package folders exist, and prints the command for the rest', () => {
    const { main, got } = inWorktree(RECORD);
    mkdirSync(join(batch, 'node_modules'));
    const sha = pr(92, baseSha, (d) => write(d, 'src/new.txt', 'new by 92\n'));
    const r = runBatch([`92 ${sha}`]);
    expect(r.code).toBe(0);
    expect(existsSync(got)).toBe(true);
    expect(r.out).toContain('no widget-src/node_modules;');
    expect(r.out).toContain(`| node ${join(realpathSync(main), '.claude/hooks/worktree-guard.cjs')}`);
  });
});
