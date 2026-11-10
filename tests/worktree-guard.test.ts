/**
 * US-64: the worktree workflow (docs/git-workflow.md, Brad 2026-10-31): .claude/hooks/worktree-guard.cjs and
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
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
const cacheDir = (wt: string) => spawnSync('node', [GUARD, '--pkg-cache-dir', wt], { encoding: 'utf8', env: ENV }).stdout.trim();
const countFiles = (dir: string) => Number(spawnSync('sh', ['-c', `find "${dir}" -type f | wc -l`], { encoding: 'utf8' }).stdout.trim());
const bash = (cwd: string, command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } });
const edit = (file: string, extra: NodeJS.ProcessEnv = {}, tool = 'Edit', cwd = MAIN) =>
  hook({ hook_event_name: 'PreToolUse', tool_name: tool, cwd,
    tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } }, extra);
const denied = (o: unknown) => (o as { hookSpecificOutput?: { permissionDecision?: string } } | null)
  ?.hookSpecificOutput?.permissionDecision === 'deny';
const stop = (cwd: string, extra: NodeJS.ProcessEnv = {}, active = false, guard = GUARD) =>
  hook({ hook_event_name: 'Stop', cwd, stop_hook_active: active }, extra, guard);

function newWorktree(name: string, extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('sh', [NEW, name], { cwd: MAIN, encoding: 'utf8', env: { ...ENV, ...extra } });
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
  // cp passes through to the real one, unless CP_FAIL asks it to fail (a disk or OS with no clone support), or
  // CP_FAIL_ON names a path in its arguments (one package folder's clone fails, the others work).
  writeFileSync(join(BIN, 'cp'), `#!/bin/sh\n[ -n "$CP_FAIL" ] && exit 1\n`
    + `case "$*" in *"\${CP_FAIL_ON:-//none//}"*) exit 1;; esac\nexec ${spawnSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim()} "$@"\n`);
  chmodSync(join(BIN, 'cp'), 0o755);
  // rm passes through to the real one, unless RM_FAIL is set and the call names a package clone folder.
  writeFileSync(join(BIN, 'rm'), `#!/bin/sh\ncase "$*" in *claude-worktree-packages/*) [ -n "$RM_FAIL" ] && exit 1;; esac\n`
    + `exec ${spawnSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).stdout.trim()} "$@"\n`);
  chmodSync(join(BIN, 'rm'), 0o755);
  ENV = {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH}`,
    HOME: join(S, 'home'), // the package clone cache lands in the scratch folder, never the real one
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  delete ENV.CLAUDE_CODE_REMOTE;
  delete ENV.CLAUDE_MAIN_CHECKOUT_WRITES;
  delete ENV.XDG_CACHE_HOME;
  MAIN = join(S, 'main');
  sh(S, 'git init -q --bare -b main remote.git && git clone -q remote.git main 2>/dev/null');
  // `node_modules` with no trailing slash, as the real .gitignore: it matches the link too.
  writeFileSync(join(MAIN, '.gitignore'), 'node_modules\ntmp/\n.claude/*\n*.log\nios/HealthRoadmap/Engine/health-engine.js\n'
    + 'ios/HealthRoadmap/Engine/health-engine.json\nios/HealthRoadmapTests/Fixtures/\n'); // as ios/.gitignore
  writeFileSync(join(MAIN, 'tracked.txt'), 'one\n');
  mkdirSync(join(MAIN, 'widget-src'));
  writeFileSync(join(MAIN, 'widget-src/a.ts'), 'x\n');
  // A tracked link to an absolute path in the main checkout, as claude_business's docs/products.md is: cleanup
  // must never delete it.
  symlinkSync(join(MAIN, 'tracked.txt'), join(MAIN, 'abs-link'));
  // A workspace package, as packages/health-core is.
  mkdirSync(join(MAIN, 'packages/health-core'), { recursive: true });
  writeFileSync(join(MAIN, 'packages/health-core/package.json'), '{"name":"@roadmap/health-core","main":"index.js"}\n');
  writeFileSync(join(MAIN, 'packages/health-core/index.js'), 'module.exports = 1;\n');
  sh(MAIN, 'git add -A && git commit -q -m one && git push -q origin main');
  GUARD = installGuard(MAIN);
  // Installed packages exist only in the main checkout, as in real life.
  for (const d of ['node_modules', 'widget-src/node_modules']) mkdirSync(join(MAIN, d, 'pkg'), { recursive: true });
  // A stray self-link, as the real main checkout has (node_modules/node_modules -> node_modules).
  symlinkSync(join(MAIN, 'node_modules'), join(MAIN, 'node_modules/node_modules'));
  // npm's workspace link, relative as npm writes it.
  mkdirSync(join(MAIN, 'node_modules/@roadmap'));
  symlinkSync('../../packages/health-core', join(MAIN, 'node_modules/@roadmap/health-core'));
}, 60_000);
afterAll(() => rmSync(S, { recursive: true, force: true }));

describe('worktree-guard.cjs: edits (US-64 AC1)', () => {
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
  it('denies an edit to the main checkout whatever the session cwd (scratchpad, another repo) (US-64 AC1)', () => {
    expect(denied(edit(join(MAIN, 'tracked.txt'), {}, 'Edit', S))).toBe(true);
    expect(denied(edit(join(MAIN, 'tracked.txt'), {}, 'Edit', '/'))).toBe(true);
  });
  it('denies a gitignored file under .claude/, where settings.local.json could switch the hooks off (US-64 AC1)', () => {
    expect(denied(edit(join(MAIN, '.claude/settings.local.json'), {}, 'Write'))).toBe(true);
    expect(denied(edit(join(MAIN, '.claude/hooks/worktree-guard.cjs')))).toBe(true);
  });
  it('skips cloud sessions and the opt-out', () => {
    expect(edit(join(MAIN, 'tracked.txt'), { CLAUDE_CODE_REMOTE: 'true' })).toBeNull();
    expect(edit(join(MAIN, 'tracked.txt'), { CLAUDE_MAIN_CHECKOUT_WRITES: '1' })).toBeNull();
  });
});

describe('worktree-new.sh, the guard inside a worktree, and worktree-done.sh (US-64 AC2-AC4)', () => {
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
  it("a Bash call links each package folder to the worktree's own clone, outside the repo (US-64 AC3)", () => {
    expect(bash(WT, 'ls')).toBeNull();
    const cache = cacheDir(WT);
    expect(cache.startsWith(join(S, 'home') + '/')).toBe(true);
    for (const d of ['node_modules', 'widget-src/node_modules']) {
      expect(readlinkSync(join(WT, d))).toBe(join(cache, d));
      expect(existsSync(join(WT, d, 'pkg'))).toBe(true);
    }
    expect(existsSync(join(WT, 'packages/health-core/node_modules'))).toBe(false); // no source, no parent: skipped
    // A link back into the main checkout would load a second copy of a package (two Reacts): dropped.
    expect(() => lstatSync(join(cache, 'node_modules/node_modules'))).toThrow();
    expect(readFileSync(join(cache, '.owner'), 'utf8')).toBe(WT);
    expect(sh(WT, 'git status --porcelain')).toBe('');
  });
  it("the clone resolves workspace packages to the worktree's own source (US-64 AC3)", () => {
    const resolved = createRequire(join(WT, 'x.js')).resolve('@roadmap/health-core');
    expect(realpathSync(resolved)).toBe(join(WT, 'packages/health-core/index.js'));
  });
  it('npm ci or rm -rf through the link empties only the clone, and the next call re-clones (US-64 AC3)', () => {
    sh(WT, 'rm -rf node_modules/'); // follows the link, as npm ci does
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true);
    sh(WT, 'rm -rf "$(readlink node_modules)"'); // the clone itself gone
    expect(bash(WT, 'ls')).toBeNull();
    expect(existsSync(join(WT, 'node_modules/pkg'))).toBe(true);
  });
  it('replaces an old link into the main checkout (the link only) and leaves any other link alone (US-64 AC3)', () => {
    const w = newWorktree('oldlink').path;
    for (const d of ['node_modules', 'widget-src/node_modules']) rmSync(join(w, d)); // the link worktree-new made
    symlinkSync(join(MAIN, 'node_modules'), join(w, 'node_modules'));
    symlinkSync(join(S, 'elsewhere'), join(w, 'widget-src/node_modules'));
    expect(bash(w, 'ls')).toBeNull();
    expect(readlinkSync(join(w, 'node_modules'))).toBe(join(cacheDir(w), 'node_modules'));
    expect(readlinkSync(join(w, 'widget-src/node_modules'))).toBe(join(S, 'elsewhere'));
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true);
  });
  it('Stop: nothing to land, so the turn may end; the main checkout is never blocked', () => {
    expect(stop(WT)).toBeNull();
    expect(stop(MAIN)).toBeNull();
  });
  it('Stop blocks uncommitted work, once, even from a cwd outside the repo (US-64 AC2)', () => {
    writeFileSync(join(WT, 'tracked.txt'), 'two\n');
    expect(stop(WT)?.decision).toBe('block');
    // A session started in the worktree runs the worktree's own copy of the hook; its cwd may wander off.
    expect(stop(S, {}, false, installGuard(WT))?.decision).toBe('block');
    expect(stop(WT, {}, true)).toBeNull();
    expect(stop(WT, { CLAUDE_CODE_REMOTE: 'true' })).toBeNull();
  });
  it('Stop skips uncommitted files while a background subagent of this session runs (US-64 AC25)', () => {
    const tasks = (type: string, status: string) => hook({ hook_event_name: 'Stop', cwd: WT, stop_hook_active: false,
      background_tasks: [{ id: 't1', type, status, description: 'x' }] });
    expect(tasks('subagent', 'running')).toBeNull();
    expect(tasks('teammate', 'pending')).toBeNull();
    expect(tasks('workflow', 'running')).toBeNull();
    expect(tasks('subagent', 'in_progress')).toBeNull(); // an unlisted status word still counts (re-check N1)
    // A shell or monitor task edits nothing; a finished subagent no longer counts; an empty list is none.
    expect(tasks('shell', 'running')?.reason).toMatch(/uncommitted/);
    expect(tasks('monitor', 'running')?.reason).toMatch(/uncommitted/);
    expect(tasks('subagent', 'completed')?.reason).toMatch(/uncommitted/);
    expect(tasks('subagent', 'failed')?.reason).toMatch(/uncommitted/);
    expect(hook({ hook_event_name: 'Stop', cwd: WT, background_tasks: [] })?.reason).toMatch(/uncommitted/);
    expect(hook({ hook_event_name: 'Stop', cwd: WT, background_tasks: 'junk' })?.reason).toMatch(/uncommitted/);
  });
  it('worktree-done refuses uncommitted work', () => {
    const r = done('feat');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/uncommitted/);
  });
  it('Stop blocks an unpushed commit', () => {
    sh(WT, 'git commit -q -am two');
    expect(stop(WT)?.reason).toMatch(/not pushed/);
    // A running subagent hides only uncommitted files, never an unpushed commit (US-64 AC25).
    writeFileSync(join(WT, 'wip.txt'), 'half\n');
    const r = hook({ hook_event_name: 'Stop', cwd: WT, background_tasks: [{ id: 't', type: 'subagent', status: 'running' }] });
    expect(r?.reason).toMatch(/not pushed/);
    expect(r?.reason).not.toMatch(/uncommitted/);
    rmSync(join(WT, 'wip.txt'));
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
  it('once merged, worktree-done copies gitignored output back, removes the links (never their targets), the worktree and branch', () => {
    mkdirSync(join(WT, 'tmp'));
    writeFileSync(join(WT, 'tmp/result.txt'), 'made in the worktree\n');
    writeFileSync(join(WT, '.claude/settings.local.json'), '{}\n'); // gitignored, but never copied back
    writeFileSync(join(WT, 'run.log'), 'a log\n'); // copied back, not dropped (review R8)
    // ios/scripts/build-engine.mjs rebuilds the engine bundle, its sidecar and the parity fixtures in each
    // checkout, so a different copy never keeps the worktree, and none is copied back (US-64 AC21).
    const GENERATED = ['ios/HealthRoadmap/Engine/health-engine.js', 'ios/HealthRoadmap/Engine/health-engine.json',
      'ios/HealthRoadmapTests/Fixtures/minor.utc.golden.json', 'ios/HealthRoadmapTests/Fixtures/minor.record.json'];
    for (const [dir, body] of [[WT, 'worktree build'], [MAIN, 'main build']]) {
      for (const f of GENERATED) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), body);
      }
    }
    writeFileSync(join(WT, 'ios/HealthRoadmapTests/Fixtures/only-here.auckland.golden.json'), 'worktree build');
    const clones = cacheDir(WT);
    expect(existsSync(clones)).toBe(true);
    sh(MAIN, 'git pull -q --ff-only && git merge -q --no-edit origin/claude/feat && git push -q origin main');
    const r = done('feat');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^done/m);
    expect(readFileSync(join(MAIN, 'tmp/result.txt'), 'utf8')).toBe('made in the worktree\n');
    expect(existsSync(join(MAIN, '.claude/settings.local.json'))).toBe(false);
    expect(r.stdout).toMatch(/not copied back[\s\S]*\.claude\/settings\.local\.json/);
    expect(readFileSync(join(MAIN, 'run.log'), 'utf8')).toBe('a log\n');
    for (const f of GENERATED) expect(readFileSync(join(MAIN, f), 'utf8')).toBe('main build');
    expect(existsSync(join(MAIN, 'ios/HealthRoadmapTests/Fixtures/only-here.auckland.golden.json'))).toBe(false);
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true); // the worktree's link went, never the folder
    expect(existsSync(clones)).toBe(false); // its clones are deleted too
    expect(readlinkSync(join(MAIN, 'abs-link'))).toBe(join(MAIN, 'tracked.txt'));
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

describe('worktree-done.sh --all (US-64 AC4)', () => {
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

describe('worktree-done.sh on a folder that is not a worktree (US-64 AC4)', () => {
  it('refuses a plain folder under .claude/worktrees/, which git would resolve to the main checkout', () => {
    const fake = join(MAIN, '.claude/worktrees/fake');
    mkdirSync(fake, { recursive: true });
    const r = done('fake');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/not a registered worktree/);
    expect(existsSync(join(MAIN, 'tracked.txt'))).toBe(true);
    expect(sh(MAIN, 'git rev-parse --abbrev-ref HEAD')).toBe('main');
  });
});

describe('package clones: new worktrees, failures, races and orphans (US-64 AC3, AC4)', () => {
  it('in an older worktree outside .claude/worktrees/, swaps a link into the main checkout and adds nothing', () => {
    const older = join(S, 'older');
    sh(MAIN, `git worktree add -q --detach "${older}" origin/main`);
    symlinkSync(join(MAIN, 'node_modules'), join(older, 'node_modules'));
    expect(bash(older, 'ls')).toBeNull();
    expect(readlinkSync(join(older, 'node_modules'))).toBe(join(cacheDir(older), 'node_modules'));
    expect(existsSync(join(older, 'node_modules/pkg'))).toBe(true);
    expect(() => lstatSync(join(older, 'widget-src/node_modules'))).toThrow(); // absent stays absent here
    sh(older, 'rm -rf node_modules/');
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true);
  });
  it('swaps the link when the guard runs from inside an older worktree (a session started there) (re-check R4)', () => {
    const ext = join(S, 'ext');
    sh(MAIN, `git worktree add -q --detach "${ext}" origin/main`);
    const guard = installGuard(ext);
    symlinkSync(join(MAIN, 'node_modules'), join(ext, 'node_modules'));
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: ext, tool_input: { command: 'ls' } }, {}, guard)).toBeNull();
    expect(readlinkSync(join(ext, 'node_modules'))).toBe(join(cacheDir(ext), 'node_modules'));
  });
  it('leaves a link alone in a folder that is not a registered worktree', () => {
    const fake = join(MAIN, '.claude/worktrees/notreg');
    mkdirSync(fake, { recursive: true });
    symlinkSync(join(MAIN, 'node_modules'), join(fake, 'node_modules'));
    expect(bash(fake, 'ls')).toBeNull();
    expect(readlinkSync(join(fake, 'node_modules'))).toBe(join(MAIN, 'node_modules'));
    rmSync(fake, { recursive: true });
  });
  it('worktree-new links the packages itself, so a subagent using the worktree by path has them (US-64 AC21)', () => {
    const w = newWorktree('born').path; // no Bash hook ever fires with this cwd
    for (const d of ['node_modules', 'widget-src/node_modules']) {
      expect(readlinkSync(join(w, d))).toBe(join(cacheDir(w), d));
      expect(existsSync(join(w, d, 'pkg'))).toBe(true);
    }
    expect(sh(w, 'git status --porcelain')).toBe('');
    const clones = cacheDir(w);
    expect(done('born').status).toBe(0); // worktree-done still removes the links and the clones
    expect(existsSync(clones)).toBe(false);
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true);
  });
  it('worktree-new deletes a clone left by an earlier worktree at the same path', () => {
    let w = newWorktree('reuse').path;
    expect(bash(w, 'ls')).toBeNull();
    writeFileSync(join(cacheDir(w), 'node_modules/stale'), 'x');
    sh(MAIN, `git worktree remove -f -f "${w}" && git branch -q -D claude/reuse`);
    w = newWorktree('reuse').path;
    expect(existsSync(join(cacheDir(w), 'node_modules/stale'))).toBe(false);
  });
  it('worktree-new still prints the path when it cannot delete an old clone (issue 936)', () => {
    const r = newWorktree('rmfail', { RM_FAIL: '1' });
    expect(r.status).toBe(0);
    expect(r.path).toMatch(/\/rmfail$/);
    expect(r.stderr).toMatch(/could not delete/);
  });
  it('a failed clone answers cleanly, links nothing and leaves no temp folder', () => {
    const w = newWorktree('noclone', { CP_FAIL: '1' }).path;
    expect(newWorktree('noclone2', { CP_FAIL: '1' }).stderr).toMatch(/no package links yet/);
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: w, tool_input: { command: 'ls' } },
      { CP_FAIL: '1' })).toBeNull();
    expect(() => lstatSync(join(w, 'node_modules'))).toThrow();
    expect(readdirSync(cacheDir(w)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
  it('the note names each package folder left without a link, not only the root one (US-64 AC21, review R4)', () => {
    const r = newWorktree('halfclone', { CP_FAIL_ON: 'widget-src/node_modules' });
    expect(r.status).toBe(0);
    expect(readlinkSync(join(r.path, 'node_modules'))).toBe(join(cacheDir(r.path), 'node_modules'));
    expect(r.stderr).toMatch(/no package links yet for widget-src\/node_modules;/);
    expect(r.stderr).not.toMatch(/for node_modules|packages\/health-core/); // linked, or absent in the main checkout
  });
  it('a guard that fails while linking still leaves the path printed and the run a success (US-64 AC21, review R3)', () => {
    const good = readFileSync(GUARD, 'utf8');
    writeFileSync(GUARD, 'process.exit(3);\n'); // fails, or is killed, after `git worktree add`
    let r;
    try { r = newWorktree('guardfail'); } finally { writeFileSync(GUARD, good); }
    expect(r.status).toBe(0);
    expect(r.path).toBe(join(MAIN, '.claude/worktrees/guardfail'));
    expect(existsSync(join(r.path, 'tracked.txt'))).toBe(true);
    expect(r.stderr).toMatch(/no package links yet for node_modules widget-src\/node_modules;/);
  });
  it('three hooks at once leave one whole clone, one link per folder and no temp folders', async () => {
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(MAIN, 'node_modules', `p${i}`), { recursive: true });
      for (let j = 0; j < 50; j++) writeFileSync(join(MAIN, 'node_modules', `p${i}`, `f${j}.js`), `${i}-${j}\n`);
    }
    const wt = newWorktree('race').path;
    for (const d of ['node_modules', 'widget-src/node_modules']) rmSync(join(wt, d)); // start with no links
    rmSync(cacheDir(wt), { recursive: true });
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: wt, tool_input: { command: 'ls' } });
    const run = () => new Promise<number>((resolve) => {
      const c = spawn('node', [GUARD], { env: ENV, stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('close', (code) => resolve(code ?? -1));
      c.stdin.end(payload);
    });
    expect(await Promise.all([run(), run(), run()])).toEqual([0, 0, 0]);
    expect(readlinkSync(join(wt, 'node_modules'))).toBe(join(cacheDir(wt), 'node_modules'));
    expect(countFiles(join(wt, 'node_modules/'))).toBe(countFiles(join(MAIN, 'node_modules')));
    expect(readdirSync(cacheDir(wt)).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(sh(wt, 'git status --porcelain')).toBe('');
  }, 120_000);
  it('SessionStart deletes a clone folder whose worktree is gone', () => {
    const w = newWorktree('orphan').path;
    expect(bash(w, 'ls')).toBeNull();
    const clones = cacheDir(w);
    sh(MAIN, `git worktree remove -f -f "${w}"`);
    const cache = dirname(clones);
    // A live clone whose name merely contains `.deleting-` stays (re-check N3); an earlier run's tombstone goes.
    const live = join(cache, 'x.deleting-1-0123456789ab');
    mkdirSync(live);
    writeFileSync(join(live, '.owner'), MAIN); // MAIN has a .git: alive
    mkdirSync(join(cache, '.tombstones/old-1/x'), { recursive: true });
    hook({ hook_event_name: 'SessionStart', cwd: MAIN });
    expect(existsSync(clones)).toBe(false); // moved to .tombstones at once; a detached process deletes it
    const deadline = Date.now() + 20_000;
    while (existsSync(join(cache, '.tombstones')) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
    expect(existsSync(join(cache, '.tombstones'))).toBe(false);
    expect(existsSync(join(live, '.owner'))).toBe(true);
    expect(existsSync(join(MAIN, 'node_modules/pkg'))).toBe(true);
  }, 60_000);
});

describe('SessionStart names merged worktrees ready to remove (US-64 AC21)', () => {
  // Commit, push and merge a worktree's own change, as a finished session leaves it.
  const mergeIn = (w: string, name: string) => {
    writeFileSync(join(w, `${name}.txt`), 'x\n');
    sh(w, `git add ${name}.txt && git commit -q -m ${name} && git push -q -u origin claude/${name}`);
    sh(MAIN, `git pull -q --ff-only && git merge -q --no-ff --no-edit origin/claude/${name} && git push -q origin main`);
  };
  // As worktree-done.sh's last-used test reads it: the worktree's git dir index and HEAD.
  const ageGitDir = (w: string) => {
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const f of ['index', 'HEAD']) utimesSync(join(gitDirOf(w), f), old, old);
  };
  it('lists a clean worktree whose branch was merged with the worktree-done line, and not a fresh one', () => {
    const fresh = newWorktree('nudge-fresh').path; // no commits of its own: a live session may just have started
    const w = newWorktree('nudge-merged').path;
    mergeIn(w, 'nudge-merged');
    sh(w, 'git status -s'); // settle the index, so the hook's own status leaves its mtime alone
    ageGitDir(w);
    sh(fresh, 'git fetch -q origin');
    const ctx = hook({ hook_event_name: 'SessionStart', cwd: MAIN }).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/- \.claude\/worktrees\/nudge-merged \[claude\/nudge-merged\]: merged; if no session still uses it, bash tools\/worktree-done\.sh nudge-merged/);
    expect(ctx).not.toMatch(/nudge-fresh/);
    expect(done('nudge-merged').stdout).toMatch(/^done/m); // the line it prints does finish it
    expect(done('nudge-fresh').status).toBe(0);
  });
  it('a merged worktree used in the last day is marked in use, with no removal command (review R1)', () => {
    const w = newWorktree('nudge-live').path; // merged, but its session may still be deploying or verifying
    mergeIn(w, 'nudge-live');
    const ctx = hook({ hook_event_name: 'SessionStart', cwd: MAIN }).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/- \.claude\/worktrees\/nudge-live \[claude\/nudge-live\]: merged, in use \(changed in the last day\); leave it/);
    expect(ctx).not.toMatch(/worktree-done\.sh nudge-live/);
    expect(done('nudge-live').status).toBe(0);
  });
  it('a merged worktree whose session ended a turn in the last day is in use, even with an old git dir (issue 937)', () => {
    const w = newWorktree('nudge-idle').path;
    mergeIn(w, 'nudge-idle');
    sh(w, 'git status -s');
    ageGitDir(w);
    stop(w); // the Stop hook leaves its heartbeat in the git dir
    ageGitDir(w); // its own git status touched the index; only the heartbeat is recent now
    const ctx = hook({ hook_event_name: 'SessionStart', cwd: MAIN }).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/nudge-idle \[claude\/nudge-idle\]: merged, in use/);
    expect(ctx).not.toMatch(/worktree-done\.sh nudge-idle/);
  });
});
