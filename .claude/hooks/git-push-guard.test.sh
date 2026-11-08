#!/bin/bash
# Test for git-push-guard.cjs against a throwaway local bare remote. Run: bash .claude/hooks/git-push-guard.test.sh
# Prints one line per case; every line must read DENY/DENY or allow/allow. Exits 1 if any does not.
# tests/git-push-guard.test.ts runs it in CI.
G="$(cd "$(dirname "$0")" && pwd)/git-push-guard.cjs"
fail=0
S=$(mktemp -d); rm -rf "$S"; mkdir -p "$S"; cd "$S" || exit 1
git init -q --bare -b main remote.git; git clone -q remote.git a 2>/dev/null
(cd a && git commit -q --allow-empty -m one && git push -q origin main); git clone -q remote.git b
t(){ out=$(printf '{"cwd":"%s","tool_input":{"command":%s}}' "$1" "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$2")" | node "$G")
  case "$out" in *deny*) r=DENY;; *) r=allow;; esac; printf '%-6s expected %-6s %s\n' "$r" "$3" "[$2] in $(basename "$1")"; [ "$r" = "$3" ] || fail=1; }
t "$S/b" "git push" allow
t "$S/b" "git push --force origin main" DENY
t "$S/b" "git push -f" DENY
t "$S/b" "git push origin +main" DENY
t "$S/b" "git push --force-with-lease" DENY
t "$S/b" "git push origin --delete foo" DENY
t "$S/b" "git push origin \"--force\" HEAD~1:main" DENY
t "$S/b" "git --no-pager push --force origin main" DENY
t "$S/b" "git push origin :refs/heads/shared" DENY
t "$S/b" "git push origin ':shared'" DENY
t "$S/b" "git -c core.x=1 push -uf origin main" DENY
t "$S/b" "/usr/bin/git push --mirror" DENY
t "$S/b" "git push 'unclosed" DENY
t "$S/b" "git push --del origin main" DENY
t "$S/b" "git push --forc origin main" DENY
t "$S/b" "bash -c 'git push --force origin main'" DENY
t "$S/b" "sh -c \"cd x && git push -f\"" DENY
t "$S/b" "git -c remote.origin.push=+HEAD~1:refs/heads/main push origin" DENY
t "$S/b" "git -c remote.origin.mirror=true push origin" DENY
t "$S/b" "git push --de origin refs/tags/release" DENY
t "$S/b" "git push --mi origin" DENY
t "$S/b" "git -c remote.origin.push=:refs/tags/release push origin" DENY
t "$S/b" "MIRROR=true git --config-env=remote.origin.mirror=MIRROR push origin" DENY
t "$S/b" "git --config-env remote.origin.push=X push origin" DENY
t "$S/b" "git config remote.origin.push '+HEAD~1:refs/heads/main' && git push origin" DENY
t "$S/b" "git config --get remote.origin.url && git push" allow
t "$S/b" "git push --follow-tags" allow
t "$S/b" "git push origin main:main" allow
t "$S/b" "git push --dry-run" allow
t "$S/b" "git status && git push -q" allow
(cd a && git commit -q --allow-empty -m two && git push -q origin main)
t "$S/b" "git push" DENY
t "$S" "git -C b push origin main" DENY
t "$S" "git -C \"b\" push" DENY
t "$S/b" "git --no-pager push" DENY
t "$S/b" "git pull --ff-only && git push origin main" allow
t "$S/b" "git pull --no-rebase -q; git push" allow
t "$S/b" "git pull --ff-only && git push --force" DENY
t "$S/b" "git -C ../a pull --ff-only && git push origin main" DENY
t "$S/b" "bash -c 'git push'" DENY
t "$S" "cd b && git push" DENY
t "$S/a" "cd ../b && git push" DENY
t "$S" "git --git-dir=b/.git push origin main" DENY
t "$S" "git -C . -C b push" DENY
t "$S/b" "cd ../a && git push" allow
# A claude/ branch push may be behind main (docs/git-workflow.md); anything landing on main may not.
(cd b && git checkout -q -b claude/x)
t "$S/b" "git push -u origin claude/x" allow
t "$S/b" "git push" allow
t "$S/b" "git push origin HEAD:main" DENY
t "$S/b" "git push origin claude/x:refs/heads/main" DENY
t "$S/b" "git push --all origin" DENY
t "$S/b" "git push origin @:main" DENY
(cd b && git pull -q --no-rebase origin main 2>/dev/null)   # even when not behind, a branch never pushes to main
t "$S/b" "git push origin HEAD:main" DENY
t "$S/b" "git push -u origin claude/x" allow
t "$S/b" "git merge --no-edit origin/main && git push origin HEAD:main" DENY
# A configured bare push from an up-to-date branch is git's to resolve (GitHub still refuses a non-fast-forward).
(cd b && git config push.default upstream); t "$S/b" "git push" allow; (cd b && git config --unset push.default)
# Other spellings of main, and config that sends a bare push to main (repo or -c), are refused too (PR 415 R3).
t "$S/b" "git push origin HEAD:heads/main" DENY
t "$S/b" "git push origin HEAD:refs/heads/main" DENY
t "$S/b" "git -c remote.origin.push=HEAD:refs/heads/main push origin" DENY
t "$S/b" "git -c remote.origin.push=HEAD:refs/heads/main push" DENY
(cd b && git config remote.origin.push HEAD:refs/heads/main); t "$S/b" "git push" DENY; t "$S/b" "git push origin" DENY
(cd b && git config --unset remote.origin.push)
(cd b && git branch -q --set-upstream-to=origin/main)
t "$S/b" "git -c push.default=upstream push" DENY
t "$S/b" "git push" DENY
t "$S/b" "git push origin" DENY
t "$S/b" "git push origin claude/x" allow
CLAUDE_CODE_REMOTE=true t "$S/b" "git push origin HEAD:main" allow   # cloud loops commit to main by design
(cd b && git branch -q --unset-upstream)
# PR 415 review round 2: an inline upstream of main (Codex R3), a variable destination (adversary R4).
t "$S/b" "git -c branch.claude/x.merge=refs/heads/main -c push.default=upstream push" DENY
t "$S/b" "git -c branch.claude/x.merge=refs/heads/main push origin" DENY
t "$S/b" "git push origin HEAD:\$D" DENY
t "$S/b" "git push origin \"HEAD:\$(echo main)\"" DENY
t "$S/b" "git -c branch.claude/x.merge=refs/heads/claude/x push origin claude/x" allow
# PR 415 re-check: option values are not the remote (Codex R2); any shell -c cluster and any quoted script are
# parsed (Codex R1, adversary S1).
t "$S/b" "git push --repo=origin HEAD:main" DENY
t "$S/b" "git push --repo origin HEAD:main" DENY
t "$S/b" "git push -o ci.skip origin HEAD:main" DENY
t "$S/b" "git push -o ci.skip origin claude/x" allow
t "$S/b" "bash -cl 'git push --force'" DENY
t "$S/b" "bash -lc 'git push origin HEAD:main'" DENY
t "$S/b" "bash -l -c 'git push -f'" DENY
t "$S/b" "python3 -c \"import os; os.system('git push --force')\"" DENY
t "$S/b" "node -e \"require('child_process').execSync('git push -f')\"" DENY
t "$S/b" "watch -n 60 'git push --force'" DENY
t "$S/b" "script -q -c 'git push --force' /dev/null" DENY
t "$S/b" "ssh host 'cd repo && git push --force'" DENY
t "$S/b" $'git commit -m "$(cat <<\'EOF\'\nNever git push --force; never gh pr merge 5 --squash.\nEOF\n)"' allow
t "$S/b" $'gh pr create --title "Push guard" --body "$(cat <<\'EOF\'\nRefuses git push --force and gh pr merge 5 --squash.\nEOF\n)"' allow
(cd b && git checkout -q main)
t "$S/b" "git push origin @" DENY
(cd a && git config remote.origin.push +refs/heads/main:refs/heads/main); t "$S/b" "cd ../a && git push" DENY
(cd a && git config --unset remote.origin.push)
(cd b && git config remote.origin.push +refs/heads/main:refs/heads/main); t "$S/b" "git pull -q && git push" DENY
(cd b && git config --unset remote.origin.push)
(cd b && git pull -q --no-rebase); t "$S/b" "git push" allow
# On main or a detached HEAD, a refspec onto main must push main itself (adversary R4).
t "$S/b" "git push origin claude/x:main" DENY
t "$S/b" "git push origin HEAD~1:refs/heads/main" DENY
t "$S/b" "git push origin main:main" allow
# An unresolved source is never taken for main (adversary B1, Codex R3).
t "$S/b" "git push origin \"\$B\":main" DENY
t "$S/b" "git push origin \"\$(git rev-parse HEAD)\":main" DENY
t "$S/b" "git push origin \`git rev-parse HEAD\`:main" DENY
(cd b && git checkout -q --detach)
t "$S/b" "git push origin HEAD:main" DENY
(cd b && git checkout -q main)
# PR merges: a merge commit of the reviewed head only (Brad 2026-11-01).
t "$S/b" "gh pr merge 32 --merge --match-head-commit abc1234" allow
t "$S/b" "gh pr merge 32 -m --match-head-commit=abc1234" allow
t "$S/b" "gh pr merge 32 --merge" DENY
t "$S/b" "gh pr merge 32 --squash --match-head-commit abc1234" DENY
t "$S/b" "gh pr merge 32 -s --match-head-commit abc1234" DENY
t "$S/b" "gh pr merge 32 --merge --admin --match-head-commit abc1234" DENY
t "$S/b" "gh pr merge 32 --merge --auto --match-head-commit abc1234" DENY
t "$S/b" "gh pr merge 32 --rebase --match-head-commit abc1234" DENY
t "$S/b" "bash -c 'gh pr merge 32 --merge'" DENY
t "$S/b" "gh pr view 32 && gh pr merge 32" DENY
t "$S/b" "gh pr view 32 --json state" allow
# PR 415 review round 2: the sha must be 7-40 hex, once (Codex R2); no branch delete, no API merge (adversary R4);
# quoted text and option values are data, not commands (adversary R3).
t "$S/b" "gh pr merge 32 --merge --match-head-commit ''" DENY
t "$S/b" "gh pr merge 32 --merge --match-head-commit=" DENY
t "$S/b" "gh pr merge 32 --merge --match-head-commit zzzzzzz" DENY
t "$S/b" "gh pr merge 32 --merge --match-head-commit abc1234 --match-head-commit def5678" DENY
t "$S/b" "gh pr merge 32 --merge --merge --match-head-commit abc1234" DENY
t "$S/b" "gh pr merge 32 --merge --match-head-commit 0123456789abcdef0123456789abcdef01234567" allow
t "$S/b" "gh pr merge 32 --merge -d --match-head-commit abc1234" DENY
t "$S/b" "gh pr merge 32 --merge --delete-branch --match-head-commit abc1234" DENY
t "$S/b" "gh api -X PUT repos/o/r/pulls/32/merge" DENY
t "$S/b" "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'" DENY
t "$S/b" "gh api repos/o/r/pulls/32" allow
t "$S/b" "gh api repos/o/r/merges -f base=main -f head=x" DENY
t "$S/b" "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc1234" DENY
t "$S/b" "gh api repos/o/r/git/refs/heads/main" allow
t "$S/b" "gh api graphql -f query='mutation { updateRef(input: {}) { clientMutationId } }'" DENY
t "$S/b" "gh api graphql -f query='mutation { mergeBranch(input: {}) { clientMutationId } }'" DENY
t "$S/b" "git commit -m 'Later: gh pr merge 32 --squash'" allow
t "$S/b" "gh pr create --title 'gh pr merge --squash' --body '-s'" allow
t "$S/b" "gh pr merge 32 --merge --match-head-commit abc1234 --body '-s' -t '--squash'" allow
# A session may delete its claude/ branches already merged into main (Brad 2026-11-02, US-64 AC8); any other delete
# stays Brad's. m1/m2 sit on main's tip, u holds a commit main lacks, shared is merged but outside claude/.
(cd b && git push -q origin main:refs/heads/claude/m1 main:refs/heads/claude/m2 main:refs/heads/shared \
  && git checkout -q -b claude/u && git commit -q --allow-empty -m u && git push -q origin claude/u && git checkout -q main \
  && git remote add other ../remote.git)
