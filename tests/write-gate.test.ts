/**
 * US-63 AC6: live writes run merged code only (tools/write-gate.mjs, docs/git-workflow.md § Exceptions).
 * A throwaway "main checkout" with a local bare remote stands in for Brad's; each case checks the refusal the
 * tool would print, or null when it may write.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCanonicalRoot, mergedWorktreeProblem } from '../tools/write-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
let S: string, MAIN: string;
const sh = (cwd: string, cmd: string) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
};
// The real git, run with the clean config above.
const git = (dir: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV });
  return r.status === 0 ? r.stdout.trim() : null;
};
const gate = (repoRoot: string, cwd = repoRoot) => checkCanonicalRoot({ roots: [MAIN], repoRoot, cwd, git });
const worktree = (name: string) => {
  sh(MAIN, `git fetch -q origin main && git worktree add -q --detach .claude/worktrees/${name} origin/main`);
  return join(MAIN, '.claude/worktrees', name);
};

beforeAll(() => {
  S = realpathSync(mkdtempSync(join(tmpdir(), 'write-gate-')));
  MAIN = join(S, 'main');
  sh(S, 'git init -q --bare -b main remote.git && git clone -q remote.git main 2>/dev/null');
  writeFileSync(join(MAIN, '.gitignore'), '.claude/\n');
  writeFileSync(join(MAIN, 'tool.mjs'), 'one\n');
  sh(MAIN, 'git add -A && git commit -q -m one && git push -q origin main');
}, 60_000);
afterAll(() => rmSync(S, { recursive: true, force: true }));

describe('write-gate.mjs (US-63 AC6)', () => {
  it('allows the main checkout as it is', () => {
    expect(gate(MAIN)).toBeNull();
  });
  it('allows a session worktree at exactly origin/main with no tracked change', () => {
    expect(gate(worktree('clean'))).toBeNull();
  });
  it('refuses a session worktree with a tracked change (its own unmerged code)', () => {
    const w = worktree('dirty');
    writeFileSync(join(w, 'tool.mjs'), 'changed\n');
    expect(gate(w)).toMatch(/it has tracked changes/);
  });
  it('refuses a session worktree whose HEAD is not origin/main', () => {
    const w = worktree('ahead');
    sh(w, 'git commit -q --allow-empty -m unmerged');
    expect(gate(w)).toMatch(/HEAD is not exactly origin\/main/);
  });
  it('refuses a change hidden by skip-worktree', () => {
    const w = worktree('hidden');
    sh(w, 'git update-index --skip-worktree tool.mjs');
    writeFileSync(join(w, 'tool.mjs'), 'hidden\n');
    expect(gate(w)).toMatch(/skip-worktree/);
  });
  it('refuses a plain folder under .claude/worktrees/, which git resolves to the main checkout', () => {
    const fake = join(MAIN, '.claude/worktrees/fake');
    mkdirSync(fake, { recursive: true });
    expect(mergedWorktreeProblem(fake, [MAIN], git)).toMatch(/not a git worktree/);
    expect(gate(fake)).toMatch(/this tool copy is at/);
  });
  it('refuses a separate clone, and a merged tool invoked from a dirty worktree', () => {
    sh(S, 'git clone -q remote.git other 2>/dev/null');
    expect(gate(join(S, 'other'))).toMatch(/this tool copy is at/);
    const w = worktree('cwd-dirty');
    writeFileSync(join(w, 'tool.mjs'), 'changed\n');
    expect(gate(MAIN, w)).toMatch(/must be invoked from the main checkout or a merged session worktree/);
  });
  it('refuses a scratch folder whose tools/ links to the real one (the cwd check)', () => {
    const scratch = join(S, 'scratch');
    mkdirSync(scratch);
    symlinkSync(MAIN, join(scratch, 'tools'));
    expect(gate(MAIN, scratch)).toMatch(/is not in a git checkout/);
  });
  it('the live-write tools call it before writing', () => {
    for (const f of ['scripts/publish-guides.mjs', 'scripts/build-privacy-page.mjs', 'tools/backfill-shopify-link-proof.ts',
      'tools/repair-trigger-first-links.ts', 'tools/mcp-reviewer-token.ts']) {
      expect(sh(ROOT, `grep -c "requireMergedCode('" ${f}`), f).toBe('1');
    }
  });
});
