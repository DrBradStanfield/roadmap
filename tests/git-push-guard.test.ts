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
    // The hook input holds the cwd. The settings wiring now runs the guard on every Bash call; the folder name still
    // holds none of the old gate words, so a word gate put back in settings cannot pass these tests through the cwd.
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

  // US-64 AC5: a write to main through `gh api` is refused. These commands hold neither "push" nor "merge", so the
  // settings wiring must still send them to the guard (the shell test pipes straight into the guard and skips it).
  it('reaches the guard for a gh api write to main, which holds no "push" or "merge" (US-64 AC5)', () => {
    for (const cmd of [
      'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api --method PATCH -f sha=abc1234 repos/o/r/git/refs/heads/main',
      'gh api repos/o/r/git/refs/heads/main --method=PATCH -f sha=abc1234',
      "gh api graphql -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation M { updateRef(input: {}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { updateRefs(input: {}) { clientMutationId } }'",
    ]) {
      const r = runHook(scratch, cmd);
      expect(r.stderr, cmd).toBe('');
      expect(r.stdout, cmd).not.toBe('');
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, cmd).toBe('deny');
    }
    // A read of main's ref is still allowed.
    expect(runHook(scratch, 'gh api repos/o/r/git/refs/heads/main').stdout).toBe('');
  });

  // US-64 AC5, Brad's review of #805 (group #830): forms that still reached main. A quoted `bash -lc '...'` command
  // was not parsed; spellings without a gate word never reached the guard; a file, a variable or an encoded path hid
  // the target; GraphQL createCommitOnBranch and the contents API write main without any keyword.
  it('refuses quoted, encoded, hidden and keyword-free gh api writes to main (US-64 AC5)', () => {
    for (const cmd of [
      "bash -lc 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234'",
      `bash -lc "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'"`,
      `sh -c "g''h a''pi -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234"`,
      "gh api -X PATCH repos/o/r/git/refs/heads/ma''in -f sha=abc1234",
      'gh api -X PATCH "repos/o/r/git/refs/heads/$B" -f sha=abc1234',
      'gh api -X PATCH "repos/o/r/$REF" -f sha=abc1234',
      'gh api -X PATCH repos/o/r/git/refs/heads%2Fmain -f sha=abc1234',
      'gh api -X PATCH repos/o/r/git/refs/heads/%6Dain -f sha=abc1234',
      'gh api -iXPATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X GET -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X DELETE repos/o/r/git/refs/heads/main',
      'gh api graphql -F query=@q.graphql',
      'gh api graphql --input q.json',
      'gh api graphql -f query="$Q"',
      'gh api graphql -f query="$(cat q.graphql)"',
      "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'",
      "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
      'gh api -X PUT repos/o/r/contents/X -f branch=main -f message=m -f content=eA==',
      'gh api -X PUT repos/o/r/contents/X -f message=m -f content=eA==',
      'gh api -X PUT repos/o/r/contents/X -f branch="$BR" -f message=m -f content=eA==',
      'gh api -X PUT repos/o/r/contents/X --input body.json',
      'gh api -X DELETE repos/o/r/contents/X -f message=m -f sha=abc1234',
      // gh fills {branch} with the current branch, which may be main; xargs supplies an endpoint the guard never sees.
      'gh api -X PATCH "repos/{owner}/{repo}/git/refs/heads/{branch}" -f sha=abc1234',
      'gh api -X PUT repos/o/r/contents/X -F branch={branch} -f message=m -f content=eA==',
      'echo repos/o/r/git/refs/heads/main | xargs gh api -X PATCH -f sha=abc1234',
      // ANSI-C quoting is not parsed, so a command in it is refused rather than passed.
      "bash -c $'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234'",
      // An inner string that does not parse is refused when the command holds `gh api`.
      `bash -c "echo it's; gh api repos/o/r/pulls/1"`,
      "gh api graphql -f query='mutation { enqueuePullRequest(input: {}) { clientMutationId } }'",
    ]) {
      const r = runHook(scratch, cmd);
      expect(r.stderr, cmd).toBe('');
      expect(r.stdout, cmd).not.toBe('');
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, cmd).toBe('deny');
    }
    // Reads, an explicit GET with fields, a write elsewhere, and a contents write to a named other branch stay allowed.
    for (const cmd of [
      'echo hello',
      'gh api -X GET repos/o/r/git/refs/heads/main -f per_page=1',
      'gh api --method=get repos/o/r/git/refs/heads/main -F per_page=1',
      'gh api repos/o/r/git/refs/heads/main',
      "gh api graphql -f query='query { viewer { login } }'",
      'gh api -X POST repos/o/r/issues/5/comments -f body=hi',
      'gh api -X POST "repos/o/r/issues/$N/comments" -f body=hi',
      'gh api -X PUT repos/o/r/contents/X -f branch=claude/x -f message=m -f content=eA==',
      "bash -lc 'gh api repos/o/r/git/refs/heads/main'",
      'gh api -X POST "repos/{owner}/{repo}/issues/{}/comments" -f body=hi',
      'gh api -X HEAD repos/o/r/git/refs/heads/main -f per_page=1',
      'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/claude/x -f sha=abc1234',
    ]) {
      expect(runHook(scratch, cmd).stdout, cmd).toBe('');
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