t "$S/b" "git push origin --delete claude/m1" allow
t "$S/b" "git push -d origin claude/m1" allow
t "$S/b" "git push origin :claude/m1" allow
t "$S/b" "git push --de origin refs/heads/claude/m1 claude/m2" allow
t "$S/b" "git push origin :claude/m1 :refs/heads/claude/m2" allow
t "$S/b" "git push origin --delete claude/u" DENY
t "$S/b" "git push origin --delete shared" DENY
t "$S/b" "git push origin --delete main" DENY
t "$S/b" "git push origin :main" DENY
t "$S/b" "git push origin --delete claude/gone" DENY
t "$S/b" "git push origin --delete claude/m1 claude/u" DENY
t "$S/b" "git push origin :claude/m1 claude/m2" DENY
t "$S/b" "git push --force origin --delete claude/m1" DENY
t "$S/b" "git push origin --delete \$B" DENY
t "$S/b" "git push origin --delete claude/\$B" DENY
t "$S/b" "git push origin --delete 'claude/*'" DENY
t "$S/b" "git push other --delete claude/m1" DENY
t "$S/b" "git push --repo=origin --delete claude/m1" DENY
t "$S/b" "git -c core.x=1 push origin --delete claude/m1" DENY
t "$S/b" "gh pr merge 32 --merge --match-head-commit abc1234 --delete-branch" DENY
# The delete must be the whole command (review of fd7cf84a): a subshell or piped cd, an env prefix or a remote
# change before it could send the push to a repo the check never read.
t "$S/b" "(cd $S/a) && git push origin --delete claude/m1" DENY
t "$S/b" "cd $S/a | true; git push origin --delete claude/m1" DENY
t "$S/b" "GIT_DIR=$S/a/.git git push origin --delete claude/m1" DENY
t "$S/b" "env GIT_CONFIG_COUNT=1 git push origin --delete claude/m1" DENY
t "$S/b" "git remote set-url --push origin ../x.git && git push origin --delete claude/m1" DENY
t "$S/b" "git push origin --delete claude/m1 && echo done" DENY
t "$S/b" "git push --dry-run origin --delete claude/m1
git remote set-url --push origin ../x.git
git push origin --delete claude/m1" DENY
# Origin must have exactly one URL, the same for fetch and push: git deletes on every push URL.
git clone -q remote.git c; git -C c config --add remote.origin.pushurl "$S/remote.git"; git -C c config --add remote.origin.pushurl "$S/x.git"
t "$S/c" "git push origin --delete claude/m1" DENY
git clone -q remote.git d; git -C d config remote.origin.pushurl "$S/x.git"
t "$S/d" "git push origin --delete claude/m1" DENY
git clone -q remote.git e; git -C e config remote.origin.receivepack "git-receive-pack $S/x.git; :"
t "$S/e" "git push origin --delete claude/m1" DENY
# A tip this checkout has not fetched: one `git fetch origin main` brings it, then the check runs.
(cd a && git pull -q --no-rebase && git commit -q --allow-empty -m three && git push -q origin main main:refs/heads/claude/m3)
t "$S/b" "git push origin --delete claude/m3" allow
t /nonexistent "git push" allow
t "$S/b" "git commit -m 'note' && echo pushed" allow
exit $fail
