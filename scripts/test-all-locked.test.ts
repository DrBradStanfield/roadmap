/** US-66: one local `test:all` at a time, shared across worktrees. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
// @ts-expect-error plain .mjs script
import { tryAcquire, acquire, release, readHolder, workerCap, vitestArgs } from './test-all-locked.mjs';

let base: string;
let dir: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-lock-')); dir = path.join(base, 'test-all.lock'); });
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const deadPid = () => {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid as number; // exited, so no longer alive
};

describe('test:all lock (US-66 AC1)', () => {
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

describe('worker cap and CI (US-66 AC2, AC3)', () => {
  it('defaults to max(2, cpus/4) and honours the env override', () => {
    expect(workerCap({}, 16)).toBe('4');
    expect(workerCap({}, 4)).toBe('2');
    expect(workerCap({ TEST_ALL_MAX_WORKERS: '7' }, 16)).toBe('7');
    expect(workerCap({ TEST_ALL_MAX_WORKERS: 'junk' }, 16)).toBe('4');
  });

  it('passes extra args through, and adds no cap in CI', () => {
    expect(vitestArgs(['scripts/x.test.ts', '-t', 'a'], {})).toEqual(['run', '--maxWorkers=' + workerCap({}), 'scripts/x.test.ts', '-t', 'a']);
    expect(vitestArgs(['a'], { CI: 'true' })).toEqual(['run', 'a']);
  });
});
