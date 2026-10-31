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
    scratch = mkdtempSync(join(tmpdir(), 'push-guard-'));
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
    expect(cases.length).toBeGreaterThanOrEqual(70);
    expect(mismatches).toEqual([]);
    expect(r.status).toBe(0);
  }, 120_000);

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
  }, 120_000);
});
