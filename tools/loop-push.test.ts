/**
 * US-64 AC39: `node tools/loop-push.mjs` pushes HEAD's one sha to origin's main only when every path it adds is a
 * loop's own (docs/loops/ minus Brad's files, plus docs/user-stories.md). Each test builds a bare remote and a clone
 * in a temp folder, runs the script there, and checks the remote's main afterwards, not just the exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'loop-push.mjs');
// The test remotes are local bare paths, which the script accepts only with this test-only variable, outside a cloud session.
const BASE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'CLAUDE_CODE_REMOTE')),
  LOOP_PUSH_TEST_ALLOW_LOCAL: '1',
};
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];

let dir = '';
let remote = '';
let work = '';

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...ID, ...args], { env: BASE_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Writes (string) or deletes (null) each file, then commits everything. Returns the new sha. */
function commit(cwd: string, files: Record<string, string | null>, msg = 'loop run'): string {
  for (const [p, body] of Object.entries(files)) {
    const f = join(cwd, p);
    if (body === null) rmSync(f);
    else { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); }
  }
  g(cwd, 'add', '-A');
  g(cwd, 'commit', '-q', '-m', msg);
  return g(cwd, 'rev-parse', 'HEAD');
}

function run(cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd, env: { ...BASE_ENV, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const remoteMain = (r = remote) => g(r, 'rev-parse', 'refs/heads/main');

function clone(name: string): string {
  const p = join(dir, name);
  execFileSync('git', [...ID, 'clone', '-q', remote, p], { env: BASE_ENV, stdio: 'ignore' });
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-push-'));
  remote = join(dir, 'remote.git');
  execFileSync('git', [...ID, 'init', '-q', '--bare', '-b', 'main', remote], { env: BASE_ENV });
  const seed = join(dir, 'seed');
  execFileSync('git', [...ID, 'init', '-q', '-b', 'main', seed], { env: BASE_ENV });
  commit(seed, {
    'docs/loops/LOOP.md': 'constitution\n', 'docs/loops/REGISTRY.md': 'registry\n', 'docs/loops/_TEMPLATE.md': 't\n',
    'docs/loops/x/LOOP.md': 'charter\n', 'docs/loops/x/ledger.csv': 'id,v\n1,a\n', 'docs/user-stories.md': '# stories\n',
    'app/a.ts': 'export {};\n',
  }, 'seed');
  g(seed, 'remote', 'add', 'origin', remote);
  g(seed, 'push', '-q', 'origin', 'main');
  work = clone('work');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function expectRefused(r: { status: number | null; out: string }, before: string, text: RegExp) {
  expect(r.status, r.out).not.toBe(0);
  expect(r.out).toMatch(text);
  expect(remoteMain()).toBe(before);
}

describe('loop-push: what lands (US-64 AC39)', () => {
  it('pushes a loop-only commit: LEARNINGS, changelog, ledger, a report', () => {
    const sha = commit(work, {
      'docs/loops/x/LEARNINGS.md': 'l\n', 'docs/loops/x/changelog.md': 'c\n',
      'docs/loops/x/ledger.csv': 'id,v\n1,a\n2,b\n', 'docs/loops/x/reports/2026-11-23.md': 'r\n',
    });
    const r = run(work);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`pushed ${sha} to main (4 paths)`);
    expect(remoteMain()).toBe(sha);
  });

  it('pushes docs/user-stories.md', () => {
    const sha = commit(work, { 'docs/user-stories.md': '# stories\n- AC1\n' });
    expect(run(work).status).toBe(0);
    expect(remoteMain()).toBe(sha);
  });

  it('nothing to push exits 0 and leaves main alone', () => {
    const before = remoteMain();
    const r = run(work);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('nothing to push');
    expect(remoteMain()).toBe(before);
  });

  it('pushes from a detached HEAD', () => {
    g(work, 'checkout', '-q', '--detach');
    const sha = commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    expect(run(work).status).toBe(0);
    expect(remoteMain()).toBe(sha);
  });

  it("pushes HEAD's sha when the local branch main is stale", () => {
    const stale = g(work, 'rev-parse', 'main');
    g(work, 'switch', '-q', '-c', 'loopwork');
    const sha = commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    expect(g(work, 'rev-parse', 'main')).toBe(stale);
    expect(run(work).status).toBe(0);
    expect(remoteMain()).toBe(sha);
  });

  it('after a separate fetch and merge of origin/main (main gained app/y.ts; a CSV conflict resolved), pushes', () => {
    const other = clone('other');
    commit(other, { 'app/y.ts': 'export {};\n', 'docs/loops/x/ledger.csv': 'id,v\n1,a\n2,main\n' }, 'main moves');
    g(other, 'push', '-q', 'origin', 'main');
    commit(work, { 'docs/loops/x/ledger.csv': 'id,v\n1,a\n2,loop\n' });
    expectRefused(run(work), remoteMain(), /main has moved/);
    g(work, 'fetch', '-q', 'origin', 'main');
    expect(spawnSync('git', ['-C', work, ...ID, 'merge', '--no-edit', 'origin/main'], { env: BASE_ENV }).status).not.toBe(0);
    writeFileSync(join(work, 'docs/loops/x/ledger.csv'), 'id,v\n1,a\n2,main\n3,loop\n');
    g(work, 'add', '-A');
    g(work, 'commit', '-q', '--no-edit');
    const sha = g(work, 'rev-parse', 'HEAD');
    const r = run(work);
    expect(r.status, r.out).toBe(0);
    expect(remoteMain()).toBe(sha);
  });
});

describe('loop-push: what it refuses (US-64 AC39)', () => {
  it('refuses app/x.ts', () => {
    const before = remoteMain();
    commit(work, { 'app/x.ts': 'evil\n' });
    expectRefused(run(work), before, /outside a loop's scope: app\/x\.ts/);
  });

  it('refuses a mixed commit, naming the out-of-scope path', () => {
    const before = remoteMain();
    commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n', 'app/x.ts': 'evil\n' });
    const r = run(work);
    expectRefused(r, before, /app\/x\.ts/);
    expect(r.out).not.toMatch(/LEARNINGS/);
  });

  for (const p of ['docs/loops/x/LOOP.md', 'docs/loops/REGISTRY.md', 'docs/loops/LOOP.md', 'docs/loops/_TEMPLATE.md', 'docs/loops/loop.md']) {
    it(`refuses Brad's file ${p}`, () => {
      const before = remoteMain();
      commit(work, { [p]: 'relaxed\n' });
      expectRefused(run(work), before, /Brad's file/);
    });
  }

  it('refuses docs/blog/x.md', () => {
    const before = remoteMain();
    commit(work, { 'docs/blog/x.md': 'b\n' });
    expectRefused(run(work), before, /docs\/blog\/x\.md/);
  });

  it('refuses when main has moved, with the fetch-and-merge advice', () => {
    const other = clone('other');
    const moved = commit(other, { 'app/y.ts': 'y\n' }, 'main moves');
    g(other, 'push', '-q', 'origin', 'main');
    commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    expectRefused(run(work), moved, /main has moved: run `git fetch origin main` and `git merge --no-edit origin\/main`/);
  });

  it('refuses a file added then removed in a later commit', () => {
    const before = remoteMain();
    commit(work, { 'app/x.ts': 'evil\n' });
    commit(work, { 'app/x.ts': null, 'docs/loops/x/LEARNINGS.md': 'l\n' });
    expectRefused(run(work), before, /app\/x\.ts/);
  });

  it('refuses a gitlink at app/sub and one inside docs/loops, even with diff.ignoreSubmodules=all', () => {
    const before = remoteMain();
    g(work, 'config', 'diff.ignoreSubmodules', 'all');
    g(work, 'update-index', '--add', '--cacheinfo', `160000,${before},app/sub`);
    g(work, 'update-index', '--add', '--cacheinfo', `160000,${before},docs/loops/x/sub`);
    g(work, 'commit', '-q', '-m', 'gitlinks');
    const r = run(work);
    expectRefused(r, before, /app\/sub/);
    expect(r.out).toMatch(/docs\/loops\/x\/sub \(a gitlink\)/);
  });

  it('refuses a symlink inside docs/loops', () => {
    const before = remoteMain();
    symlinkSync('../../../app/a.ts', join(work, 'docs/loops/x/link.md'));
    commit(work, {});
    expectRefused(run(work), before, /docs\/loops\/x\/link\.md \(a symlink\)/);
  });

  it('a refs/main shadow does not hide app content at HEAD', () => {
    const before = remoteMain();
    const clean = commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    commit(work, { 'app/x.ts': 'evil\n' });
    g(work, 'update-ref', 'refs/main', clean);
    expectRefused(run(work), before, /app\/x\.ts/);
  });

  it('git replace of an evil commit by a clean one is ignored, and the evil one refused', () => {
    const before = remoteMain();
    const evil = commit(work, { 'app/x.ts': 'evil\n' });
    g(work, 'checkout', '-q', '--detach', before);
    const clean = commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    g(work, 'checkout', '-q', 'main');
    g(work, 'replace', evil, clean);
    expect(g(work, 'log', '-1', '--format=%s%n', '--name-only')).toContain('LEARNINGS');
    expectRefused(run(work), before, /app\/x\.ts/);
  });

  it('refuses a merge that brings in app/x.ts, even when a later merge removes it', () => {
    const before = remoteMain();
    const other = clone('other');
    commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    commit(other, { 'app/y.ts': 'y\n' }, 'main moves');
    g(other, 'push', '-q', 'origin', 'main');
    g(work, 'fetch', '-q', 'origin', 'main');
    g(work, 'merge', '-q', '--no-commit', '--no-ff', 'origin/main');
    mkdirSync(join(work, 'app'), { recursive: true });
    writeFileSync(join(work, 'app/x.ts'), 'evil\n');
    g(work, 'add', '-A');
    g(work, 'commit', '-q', '--no-edit');
    const moved = commit(other, { 'app/z.ts': 'z\n' }, 'main moves again');
    g(other, 'push', '-q', 'origin', 'main');
    g(work, 'fetch', '-q', 'origin', 'main');
    g(work, 'merge', '-q', '--no-commit', '--no-ff', 'origin/main');
    g(work, 'rm', '-q', 'app/x.ts');
    g(work, 'commit', '-q', '--no-edit');
    expect(g(work, 'diff', '--name-only', 'origin/main', 'HEAD')).toBe('docs/loops/x/LEARNINGS.md');
    expect(before).not.toBe(moved);
    expectRefused(run(work), moved, /outside a loop's scope: app\/x\.ts/);
  });

  it('refuses an ext:: origin before any transport runs', () => {
    const before = remoteMain();
    const marker = join(dir, 'ext-marker');
    g(work, 'remote', 'set-url', 'origin', `ext::sh -c touch% ${marker}`);
    commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    expectRefused(run(work), before, /origin must be an https:\/\/ or ssh URL/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a file:// origin, even with the test variable set', () => {
    const before = remoteMain();
    g(work, 'remote', 'set-url', 'origin', `file://${remote}`);
    commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    expectRefused(run(work), before, /origin must be an https:\/\/ or ssh URL/);
  });

  for (const [label, env] of [['without the test variable', { LOOP_PUSH_TEST_ALLOW_LOCAL: '' }], ['in a cloud session', { CLAUDE_CODE_REMOTE: 'true' }]] as const) {
    it(`refuses a local-path origin ${label}`, () => {
      const before = remoteMain();
      commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
      expectRefused(run(work, [], env), before, /origin must be an https:\/\/ or ssh URL/);
    });
  }

  it('refuses when the push URL differs from the fetch URL, and neither remote moves', () => {
    const before = remoteMain();
    const other = join(dir, 'other.git');
    execFileSync('git', [...ID, 'clone', '-q', '--bare', remote, other], { env: BASE_ENV });
    g(work, 'remote', 'set-url', '--push', 'origin', other);
    commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    expectRefused(run(work), before, /push URL differs/);
    expect(remoteMain(other)).toBe(before);
  });

  for (const [key, value] of [['remote.origin.receivepack', 'git-receive-pack'], ['remote.origin.uploadpack', 'git-upload-pack'], ['core.sshCommand', 'ssh']]) {
    it(`refuses when ${key} is set`, () => {
      const before = remoteMain();
      g(work, 'config', key, value);
      commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
      expectRefused(run(work), before, new RegExp(`${key.replace('.', '\\.')} is set`));
    });
  }

  it('never runs a hook: pre-push, or reference-transaction (which --no-verify does not skip), here or under core.hooksPath', () => {
    const marker = join(dir, 'marker');
    const sha = commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
    for (const hooks of [join(work, '.git', 'hooks'), join(dir, 'hooks')]) {
      mkdirSync(hooks, { recursive: true });
      for (const hook of ['pre-push', 'reference-transaction']) {
        writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> '${marker}'\nexit 1\n`);
        chmodSync(join(hooks, hook), 0o755);
      }
    }
    g(work, 'config', 'core.hooksPath', join(dir, 'hooks'));
    const r = run(work);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(remoteMain()).toBe(sha);
  });

  it('ignores GIT_DIR and GIT_WORK_TREE pointing at another repo', () => {
    const evilRepo = clone('evil');
    const evil = commit(evilRepo, { 'docs/loops/x/LEARNINGS.md': 'evil repo\n' });
    const sha = commit(work, { 'docs/loops/x/LEARNINGS.md': 'work repo\n' });
    const r = run(work, [], { GIT_DIR: join(evilRepo, '.git'), GIT_WORK_TREE: evilRepo });
    expect(r.status, r.out).toBe(0);
    expect(remoteMain()).toBe(sha);
    expect(remoteMain()).not.toBe(evil);
    expect(readFileSync(join(work, 'docs/loops/x/LEARNINGS.md'), 'utf8')).toBe('work repo\n');
  });

  for (const args of [['--force'], ['HEAD'], ['']]) {
    it(`refuses any argument (${JSON.stringify(args)})`, () => {
      const before = remoteMain();
      commit(work, { 'docs/loops/x/LEARNINGS.md': 'l\n' });
      expectRefused(run(work, args), before, /takes no arguments/);
    });
  }
});

describe('loop-push: the allow rule (US-64 AC39)', () => {
  it('settings.json allows the script exactly, with no argument wildcard, and allows no git push', () => {
    const settings = JSON.parse(readFileSync(join(dirname(SCRIPT), '..', '.claude', 'settings.json'), 'utf8'));
    const allow: string[] = settings.permissions.allow;
    expect(allow).toContain('Bash(node tools/loop-push.mjs)');
    expect(allow.filter((r) => /loop-push/.test(r))).toEqual(['Bash(node tools/loop-push.mjs)']);
    expect(allow.filter((r) => /git\s+push/.test(r))).toEqual([]);
  });
});
