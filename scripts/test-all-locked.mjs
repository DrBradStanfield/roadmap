#!/usr/bin/env node
/**
 * `npm run test:all` for a Mac running many sessions: one full local run at a
 * time across every checkout and worktree (US-66), with a worker cap.
 * The lock is a directory in the git common dir, shared by all worktrees.
 * CI (CI env set) skips the lock and the cap. Extra args go to vitest.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function lockDir() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    if (common) return path.join(common, 'test-all.lock');
  } catch { /* not a git checkout */ }
  return path.join(os.tmpdir(), 'roadmap-test-all.lock');
}

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export function readHolder(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { return null; }
}

/** One try. Returns true when we now hold the lock; false when someone live does. */
export function tryAcquire(dir, info = { pid: process.pid, started: new Date().toISOString(), cwd: process.cwd() }) {
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readHolder(dir);
    if (holder && isAlive(holder.pid)) return false;
    // Stale (dead pid), or owner.json not written yet / unreadable: only a dead pid is taken over.
    if (!holder) {
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { return false; }
      if (age < 10_000) return false;
    }
    // Rename first: of several racing takers only one rename succeeds.
    const aside = `${dir}.stale-${process.pid}-${Date.now()}`;
    try { fs.renameSync(dir, aside); } catch { return false; }
    fs.rmSync(aside, { recursive: true, force: true });
    return tryAcquire(dir, info);
  }
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(info));
  return true;
}

export function release(dir, pid = process.pid) {
  const holder = readHolder(dir);
  if (holder && holder.pid === pid) fs.rmSync(dir, { recursive: true, force: true });
}

export async function acquire(dir, { timeoutMs = 60 * 60_000, pollMs = 3000, log = console.error } = {}) {
  const end = Date.now() + timeoutMs;
  let told = false;
  while (!tryAcquire(dir)) {
    if (!told) {
      const h = readHolder(dir);
      log(`test:all is locked by pid ${h?.pid ?? '?'} (started ${h?.started ?? '?'}, in ${h?.cwd ?? '?'}); waiting. Clear a stuck lock: rm -rf ${dir}`);
      told = true;
    }
    if (Date.now() >= end) throw new Error(`timed out waiting for the test:all lock (${dir})`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export const workerCap = (env = process.env, cpus = os.cpus().length) =>
  Number(env.TEST_ALL_MAX_WORKERS) > 0 ? String(Number(env.TEST_ALL_MAX_WORKERS)) : String(Math.max(2, Math.floor(cpus / 4)));

export function vitestArgs(extra, env = process.env) {
  return env.CI ? ['run', ...extra] : ['run', `--maxWorkers=${workerCap(env)}`, ...extra];
}

async function main() {
  const extra = process.argv.slice(2);
  const bin = path.join(process.cwd(), 'node_modules', '.bin', 'vitest');
  const run = () => spawn(bin, vitestArgs(extra), { stdio: 'inherit' });
  if (process.env.CI) return run().on('exit', (c) => process.exit(c ?? 1));

  const dir = lockDir();
  const timeoutMs = (Number(process.env.TEST_ALL_LOCK_TIMEOUT_MIN) || 60) * 60_000;
  await acquire(dir, { timeoutMs });
  let child;
  const done = (code) => { release(dir); process.exit(code); };
  process.on('exit', () => release(dir));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { child?.kill(s); done(130); });
  child = run();
  child.on('exit', (c) => done(c ?? 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
