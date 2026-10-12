#!/bin/bash
# Test for git-push-guard.js against a throwaway local bare remote. Run: bash .claude/hooks/git-push-guard.test.sh
# Prints one line per case; every line must read DENY/DENY or allow/allow.
G="$(cd "$(dirname "$0")" && pwd)/git-push-guard.js"
S=$(mktemp -d); rm -rf "$S"; mkdir -p "$S"; cd "$S" || exit 1
git init -q --bare -b main remote.git; git clone -q remote.git a 2>/dev/null
(cd a && git commit -q --allow-empty -m one && git push -q origin main); git clone -q remote.git b
t(){ out=$(printf '{"cwd":"%s","tool_input":{"command":%s}}' "$1" "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$2")" | node "$G")
  case "$out" in *deny*) r=DENY;; *) r=allow;; esac; printf '%-6s expected %-6s %s\n' "$r" "$3" "[$2] in $(basename "$1")"; }
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
(cd a && git config remote.origin.push +refs/heads/main:refs/heads/main); t "$S/b" "cd ../a && git push" DENY
(cd a && git config --unset remote.origin.push)
(cd b && git config remote.origin.push +refs/heads/main:refs/heads/main); t "$S/b" "git pull -q && git push" DENY
(cd b && git config --unset remote.origin.push)
(cd b && git pull -q --no-rebase); t "$S/b" "git push" allow
t /nonexistent "git push" allow
t "$S/b" "git commit -m 'note' && echo pushed" allow
