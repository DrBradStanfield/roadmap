#!/usr/bin/env node
// PreToolUse(Bash) guard for `git push` (Brad 2026-10-08: cloud loops and local
// sessions all push to main; nobody may overwrite anyone's work).
//   1. Denies force, delete (--delete, -d, ":dest"), mirror, prune and "+refspec" pushes. One exception (Brad
//      2026-11-02): a plain delete of claude/ branches on origin whose tips are already in origin/main.
//   2. Fetches origin/main and denies the push while origin/main holds commits HEAD
//      lacks, unless the same command pulls/merges first: merge deliberately, then push.
//   3. A claude/ branch never pushes to main, and `gh pr merge` runs only as
//      `--merge --match-head-commit <sha>` (docs/git-workflow.md).
// Fails open on fetch errors (GitHub still rejects a non-fast-forward push); fails
// closed on a git push it cannot tokenize. The same file lives in claude_business
// and roadmap: edit both.
const { execFileSync } = require('child_process');
const path = require('path');

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

let input;
try { input = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch { process.exit(0); }
const cmd = (input.tool_input && input.tool_input.command) || '';
const cwd = input.cwd || process.cwd();

// Shell-ish tokenizer: words with quotes removed; ; & | ( ) and newlines become separators.
function segments(s) {
  const segs = [[]];
  let word = null, q = null;
  const end = () => { if (word !== null) { segs[segs.length - 1].push(word); word = null; } };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < s.length) word += s[++i]; else word += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; word = word ?? ''; continue; }
    if (ch === '\\' && i + 1 < s.length) { word = (word ?? '') + s[++i]; continue; }
    if (/\s/.test(ch) && ch !== '\n') { end(); continue; }
    if (';&|()\n'.includes(ch)) { end(); segs.push([]); continue; }
    word = (word ?? '') + ch;
  }
  if (q) return null;
  end();
  return segs.filter((x) => x.length);
}

// Global options that take a separate value: `git -C dir push`, `git --git-dir x push`.
const VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const expand = (d) => d.replace(/^~(?=\/|$)/, process.env.HOME || '~');
// The git subcommand, its args, the repo dir it acts on (from base, every -C composed,
// --git-dir) and its inline config (-c k=v; --config-env k=ENV recorded as "k=?").
function gitCall(seg, base) {
  const at = seg.findIndex((t) => t === 'git' || t.endsWith('/git'));
  if (at < 0) return null;
  let i = at + 1, dir = base;
  const cfg = [];
  while (i < seg.length && seg[i].startsWith('-')) {
    const [opt, inl] = seg[i].startsWith('--') && seg[i].includes('=')
      ? [seg[i].slice(0, seg[i].indexOf('=')), seg[i].slice(seg[i].indexOf('=') + 1)] : [seg[i], null];
    const val = inl ?? seg[i + 1] ?? '';
    if (opt === '-C' || opt === '--git-dir') dir = path.resolve(dir, expand(val));
    if (opt === '-c') cfg.push(val);
    if (opt === '--config-env') cfg.push(val.replace(/=.*$/, '=?'));
    i += VALUE_OPTS.has(opt) && inl === null ? 2 : 1;
  }
  return { sub: seg[i], args: seg.slice(i + 1), dir, cfg };
}

// The indexes of a command's message values: the text of git commit/tag -m/--message/-F/--file, and of gh pr|issue
// create/comment/edit/merge --body/--title/--subject/-b/-t/-F (a `$(cat <<'EOF' ... EOF)` heredoc there too). Such
// text is data, so a commit message or PR body that mentions `gh pr merge --squash` is not a command.
function messageValues(seg) {
  const skip = new Set();
  const g = seg.findIndex((t) => t === 'git' || t.endsWith('/git'));
  const h = seg.findIndex((t) => t === 'gh' || t.endsWith('/gh'));
  let from = -1, opts = null, inline = null;
  if (g >= 0) {
    const c = gitCall(seg.slice(g), '.');
    if (c && (c.sub === 'commit' || c.sub === 'tag')) {
      from = seg.length - c.args.length; opts = /^(-m|--message|-F|--file)$/; inline = /^(-m.|--message=|-F.|--file=)/;
    }
  }
  if (h >= 0 && /^(pr|issue)$/.test(seg[h + 1] || '') && /^(create|comment|edit|merge)$/.test(seg[h + 2] || '')) {
    from = h + 3; opts = /^(-b|-t|-F|--body|--title|--subject|--body-file)$/; inline = /^--(body|title|subject|body-file)=/;
  }
  if (from < 0) return skip;
  for (let k = from; k < seg.length; k++) {
    if (opts.test(seg[k])) skip.add(++k);
    else if (inline.test(seg[k])) skip.add(k);
  }
  return skip;
}
// Every simple command, recursing into every quoted string that may hold one (`bash -lc 'git push ...'`,
// `python -c`, `node -e`, `watch`, `ssh host '...'`), except message values (above).
function allSegments(s, depth = 0) {
  const segs = segments(s);
  if (segs === null) return null;
  const out = [];
  for (const seg of segs) {
    out.push(seg);
    const skip = messageValues(seg);
    for (let k = 0; k < seg.length; k++) {
      const t = seg[k];
      if (!skip.has(k) && depth < 3 && /\s/.test(t) && /\b(git|gh)\b/.test(t) && /\b(push|pull|merge)\b/.test(t)) {
        const inner = allSegments(t, depth + 1);
        if (inner === null) return null;
        out.push(...inner);
      }
    }
  }
  return out;
}

