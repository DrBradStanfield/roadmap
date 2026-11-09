/**
 * The git push guard (.claude/hooks/) is CommonJS, and the root package.json
 * sets "type": "module". Saved as `.js`, Node loads it as an ES module, it
 * throws "require is not defined" on its first line and exits 1, and Claude
 * Code treats a non-2 exit as "allow". So the guard let every force push and
 * branch delete through. Its own shell test printed 37 mismatches and still
 * exited 0, and nothing ran it.
 *
 * Housekeeping (no user-facing behaviour). These tests run the hook exactly as
 * .claude/settings.json wires it, and run the shell test, so test:all in CI
 * now catches a guard that does not load.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, '.claude/hooks/git-push-guard.test.sh');

// A clean git: no user or system config (signing, hooks), a fixed identity.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function settingsHookCommand(): string {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'));
  const bash = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash');
  return bash.hooks[0].command;
}

function runHook(cwd: string, command: string) {
  const payload = JSON.stringify({ cwd, tool_input: { command } });
  return spawnSync('bash', ['-c', settingsHookCommand()], {
    input: payload,
    encoding: 'utf8',
    env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: ROOT },
  });
}

describe('git push guard, as .claude/settings.json runs it', () => {
  let scratch: string;
  beforeAll(() => {
    // The hook input holds the cwd. A folder named after a gate word would send every payload to the guard and hide
    // a word missing from the settings gate, so the folder name holds none of them.
    scratch = mkdtempSync(join(tmpdir(), 'hook-wiring-'));
    expect(scratch).not.toMatch(/push|merge|refs\/heads\/main|updateRef/);
  });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('loads and denies a force push', () => {
    const r = runHook(scratch, 'git push --force origin main');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('loads and denies a branch delete', () => {
    const r = runHook(scratch, 'git push origin --delete shared');
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('reaches the guard for a gh pr merge, which holds no "push" (US-64 AC5)', () => {
    const r = runHook(scratch, 'gh pr merge 415 --squash --match-head-commit abc1234');
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(runHook(scratch, 'gh pr merge 415 --merge --match-head-commit abc1234').stdout).toBe('');
  });

  // US-64 AC5: a plain write to main's ref through `gh api` is refused. These commands hold neither "push" nor
  // "merge", so the settings wiring must still send them to the guard (the shell test pipes straight into the guard).
  it('reaches the guard for a plain gh api write to main, which holds no "push" or "merge" (US-64 AC5)', () => {
    for (const cmd of [
      'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -XPATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api --method PATCH -f sha=abc1234 repos/o/r/git/refs/heads/main',
      'gh api repos/o/r/git/refs/heads/main --method=PATCH -f sha=abc1234',
      'gh api repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X GET -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X PATCH repos/o/r/git/refs/heads/main',
      'gh api -X POST repos/o/r/git/refs/heads/main',
      'gh api -X PUT repos/o/r/git/refs/heads/main',
      'gh api -X DELETE repos/o/r/git/refs/heads/main',
      'gh api -XDELETE repos/o/r/git/refs/heads/main',
      'gh api repos/o/r/git/refs/heads/main --method=DELETE',
      'gh api -X delete repos/o/r/git/refs/heads/main',
      // Fields count as a write unless every method flag is a plain GET or HEAD.
      'gh api -X GET -X OPTIONS repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X get repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X=PATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X GET -iXPATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X XPATCH repos/o/r/git/refs/heads/main',
      'gh api -XGETX repos/o/r/git/refs/heads/main -f sha=abc1234',
      "gh api graphql -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation M { updateRef(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { updateRefs(input: {}) { clientMutationId } }'",
    ]) {
      const r = runHook(scratch, cmd);
      expect(r.stderr, cmd).toBe('');
      expect(r.stdout, cmd).not.toBe('');
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, cmd).toBe('deny');
    }
    // Reads of main's ref stay allowed, an explicit GET or HEAD with fields included (a GET or HEAD changes nothing).
    for (const cmd of [
      'gh api repos/o/r/git/refs/heads/main',
      'gh api -X GET repos/o/r/git/refs/heads/main -f per_page=1',
      'gh api repos/o/r/git/refs/heads/main --method=GET -F per_page=1',
      'gh api -XHEAD repos/o/r/git/refs/heads/main -f per_page=1',
      'gh api --method HEAD repos/o/r/git/refs/heads/main -F per_page=1',
      'gh api -X DELETE repos/o/r/git/refs/heads/feature',
    ]) {
      const r = runHook(scratch, cmd);
      expect(r.stderr, cmd).toBe('');
      expect(r.stdout, cmd).toBe('');
    }
  });

  it('settings.json allows exactly the reviewed merge form and denies the four flags (US-64 AC5)', () => {
    // Claude Code's Bash(...) rules: `*` matches any text; a deny beats an allow.
    const { allow, deny } = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')).permissions;
    const rx = (rule: string) => new RegExp(`^${rule.replace(/^Bash\((.*)\)$/, '$1')
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const verdict = (cmd: string) => (deny.some((r: string) => rx(r).test(cmd)) ? 'deny'
      : allow.some((r: string) => /gh pr merge/.test(r) && rx(r).test(cmd)) ? 'allow' : 'ask');
    expect(verdict('gh pr merge 415 --merge --match-head-commit abc1234')).toBe('allow');
    for (const flag of ['--admin', '--squash', '--rebase', '--auto']) {
      expect(verdict(`gh pr merge 415 --merge ${flag} --match-head-commit abc1234`), flag).toBe('deny');
    }
    expect(verdict('gh pr merge 415')).toBe('ask');
  });

  it('loads and allows a plain push it cannot fetch for', () => {
    const r = runHook(scratch, 'git push');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('git-push-guard.test.sh', () => {
  it('passes every case and exits 0', () => {
    const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: GIT_ENV });
    const cases = r.stdout.split('\n').filter((l) => /^(DENY|allow)\s+expected\s+(DENY|allow)\s/.test(l));
    const mismatches = cases.filter((l) => {
      const [, got, want] = l.match(/^(\S+)\s+expected\s+(\S+)/)!;
      return got !== want;
    });
    expect(cases.length).toBeGreaterThanOrEqual(158);
    expect(mismatches).toEqual([]);
    expect(r.status).toBe(0);
  }, 240_000);

  it('exits non-zero when a case does not match', () => {
    // A copy of the script beside a guard that fails open (exit 1, no output),
    // as the ES-module crash did. The script resolves the guard next to itself.
    const dir = mkdtempSync(join(tmpdir(), 'push-guard-sh-'));
    try {
      copyFileSync(SCRIPT, join(dir, 'git-push-guard.test.sh'));
      for (const name of ['git-push-guard.js', 'git-push-guard.cjs']) {
        writeFileSync(join(dir, name), 'process.exit(1);\n');
      }
      const r = spawnSync('bash', [join(dir, 'git-push-guard.test.sh')], { encoding: 'utf8', env: GIT_ENV });
      expect(r.stdout).toMatch(/^allow\s+expected DENY/m);
      expect(r.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
