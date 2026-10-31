/**
 * US-63: the worktree workflow (docs/git-workflow.md, Brad 2026-10-31): .claude/hooks/worktree-guard.cjs and
 * tools/worktree-new.sh / worktree-done.sh, run against a throwaway repo with a local bare remote.
 * A stub `gh` on PATH answers the PR questions: GH_COUNT (open PRs for the Stop check) and GH_STATE
 * (the PR state worktree-done.sh reads); GH_FAIL makes it fail. The guard finds the main checkout it protects
 * from its own place, so each case runs a copy installed in the throwaway repo's .claude/hooks/.
 *
 * Housekeeping (no user-facing behaviour). Each case checks what the harness sees: the hook's JSON
 * decision, or the script's exit code and what it left on disk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_SRC = join(ROOT, '.claude/hooks/worktree-guard.cjs');
const NEW = join(ROOT, 'tools/worktree-new.sh');
const DONE = join(ROOT, 'tools/worktree-done.sh');

let S: string; // scratch root (real path)
let MAIN: string; // the "main checkout"
let BIN: string; // stub gh
let ENV: NodeJS.ProcessEnv;
let GUARD: string; // the guard as installed in MAIN

// Install the guard in a checkout, where settings.json would run it from.
function installGuard(checkout: string) {
  mkdirSync(join(checkout, '.claude/hooks'), { recursive: true });
  copyFileSync(GUARD_SRC, join(checkout, '.claude/hooks/worktree-guard.cjs'));
  return join(checkout, '.claude/hooks/worktree-guard.cjs');
}
const countFiles = (dir: string) => Number(spawnSync('sh', ['-c', `find "${dir}" -type f | wc -l`], { encoding: 'utf8' }).stdout.trim());

function sh(cwd: string, cmd: string, extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...ENV, ...extra } });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function hook(payload: Record<string, unknown>, extra: NodeJS.ProcessEnv = {}, guard = GUARD) {
  const r = spawnSync('node', [guard], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...ENV, ...extra } });
  expect(r.status).toBe(0);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const edit = (file: string, extra: NodeJS.ProcessEnv = {}, tool = 'Edit', cwd = MAIN) =>
  hook({ hook_event_name: 'PreToolUse', tool_name: tool, cwd,
    tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } }, extra);
const denied = (o: unknown) => (o as { hookSpecificOutput?: { permissionDecision?: string } } | null)
  ?.hookSpecificOutput?.permissionDecision === 'deny';
const stop = (cwd: string, extra: NodeJS.ProcessEnv = {}, active = false, guard = GUARD) =>
  hook({ hook_event_name: 'Stop', cwd, stop_hook_active: active }, extra, guard);

function newWorktree(name: string) {
  const r = spawnSync('sh', [NEW, name], { cwd: MAIN, encoding: 'utf8', env: ENV });
  return { ...r, path: r.stdout.trim() };
}
const done = (name: string, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync('bash', [DONE, name], { cwd: MAIN, encoding: 'utf8', env: { ...ENV, ...extra } });
const gitDirOf = (wt: string) => spawnSync('git', ['-C', wt, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8', env: ENV }).stdout.trim();

beforeAll(() => {
  S = realpathSync(mkdtempSync(join(tmpdir(), 'wt-guard-')));
  BIN = join(S, 'bin');
  mkdirSync(BIN);
  writeFileSync(join(BIN, 'gh'), '#!/bin/sh\n[ -n "$GH_FAIL" ] && exit 1\n'
    + 'case "$*" in *length*) echo "${GH_COUNT:-0}";; *) echo "${GH_STATE:-}";; esac\n');
  chmodSync(join(BIN, 'gh'), 0o755);
  // cp passes through to the real one, unless CP_FAIL asks it to fail (a disk or OS with no clone support).
  writeFileSync(join(BIN, 'cp'), `#!/bin/sh\n[ -n "$CP_FAIL" ] && exit 1\nexec ${spawnSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim()} "$@"\n`);
  chmodSync(join(BIN, 'cp'), 0o755);
  ENV = {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH}`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  delete ENV.CLAUDE_CODE_REMOTE;
  delete ENV.CLAUDE_MAIN_CHECKOUT_WRITES;
  MAIN = join(S, 'main');
  sh(S, 'git init -q --bare -b main remote.git && git clone -q remote.git main 2>/dev/null');
  writeFileSync(join(MAIN, '.gitignore'), 'node_modules/\ntmp/\n.claude/*\n');
  writeFileSync(join(MAIN, 'tracked.txt'), 'one\n');
  mkdirSync(join(MAIN, 'widget-src'));
  writeFileSync(join(MAIN, 'widget-src/a.ts'), 'x\n');
  sh(MAIN, 'git add -A && git commit -q -m one && git push -q origin main');
  GUARD = installGuard(MAIN);
  // Installed packages exist only in the main checkout, as in real life.
  for (const d of ['node_modules', 'widget-src/node_modules']) mkdirSync(join(MAIN, d, 'pkg'), { recursive: true });
  // A stray self-link, as the real main checkout has (node_modules/node_modules -> node_modules).
  symlinkSync(join(MAIN, 'node_modules'), join(MAIN, 'node_modules/node_modules'));
}, 60_000);
afterAll(() => rmSync(S, { recursive: true, force: true }));

describe('worktree-guard.cjs: edits (US-63 AC1)', () => {
  it('denies an edit to a tracked file in the main checkout', () => {
    expect(denied(edit(join(MAIN, 'tracked.txt')))).toBe(true);
  });
  it('denies a new, trackable file in the main checkout', () => {
    expect(denied(edit(join(MAIN, 'docs/new.md'), {}, 'Write'))).toBe(true);
  });
  it('denies a NotebookEdit in the main checkout', () => {
    expect(denied(edit(join(MAIN, 'nb.ipynb'), {}, 'NotebookEdit'))).toBe(true);
  });
  it('allows an untracked, gitignored output in the main checkout', () => {
    expect(edit(join(MAIN, 'tmp/out.txt'), {}, 'Write')).toBeNull();
  });
  it('allows a file outside the repo', () => {
    expect(edit(join(S, 'elsewhere.txt'), {}, 'Write')).toBeNull();
  });
  it('denies a path that reaches the main checkout through a symlink', () => {
    symlinkSync(MAIN, join(S, 'alias'));
    expect(denied(edit(join(S, 'alias', 'tracked.txt')))).toBe(true);
  });
  it('denies a differently cased path on a case-insensitive disk', () => {
    if (!existsSync(join(MAIN, 'TRACKED.TXT'))) return; // case-sensitive disk: nothing to prove
    expect(denied(edit(join(MAIN, 'TRACKED.TXT')))).toBe(true);
  });
  it('denies an edit to the main checkout whatever the session cwd (scratchpad, another repo) (US-63 AC1)', () => {
    expect(denied(edit(join(MAIN, 'tracked.txt'), {}, 'Edit', S))).toBe(true);
    expect(denied(edit(join(MAIN, 'tracked.txt'), {}, 'Edit', '/'))).toBe(true);
  });
  it('denies a gitignored file under .claude/, where settings.local.json could switch the hooks off (US-63 AC1)', () => {
    expect(denied(edit(join(MAIN, '.claude/settings.local.json'), {}, 'Write'))).toBe(true);
    expect(denied(edit(join(MAIN, '.claude/hooks/worktree-guard.cjs')))).toBe(true);
  });
  it('skips cloud sessions and the opt-out', () => {
    expect(edit(join(MAIN, 'tracked.txt'), { CLAUDE_CODE_REMOTE: 'true' })).toBeNull();
    expect(edit(join(MAIN, 'tracked.txt'), { CLAUDE_MAIN_CHECKOUT_WRITES: '1' })).toBeNull();
  });
});

describe('worktree-new.sh, the guard inside a worktree, and worktree-done.sh (US-63 AC2-AC4)', () => {
  let WT: string;
  beforeAll(() => {
    const r = newWorktree('feat');
    expect(r.status).toBe(0);
    WT = r.path;
  }, 60_000);

  it('makes a locked worktree on claude/<name> from origin/main, tracking nothing', () => {
    expect(WT).toBe(join(MAIN, '.claude/worktrees/feat'));
    expect(sh(WT, 'git rev-parse --abbrev-ref HEAD')).toBe('claude/feat');
    expect(sh(WT, 'git rev-parse HEAD')).toBe(sh(MAIN, 'git rev-parse origin/main'));
    expect(spawnSync('git', ['-C', WT, 'rev-parse', '--abbrev-ref', '@{u}'], { env: ENV }).status).not.toBe(0);
    expect(existsSync(join(sh(WT, 'git rev-parse --absolute-git-dir'), 'locked'))).toBe(true);
  });
  it('refuses a taken name and a bad name', () => {
    expect(newWorktree('feat').status).not.toBe(0);
    expect(newWorktree('a/b').status).not.toBe(0);
  });
  it('allows edits inside the worktree', () => {
    expect(edit(join(WT, 'tracked.txt'))).toBeNull();
  });
  it('a Bash call in the worktree clones the installed packages as its own folders, and git ignores them', () => {
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: WT, tool_input: { command: 'ls' } })).toBeNull();
    for (const d of ['node_modules', 'widget-src/node_modules']) {
      expect(lstatSync(join(WT, d)).isSymbolicLink()).toBe(false);
      expect(existsSync(join(WT, d, 'pkg'))).toBe(true);
    }
    expect(existsSync(join(WT, 'packages/health-core/node_modules'))).toBe(false); // no source, no parent: skipped
    // A link back into the main checkout would load a second copy of a package (two Reacts): dropped.
    expect(() => lstatSync(join(WT, 'node_modules/node_modules'))).toThrow();
    expect(sh(WT, 'git status --porcelain')).toBe('');
    // The clone is the worktree's own: emptying it (as `npm ci` does) leaves the main checkout's alone.
    rmSync(join(WT, 'node_modules/pkg'), { recursive: true });
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true);
    mkdirSync(join(WT, 'node_modules/pkg'));
  });
  it('Stop: nothing to land, so the turn may end; the main checkout is never blocked', () => {
    expect(stop(WT)).toBeNull();
    expect(stop(MAIN)).toBeNull();
  });
  it('Stop blocks uncommitted work, once, even from a cwd outside the repo (US-63 AC2)', () => {
    writeFileSync(join(WT, 'tracked.txt'), 'two\n');
    expect(stop(WT)?.decision).toBe('block');
    // A session started in the worktree runs the worktree's own copy of the hook; its cwd may wander off.
    expect(stop(S, {}, false, installGuard(WT))?.decision).toBe('block');
    expect(stop(WT, {}, true)).toBeNull();
    expect(stop(WT, { CLAUDE_CODE_REMOTE: 'true' })).toBeNull();
  });
  it('worktree-done refuses uncommitted work', () => {
    const r = done('feat');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/uncommitted/);
  });
  it('Stop blocks an unpushed commit', () => {
    sh(WT, 'git commit -q -am two');
    expect(stop(WT)?.reason).toMatch(/not pushed/);
  });
  it('worktree-done refuses an unpushed commit', () => {
    expect(done('feat').stdout).toMatch(/on no remote branch/);
  });
  it('Stop blocks a pushed branch with no open PR, and allows one with a PR', () => {
    sh(WT, 'git push -q -u origin claude/feat');
    expect(stop(WT, { GH_COUNT: '0' })?.reason).toMatch(/no open PR/);
    expect(stop(WT, { GH_COUNT: '1' })).toBeNull();
    expect(stop(WT, { GH_FAIL: '1' })).toBeNull(); // gh missing or failing: fail open, the GitHub watches back it up
  });
  it('worktree-done refuses work whose PR is still open', () => {
    expect(done('feat', { GH_STATE: 'OPEN' }).stdout).toMatch(/PR OPEN; merge or close it first/);
  });
  it('SessionStart lists the worktree with unlanded work and the dirty main checkout', () => {
    writeFileSync(join(MAIN, 'stray.txt'), 'x\n');
    const o = hook({ hook_event_name: 'SessionStart', cwd: MAIN });
    const ctx = o.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/\.claude\/worktrees\/feat \[claude\/feat\]: 0 uncommitted file\(s\), 0 unpushed commit\(s\), 1 not on origin\/main/);
    expect(ctx).toMatch(/main checkout: 1 uncommitted file\(s\), e\.g\. stray\.txt/);
    rmSync(join(MAIN, 'stray.txt'));
  });
  it('once merged, worktree-done copies gitignored output back, keeps the packages, removes worktree and branch', () => {
    mkdirSync(join(WT, 'tmp'));
    writeFileSync(join(WT, 'tmp/result.txt'), 'made in the worktree\n');
    writeFileSync(join(WT, '.claude/settings.local.json'), '{}\n'); // gitignored, but never copied back
    sh(MAIN, 'git pull -q --ff-only && git merge -q --no-edit origin/claude/feat && git push -q origin main');
    const r = done('feat');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^done/m);
    expect(readFileSync(join(MAIN, 'tmp/result.txt'), 'utf8')).toBe('made in the worktree\n');
    expect(existsSync(join(MAIN, '.claude/settings.local.json'))).toBe(false);
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true); // the worktree's clone went, never the original
    expect(existsSync(WT)).toBe(false);
    expect(spawnSync('git', ['-C', MAIN, 'show-ref', '-q', '--verify', 'refs/heads/claude/feat'], { env: ENV }).status).not.toBe(0);
  });
  it('a gitignored file that differs from the main checkout keeps the worktree for a human', () => {
    const w = newWorktree('clash').path;
    mkdirSync(join(w, 'tmp'));
    writeFileSync(join(w, 'tmp/result.txt'), 'a different copy\n');
    const r = done('clash');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/differ from the main checkout's copy[\s\S]*tmp\/result\.txt/);
    expect(existsSync(w)).toBe(true);
    expect(readFileSync(join(MAIN, 'tmp/result.txt'), 'utf8')).toBe('made in the worktree\n');
  });
});

describe('worktree-done.sh --all (US-63 AC4)', () => {
  it('skips a locked worktree and one used in the last day, and finishes an old unlocked one', () => {
    const locked = newWorktree('all-locked').path;
    const recent = newWorktree('all-recent').path;
    const old = newWorktree('all-old').path;
    for (const w of [recent, old]) sh(MAIN, `git worktree unlock "${w}"`);
    const past = new Date(Date.now() - 3 * 86_400_000);
    for (const f of ['index', 'HEAD']) utimesSync(join(gitDirOf(old), f), past, past);
    const r = spawnSync('bash', [DONE, '--all'], { cwd: MAIN, encoding: 'utf8', env: ENV });
    expect(r.stdout).toMatch(/skip .*all-locked.*locked/);
    expect(r.stdout).toMatch(/skip .*all-recent.*used in the last day/);
    expect(r.stdout).toMatch(/done .*all-old/);
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(old)).toBe(false);
  }, 60_000);
});

describe('a worktree whose packages cannot be cloned (US-63 AC3)', () => {
  it('the hook still answers cleanly, leaves no partial folder and no stray copy', () => {
    const wt = newWorktree('noclone').path;
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: wt, tool_input: { command: 'ls' } },
      { CP_FAIL: '1' })).toBeNull();
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
    expect(readdirSync(gitDirOf(wt)).filter((f) => f.startsWith('package-clone-'))).toEqual([]);
  }, 60_000);
});

describe('parallel Bash calls in a new worktree (US-63 AC3)', () => {
  it('three hooks 0.2 s apart leave one whole clone and no stray copies', async () => {
    // Enough files that the clones overlap in time.
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(MAIN, 'node_modules', `p${i}`), { recursive: true });
      for (let j = 0; j < 50; j++) writeFileSync(join(MAIN, 'node_modules', `p${i}`, `f${j}.js`), `${i}-${j}\n`);
    }
    const wt = newWorktree('race').path;
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: wt, tool_input: { command: 'ls' } });
    const run = (delay: number) => new Promise<number>((resolve) => setTimeout(() => {
      const c = spawn('node', [GUARD], { env: ENV, stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('close', (code) => resolve(code ?? -1));
      c.stdin.end(payload);
    }, delay));
    expect(await Promise.all([run(0), run(200), run(400)])).toEqual([0, 0, 0]);
    // The source's regular files plus the marker written last; the stray self-link is dropped.
    expect(countFiles(join(wt, 'node_modules'))).toBe(countFiles(join(MAIN, 'node_modules')) + 1);
    expect(existsSync(join(wt, 'node_modules/.worktree-clone'))).toBe(true);
    expect(readdirSync(gitDirOf(wt)).filter((f) => f.startsWith('package-clone-'))).toEqual([]);
  }, 120_000);
});