// Long options git accepts by unique prefix (`--de` = --delete), so match any prefix (an ambiguous one fails in git anyway).
const BAD_LONG = ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete', 'prune'];
const badArg = (a) => {
  const long = a.match(/^--([a-z-]+)(=|$)/);
  if (long && BAD_LONG.some((o) => o.startsWith(long[1]))) return true;
  return /^-[a-zA-Z]*[fd][a-zA-Z]*$/.test(a) || /^\+/.test(a) || /^:/.test(a);
};
// Rule 1's exception: a push whose only bad args are a delete, --delete (any prefix) or -d with branch names, or
// ":<branch>" refspecs alone; no other flag beyond -q/-v/-n/--porcelain, no inline config, no --repo. Returns
// { remote, branches } (the names still unchecked), or null when the push is not a plain delete.
const QUIET = /^(-q|--quiet|-v|--verbose|-n|--dry-run|--porcelain)$/;
function plainDelete(g) {
  if (g.cfg.length) return null;
  const isDel = (a) => a === '-d' || (/^--[a-z]{2,}$/.test(a) && 'delete'.startsWith(a.slice(2)));
  const flags = g.args.filter((a) => a.startsWith('-'));
  if (!flags.every((a) => isDel(a) || QUIET.test(a))) return null;
  const [remote, ...specs] = g.args.filter((a) => !a.startsWith('-'));
  if (!remote || !specs.length) return null;
  const byFlag = flags.some(isDel);
  if (byFlag ? specs.some((r) => r.includes(':')) : !specs.every((r) => /^:[^:]/.test(r))) return null;
  return { remote, branches: specs.map((r) => r.replace(/^:/, '')) };
}
// Config that makes a plain push force, delete or mirror (remote.<name>.push=+... or =:..., remote.<name>.mirror);
// an unknown value ("=?", from --config-env) counts as bad.
const badConfig = (kv) => /^remote\..*\.(push=\s*[+:?]|mirror(=|$))/i.test(kv) && !/\.mirror=\s*false$/i.test(kv);

const segs = allSegments(cmd);
if (segs === null) {
  if (/\bgit\b[\s\S]*\bpush\b/.test(cmd)) deny('Push guard could not parse this command (unbalanced quotes). Run the git push on its own line.');
  process.exit(0);
}

