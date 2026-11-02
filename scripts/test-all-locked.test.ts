/** US-68: one local `test:all` at a time, shared across worktrees. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('test:all lock (US-68 AC1)', () => {
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

  it('a real run releases the lock on exit and on SIGTERM', async () => {
    const script = `
      import { tryAcquire, release } from ${JSON.stringify(path.resolve(__dirname, 'test-all-locked.mjs'))};
      const d = ${JSON.stringify(dir)};
      tryAcquire(d);
      process.on('exit', () => release(d));
      process.on('SIGTERM', () => process.exit(143));
      console.log('held'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => child.stdout!.once('data', r));
    expect(fs.existsSync(dir)).toBe(true);
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('worker cap and CI (US-68 AC2, AC3)', () => {
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
  });

  it('passes extra args through, and adds no cap in CI', () => {
    expect(vitestArgs(['scripts/x.test.ts', '-t', 'a'], {})).toEqual(['run', '--maxWorkers=' + workerCap({}), 'scripts/x.test.ts', '-t', 'a']);
    expect(vitestArgs(['a'], { CI: 'true' })).toEqual(['run', 'a']);
  });
});

describe('lock holder liveness and takeover races (US-68 AC1)', () => {
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

  it('prints the rm hint only for a stale holder', async () => {
    const lines: string[] = [];
    tryAcquire(dir, { pid: process.ppid, started: 'S', cwd: 'c' });
    await expect(acquire(dir, { pollMs: 10, timeoutMs: 30, log: (l: string) => lines.push(l) })).rejects.toThrow();
    expect(lines[0]).toContain(`do not remove; pid ${process.ppid} is alive`);
    expect(lines[0]).not.toContain('rm -rf');
  });
});

describe('the real script (US-68 AC1-AC3)', () => {
  const script = path.resolve(__dirname, 'test-all-locked.mjs');
  let proj: string;
  let log: string;
  beforeEach(() => {
    proj = path.join(base, 'proj');
    log = path.join(base, 'log.txt');
    fs.mkdirSync(path.join(proj, 'node_modules', '.bin'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: proj });
  });
  // The fake vitest logs start/end with the lock's presence, then behaves as MODE says.
  const fakeVitest = (body: string) => {
    const bin = path.join(proj, 'node_modules', '.bin', 'vitest');
    fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const lock = ${JSON.stringify(path.join(proj, '.git', 'test-all.lock'))};
const note = (m) => fs.appendFileSync(${JSON.stringify(log)}, m + '\\n');
note('start ' + process.argv.slice(2).join(' ') + ' lock=' + fs.existsSync(lock));
${body}`, { mode: 0o755 });
  };
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    spawn(process.execPath, [script, ...args], { cwd: proj, env: { ...process.env, CI: '', ...env }, stdio: 'ignore' });
  const exited = (c: ReturnType<typeof spawn>) => new Promise<number | null>((r) => c.once('exit', (code) => r(code)));
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); };
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
    await waitFor(() => logText().includes('start'));
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(true);
    expect(await exited(c)).toBe(0);
    expect(logText()).toContain('end lock=true');
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('SIGTERM stops the child, exits 143 and releases the lock', async () => {
    fakeVitest("process.on('SIGTERM', () => setTimeout(() => { note('child-term'); process.exit(0); }, 200)); setInterval(() => {}, 1000);");
    const c = run();
    await waitFor(() => logText().includes('start'));
    c.kill('SIGTERM');
    expect(await exited(c)).toBe(143);
    expect(logText()).toContain('child-term');
    expect(fs.existsSync(path.join(proj, '.git', 'test-all.lock'))).toBe(false);
  });

  it('a second signal force-kills the child group', async () => {
    fakeVitest("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const c = run();
    await waitFor(() => logText().includes('start'));
    c.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 150));
    c.kill('SIGTERM');
    expect(await exited(c)).toBe(143);
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
    await waitFor(() => logText().includes('begin'));
    const b = run();
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
