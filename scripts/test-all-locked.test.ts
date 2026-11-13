/** US-71: one local `test:all` at a time, shared across worktrees. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
// @ts-expect-error plain .mjs script
import { tryAcquire, acquire, release, readHolder, workerCap, vitestArgs, lockDir, inCI, timeoutMinutes, isTargeted, findVitest, recordChild } from './test-all-locked.mjs';

let base: string;
let dir: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-lock-')); dir = path.join(base, 'test-all.lock'); });
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid as number; // exited, so no longer alive
};

describe('test:all lock (US-71 AC1)', () => {
  it('acquires, then refuses a second taker while the holder lives', () => {
    expect(tryAcquire(dir)).toBe(true);
    expect(readHolder(dir).pid).toBe(process.pid);
    expect(tryAcquire(dir, { pid: process.ppid, started: 'x', cwd: 'y' })).toBe(false);
  });

  it('waits, logs one line naming the holder, and gets the lock after release', async () => {
    tryAcquire(dir, { pid: process.ppid, started: 'S', cwd: '/other/worktree' });
    const lines: string[] = [];
    setTimeout(() => fs.rmSync(dir, { recursive: true }), 120);
    await acquire(dir, { pollMs: 30, timeoutMs: 5000, log: (l: string) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`pid ${process.ppid}`);
    expect(lines[0]).toContain('/other/worktree');
    expect(readHolder(dir).pid).toBe(process.pid);
  });

  it('times out when the holder never lets go', async () => {
    tryAcquire(dir, { pid: process.ppid, started: 'S', cwd: 'c' });
    await expect(acquire(dir, { pollMs: 20, timeoutMs: 80, log: () => {} })).rejects.toThrow(/timed out/);
  });

  it('takes over a lock whose pid is dead', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: deadPid(), started: 'old', cwd: 'gone' }));
    expect(tryAcquire(dir)).toBe(true);
    expect(readHolder(dir).pid).toBe(process.pid);
  });

  it('release removes only our own lock', () => {
    tryAcquire(dir, { pid: process.ppid, started: 'S', cwd: 'c' });
    release(dir);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true });
    tryAcquire(dir);
    release(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('worker cap and CI (US-71 AC2, AC3)', () => {
  it('defaults to max(2, cpus/4) and honours the env override', () => {
    expect(workerCap({}, 16)).toBe('4');
    expect(workerCap({}, 4)).toBe('2');
    expect(workerCap({ TEST_ALL_MAX_WORKERS: '7' }, 16)).toBe('7');
    expect(workerCap({ TEST_ALL_MAX_WORKERS: 'junk' }, 16)).toBe('4');
  });

  it('CI counts only when set and not false or 0; a bad timeout falls back to 60', () => {
    expect(inCI({ CI: 'true' })).toBe(true);
    expect(inCI({ CI: 'false' })).toBe(false);
    expect(inCI({ CI: '0' })).toBe(false);
    expect(inCI({})).toBe(false);
    expect(timeoutMinutes({ TEST_ALL_LOCK_TIMEOUT_MIN: '0' })).toBe(60);
    expect(timeoutMinutes({ TEST_ALL_LOCK_TIMEOUT_MIN: '-5' })).toBe(60);
    expect(timeoutMinutes({ TEST_ALL_LOCK_TIMEOUT_MIN: '2' })).toBe(2);
    expect(isTargeted(['--reporter=dot'])).toBe(false);
    expect(isTargeted(['--reporter=dot', 'a.test.ts'])).toBe(true);
    expect(isTargeted(['--reporter', 'verbose'])).toBe(false);
    expect(isTargeted(['-t', 'foo'])).toBe(false);
    expect(isTargeted(['--shard', '1/2'])).toBe(false);
    expect(isTargeted(['--shard=1/2', '--silent'])).toBe(false);
    expect(isTargeted(['packages/health-core'])).toBe(true);
    expect(isTargeted(['x.test.ts', '-t', 'foo'])).toBe(true);
    expect(isTargeted(['scripts/*.mjs'])).toBe(true);
  });

  it('passes extra args through, and adds no cap in CI', () => {
    expect(vitestArgs(['scripts/x.test.ts', '-t', 'a'], {})).toEqual(['run', '--maxWorkers=' + workerCap({}), 'scripts/x.test.ts', '-t', 'a']);
    expect(vitestArgs(['a'], { CI: 'true' })).toEqual(['run', 'a']);
  });
});

describe('lock holder liveness and takeover races (US-71 AC1)', () => {
  it('stays held while the vitest group lives though the wrapper is dead', () => {
    const grp = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: deadPid(), child: grp.pid, started: 's', cwd: 'c' }));
      expect(tryAcquire(dir)).toBe(false);
    } finally { process.kill(-grp.pid!, 'SIGKILL'); }
  });

  it('records the child pid next to ours', () => {
    tryAcquire(dir);
    recordChild(dir, 4242);
    expect(readHolder(dir)).toMatchObject({ pid: process.pid, child: 4242 });
  });

  it('puts back a fresh lock it renamed away by mistake', () => {
    // A's stale lock is judged dead, but by the time we rename, the directory is B's live lock.
    const dead = deadPid();
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: dead, started: 's', cwd: 'c' }));
    const real = fs.renameSync;
    let swapped = false;
    (fs as any).renameSync = (a: string, b: string) => {
      if (!swapped && a === dir) {
        swapped = true;
        fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.ppid, started: 'new', cwd: 'b' }));
      }
      return real(a, b);
    };
    try { expect(tryAcquire(dir)).toBe(false); } finally { (fs as any).renameSync = real; }
    expect(readHolder(dir).pid).toBe(process.ppid);
    expect(fs.readdirSync(base).filter((f) => f.includes('stale'))).toEqual([]);
  });

  it('names the vitest pid when only its group is alive', async () => {
    const grp = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: deadPid(), child: grp.pid, started: 's', cwd: 'c' }));
      const lines: string[] = [];
      await expect(acquire(dir, { pollMs: 10, timeoutMs: 30, log: (l: string) => lines.push(l) })).rejects.toThrow();
      expect(lines[0]).toContain(`vitest pid ${grp.pid} is alive`);
      expect(lines[0]).not.toContain('rm -rf');
    } finally { process.kill(-grp.pid!, 'SIGKILL'); }
  });

  it('prints the rm hint only for a stale holder', async () => {
    const lines: string[] = [];
    tryAcquire(dir, { pid: process.ppid, started: 'S', cwd: 'c' });
    await expect(acquire(dir, { pollMs: 10, timeoutMs: 30, log: (l: string) => lines.push(l) })).rejects.toThrow();
    expect(lines[0]).toContain(`do not remove; pid ${process.ppid} is alive`);
    expect(lines[0]).not.toContain('rm -rf');
  });
});

describe('the real script (US-71 AC1-AC3)', () => {
  const script = path.resolve(__dirname, 'test-all-locked.mjs');
  let proj: string;
  let log: string;
  beforeEach(() => {
    proj = path.join(base, 'proj');
    log = path.join(base, 'log.txt');
    fs.mkdirSync(path.join(proj, 'node_modules', '.bin'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: proj });
  });
  // A failed waitFor skips the test's own kill: SIGKILL any wrapper still up and each fake vitest's
  // group (it runs detached, so its pid is its group), or both run forever. Runs before base is removed.
  // Only after a failure: a passing test reaped its own, and a logged pid may since name another process.
  const spawned: ReturnType<typeof spawn>[] = [];
  const pids = () => path.join(base, 'vitest-pids.txt');
  afterEach((ctx) => {
    if (ctx.task.result?.state !== 'fail') { spawned.splice(0); return; }
    const kill = (pid: number) => {
      try { process.kill(pid, 'SIGKILL'); } catch (e) { if (!['ESRCH', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
    };
    for (const c of spawned.splice(0)) if (c.exitCode === null && c.signalCode === null) kill(c.pid!);
    // The fake notes its pid as it boots; the wrapper's owner.json names it from spawn, before that.
    const groups = fs.existsSync(pids()) ? fs.readFileSync(pids(), 'utf8').split('\n').filter(Boolean).map(Number) : [];
    const child = readHolder(path.join(proj, '.git', 'test-all.lock'))?.child;
    for (const g of new Set(child ? [...groups, child] : groups)) kill(-g);
  });
  // The fake vitest logs start/end with the lock's presence, then behaves as MODE says.
  const fakeVitest = (body: string) => {
    const bin = path.join(proj, 'node_modules', '.bin', 'vitest');
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const lock = ${JSON.stringify(path.join(proj, '.git', 'test-all.lock'))};
const note = (m) => fs.appendFileSync(${JSON.stringify(log)}, m + '\\n');
fs.appendFileSync(${JSON.stringify(pids())}, process.pid + '\\n');
note('start ' + process.argv.slice(2).join(' ') + ' lock=' + fs.existsSync(lock));
${body}`, { mode: 0o755 });
  };
  const run = (args: string[] = [], env: Record<string, string> = {}, nodeArgs: string[] = []) => {
    const c = spawn(process.execPath, [...nodeArgs, script, ...args], { cwd: proj, env: { ...process.env, CI: '', ...env }, stdio: 'ignore' });
    spawned.push(c);
    return c;
  };
  const exited = (c: ReturnType<typeof spawn>) => new Promise<number | null>((r) => c.once('exit', (code) => r(code)));
  /** Polls up to 5 s, then fails the test naming what never came. */
  const waitFor = async (what: string, f: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (f()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`timed out waiting for ${what}; the log holds: ${JSON.stringify(logText())}`);
  };
  const logText = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');

  it('passes the exit code through, locally and in CI, and caps workers locally only', async () => {
    fakeVitest('process.exit(3);');
    expect(await exited(run())).toBe(3);
    expect(await exited(run([], { CI: 'true' }))).toBe(3);
    const lines = logText().trim().split('\n');
    expect(lines[0]).toMatch(/^start run --maxWorkers=\d+ lock=true$/);
    expect(lines[1]).toBe('start run lock=false');
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('keeps the lock until the child has exited', async () => {
    fakeVitest("setTimeout(() => { note('end lock=' + fs.existsSync(lock)); process.exit(0); }, 400);");
    const c = run();
    await waitFor("the fake vitest's 'start' line", () => logText().includes('start'));
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(true);
    expect(await exited(c)).toBe(0);
    expect(logText()).toContain('end lock=true');
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('a SIGTERM landing the moment vitest is spawned still reaches the handler (exits 143, not killed)', async () => {
    // A preload makes the wrapper signal itself as spawn() returns: the instant a busy wrapper
    // may be descheduled while vitest boots and the caller signals. No handler yet = killed.
    const hook = path.join(base, 'term-after-spawn.mjs');
    fs.writeFileSync(hook, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const real = cp.spawn;
cp.spawn = (...a) => { const c = real(...a); process.kill(process.pid, 'SIGTERM'); return c; };
syncBuiltinESMExports();`);
    // Exits on SIGTERM (default action or handler); a safety exit if the wrapper died without forwarding.
    fakeVitest("process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(1), 5000);");
    expect(await exited(run([], {}, ['--import', hook]))).toBe(143);
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('SIGTERM stops the child, exits 143 and releases the lock', async () => {
    // 'ready' comes after the child's handler, and the wrapper's handlers precede the spawn.
    fakeVitest("process.on('SIGTERM', () => setTimeout(() => { note('child-term'); process.exit(0); }, 200)); note('ready'); setInterval(() => {}, 1000);");
    const c = run();
    await waitFor("'ready' (the fake vitest's SIGTERM handler installed)", () => logText().includes('ready'));
    c.kill('SIGTERM');
    expect(await exited(c)).toBe(143);
    expect(logText()).toContain('child-term');
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('a later signal (over 1 s on) force-kills a child that ignores SIGTERM', async () => {
    fakeVitest("process.on('SIGTERM', () => note('sigterm ' + process.pid)); note('pid ' + process.pid); setInterval(() => {}, 1000);");
    const c = run();
    await waitFor("'pid <n>' (the fake vitest's SIGTERM handler installed)", () => logText().includes('pid '));
    const pid = Number(/pid (\d+)/.exec(logText())![1]);
    c.kill('SIGTERM');
    await waitFor("'sigterm <pid>' (the wrapper forwarded the first SIGTERM)", () => logText().includes('sigterm'));
    expect(logText()).toContain('sigterm ' + pid);
    await new Promise((r) => setTimeout(r, 1200));
    c.kill('SIGTERM');
    expect(await exited(c)).toBe(143);
    expect(() => process.kill(pid, 0)).toThrow(); // SIGKILL reached the child: it is gone
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('two SIGINTs 10 ms apart (npm) let vitest stop gracefully', async () => {
    fakeVitest("process.on('SIGINT', () => setTimeout(() => { note('graceful'); process.exit(0); }, 300)); note('ready'); setInterval(() => {}, 1000);");
    const c = run();
    await waitFor("'ready' (the fake vitest's SIGINT handler installed)", () => logText().includes('ready'));
    c.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 10));
    c.kill('SIGINT');
    expect(await exited(c)).toBe(130);
    expect(logText()).toContain('graceful');
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('CI and targeted runs create no lock', async () => {
    fakeVitest("note('lock-during=' + fs.existsSync(lock)); process.exit(0);");
    expect(await exited(run([], { CI: 'true' }))).toBe(0);
    expect(await exited(run(['some/file.test.ts']))).toBe(0);
    expect(logText()).not.toContain('lock-during=true');
    expect(logText()).toContain('start run --maxWorkers=');
  });

  it('two concurrent runs serialize', async () => {
    fakeVitest("note('begin'); setTimeout(() => { note('finish'); process.exit(0); }, 500);");
    const a = run();
    await waitFor("the first run's 'begin' line", () => logText().includes('begin'));
    // The script's own 3 s poll, shortened here: the order, not the interval, is under test.
    const b = run([], { TEST_ALL_LOCK_POLL_MS: '50' });
    await Promise.all([exited(a), exited(b)]);
    const ev = logText().split('\n').filter((l) => l === 'begin' || l === 'finish');
    expect(ev).toEqual(['begin', 'finish', 'begin', 'finish']);
  }, 20000);

  it('reports a missing vitest in one line', async () => {
    fs.rmSync(path.join(proj, 'node_modules'), { recursive: true });
    const c = spawn(process.execPath, [script], { cwd: proj, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr!.on('data', (d) => (err += d));
    expect(await exited(c)).toBe(1);
    expect(err).toMatch(/no node_modules\/\.bin\/vitest/);
  });

  it('lockDir is the git common dir, the same from a linked worktree', () => {
    execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '--allow-empty', '-qm', 'x'], { cwd: proj });
    const wt = path.join(base, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'w'], { cwd: proj });
    const here = process.cwd();
    try {
      process.chdir(wt);
      expect(fs.realpathSync(path.dirname(lockDir()))).toBe(fs.realpathSync(path.join(proj, '.git')));
    } finally { process.chdir(here); }
    expect(path.basename(lockDir())).toBe('test-all.lock');
  });

  it('findVitest walks up from a subfolder', () => {
    fakeVitest('');
    const sub = path.join(proj, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    expect(findVitest(sub)).toBe(path.join(proj, 'node_modules', '.bin', 'vitest'));
  });
});

describe('every local vitest run is capped, targeted ones too (US-71 AC5)', () => {
  const repo = path.resolve(__dirname, '..');
  // In-process: a fresh import (cache-busted) evaluates the config under the stubbed env.
  let fresh = 0;
  const readCap = async (config: string, env: Record<string, string>) => {
    for (const [k, v] of Object.entries({ CI: '', TEST_ALL_MAX_WORKERS: '', ...env })) vi.stubEnv(k, v);
    try {
      const m = await import(`${path.join(repo, config)}?fresh=${fresh++}`);
      const c = m.default.test ? m.default : m.default.default;
      return c.test.maxWorkers ?? null;
    } finally { vi.unstubAllEnvs(); }
  };
  for (const config of ['vitest.config.ts', 'packages/health-core/vitest.config.ts']) {
    it(`${config}: test:all's cap locally, the override honoured, none in CI`, async () => {
      expect(await readCap(config, {})).toBe(Math.max(2, Math.floor(os.cpus().length / 4)));
      expect(await readCap(config, { TEST_ALL_MAX_WORKERS: '3' })).toBe(3);
      expect(await readCap(config, { CI: 'true' })).toBeNull();
    });
  }
});
