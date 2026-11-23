/**
 * US-64 AC39: `node tools/loop-push.mjs` pushes HEAD's one sha to origin's main only when every path it adds is a
 * loop's own (docs/loops/ minus Brad's files, plus docs/user-stories.md). Each test builds a bare remote and a clone
 * in a temp folder whose main holds this script, runs `node tools/loop-push.mjs` there with a temp HOME, and checks
 * the remote's main afterwards, not just the exit code.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, symlinkSync, copyFileSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'loop-push.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];

let dir = '';
let remote = '';
let work = '';

/** No GIT_* and no cloud flag; a temp HOME so global config is the test's; the test-only local-remote variable. */
function env(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'CLAUDE_CODE_REMOTE')),
    HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'xdg'), LOOP_PUSH_TEST_ALLOW_LOCAL: '1',
  };
}

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...ID, ...args], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function run(cwd: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('node', ['tools/loop-push.mjs', ...args], { cwd, env: { ...env(), ...extra }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const remoteMain = (r = remote) => g(r, 'rev-parse', 'refs/heads/main');

function clone(name: string): string {
  const p = join(dir, name);
  execFileSync('git', [...ID, 'clone', '-q', remote, p], { env: env(), stdio: 'ignore' });
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-push-'));
  mkdirSync(join(dir, 'home'));
  remote = join(dir, 'remote.git');
  execFileSync('git', [...ID, 'init', '-q', '--bare', '-b', 'main', remote], { env: env() });
  const seed = join(dir, 'seed');
  execFileSync('git', [...ID, 'init', '-q', '-b', 'main', seed], { env: env() });
  commit(seed, {
    'docs/loops/LOOP.md': 'constitution\n', 'docs/loops/REGISTRY.md': 'registry\n', 'docs/loops/_TEMPLATE.md': 't\n',
    'docs/loops/x/LOOP.md': 'charter\n', 'docs/loops/x/ledger.csv': 'id,v\n1,a\n', 'docs/user-stories.md': '# stories\n',
    'app/a.ts': 'export const a = 1;\n', 'tools/loop-push.mjs': readFileSync(SCRIPT, 'utf8'),
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

/** Main moves on the remote by another clone's commit. Returns the new main sha. */
function moveMain(files: Record<string, string | null>, name = 'other'): string {
  const other = existsSync(join(dir, name)) ? join(dir, name) : clone(name);
  g(other, 'pull', '-q', '--ff-only', 'origin', 'main');
  const sha = commit(other, files, 'main moves');
  g(other, 'push', '-q', 'origin', 'main');
  return sha;
}

const loopFile = { 'docs/loops/x/LEARNINGS.md': 'l\n' };

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

  it('HEAD behind main: nothing to push, exit 0, main untouched', () => {
    const moved = moveMain({ 'app/y.ts': 'y\n' });
    const r = run(work);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('nothing to push (HEAD is behind main)');
    expect(remoteMain()).toBe(moved);
  });

  it('pushes from a detached HEAD', () => {
    g(work, 'checkout', '-q', '--detach');
    const sha = commit(work, loopFile);
    expect(run(work).status).toBe(0);
    expect(remoteMain()).toBe(sha);
  });

  it("pushes HEAD's sha when the local branch main is stale", () => {
    const stale = g(work, 'rev-parse', 'main');
    g(work, 'switch', '-q', '-c', 'loopwork');
    const sha = commit(work, loopFile);
    expect(g(work, 'rev-parse', 'main')).toBe(stale);
    expect(run(work).status).toBe(0);
    expect(remoteMain()).toBe(sha);
  });

  it('after a separate fetch and merge of origin/main (main gained app/y.ts; a CSV conflict resolved), pushes', () => {
    moveMain({ 'app/y.ts': 'export {};\n', 'docs/loops/x/ledger.csv': 'id,v\n1,a\n2,main\n' });
    commit(work, { 'docs/loops/x/ledger.csv': 'id,v\n1,a\n2,loop\n' });
    expectRefused(run(work), remoteMain(), /main has moved/);
    g(work, 'fetch', '-q', 'origin', 'main');
    expect(spawnSync('git', ['-C', work, ...ID, 'merge', '--no-edit', 'origin/main'], { env: env() }).status).not.toBe(0);
    writeFileSync(join(work, 'docs/loops/x/ledger.csv'), 'id,v\n1,a\n2,main\n3,loop\n');
    g(work, 'add', '-A');
    g(work, 'commit', '-q', '--no-edit');
    const sha = g(work, 'rev-parse', 'HEAD');
    const r = run(work);
    expect(r.status, r.out).toBe(0);
    expect(remoteMain()).toBe(sha);
  });

  it('pushes from a shallow clone, after a separate fetch and merge', () => {
    for (let i = 2; i <= 4; i++) moveMain({ 'app/a.ts': `export const a = ${i};\n` });
    const shallow = join(dir, 'shallow');
    execFileSync('git', [...ID, 'clone', '-q', '--depth', '1', `file://${remote}`, shallow], { env: env(), stdio: 'ignore' });
    g(shallow, 'remote', 'set-url', 'origin', remote);
    expect(existsSync(join(shallow, '.git', 'shallow'))).toBe(true);
    commit(shallow, { 'docs/loops/x/ledger.csv': 'id,v\n1,a\n2,loop\n' });
    moveMain({ 'app/a.ts': 'export const a = 5;\n' });
    expectRefused(run(shallow), remoteMain(), /main has moved/);
    g(shallow, 'fetch', '-q', 'origin', 'main');
    g(shallow, 'merge', '-q', '--no-edit', 'origin/main');
    const sha = g(shallow, 'rev-parse', 'HEAD');
    const r = run(shallow);
    expect(r.status, r.out).toBe(0);
    expect(remoteMain()).toBe(sha);
  });

  it('runs no hook: pre-push, or reference-transaction (which --no-verify does not skip)', () => {
    const marker = join(dir, 'marker');
    const sha = commit(work, loopFile);
    for (const hook of ['pre-push', 'reference-transaction']) {
      writeFileSync(join(work, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> '${marker}'\nexit 1\n`);
      chmodSync(join(work, '.git', 'hooks', hook), 0o755);
    }
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
  });
});

describe('loop-push: scope (US-64 AC39)', () => {
  it('refuses app/x.ts', () => {
    const before = remoteMain();
    commit(work, { 'app/x.ts': 'evil\n' });
    expectRefused(run(work), before, /outside a loop's scope: app\/x\.ts/);
  });

  it('refuses a mixed commit, naming the out-of-scope path', () => {
    const before = remoteMain();
    commit(work, { ...loopFile, 'app/x.ts': 'evil\n' });
    const r = run(work);
    expectRefused(r, before, /app\/x\.ts/);
    expect(r.out).not.toMatch(/LEARNINGS/);
  });

  for (const p of ['docs/loops/x/LOOP.md', 'docs/loops/REGISTRY.md', 'docs/loops/LOOP.md', 'docs/loops/_TEMPLATE.md',
    'docs/loops/loop.md', 'docs/loops/a/b/LOOP.md', 'docs/loops/x/notes/loop.md',
    'docs/loops/chat-health/lint-allowlist.json', 'docs/loops/x/sub/Lint-Allowlist.json']) {
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
    const moved = moveMain({ 'app/y.ts': 'y\n' });
    commit(work, loopFile);
    expectRefused(run(work), moved, /main has moved: run `git fetch origin main` and `git merge --no-edit origin\/main`/);
  });

  it('refuses a file added then removed in a later commit', () => {
    const before = remoteMain();
    commit(work, { 'app/x.ts': 'evil\n' });
    commit(work, { 'app/x.ts': null, ...loopFile });
    expectRefused(run(work), before, /app\/x\.ts/);
  });

  it('refuses a merge that brings in app/x.ts, even when a later merge removes it', () => {
    commit(work, loopFile);
    moveMain({ 'app/y.ts': 'y\n' });
    g(work, 'fetch', '-q', 'origin', 'main');
    g(work, 'merge', '-q', '--no-commit', '--no-ff', 'origin/main');
    mkdirSync(join(work, 'app'), { recursive: true });
    writeFileSync(join(work, 'app/x.ts'), 'evil\n');
    g(work, 'add', '-A');
    g(work, 'commit', '-q', '--no-edit');
    const moved = moveMain({ 'app/z.ts': 'z\n' });
    g(work, 'fetch', '-q', 'origin', 'main');
    g(work, 'merge', '-q', '--no-commit', '--no-ff', 'origin/main');
    g(work, 'rm', '-q', 'app/x.ts');
    g(work, 'commit', '-q', '--no-edit');
    expect(g(work, 'diff', '--name-only', 'origin/main', 'HEAD')).toBe('docs/loops/x/LEARNINGS.md');
    expectRefused(run(work), moved, /outside a loop's scope: app\/x\.ts/);
  });

  it("refuses a merge that quietly takes an older main's app/a.ts (caught only by the net change)", () => {
    const old = remoteMain();
    const moved = moveMain({ 'app/a.ts': 'export const a = 2;\n' });
    g(work, 'pull', '-q', '--ff-only', 'origin', 'main');
    const loop = commit(work, loopFile);
    g(work, 'checkout', '-q', `${old}`, '--', 'app/a.ts');
    g(work, 'add', '-A');
    const tree = g(work, 'write-tree');
    const merge = g(work, 'commit-tree', tree, '-p', loop, '-p', old, '-m', 'merge');
    g(work, 'reset', '-q', '--hard', merge);
    expectRefused(run(work), moved, /outside a loop's scope: app\/a\.ts/);
  });

  it('refuses a gitlink at app/sub and one inside docs/loops', () => {
    const before = remoteMain();
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
    const clean = commit(work, loopFile);
    commit(work, { 'app/x.ts': 'evil\n' });
    g(work, 'update-ref', 'refs/main', clean);
    expectRefused(run(work), before, /app\/x\.ts/);
  });

  it('git replace of an evil commit by a clean one is ignored, and the evil one refused', () => {
    const before = remoteMain();
    const evil = commit(work, { 'app/x.ts': 'evil\n' });
    g(work, 'checkout', '-q', '--detach', before);
    const clean = commit(work, loopFile);
    g(work, 'checkout', '-q', 'main');
    g(work, 'replace', evil, clean);
    expect(g(work, 'log', '-1', '--format=%s%n', '--name-only')).toContain('LEARNINGS');
    expectRefused(run(work), before, /app\/x\.ts/);
  });
});

describe('loop-push: the repo and its config (US-64 AC39)', () => {
  it('refuses a grafts file that makes an orphan look like a child of main; main keeps its history', () => {
    const before = remoteMain();
    g(work, 'checkout', '-q', '--orphan', 'evil');
    g(work, 'rm', '-q', '-r', '--cached', '.');
    rmSync(join(work, 'app'), { recursive: true });
    const orphan = commit(work, { 'docs/loops/new.md': 'x\n', 'tools/loop-push.mjs': readFileSync(SCRIPT, 'utf8') }, 'orphan');
    writeFileSync(join(work, '.git', 'info', 'grafts'), `${orphan} ${before}\n`);
    expect(spawnSync('git', ['-C', work, 'merge-base', '--is-ancestor', before, orphan], { env: env() }).status).toBe(0);
    expectRefused(run(work), before, /grafts file/);
    expect(g(remote, 'merge-base', '--is-ancestor', before, 'refs/heads/main')).toBe('');
  });

  it('refuses alternates with core.alternateRefsCommand, and never runs the command', () => {
    const before = remoteMain();
    const marker = join(dir, 'PWNED_ALT');
    execFileSync('git', ['init', '-q', '--bare', join(dir, 'other.git')], { env: env() });
    writeFileSync(join(work, '.git', 'objects', 'info', 'alternates'), `${join(dir, 'other.git', 'objects')}\n`);
    g(work, 'config', 'core.alternateRefsCommand', `touch ${marker}; true`);
    commit(work, loopFile);
    expectRefused(run(work), before, /local core\.alternaterefscommand/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses an alternates file alone', () => {
    const before = remoteMain();
    execFileSync('git', ['init', '-q', '--bare', join(dir, 'other.git')], { env: env() });
    commit(work, loopFile);
    writeFileSync(join(work, '.git', 'objects', 'info', 'alternates'), `${join(dir, 'other.git', 'objects')}\n`);
    expectRefused(run(work), before, /alternate object stores/);
  });

  it('refuses remote.origin.vcs, and never runs the git-remote helper on PATH', () => {
    const before = remoteMain();
    const bin = join(dir, 'bin');
    const marker = join(dir, 'PWNED_VCS');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git-remote-evil'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(bin, 'git-remote-evil'), 0o755);
    g(work, 'config', 'remote.origin.vcs', 'evil');
    commit(work, loopFile);
    expectRefused(run(work, [], { PATH: `${bin}:${process.env.PATH}` }), before, /local remote\.origin\.vcs/);
    expect(existsSync(marker)).toBe(false);
  });

  const configCases: [string, () => void, RegExp][] = [
    ['a local key', () => g(work, 'config', 'diff.ignoreSubmodules', 'all'), /local diff\.ignoresubmodules/],
    ['a local include.path', () => g(work, 'config', 'include.path', join(dir, 'inc')), /local include\.path/],
    ['a local pushurl', () => g(work, 'config', 'remote.origin.pushurl', join(dir, 'other.git')), /local remote\.origin\.pushurl/],
    ['a local core.hooksPath', () => g(work, 'config', 'core.hooksPath', join(dir, 'hooks')), /local core\.hookspath/],
    ['a global credential.helper', () => writeFileSync(join(dir, 'home', '.gitconfig'), '[credential]\n\thelper = !touch x\n'), /global credential\.helper/],
    ['a global url.insteadOf (XDG)', () => {
      mkdirSync(join(dir, 'xdg', 'git'), { recursive: true });
      writeFileSync(join(dir, 'xdg', 'git', 'config'), `[url "${join(dir, 'other.git')}"]\n\tinsteadOf = ${remote}\n`);
    }, /global url\..*\.insteadof/],
  ];
  for (const key of ['remote.origin.receivepack', 'remote.origin.uploadpack', 'core.sshCommand', 'protocol.ext.allow', 'core.fsmonitor', 'core.askPass']) {
    configCases.push([`local ${key}`, () => g(work, 'config', key, 'x'), new RegExp(`local ${key.toLowerCase().replace(/\./g, '\\.')}`)]);
  }
  for (const [label, set, text] of configCases) {
    it(`refuses ${label}, naming scope and key`, () => {
      const before = remoteMain();
      commit(work, loopFile);
      set();
      expectRefused(run(work), before, text);
    });
  }

  it('refuses an ext:: origin before any transport runs', () => {
    const before = remoteMain();
    const marker = join(dir, 'ext-marker');
    g(work, 'remote', 'set-url', 'origin', `ext::sh -c touch% ${marker}`);
    commit(work, loopFile);
    expectRefused(run(work), before, /origin must be an https:\/\/ or ssh URL/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a file:// origin, even with the test variable set', () => {
    const before = remoteMain();
    g(work, 'remote', 'set-url', 'origin', `file://${remote}`);
    commit(work, loopFile);
    expectRefused(run(work), before, /origin must be an https:\/\/ or ssh URL/);
  });

  for (const [label, extra] of [['without the test variable', { LOOP_PUSH_TEST_ALLOW_LOCAL: '' }], ['in a cloud session', { CLAUDE_CODE_REMOTE: 'true' }]] as const) {
    it(`refuses a local-path origin ${label}`, () => {
      const before = remoteMain();
      commit(work, loopFile);
      expectRefused(run(work, [], extra), before, /origin must be an https:\/\/ or ssh URL/);
    });
  }

  it('refuses a copy of the script run from another folder', () => {
    const before = remoteMain();
    const sub = join(work, 'docs/loops/x');
    mkdirSync(join(sub, 'tools'), { recursive: true });
    copyFileSync(SCRIPT, join(sub, 'tools', 'loop-push.mjs'));
    expectRefused(run(sub), before, /run it from the repo's top folder/);
  });

  it("refuses an edited copy of the script (it differs from main's)", () => {
    const before = remoteMain();
    commit(work, loopFile);
    appendFileSync(join(work, 'tools', 'loop-push.mjs'), '// edited\n');
    expectRefused(run(work), before, /this copy differs from main's/);
  });

  for (const args of [['--force'], ['HEAD'], ['']]) {
    it(`refuses any argument (${JSON.stringify(args)})`, () => {
      const before = remoteMain();
      commit(work, loopFile);
      expectRefused(run(work, args), before, /takes no arguments/);
    });
  }
});

describe('loop-push: the allow rule (US-64 AC39)', () => {
  it('settings.json allows the script exactly, with no argument wildcard, and allows no git push', () => {
    const settings = JSON.parse(readFileSync(join(dirname(SCRIPT), '..', '.claude', 'settings.json'), 'utf8'));
    const allow: string[] = settings.permissions.allow;
    expect(allow.filter((r) => /loop-push/.test(r))).toEqual(['Bash(node tools/loop-push.mjs)']);
    expect(allow.filter((r) => /git\s+push/.test(r))).toEqual([]);
  });
});