let here = cwd; // follows `cd` through the command
let configChanged = false;
const synced = new Set(); // repos an earlier git pull/merge in this same command synced
for (const seg of segs) {
  if (seg[0] === 'cd' || seg[0] === 'pushd') { here = path.resolve(here, expand(seg[1] || process.env.HOME || '~')); continue; }
  // A PR merges only as a merge commit of the exact head that was reviewed (docs/git-workflow.md step 4; Brad
  // 2026-11-01): `gh pr merge <n> --merge --match-head-commit <sha>`, never --admin/--squash/--rebase/--auto.
  const gh = seg.findIndex((t) => t === 'gh' || t.endsWith('/gh'));
  if (gh >= 0 && seg[gh + 1] === 'pr' && seg[gh + 2] === 'merge') {
    // Flags only: the value of -b/--body, -t/--subject, -F/--body-file, -A/--author-email, -R/--repo is data, so
    // a body of "-s" is not --squash. The sha must be 7-40 hex; empty or repeated options are refused.
    const flags = [];
    let sha = [];
    for (let k = gh + 3; k < seg.length; k++) {
      const x = seg[k];
      const m = x.match(/^--match-head-commit(?:=(.*))?$/);
      if (m) { sha.push(m[1] !== undefined ? m[1] : (seg[++k] ?? '')); continue; }
      if (/^(-[btFAR]|--(body|subject|body-file|author-email|repo))$/.test(x)) { k++; continue; }
      if (/^--(body|subject|body-file|author-email|repo)=/.test(x)) continue;
      if (x.startsWith('-')) flags.push(x);
    }
    // -d/--delete-branch deletes the branch with no merged check: Brad's (push guard rule 1).
    const banned = flags.find((x) => /^--(admin|squash|rebase|auto|delete-branch)(=|$)/.test(x) || /^-[a-zA-Z]*[srd]/.test(x));
    const merges = flags.filter((x) => x === '--merge' || x === '-m').length;
    const bad = banned ? `"${banned}" is not allowed` : merges !== 1 ? '--merge must appear exactly once'
      : sha.length !== 1 ? '--match-head-commit must appear exactly once' : !/^[0-9a-f]{7,40}$/i.test(sha[0])
        ? `"${sha[0]}" is not a commit sha (7-40 hex)` : null;
    if (bad) {
      deny(`Merge PRs only with \`gh pr merge <n> --merge --match-head-commit <reviewed sha>\` (${bad}): `
        + 'a merge commit of exactly the head that was reviewed (docs/git-workflow.md step 4).');
    }
    continue;
  }
  // The same merge, or a write to main, through the REST or GraphQL API skips those checks: a PR merge, a branch
  // merge (/merges), a write to refs/heads/main, GraphQL mergePullRequest/mergeBranch/updateRef. A policy guard,
  // not a wall: a gh alias or another tool cannot be seen here.
  if (gh >= 0 && seg[gh + 1] === 'api') {
    const a = seg.slice(gh + 2);
    // Any field is a write, whatever method is given: a gh flag that takes a value can swallow a GET spelling.
    const writes = a.some((t, k) => (/^(-X|--method)$/.test(a[k - 1] || '') || /^(-X|--method=)/.test(t)) && /(PATCH|POST|PUT|DELETE)$/i.test(t))
      || a.some((t) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(t));
    if (a.some((t) => /pulls\/[^/\s]+\/merge\b|\/merges\b|mergePullRequest|mergeBranch|updateRef/i.test(t))
        || (writes && a.some((t) => /git\/refs\/heads\/main\b/.test(t)))) {
      deny('Merge PRs only with `gh pr merge <n> --merge --match-head-commit <reviewed sha>`, never through `gh api`, '
        + 'and never write main through it (docs/git-workflow.md step 4).');
    }
  }
  const g = gitCall(seg, here);
  if (!g) continue;
  const dir = g.dir;
  if (g.sub === 'pull' || g.sub === 'merge') { synced.add(dir); continue; }
  // A `git config` that rewrites push behaviour runs after this hook, so its effect cannot be checked here.
  if (g.sub === 'config' && g.args.some((a) => /^remote\..*\.(push|mirror)\b/i.test(a))) configChanged = true;
  if (g.sub !== 'push') continue;
  if (configChanged) deny('This command changes remote push/mirror config and then pushes. Change the config in its own command first.');

  const bad = g.args.find(badArg) || g.cfg.find(badConfig);
  const del = bad && plainDelete(g);
  if (bad && !del) {
    deny(`Repo policy (CLAUDE.md Git workflow): "${bad}" force-pushes or deletes, which can overwrite work the cloud loops `
      + 'or other sessions pushed. Pull, merge deliberately, push normally. A merged claude/ branch: `git push origin --delete '
      + 'claude/<name>` alone. Any other branch delete Brad has approved: he runs it himself.');
  }
  const gitq = (args, timeout = 10000) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  // Push config from the repo ("key value") and from this command's -c ("key=value"), as "key=value" lines.
  const conf = [...gitq(['config', '--get-regexp', '^(remote\\..*\\.(push|mirror)|push\\.default)$']).split('\n').filter(Boolean)
    .map((l) => l.replace(' ', '=')), ...g.cfg];
  const badConf = conf.filter((l) => /^remote\./i.test(l)).find(badConfig);
  if (badConf) deny(`Repo config "${badConf}" makes every push a force or mirror push. Remove it, then push normally.`);
  // Rule 1's exception, checked against live state and failing closed: each branch is a literal claude/ name, on
  // origin, and its remote tip is an ancestor of origin's main tip (one ls-remote reads both; a sha missing here
  // gets one `git fetch origin main`). Residual: a push to the branch between this check and the delete is lost.
  // Narrow, because the tip it replaced is already on main.
  if (del) {
    const refuse = (why) => deny(`Branch delete refused: ${why}. A session may delete only its claude/ branches on `
      + "origin that are already merged into main; an unmerged or any other branch delete is still Brad's to run.");
    // The whole Bash command must be this one plain push: an env prefix (GIT_DIR, GIT_CONFIG_*), a `cd` in a
    // subshell or pipeline, or an earlier `git remote set-url` would make the push reach a repo this check never read.
    // Spaces and tabs only: a newline separates commands in Bash.
    if (!/^[ \t]*git[ \t]+push([ \t]+[A-Za-z0-9._/:=@-]+)+[ \t]*$/.test(cmd)) refuse('run the delete as its own command, with nothing before or after it');
    if (del.remote !== 'origin') refuse(`the remote is "${del.remote}", not origin`);
    const names = del.branches.map((b) => b.replace(/^refs\/heads\//, ''));
    names.forEach((n, k) => {
      if (!/^claude\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(n) || n.includes('..')) {
        refuse(`"${del.branches[k]}" is not a literal claude/ branch`);
      }
    });
    // The check reads origin's fetch URL; the delete goes to every push URL (insteadOf rewrites applied). Exactly one
    // of each, and the same repo.
    const fetchUrls = gitq(['remote', 'get-url', '--all', 'origin']).split('\n').filter(Boolean);
    const pushUrls = gitq(['remote', 'get-url', '--push', '--all', 'origin']).split('\n').filter(Boolean);
    // A receivepack setting can run a command that reaches another repo, as can an ssh wrapper.
    if (gitq(['config', '--get-regexp', '^(remote\\.origin\\.receivepack|core\\.sshcommand)$'])) {
      refuse('the check could not run (origin sets receivepack or an ssh command)');
    }
    if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]) {
      refuse('the check could not run (origin needs exactly one URL, the same for fetch and push)');
    }
    const tips = new Map(gitq(['ls-remote', 'origin', 'refs/heads/main', ...names.map((n) => `refs/heads/${n}`)], 30000)
      .split('\n').filter(Boolean).map((l) => l.split('\t').reverse()));
    const mainTip = tips.get('refs/heads/main');
    if (!/^[0-9a-f]{40,64}$/.test(mainTip || '')) refuse('the check could not run (could not read main on origin)');
    for (const n of names) if (!/^[0-9a-f]{40,64}$/.test(tips.get(`refs/heads/${n}`) || '')) refuse(`${n} is not on origin`);
    const have = (sha) => gitq(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]) === sha;
    if (![mainTip, ...names.map((n) => tips.get(`refs/heads/${n}`))].every(have)) {
      try { execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'main'], { stdio: 'ignore', timeout: 30000 }); } catch { /* re-checked below */ }
    }
    if (!have(mainTip)) refuse("the check could not run (main's tip is not here after a fetch)");
    for (const n of names) {
      const tip = tips.get(`refs/heads/${n}`);
      if (!have(tip)) refuse(`${n} is not merged into main (its tip is not in main's history)`);
      try { execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', tip, mainTip], { stdio: 'ignore', timeout: 10000 }); } catch (e) {
        refuse(e.status === 1 ? `${n} is not merged into main` : `the check could not run for ${n} (merge-base failed)`);
      }
    }
    continue;
  }
  // The repository and refspecs, without option values: `--repo origin`, `-o x`, `--receive-pack x` take one. With
  // --repo, every positional may be a refspec.
  const positional = [];
  let repoOpt = false;
  for (let k = 0; k < g.args.length; k++) {
    const a = g.args[k];
    if (/^--repo(=|$)/.test(a)) repoOpt = true;
    if (/^(--repo|--receive-pack|--exec|-o|--push-option)$/.test(a)) { k++; continue; }
    if (!a.startsWith('-')) positional.push(a);
  }
  const refspecs = repoOpt ? positional : positional.slice(1);
  const current = gitq(['rev-parse', '--abbrev-ref', 'HEAD']);
  // A ref as a branch name: HEAD and @ are the current branch; refs/heads/ and heads/ are dropped. A variable or
  // command substitution ($D, `...`) cannot be resolved here, so it counts as main.
  const asBranch = (r) => (/[$`]/.test(r) ? 'main' : r === 'HEAD' || r === '@' || r === '' ? current
    : r.replace(/^refs\//, '').replace(/^heads\//, ''));
  const toDst = (s) => asBranch(s.includes(':') ? s.split(':').pop() : s);
  // A source that cannot be resolved here ($VAR, $(...), a backtick) is '?', never main.
  const toSrc = (s) => { const r = s.includes(':') ? s.slice(0, s.indexOf(':')) : s; return /[$`]/.test(r) ? '?' : asBranch(r); };
  const hint = (r) => (/[$`]/.test(r) ? ' A variable or substitution cannot be checked here: push your branch with '
    + '`git push -u origin HEAD`.' : '');
  const pushConf = conf.filter((l) => /^remote\..*\.push=/i.test(l)).map((l) => toDst(l.slice(l.indexOf('=') + 1)));
  const configured = pushConf.length > 0 || conf.some((l) => /^push\.default=(upstream|tracking)$/i.test(l));
  // A claude/ branch reaches main only through its PR: a push of it to main is refused, even right after a pull
  // or merge (checked before that shortcut). That covers an explicit main destination, and a bare push (no
  // refspec) whose destination config names main: a remote.*.push refspec, or an upstream of main. Cloud loops
  // commit to main by design (LOOP.md) and skip this.
  // Whatever the current branch (the main checkout, a detached HEAD), an explicit refspec onto main must push main
  // itself: `<other>:main` lands unreviewed commits.
  if (process.env.CLAUDE_CODE_REMOTE !== 'true') {
    const onto = refspecs.find((r) => toDst(r) === 'main' && toSrc(r) !== 'main');
    if (onto) deny(`"${onto}" pushes something other than main onto main, skipping a PR (docs/git-workflow.md). `
      + `Push your branch (\`git push -u origin <branch>\`), then merge its PR.${hint(onto)}`);
  }
  if (current && current !== 'HEAD' && current !== 'main' && process.env.CLAUDE_CODE_REMOTE !== 'true') {
    const bare = refspecs.length === 0;
    // The effective upstream: this command's -c branch.<current>.merge wins over the repo's (the last one counts).
    const inline = g.cfg.filter((kv) => kv.toLowerCase().startsWith(`branch.${current.toLowerCase()}.merge=`));
    const merge = inline.length ? inline[inline.length - 1].slice(inline[inline.length - 1].indexOf('=') + 1)
      : gitq(['config', `branch.${current}.merge`]);
    const upstreamMain = merge === '?' || toDst(merge || '-') === 'main';
    if (refspecs.map(toDst).includes('main')
        || (bare && (upstreamMain || pushConf.some((d) => d === 'main' || d === '?')))) {
      deny(`This pushes branch ${current} straight to main, skipping its PR (docs/git-workflow.md). Push the branch `
        + `(\`git push -u origin <branch>\`), then merge the PR.${hint(refspecs.find((r) => /[$\`]/.test(r)) || '')}`);
    }
  }
  if (synced.has(dir)) continue;
  // A push that cannot land on main (a claude/ branch push, docs/git-workflow.md) skips the behind-main check:
  // that branch merges origin/main at PR time. Unknown, --all, or a bare push whose destination comes from
  // config (remote.*.push, push.default upstream/tracking, from the repo or -c) counts as main-bound.
  const specs = refspecs.length ? refspecs : [configured ? 'main' : (current || 'main')];
  if (!g.args.some((a) => a === '--all' || a === '--branches') && specs.map(toDst).every((d) => d && d !== 'main')) continue;

  let behind = 0;
  try {
    execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', 'main'], { stdio: 'ignore', timeout: 30000 });
    behind = parseInt(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD..origin/main'],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 10) || 0;
  } catch { continue; }
  if (behind > 0) {
    deny(`origin/main has ${behind} commit(s) this checkout lacks (a cloud loop or another session pushed). `
      + 'Commit first, then `git pull --no-rebase` (on main) or `git fetch origin main && git merge --no-edit origin/main` '
      + '(on a claude/ branch), resolve any conflict deliberately (ledgers/CSVs keep '
      + 'BOTH sides\' rows, never "take mine"), then push. Never force.');
  }
}
process.exit(0);
