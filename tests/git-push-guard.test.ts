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
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      // With --input the file is the body; a branch field beside it is not what GitHub reads.
      'gh api -X PUT repos/o/r/contents/X -f branch=claude/x --input body.json',
      'gh api -X DELETE repos/o/r/contents/X -f message=m -f sha=abc1234',
      // gh fills {branch} with the current branch, which may be main; xargs supplies an endpoint the guard never sees.
      'gh api -X PATCH "repos/{owner}/{repo}/git/refs/heads/{branch}" -f sha=abc1234',
      'gh api -X PUT repos/o/r/contents/X -F branch={branch} -f message=m -f content=eA==',
      'echo repos/o/r/git/refs/heads/main | xargs gh api -X PATCH -f sha=abc1234',
      // ANSI-C text is decoded as bash decodes it, so the command in it is read.
      "bash -c $'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234'",
      // An inner string that does not parse is refused when the command holds `gh api`.
      `bash -c "echo it's; gh api repos/o/r/pulls/1"`,
      "gh api graphql -f query='mutation { enqueuePullRequest(input: {}) { clientMutationId } }'",
      // Spellings of the same writes: long field flags, --input with no method, -X=, encoded or upper-case merge paths,
      // the /graphql URL, a backtick query, and every way a branch field can name main or hide it.
      'gh api repos/o/r/git/refs/heads/main --field sha=abc1234',
      'gh api repos/o/r/git/refs/heads/main --raw-field=sha=abc1234',
      'gh api repos/o/r/git/refs/heads/main --input body.json',
      'gh api -X=PATCH repos/o/r/git/refs/heads/main',
      'gh api -X PUT repos/o/r/pulls/32/%6Derge',
      'gh api -X PUT repos/o/r/pulls/32/MERGE',
      'gh api -X PUT "repos/o/r/pulls/32/merge?a=%"',
      'gh api https://api.github.com/graphql --input q.json',
      'gh api graphql -f query="`cat q.graphql`"',
      'gh api -X PATCH "repos/o/r/git/refs/heads/`cat b`" -f sha=abc1234',
      'gh api -X PATCH "repos/$R/git/refs/heads/$B" -f sha=abc1234',
      'gh api -X POST "repos/o/r/merge$S" -f base=main -f head=claude/x',
      'gh api -X PATCH "repos/o/r//$P" -f sha=abc1234',
      'gh api -X PUT repos/o/r/contents/X -f branch=refs/heads/main -f message=m -f content=eA==',
      'gh api -X PUT repos/o/r/contents/X -F branch=@b.txt -f message=m -f content=eA==',
      'gh api -X PUT repos/o/r/contents/X -f branch="`cat b`" -f message=m -f content=eA==',
      'gh api -X PUT repos/o/r/contents/X -f branch=claude/x -f branch=main -f message=m -f content=eA==',
      `bash -c $'g''h a''pi -X PATCH repos/o/r/git/refs/heads/main'`,
      // No literal `gh`, `git` or `api` anywhere in the text: only the guard's own parse can see these.
      'sh -c "g\\\\h a\\\\pi -X PUT repos/o/r/contents/X -f message=m -f content=eA=="',
      "g''h a''pi -X PUT repos/o/r/contents/X -f message=m -f content=eA==",
      'gh api graphql -f query="mutation { $(cat body) }"',
      // A command saved in a variable for a later eval is read where it is assigned.
      'CMD="gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234"; eval "$CMD"',
      "CMD=$'gh api -X PATCH repos/o/r/git/refs/heads/main'; eval \"$CMD\"",
      // `--` ends the options; it is not an endpoint, so xargs still supplies the only one.
      'echo repos/o/r/git/refs/heads/main | xargs gh api -X PATCH -f sha=abc1234 --',
      // A field flag with no value (last on the line) must not crash the guard, which would let the call through.
      'gh api -X PUT repos/o/r/contents/X -f message=m -f',
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
      'gh api -X=GET repos/o/r/git/refs/heads/main -f per_page=1',
      'gh api -X PATCH repos/o/r/git/refs/heads/mainline -f sha=abc1234',
      'gh api -i repos/o/r/issues/5/comments -X POST -f body=hi',
      'gh api -X POST "https://api.github.com/repos/o/r/issues/$N/comments" -f body=hi',
      'gh api -X POST "/repos/o/r/issues/$N/comments" -f body=hi',
      'gh api -X PUT "repos/o/r/contents/$F" -f branch=claude/x -f message=m -f content=eA==',
      // Option values are not the endpoint, even when they hold a `$`.
      "gh api -X POST repos/o/r/issues/5/comments -f body=hi --jq '.[$k]' --template '{{$x}}' --header 'X-A: $v'",
      "gh api -X POST repos/o/r/issues/5/comments -f body=hi --preview '$p' --hostname '$h' --cache '$c'",
      "gh api -X POST repos/o/r/issues/5/comments -f body=hi -q '.[$k]' -t '{{$x}}' -H 'X-A: $v' -p '$p'",
      // A flag that takes no value does not swallow the endpoint after it.
      'gh api --paginate repos/o/r/issues/5/comments -X POST -f body=hi',
    ]) {
      expect(runHook(scratch, cmd).stdout, cmd).toBe('');
    }
  });

  // US-64 AC5, round 3 (adversary at 67f28818): what the guard cannot read is refused when the call could reach
  // GraphQL or main: run-time arguments, xargs, query or fragment suffixes on graphql, a bad percent escape beside a
  // good one, line continuations, deep nesting, globs; plus GraphQL deleteRef, merge-upstream and a forced repo sync.
  it('refuses gh api writes whose arguments are only known at run time (US-64 AC5)', () => {
    const q = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
    const nest = (n: number, inner: string): string => (n === 0 ? inner : `bash -c ${q(nest(n - 1, inner))}`);
    const PATCH_MAIN = 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234';
    for (const cmd of [
      // B1: method, fields or GraphQL text from a variable, a substitution or xargs.
      'gh api graphql -f query="mutation { $M }"',
      'gh api graphql -f query="mutation { ${M} }"',
      'gh api graphql -f "$KV"',
      'gh api graphql -F "$KV"',
      'gh api graphql $ARGS',
      'gh api repos/o/r/git/refs/heads/main $ARGS',
      'gh api repos/o/r/git/refs/heads/main $(echo -X PATCH -f sha=abc1234)',
      'gh api repos/o/r/git/refs/heads/main "$F"',
      'gh api repos/o/r/git/refs/heads/main --jq $J',
      'gh api repos/o/r/contents/X $ARGS',
      'gh api $EP',
      'echo -X PATCH -f sha=abc1234 | xargs gh api repos/o/r/git/refs/heads/main',
      'echo main | xargs -I X gh api -X PATCH repos/o/r/git/refs/heads/X -f sha=abc1234',
      `bash -c "gh api graphql -f query='mutation { $M }'"`,
      'gh api repos/o/r/git/refs/heads/main {-XPATCH,-fsha=abc1234}',
      'gh api {-XPATCH,-fsha=abc1234,repos/o/r/git/refs/heads/main}',
      'gh api repos/o/r/git/refs/heads/main "-$V"',
      'gh api repos/o/r/git/refs/heads/main *',
      'echo fsha=abc1234 | xargs -I Z gh api repos/o/r/git/refs/heads/main -Z',
      `sh -c 'gh api repos/o/r/git/refs/heads/main "$@"' _ -XPATCH -fsha=abc1234`,
      `sh -c 'gh api "$@"' _ repos/o/r/git/refs/heads/main -XPATCH -fsha=abc1234`,
      'echo -XPATCH | parallel gh api repos/o/r/git/refs/heads/main',
      // R3: the call is the gh/git word that runs, not the first one (an xargs replace string).
      `xargs -I gh ${PATCH_MAIN} < /dev/null`,
      'xargs -I git git push origin HEAD:main < /dev/null',
      // B2: gh sends graphql?x / graphql#x in REST mode and GitHub still runs the query.
      "gh api 'graphql?x=1' -F query=@q.graphql",
      "gh api 'graphql#x' --input q.json",
      'gh api graphql/ -F query=@q.graphql',
      "gh api 'graphql?x=1' -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
      "gh api 'graphql?query=mutation%7B%75pdateRef(input:{})%7D'",
      `gh api "repos/o/r/issues/$N" -f query='mutation { updateRef(input: {}) { clientMutationId } }'`,
      "gh api --jq $J repos/o/r/issues/1/comments -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
      'gh api --jq $J repos/o/r/issues/1/comments -F query=@q.graphql',
      "gh api --jq * repos/o/r/issues/1/comments -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
      'echo a`gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`b',
      'gh api -X GET repos/o/r/git/refs/heads/main --jq `cat jq.txt`',
      `git commit -m "$(cat <<EOF\nok \`gh api -X PUT repos/o/r/pulls/1/merge\`\nEOF\n)"`,
      "bash -c 'gh repo sync o/r --branch main --force'",
      "cat > n.md <<'EOF'\nDon't gh repo sync --force\nEOF",
      // Only commit/tag messages and gh pr|issue create/comment/edit/merge bodies are text; other quoted text naming a
      // write is read as a command (AC5's new refusals).
      'git stash push -m "gh api -X PUT repos/o/r/pulls/1/merge"',
      'gh release create v1 --title "gh api -X PUT repos/o/r/pulls/1/merge"',
      'gh pr checkout 1 -b "gh api -X PUT repos/o/r/pulls/1/merge"',
      'gh api graphql "-$X"',
      "gh api graphql -F n={1..2} -f query='query { viewer { login } }'",
      'gh api GraphQL --input q.json',
      'gh api graphql -f "$K=@q.graphql"',
      'gh api -X PUT repos/o/r/contents/X -f branch=dev "-$X"',
      // ANSI-C text is decoded (round 4), so this is `git push origin HEAD:main`, refused as it is when typed plainly.
      "bash -c $'gi''t pu''sh origin HEAD:main'",
      // B3: one bad escape does not stop the good ones being decoded.
      "gh api -X PATCH 'repos/o/r/git/refs/heads/%6Dain?x=%FF' -f sha=abc1234",
      "gh api -X PUT 'repos/o/r/%63ontents/README.md?x=%FF' -f message=m -f content=eA==",
      // B4: bash deletes a backslash-newline.
      'gh \\\napi -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      'gh api -X PATCH repos/o/r/git/refs/heads/ma\\\nin -f sha=abc1234',
      'gh api -X PATCH "repos/o/r/git/refs/heads/ma\\\nin" -f sha=abc1234',
      'git \\\npush origin HEAD:main',
      // B5: nesting past the depth the guard reads is refused, not passed.
      nest(4, PATCH_MAIN),
      nest(5, PATCH_MAIN),
      // Past that depth even a read is refused: the guard cannot see what it holds.
      nest(4, 'gh api repos/o/r/pulls/1'),
      // An unquoted backslash escapes one character: bash reads `ma\in` as main.
      'gh api -X PATCH repos/o/r/git/refs/heads/ma\\in -f sha=abc1234',
      // A here-string glued to its operator.
      `bash <<<${q(PATCH_MAIN)}`,
      `bash<<<${q(PATCH_MAIN)}`,
      // R1, R2, R4.
      "gh api graphql -f query='mutation { deleteRef(input: {}) { clientMutationId } }'",
      'gh api -X POST repos/o/r/merge-upstream -f branch=main',
      'gh repo sync o/r --branch main --force',
      'gh repo sync --force',
      'gh api -X PATCH repos/o/r/git/refs/heads/ma[i]n -f sha=abc1234',
      'gh api -X PATCH repos/o/r/git/refs/heads/m* -f sha=abc1234',
      // Text that a shell runs is still read: echo or grep output sent to a shell, a substitution, a file.
      `echo ${q(PATCH_MAIN)} | sh`,
      `$(echo ${q(PATCH_MAIN)})`,
      `\`echo ${q(PATCH_MAIN)}\``,
      // A backtick substitution runs its body, quoted or not, inside a message value too; so does `$(...)` there.
      'echo "`gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`"',
      '`gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`',
      'x=`gh api -X PUT repos/o/r/pulls/1/merge`',
      'ls `gh api -X PUT repos/o/r/pulls/1/merge`',
      'echo "a `gh api -X PUT repos/o/r/pulls/1/merge` b"',
      'git commit -m "`gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`"',
      'git commit -m "$(gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234)"',
      'gh pr comment 1 --body "$(gh api -X PUT repos/o/r/pulls/1/merge)"',
      `git commit -m "$(cat <<'EOF'\nok\nEOF\n)$(gh api -X PUT repos/o/r/pulls/1/merge)"`,
      `git commit -m "$(cat <<'EOF'\nok\nEOF\n)\n\`gh api -X PUT repos/o/r/pulls/1/merge\`"`,
      `git commit -m "$(cat <<'EOF'\nok\nEOF\n) \`gh api -X PUT repos/o/r/pulls/1/merge\` $(cat <<'EOF'\nEOF\n)"`,
      'gh api -X PATCH "repos/o/r/git/refs/heads/`echo main`" -f sha=abc1234',
      'bash -c "gh api -X PATCH repos/o/r/git/refs/heads/\\`echo main\\` -f sha=$S"',
      `bash <(echo ${q(PATCH_MAIN)})`,
      `echo ${q(PATCH_MAIN)} > run.sh`,
      `grep -ohF ${q(PATCH_MAIN)} tests/git-push-guard.test.ts | bash`,
      `printf -v C '%s' ${q(PATCH_MAIN)}; eval "$C"`,
    ]) {
      const r = runHook(scratch, cmd);
      expect(r.stderr, cmd).toBe('');
      expect(r.stdout, cmd).not.toBe('');
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, cmd).toBe('deny');
    }
    for (const cmd of [
      // GraphQL variables: a `$` in single quotes is GraphQL's, and a variable's value may come from the shell.
      "gh api graphql -f query='query($n: Int!) { viewer { login } }' -F n=1",
      `gh api graphql -f query='query($o: String!) { repository(owner: $o, name: "r") { id } }' -F o="$OWNER"`,
      `bash -c "gh api graphql -f query='query(\\$n: Int!) { viewer { login } }' -F n=1"`,
      // Reads with a run-time endpoint, and writes elsewhere with run-time values.
      'gh api "$EP"',
      'gh api repos/o/r/pulls/$N',
      'gh api repos/{owner}/{repo}/pulls --jq .[0].number',
      'gh api repos/{owner}/{repo}/contents/README.md',
      `gh api graphql -f query='{ repository(owner: "o", name: "r") { id } }'`,
      'gh api repos/o/r/contents/README.md?ref=main',
      'gh api -X POST "repos/o/r/issues/$N/comments" -f body="$MSG"',
      'echo 123 | xargs -I{} gh api repos/o/r/pulls/{}',
      'gh api repos/o/r/git/refs/heads/main --jq xargs',
      '/bin/echo "gh api -X PATCH repos/o/r/git/refs/heads/main"',
      'gh api -X PATCH repos/o/r/labels/graphql-api --input label.json',
      'gh extension install owner/gh-ext --force',
      'echo gh api -X PATCH repos/o/r/git/refs/heads/main',
      'echo "`gh api repos/o/r/pulls/1`"',
      'x=`gh api repos/o/r/pulls/1 --jq .title`',
      'git tag -a v1 -m "Note: gh api -X PUT repos/o/r/pulls/1/merge is refused"',
      'git commit --message="Note: gh api -X PUT repos/o/r/pulls/1/merge is refused"',
      'sudo -u git gh pr comment 1 --body "Refuses gh api -X PUT repos/o/r/pulls/1/merge"',
      "git commit -m 'Refuse `gh api -X PATCH repos/o/r/git/refs/heads/main`'",
      `git commit -m "$(cat <<'EOF'\nNote: \`gh api -X PATCH repos/o/r/git/refs/heads/main\` is refused; \$(git push) too\nEOF\n)"`,
      'git commit -m "Bump to $VERSION before the git push"',
      "cat > n.md <<'EOF'\nDon't push yet; run git status.\nEOF",
      'gh api repos/o/r/pulls/805/merge',
      'gh repo sync o/r --branch main',
      // A comment body that names a mutation is text, not a GraphQL query.
      "gh api -X POST repos/o/r/issues/805/comments -f body='Fixed: updateRef is now refused'",
      // grep/rg patterns and echo text are data when nothing runs the output.
      "grep -rn 'gh api -X PATCH' tests/",
      `rg -n "gh api -X PATCH repos/o/r/git/refs/heads/main" tests/`,
      `echo "gh api -X PATCH repos/o/r/git/refs/heads/main"`,
      "grep -rn 'gh api -X PATCH' tests/ 2>/dev/null | head -5",
      "grep -rn 'gh api -X PATCH' tests/ 2>err.log",
      `echo "gh api -X PATCH repos/o/r/git/refs/heads/main" > /dev/null`,
      `echo "gh api -X PATCH repos/o/r/git/refs/heads/main" >&2`,
      'gh \\\napi repos/o/r/pulls/1',
      nest(3, 'gh api repos/o/r/pulls/1'),
    ]) {
      expect(runHook(scratch, cmd).stdout, cmd).toBe('');
    }
  });

  // US-64 AC5, round 4 (adversary at ac0e6655): the guard pairs quotes as bash does (top-level comments, ANSI-C and
  // locale strings, heredoc bodies), so a quote it reads differently cannot hide a command inside echo text or a
  // message; a word that may still differ from bash's reading is read as commands. Multi-word expansions are unknown
  // arguments, and quoting inside the command word is decoded.
  it('reads comments, ANSI-C strings, heredocs and multi-word expansions as bash does (US-64 AC5)', () => {
    const PATCH_MAIN = 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234';
    const MERGE = 'gh api -X PUT repos/o/r/pulls/1/merge';
    for (const cmd of [
      // B7: a quote inside a comment, an escaped quote inside $'...', and a quote inside a quoted heredoc's body.
      `echo x # '\n${PATCH_MAIN}\necho y # '`,
      `echo x # "\n${PATCH_MAIN}\necho y # "`,
      `echo x #'\n${PATCH_MAIN}\necho y #'`,
      `grep -n x f # '\n${PATCH_MAIN}\n# '`,
      `echo $'a\\'' ; ${PATCH_MAIN} ; # '`,
      `git commit -m $'a\\'' ; ${PATCH_MAIN} ; # '`,
      `gh pr comment 1 --body $'a\\'' ; ${PATCH_MAIN} ; # '`,
      `cat <<'EOF'\necho '\nEOF\n${PATCH_MAIN}\n# '`,
      `cat <<'EOF'\necho '\nEOF\n${PATCH_MAIN}\nEOF2='`,
      `cat <<-"EOF"\n\techo '\n\tEOF\n${PATCH_MAIN}\n# '`,
      `cat <<EOF; echo x\nbody '\nEOF\n${PATCH_MAIN}\n# '`,
      `echo x # '\ngh repo sync o/r --branch main --force\necho y # '`,
      // The merge flags main already refused, behind the same trick (it passed at ac0e6655).
      `echo x # '\ngh pr merge 1 --admin --squash\necho y # '`,
      // A # inside a word is not a comment.
      'gh api -X PATCH repos/o/r/git/refs/heads/main#x -f sha=abc1234',
      'true # ok\n' + PATCH_MAIN,
      `echo a#; ${PATCH_MAIN}`,
      `echo x # c\n${PATCH_MAIN}`,
      // An unterminated $'...' is unparseable.
      `echo $'x\\'; ${PATCH_MAIN}`,
      // Nested strings keep no comment rule: the quote opens, and the text it swallows is read as commands.
      `bash -c "echo x # '\n${PATCH_MAIN}\necho y # '"`,
      // ...because the text may not be shell: in JS, #x is a private field.
      `node -e "class A { #x = require('child_process').execSync('${PATCH_MAIN}') }; new A()"`,
      // The decoded text is what the inner shell parses: a decoded \n separates commands, and a quote left open there
      // is unparseable.
      `bash -c $'echo x\\n${PATCH_MAIN}'`,
      `bash -c $'echo it\\'s; gh api repos/o/r/pulls/1'`,
      // An outer string's $M is expanded before the inner shell reads $'...' or a heredoc body, and an unquoted
      // heredoc expands $M inside single quotes: the query is hidden.
      `bash -c "gh api graphql -f query=$'mutation { $M }'"`,
      `bash <<EOF\ngh api graphql -f query='mutation { $M }'\nEOF`,
      `bash -c "bash <<'EOF'\ngh api graphql -f query='mutation { $M }'\nEOF"`,
      // echo text or a message holding a newline, ; & | ( or ) is read as commands, even where bash would not run it.
      `echo 'a\n${PATCH_MAIN}'`,
      `echo 'a; ${PATCH_MAIN}'`,
      `echo 'a && ${PATCH_MAIN}'`,
      `echo '(${PATCH_MAIN}'`,
      `echo '${PATCH_MAIN})'`,
      `git commit -m "a\n${MERGE}"`,
      `gh pr create --title t --body 'x | ${MERGE}'`,
      // bash 3.2 ends the $( at an unbalanced ) in a quoted heredoc body and runs a later $(...) or backtick (checked
      // with /bin/bash 3.2 for the first three, `# (` and `$((1))`). After a quote, backslash, backtick, # or ${ the
      // count no longer trusts a ( (bash skips one in a comment), so the rest are read as commands too, though bash
      // 3.2 does not run `${x/(/}`'s.
      `git commit -m "$(cat <<'EOF'\na) $(${MERGE})\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\n(a) b) \`${MERGE}\`\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\n'(' a) \`${MERGE}\`\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\n\${x/(/} a) \`${MERGE}\`\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\n# (\na) \`${MERGE}\`\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\n$((1)) a) \`${MERGE}\`\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\n\\\\( a) \`${MERGE}\`\nEOF\n)"`,
      `git commit -m "$(cat <<'EOF'\n\`x\` ( a) \`${MERGE}\`\nEOF\n)"`,
      // B8: expansions that become several words inside double quotes.
      'set -- repos/o/r/git/refs/heads/main -X PATCH -f sha=abc1234; gh api "${@}"',
      'set -- repos/o/r/git/refs/heads/main -X PATCH -f sha=abc1234; gh api "${@:1}"',
      'x=@; set -- repos/o/r/git/refs/heads/main -X PATCH -f sha=abc1234; gh api "${!x}"',
      'A=(repos/o/r/git/refs/heads/main -X PATCH -f sha=abc1234); x="A[@]"; gh api "${!x}"',
      'gh api "${ARGS_WITH_A_LONG_NAME_PAST_SIXTY_FOUR_CHARACTERS_OF_TEXT_ABCDEFGH[@]}"',
      'gh api "${(@)A}"',
      'gh api "${=A}"',
      'gh api "$=A"',
      'gh api "$A[@]"',
      'gh api repos/o/r/git/refs/heads/main "${x:-${A[@]}}"',
      'gh api repos/o/r/git/refs/heads/main --jq "${A[@]}"',
      // B9: ANSI-C and locale quoting in the command and subcommand words.
      `gh $'api' -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      'gh $"api" -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234',
      `gh $'\\x61pi' -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `gh $'\\141pi' -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `gh $'\\u0061pi' -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `gh $'\\U00000061pi' -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `$'gh' api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `gh a$'p'i -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `gh $'api\\0x' -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `gh $'api\\c@x' -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      `gh $'repo' sync o/r --branch main --force`,
      `git $'push' origin HEAD:main`,
      `gh $'pr' merge 1 --squash`,
      `gh pr merge 1 --merge --match-head-commit abc1234 $'--\\x61dmin'`,
      `gh api -X PATCH repos/o/r/git/refs/heads/$'\\x6d'ain -f sha=abc1234`,
      // A string led by a variable is not read, it is refused: here the variable may be the command.
      'bash -c "${GH:-gh} api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234"',
      // R6: zsh's =gh runs gh.
      `=gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234`,
      '=git push origin HEAD:main',
    ]) {
      const r = runHook(scratch, cmd);
      expect(r.stderr, cmd).toBe('');
      expect(r.stdout, cmd).not.toBe('');
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, cmd).toBe('deny');
    }
    for (const cmd of [
      // R9: a comment is not read, apostrophe or not.
      "gh api repos/o/r/pulls/805 --jq .head.sha  # PR's head",
      "# check the PR's head sha\ngh api repos/o/r/pulls/805 --jq .head.sha",
      "gh api graphql -f query='{ viewer { login } }' # it's a read",
      `true # ${PATCH_MAIN}`,
      `x=1;# ${PATCH_MAIN}`,
      `ls # \`${MERGE}\``,
      // A heredoc ends at its delimiter: an apostrophe in its text no longer hides the commands after it.
      "cat > n.md <<'EOF'\nIt's done.\nEOF\ngh api repos/o/r/pulls/1",
      'cat > n.md <<EOF\nIt\'s $HOME\nEOF\ngh api repos/o/r/pulls/1',
      "cat <<'A' <<'B'\nit's\nA\nwon't\nB\ngh api repos/o/r/pulls/1",
      "cat <<-'EOF'\n\tit's\n\tEOF\ngh api repos/o/r/pulls/1",
      "cat <<'EOF'\nx\nEOF\necho ok\n# it's\ngh api repos/o/r/pulls/1",
      "cat <<'EOF'; # it's\ngh api docs\nEOF\ngh api repos/o/r/pulls/1",
      "cat <<<x\n# it's\ngh api repos/o/r/pulls/1",
      // A quoted delimiter keeps the body literal: $n is GraphQL's own.
      "bash <<'EOF'\ngh api graphql -f query='query($n: Int!) { viewer { login } }' -F n=1\nEOF",
      // A < redirect and a # inside a word are not globs.
      'gh api repos/o/r/contents/README.md --jq .sha < /dev/null',
      'gh api repos/o/r/contents/README.md#L1 --jq .sha',
      // ANSI-C and locale strings are read, not refused.
      `gh api $'repos/o/r/pulls/1'`,
      `bash -c $'gh api repos/o/r/pulls/1'`,
      'gh api $"repos/o/r/pulls/1"',
      `echo $'it\\'s'`,
      `gh api repos/o/r/pulls/1 --jq $'.title + " it\\'s"'`,
      `echo $'\\U00110000'`,
      // A quoted heredoc message with balanced parentheses before its backticks stays text.
      `git commit -m "$(cat <<'EOF'\nFix (US-64): \`${PATCH_MAIN}\` is refused\nEOF\n)"`,
      // One-line echo text and messages stay data.
      `echo "${PATCH_MAIN}"`,
      `git commit -m "Refuse ${MERGE}"`,
      // A quoted ${A[*]} is one word, here an option's value.
      'gh api repos/o/r/git/refs/heads/main --jq "${A[*]}"',
    ]) {
      expect(runHook(scratch, cmd).stdout, cmd).toBe('');
    }
  });

  // US-64 AC5, round 5: the bypasses Brad's group review #909 found at 821315cb, each as he wrote it.
  it('reads ${...}, redirections, nested ANSI-C names and every gh or git word as bash does (US-64 AC5)', () => {
    const PATCH_MAIN = 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc';
    for (const cmd of [
      // R1: the space in ${x:- #} is inside the expansion, so that # starts no comment (main refuses these).
      'echo ${x:- #}; git push origin HEAD:main',
      `echo \${x:- #}; ${PATCH_MAIN}`,
      'true ${x:- #} && gh pr merge 5 --admin',
      'echo ${x// #/}; git push origin HEAD:main',
      'echo }; echo ${x:- #}; git push origin HEAD:main',
      // R2: `x2>` is the word x2 and a stdout redirect, and `>&2run.sh` writes the file 2run.sh (main refuses these).
      "echo 'git push --force origin main #' x2>run.sh; bash run.sh",
      "echo 'git push --force origin main #' >&2run.sh; bash 2run.sh",
      // R3: ANSI-C quoting in a nested command name; also when the command does not parse.
      `bash -c "g\\$'it' push --force origin main"`,
      `bash -c "g\\$'it' push --force origin main" '`,
      'bash -c "g\\$\\"it\\" push --force origin main"',
      // Note (b): the gh or git word that runs need not be the first or a doubled one.
      `env -u gh gh ${PATCH_MAIN.slice(3)}`,
      `sudo -u gh gh ${PATCH_MAIN.slice(3)}`,
      'find . -name git -exec git push --force origin main \\;',
      `find . -name gh -exec gh ${PATCH_MAIN.slice(3)} \\;`,
      // Note (c): a method override header makes an explicit GET a write.
      `gh api -X GET -H 'X-HTTP-Method-Override: PATCH' repos/o/r/git/refs/heads/main -f sha=abc`,
    ]) {
      const r = runHook(scratch, cmd);
      expect(r.stderr, cmd).toBe('');
      expect(r.stdout, cmd).not.toBe('');
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, cmd).toBe('deny');
    }
    for (const cmd of [
      // A comment after a closed ${...} is still a comment, and stderr or /dev/null redirects still keep echo data.
      'echo $HOME ${HOME}; gh api repos/o/r/pulls/1 # PR\'s head',
      'ls *{; gh api repos/o/r/pulls/1 # PR\'s head',
      "echo 'git push --force origin main' 2>err.log",
      "2>err.log ls; echo 'git push --force origin main'",
      "true;2>err.log ls; echo 'git push --force origin main'",
      "echo 'git push --force origin main' >        /dev/null; ls",
      "echo 'git push --force origin main' >&2",
      "echo 'git push --force origin main' > /dev/null; ls",
      // An explicit GET with other headers is a read; a find that runs no gh or git is not checked.
      "gh api -X GET -H 'Accept: application/vnd.github+json' repos/o/r/git/refs/heads/main",
      "find . -name '*.md' -exec grep -l git {} +",
      // Note (a)'s way forward: the body in a file.
      'gh pr create --title t --body-file notes.md',
      'git commit -F msg.txt',
      // A backtick body then an apostrophe is not a $'...' (the R3 rule looks only outside backtick bodies).
      `gh pr create --title t --body "$(cat <<'EOF'\nIt's (a) fix: \`x\`'s sync note\nEOF\n)"`,
    ]) {
      expect(runHook(scratch, cmd).stdout, cmd).toBe('');
    }
    // A cd moves the guard once, even into a folder named git: there a bare push from claude/x with upstream main is
    // refused.
    const repo = join(scratch, 'git');
    for (const args of [['init', '-q', '-b', 'claude/x', repo], ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'one'],
      ['-C', repo, 'config', 'branch.claude/x.merge', 'refs/heads/main']]) {
      expect(spawnSync('git', args, { env: GIT_ENV }).status).toBe(0);
    }
    expect(JSON.parse(runHook(scratch, 'cd git && git push').stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    rmSync(repo, { recursive: true, force: true });
    // Note (a): a heredoc body the guard cannot read (here a " inside "$(...)", which bash allows) is still refused,
    // now with a way forward that the guard allows.
    const body = runHook(scratch, `gh pr create --title t --body "$(cat <<'EOF'\nBrad said "it's fine" to the gh api change.\nEOF\n)"`);
    expect(JSON.parse(body.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/Write tool.*--body-file.*git commit -F/);
    const msg = runHook(scratch, `git commit -m "$(cat <<'EOF'\nSaid "don't push" here.\nEOF\n)"`);
    expect(JSON.parse(msg.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/git push on its own line.*Write tool.*git commit -F/);
  });

  // US-64 AC5, round 4 (adversary at ac0e6655, B10): a guard that crashed exited 1, which Claude Code reads as "go
  // ahead", and a guard still running at Claude Code's hook timeout lets the call through. Every error now refuses,
  // the guard refuses once its own 60 s budget is spent, and settings.json blocks the call if the hook fails anyway.
  it('refuses when it crashes or runs out of time, never lets the command run (US-64 AC5)', () => {
    const PATCH_MAIN = 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234';
    const run = (command: unknown, env: Record<string, string> = {}, raw?: string) => spawnSync('bash', ['-c', settingsHookCommand()], {
      input: raw ?? JSON.stringify({ cwd: scratch, tool_input: { command } }), encoding: 'utf8', timeout: 60_000,
      maxBuffer: 1 << 26, env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: ROOT, ...env },
    });
    const denied = (r: ReturnType<typeof run>) => r.status === 0 && JSON.parse(r.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny';
    // Shapes that overflowed the stack (one string holding over 125k commands).
    for (const cmd of [
      `bash -c '${':\n'.repeat(140_000)}${PATCH_MAIN}'`,
      `echo "${'`:`'.repeat(130_000)}"; ${PATCH_MAIN}`,
      `X="${':;'.repeat(130_000)} ${PATCH_MAIN}"; eval "$X"`,
    ]) {
      const r = run(cmd);
      expect(r.stderr, cmd.slice(-80)).toBe('');
      expect(denied(r), cmd.slice(-80)).toBe(true);
    }
    // Any error refuses: input that is not JSON, or a command that is not a string.
    for (const r of [run(null, {}, 'not json'), run(['gh', 'api'])]) {
      expect(denied(r)).toBe(true);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/^Push guard failed/);
    }
    // Past its budget it refuses. PUSH_GUARD_BUDGET_MS can only lower the 60 s budget.
    const late = run('git push origin claude/x', { PUSH_GUARD_BUDGET_MS: '1' });
    expect(denied(late)).toBe(true);
    expect(JSON.parse(late.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/ran out of time/);
    expect(denied(run('gh api repos/o/r/pulls/1', { PUSH_GUARD_BUDGET_MS: '-1' }))).toBe(true); // spent before the first check
    expect(run('git push origin claude/x', { PUSH_GUARD_BUDGET_MS: '600000' }).stdout).toBe('');
    // A git call that hangs is cut off at the budget, and the guard refuses (here the fetch for a plain push's
    // behind-main check, the last check, whose own failure lets the push go ahead: see the next test).
    const bin = mkdtempSync(join(tmpdir(), 'slow-git-'));
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(bin, 'git'), `#!/bin/bash\ncase " $* " in *" fetch "*) exec sleep 30;; esac\nexec ${realGit} "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const t0 = Date.now();
    const slow = run('git push', { PATH: `${bin}:${process.env.PATH}`, PUSH_GUARD_BUDGET_MS: '4000' });
    expect(denied(slow)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000); // cut off at the budget, not at the fetch's own 30 s timeout
    expect(JSON.parse(slow.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/ran out of time/);
    rmSync(bin, { recursive: true, force: true });
    // Claude Code (v2.1.295+) blocks the call when the hook fails to start, exits other than 0 or 2, or times out.
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash').hooks[0].onFailure).toBe('block');
  }, 120_000);

  // US-64 AC5, round 3: a long command the guard cannot parse (a heredoc with one apostrophe) is decided in linear
  // time. The old fallback regexes took over 120 s on 1 MB.
  // Round 4: so is a 1 MB run of `${x}` (each `${` looks ahead for `[@` and `}`).
  it('decides an unparseable 1 MB command quickly (US-64 AC5)', () => {
    for (const cmd of [`cat > notes.md <<'EOF'\nDon't ${'git gh word '.repeat(90_000)}\nEOF`, `echo "${'${x}'.repeat(260_000)}"`]) {
      expect(cmd.length).toBeGreaterThan(1_000_000);
      const t0 = Date.now();
      const payload = JSON.stringify({ cwd: scratch, tool_input: { command: cmd } });
      const r = spawnSync('bash', ['-c', settingsHookCommand()], {
        input: payload, encoding: 'utf8', timeout: 20_000, env: { ...GIT_ENV, CLAUDE_PROJECT_DIR: ROOT },
      });
      const ms = Date.now() - t0;
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(ms).toBeLessThan(3000);
    }
  }, 60_000);

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
