#!/usr/bin/env node
/**
 * `npm run test:all` for a Mac running many sessions: one full local run at a
 * time across every checkout and worktree (US-68), with a worker cap.
 * The lock is a directory in the git common dir, shared by all worktrees.
 * CI skips the lock and the cap. A run with file or other non-flag arguments
 * (a targeted run) skips the lock but keeps the cap. Extra args go to vitest.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function lockDir() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common) return path.join(common, 'test-all.lock');
  } catch { /* not a git checkout */ }
  return path.join(os.tmpdir(), 'roadmap-test-all.lock');
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const groupAlive = (pgid) => {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
/** Held while the wrapper or the vitest process group still runs. */
export const holderAlive = (h) => !!h && (alive(h.pid) || (!!h.child && groupAlive(h.child)));

export function readHolder(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { return null; }
}

const writeOwner = (dir, info) => fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(info));

/** Record the vitest pid (its own process group) so a killed wrapper keeps the lock held. */
export function recordChild(dir, pid) {
  const h = readHolder(dir);
  if (h && h.pid === process.pid) writeOwner(dir, { ...h, child: pid });
}

/** One try. Returns true when we now hold the lock; false when someone live does. */
export function tryAcquire(dir, info = { pid: process.pid, started: new Date().toISOString(), cwd: process.cwd() }) {
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readHolder(dir);
    if (holderAlive(holder)) return false;
    if (!holder) {
      // owner.json not written yet, or unreadable: stale only once the directory is old.
      try { if (Date.now() - fs.statSync(dir).mtimeMs < 10_000) return false; } catch { return false; }
    }
    // Rename first: of several racing takers only one rename succeeds. Then check what we
    // moved is the lock we judged stale; if a fresh owner got in between, put it back.
    const aside = `${dir}.stale-${process.pid}-${Date.now()}`;
    try { fs.renameSync(dir, aside); } catch { return false; }
    const moved = readHolder(aside);
    if (holder ? moved?.pid !== holder.pid : holderAlive(moved)) {
      try { fs.renameSync(aside, dir); } catch { /* a newer lock exists; leave the aside */ }
      return false;
    }
    fs.rmSync(aside, { recursive: true, force: true });
    return tryAcquire(dir, info);
  }
  writeOwner(dir, info);
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
      const hint = holderAlive(h) ? `do not remove; pid ${h.pid} is alive` : `looks stale; to clear: rm -rf ${dir}`;
      log(`test:all is locked by pid ${h?.pid ?? '?'} (started ${h?.started ?? '?'}, in ${h?.cwd ?? '?'}); waiting (${hint})`);
      told = true;
    }
    if (Date.now() >= end) throw new Error(`timed out waiting for the test:all lock (${dir})`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export const workerCap = (env = process.env, cpus = os.cpus().length) =>
  Number(env.TEST_ALL_MAX_WORKERS) > 0 ? String(Number(env.TEST_ALL_MAX_WORKERS)) : String(Math.max(2, Math.floor(cpus / 4)));

export const inCI = (env = process.env) => !!env.CI && env.CI !== 'false' && env.CI !== '0';
export const timeoutMinutes = (env = process.env) => (Number(env.TEST_ALL_LOCK_TIMEOUT_MIN) > 0 ? Number(env.TEST_ALL_LOCK_TIMEOUT_MIN) : 60);
/** A targeted run names files or filters: any argument that is not a flag. */
export const isTargeted = (extra) => extra.some((a) => !a.startsWith('-'));

export function vitestArgs(extra, env = process.env) {
  return inCI(env) ? ['run', ...extra] : ['run', `--maxWorkers=${workerCap(env)}`, ...extra];
}

export function findVitest(from = process.cwd()) {
  for (let d = path.resolve(from); ; d = path.dirname(d)) {
    const bin = path.join(d, 'node_modules', '.bin', 'vitest');
    if (fs.existsSync(bin)) return bin;
    if (path.dirname(d) === d) return null;
  }
}

async function main() {
  const extra = process.argv.slice(2);
  const bin = findVitest();
  if (!bin) { console.error('test:all: no node_modules/.bin/vitest found above ' + process.cwd()); process.exit(1); }
  const locked = !inCI() && !isTargeted(extra);
  const dir = lockDir();
  if (locked) await acquire(dir, { timeoutMs: timeoutMinutes() * 60_000 });

  // Own process group, so signals and the lock cover vitest's workers too.
  const child = spawn(bin, vitestArgs(extra), { stdio: 'inherit', detached: true });
  if (locked) recordChild(dir, child.pid);
  let signals = 0;
  let exitCode = null;
  child.on('error', (e) => { console.error(`test:all: could not start vitest (${e.code ?? e.message})`); exitCode = 1; if (locked) release(dir); process.exit(1); });
  for (const [name, num] of [['SIGINT', 2], ['SIGTERM', 15]]) {
    process.on(name, () => {
      exitCode = 128 + num;
      try { process.kill(-child.pid, ++signals > 1 ? 'SIGKILL' : name); } catch { /* group gone */ }
    });
  }
  child.on('exit', (code, sig) => {
    if (locked) release(dir);
    process.exit(exitCode ?? code ?? (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
