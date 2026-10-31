#!/usr/bin/env node
// PreToolUse(Bash) guard for `git push` (Brad 2026-10-08: cloud loops and local
// sessions all push to main; nobody may overwrite anyone's work).
//   1. Denies force, delete (--delete, -d, ":dest"), mirror, prune and "+refspec" pushes.
//   2. Fetches origin/main and denies the push while origin/main holds commits HEAD
//      lacks, unless the same command pulls/merges first: merge deliberately, then push.
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

// Every simple command, recursing into quoted strings that hold one (`bash -c 'git push ...'`).
function allSegments(s, depth = 0) {
  const segs = segments(s);
  if (segs === null) return null;
  const out = [];
  for (const seg of segs) {
    out.push(seg);
    for (const t of seg) {
      if (depth < 3 && /\s/.test(t) && /\bgit\b/.test(t) && /\b(push|pull|merge)\b/.test(t)) {
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
  const g = gitCall(seg, here);
  if (!g) continue;
  const dir = g.dir;
  if (g.sub === 'pull' || g.sub === 'merge') { synced.add(dir); continue; }
  // A `git config` that rewrites push behaviour runs after this hook, so its effect cannot be checked here.
  if (g.sub === 'config' && g.args.some((a) => /^remote\..*\.(push|mirror)\b/i.test(a))) configChanged = true;
  if (g.sub !== 'push') continue;
  if (configChanged) deny('This command changes remote push/mirror config and then pushes. Change the config in its own command first.');

  const bad = g.args.find(badArg) || g.cfg.find(badConfig);
  if (bad) {
    deny(`Repo policy (CLAUDE.md Git workflow): "${bad}" force-pushes or deletes, which can overwrite work the cloud loops `
      + 'or other sessions pushed. Pull, merge deliberately, push normally. A branch delete Brad has approved: he runs it himself.');
  }
  const gitq = (args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  // Push config from the repo ("key value") and from this command's -c ("key=value"), as "key=value" lines.
  const conf = [...gitq(['config', '--get-regexp', '^(remote\\..*\\.(push|mirror)|push\\.default)$']).split('\n').filter(Boolean)
    .map((l) => l.replace(' ', '=')), ...g.cfg];
  const badConf = conf.filter((l) => /^remote\./i.test(l)).find(badConfig);
  if (badConf) deny(`Repo config "${badConf}" makes every push a force or mirror push. Remove it, then push normally.`);
  const positional = g.args.filter((a) => !a.startsWith('-'));
  const current = gitq(['rev-parse', '--abbrev-ref', 'HEAD']);
  // A destination ref as a branch name: HEAD and @ are the current branch; refs/heads/ and heads/ are dropped.
  const toDst = (s) => {
    const d = s.includes(':') ? s.split(':').pop() : s;
    return d === 'HEAD' || d === '@' ? current : d.replace(/^refs\//, '').replace(/^heads\//, '');
  };
  const pushConf = conf.filter((l) => /^remote\..*\.push=/i.test(l)).map((l) => toDst(l.slice(l.indexOf('=') + 1)));
  const configured = pushConf.length > 0 || conf.some((l) => /^push\.default=(upstream|tracking)$/i.test(l));
  // A claude/ branch reaches main only through its PR: a push of it to main is refused, even right after a pull
  // or merge (checked before that shortcut). That covers an explicit main destination, and a bare push (no
  // refspec) whose destination config names main: a remote.*.push refspec, or an upstream of main. Cloud loops
  // commit to main by design (LOOP.md) and skip this.
  if (current && current !== 'HEAD' && current !== 'main' && process.env.CLAUDE_CODE_REMOTE !== 'true') {
    const bare = positional.length < 2;
    const upstreamMain = toDst(gitq(['config', `branch.${current}.merge`]) || '-') === 'main';
    if (positional.slice(1).map(toDst).includes('main')
        || (bare && (upstreamMain || pushConf.some((d) => d === 'main' || d === '?')))) {
      deny(`This pushes branch ${current} straight to main, skipping its PR (docs/git-workflow.md). Push the branch `
        + '(`git push -u origin <branch>`), then merge the PR.');
    }
  }
  if (synced.has(dir)) continue;
  // A push that cannot land on main (a claude/ branch push, docs/git-workflow.md) skips the behind-main check:
  // that branch merges origin/main at PR time. Unknown, --all, or a bare push whose destination comes from
  // config (remote.*.push, push.default upstream/tracking, from the repo or -c) counts as main-bound.
  const specs = positional.length >= 2 ? positional.slice(1) : [configured ? 'main' : (current || 'main')];
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
