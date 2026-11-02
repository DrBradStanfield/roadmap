/**
 * US-64 AC6: a manual release is cut from the main checkout as exactly origin/main (tools/release-checkout.sh,
 * docs/deploy-runbook.md step 0). A throwaway repo with a local bare remote; a stub `npm` on PATH records that it ran.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools/release-checkout.sh');
let S: string, MAIN: string, ENV: NodeJS.ProcessEnv;
const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
};
const release = (cwd: string, dest: string) => spawnSync('bash', [SCRIPT, dest], { cwd, encoding: 'utf8', env: ENV });

beforeAll(() => {
  S = realpathSync(mkdtempSync(join(tmpdir(), 'release-')));
  mkdirSync(join(S, 'bin'));
  writeFileSync(join(S, 'bin/npm'), '#!/bin/sh\necho "$*" > npm-ran\n');
  chmodSync(join(S, 'bin/npm'), 0o755);
  ENV = {
    ...process.env, PATH: `${join(S, 'bin')}:${process.env.PATH}`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  MAIN = join(S, 'main');
  sh(S, 'git init -q --bare -b main remote.git && git clone -q remote.git main 2>/dev/null');
  writeFileSync(join(MAIN, '.gitignore'), '.env\nnpm-ran\n.claude/\n');
  writeFileSync(join(MAIN, 'app.txt'), 'merged\n');
  writeFileSync(join(MAIN, '.env'), 'X=1\n');
  sh(MAIN, 'git add -A && git commit -q -m one && git push -q origin main');
  sh(MAIN, 'git commit -q --allow-empty -m unpushed'); // the main checkout's own unpushed commit never ships
}, 60_000);
afterAll(() => rmSync(S, { recursive: true, force: true }));

describe('tools/release-checkout.sh (US-64 AC6)', () => {
  it('makes a detached checkout of exactly origin/main outside the repo, with its own npm ci, and prints it', () => {
    const dest = join(S, 'rel1');
    const r = release(MAIN, dest);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(dest);
    expect(sh(dest, 'git rev-parse HEAD')).toBe(sh(MAIN, 'git rev-parse origin/main'));
    expect(sh(dest, 'git rev-parse HEAD')).not.toBe(sh(MAIN, 'git rev-parse HEAD'));
    expect(readFileSync(join(dest, 'npm-ran'), 'utf8')).toBe('ci\n');
    expect(readFileSync(join(dest, '.env'), 'utf8')).toBe('X=1\n');
  });
  it('refuses a folder that already exists, even an empty one git would accept, and leaves it as it was', () => {
    const dest = join(S, 'rel-old');
    mkdirSync(dest);
    const r = release(MAIN, dest);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/REFUSED: .* already exists/);
    expect(readdirSync(dest)).toEqual([]);
  });
  it('refuses to run from a session worktree', () => {
    sh(MAIN, 'git worktree add -q --detach .claude/worktrees/w origin/main');
    const r = release(join(MAIN, '.claude/worktrees/w'), join(S, 'rel2'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/main checkout's root/);
    expect(existsSync(join(S, 'rel2'))).toBe(false);
  });
  it('refuses a folder inside the main checkout, directly or through a symlinked parent (re-check R6, N1)', () => {
    for (const dest of [join(MAIN, 'rel-in'), join(S, 'alias', 'rel-in')]) {
      if (dest.includes('alias') && !existsSync(join(S, 'alias'))) symlinkSync(MAIN, join(S, 'alias'));
      const r = release(MAIN, dest);
      expect(r.status, dest).not.toBe(0);
      expect(r.stderr, dest).toMatch(/inside the main checkout/);
      expect(existsSync(join(MAIN, 'rel-in')), dest).toBe(false);
    }
  });
  it('refuses a relative TMPDIR when no folder is given', () => {
    const r = spawnSync('bash', [SCRIPT], { cwd: MAIN, encoding: 'utf8', env: { ...ENV, TMPDIR: 'tmp' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/TMPDIR .* not an absolute path/);
    expect(existsSync(join(MAIN, 'tmp'))).toBe(false);
  });
  it('stops, printing nothing, when npm ci fails', () => {
    writeFileSync(join(S, 'bin/npm'), '#!/bin/sh\nexit 1\n');
    const r = release(MAIN, join(S, 'rel3'));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});
