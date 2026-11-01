#!/usr/bin/env node
// Worktree + PR workflow guard (Brad 2026-10-31: worktrees are fine "so long as everything is properly
// committed, PRs, pushed"). One script, dispatched on the hook event:
//   PreToolUse Bash               in a session worktree: symlink the main checkout's node_modules folders in, so
//                                 tools resolve their packages (fs checks only; nothing shared is written), and
//                                 refuse an npm install there while a link stands (it would rewrite the main
//                                 checkout's packages).
//   PreToolUse Edit|Write|...     deny edits to the main checkout's tracked (or new, trackable) files: every change
//                                 happens in the session's own worktree. Untracked gitignored outputs are allowed.
//                                 Bash writes (sed -i, >, cp) are NOT covered.
//   Stop                          in a linked worktree, block ending the turn (once) while work is uncommitted,
//                                 unpushed, or pushed with neither an open PR nor a merge into origin/main.
//   SessionStart                  report local worktrees holding unlanded work, and uncommitted files in the main
//                                 checkout.
// Skipped in cloud sessions (CLAUDE_CODE_REMOTE=true: the loops commit to main from their own checkout, LOOP.md
// landing check) and when CLAUDE_MAIN_CHECKOUT_WRITES=1 (an unattended local job that commits to main itself; none
// in this repo today). Fails open on any git or gh error: the GitHub watches (stranded-branch-watch,
// stale-pr-watch) are the backstop. CommonJS (.cjs): the root package.json sets "type": "module" (see
// tests/git-push-guard.test.ts). Ported from claude_business's worktree-guard.js; edit both. Roadmap-only, so
// far: the main checkout found from this file's place, .claude/ never writable there, and the npm refusal.
// Workflow: docs/git-workflow.md.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (process.env.CLAUDE_CODE_REMOTE === 'true' || process.env.CLAUDE_MAIN_CHECKOUT_WRITES === '1') process.exit(0);
const cwd = input.cwd || process.cwd();
const event = input.hook_event_name;
// Hot path: a Bash call outside a session worktree has nothing to link, so skip every git call.
if (event === 'PreToolUse' && input.tool_name === 'Bash' && !/\/\.claude\/worktrees\//i.test(cwd + '/')) process.exit(0);

const git = (dir, args, timeout = 10000) => execFileSync('git', ['-C', dir, ...args],
  { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const gitOk = (dir, args) => { try { git(dir, args); return true; } catch { return false; } };
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
// Real path even for a file that does not exist yet (resolve the nearest existing ancestor).
function real(p) {
  let head = path.resolve(p), tail = '';
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), tail); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail = path.join(path.basename(head), tail); head = up;
  }
}
// realpathSync.native returns the disk's own spelling; the Mac disk ignores case, so compare lowercased too.
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const under = (p, dir) => same(p, dir) || p.toLowerCase().startsWith(dir.toLowerCase() + path.sep);

// main = the main checkout's root, found from this hook's own place (.claude/hooks/ in a checkout of this repo),
// never from the session's cwd: a session sitting in the scratchpad or another repo is still refused.
// top = the checkout the session works in: the cwd's when the cwd is inside this repo, else the hook's own.
const roots = (dir) => {
  const [common, toplevel] = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']).split('\n');
  return { main: real(path.dirname(common)), top: real(toplevel) };
};
let main, top;
try { ({ main, top } = roots(path.join(__dirname, '..', '..'))); } catch { process.exit(0); }
try { const c = roots(cwd); if (same(c.main, main)) top = c.top; } catch { /* cwd outside any repo */ }
const inWorktree = !same(top, main);
// One worktree's landing state: uncommitted lines, commits on no remote, commits not on origin/main.
const landing = (dir) => ({
  dirty: git(dir, ['status', '--porcelain']),
  localOnly: git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']),
  ahead: () => git(dir, ['rev-list', '--count', 'origin/main..HEAD']),
});

// Link the main checkout's installed packages into this worktree so tools resolve them. Only these folders: the
// tracked .gitignore rule `node_modules` (no trailing slash) matches a symlink too, so a link can never show as
// untracked or be committed, and nothing shared (like .git/info/exclude) is ever written. Other gitignored inputs
// (.env, health-roadmap.json) are NOT mirrored: work that needs them reads them from the main checkout
// (docs/git-workflow.md). Same design as claude_business's worktree-guard.js.
const PACKAGE_DIRS = ['node_modules', 'widget-src/node_modules', 'packages/health-core/node_modules'];
function linkPackages() {
  for (const rel of PACKAGE_DIRS) {
    const src = path.join(main, rel), dst = path.join(top, rel);
    try { fs.lstatSync(dst); continue; } catch { /* absent: link it */ }
    try { if (fs.existsSync(src) && fs.existsSync(path.dirname(dst))) fs.symlinkSync(src, dst, 'dir'); } catch { /* raced: skip */ }
  }
}
// npm commands that rewrite node_modules. Run through a link, they rewrite the MAIN checkout's packages: `npm ci`
// deletes the folder's contents first, so every other session loses its packages (reproduced 2026-11-01; the
// 2026-10-14 gotcha in docs/reference.md). Not in claude_business's guard.
const NPM_WRITES = new Set(['ci', 'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal',
  'isntall', 'add', 'uninstall', 'unlink', 'un', 'remove', 'rm', 'r', 'update', 'up', 'upgrade', 'udpate', 'prune',
  'dedupe', 'ddp', 'rebuild', 'rb', 'link', 'ln', 'clean-install', 'install-clean', 'ic', 'isntall-clean',
  'install-test', 'it', 'install-ci-test', 'cit', 'clean-install-test', 'sit']);
const NPM_VALUE_OPTS = new Set(['--prefix', '-C', '--workspace', '-w', '--cache', '--registry', '--userconfig', '--loglevel']);
// The npm subcommand of each simple command (words split on whitespace, quotes dropped; ; & | ( ) ` and newlines
// separate commands), so `cd widget-src && npm ci` and `npm --prefix widget-src i` are caught.
function npmWrite(cmd) {
  for (const seg of cmd.replace(/["']/g, '').split(/[;&|()`\n]/)) {
    const w = seg.trim().split(/\s+/);
    let i = w.findIndex((t) => t === 'npm' || t.endsWith('/npm'));
    if (i < 0) continue;
    for (i++; i < w.length && w[i].startsWith('-'); i++) if (NPM_VALUE_OPTS.has(w[i])) i++;
    if (NPM_WRITES.has(w[i])) return `npm ${w[i]}`;
  }
  return null;
}

if (event === 'PreToolUse' && input.tool_name === 'Bash') {
  if (!inWorktree) process.exit(0);
  const npm = npmWrite((input.tool_input && input.tool_input.command) || '');
  // An install about to run: link nothing new (the worktree may be getting its own packages); refuse it while a
  // link is there.
  if (!npm) { linkPackages(); process.exit(0); }
  const linked = PACKAGE_DIRS.map((rel) => path.join(top, rel))
    .filter((p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } });
  if (!linked.length) process.exit(0);
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    `Refused: \`${npm}\` in this worktree would rewrite the MAIN checkout's packages, because ${linked.join(', ')} `
    + `${linked.length > 1 ? 'are links' : 'is a link'} to them (npm ci empties them first). To install packages of `
    + `this worktree's own, first remove the link(s) in a command of their own: \`unlink ${linked.join(' && unlink ')}\` `
    + '(unlink removes only the link, never the main checkout\'s folder; never `rm -r`), then run npm again. '
    + 'docs/git-workflow.md.' } });
}

if (event === 'PreToolUse') {
  const ti = input.tool_input || {};
  const raw = ti.file_path || ti.notebook_path;
  if (!raw) process.exit(0);
  const file = real(path.resolve(cwd, raw));
  if (!under(file, main) || under(file, path.join(main, '.claude', 'worktrees'))) process.exit(0);
  const rel = file.slice(main.length + 1) || '.';
  // Allowed only when the path is untracked AND gitignored (renders, dumps, scratch output): it is in no commit.
  // Never under .claude/: a gitignored settings.local.json there could switch these hooks off.
  const tracked = gitOk(main, ['ls-files', '--error-unmatch', '--', rel]);
  if (!/^\.claude([/\\]|$)/i.test(rel) && !tracked && gitOk(main, ['check-ignore', '-q', '--', rel])) process.exit(0);
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    'Repo policy (CLAUDE.md Development Rules): never edit the main checkout. Start your worktree: '
    + '`sh tools/worktree-new.sh <short-name>`, then EnterWorktree with `path` set to the printed folder (never '
    + 'EnterWorktree `name`), and make this edit at the same relative path inside it. If you already have one, '
    + `edit there, not under ${main}. Workflow: docs/git-workflow.md.` } });
}

if (event === 'Stop') {
  if (!inWorktree || input.stop_hook_active) process.exit(0);
  const problems = [];
  let branch = '';
  try {
    branch = git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const s = landing(top);
    if (s.dirty) problems.push(`uncommitted changes:\n${s.dirty.split('\n').slice(0, 15).join('\n')}`);
    if (s.localOnly !== '0') problems.push(`${s.localOnly} commit(s) on ${branch} are not pushed`);
    // Nothing ahead of the last-fetched origin/main means nothing to land; otherwise fetch (a GitHub-side merge).
    if (!problems.length && s.ahead() !== '0') {
      try { git(top, ['fetch', '-q', 'origin', 'main'], 15000); } catch { /* offline: count against the last fetch */ }
      const ahead = s.ahead();
      if (ahead !== '0') {
        const prs = execFileSync('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', 'length'],
          { cwd: top, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (prs === '0') problems.push(`${branch} has ${ahead} commit(s) not on origin/main and no open PR`);
      }
    }
  } catch { process.exit(0); }
  if (!problems.length) process.exit(0);
  out({ decision: 'block', reason: `Before ending this turn, land this worktree's work (docs/git-workflow.md): `
    + `${problems.join('; ')}. Commit your own changes, push the branch, and open a PR (a draft is fine while Brad `
    + 'is still deciding), or merge it if the work is finished. If this is genuinely not yours to land, say so in '
    + 'your final message with the branch name.' });
}

if (event === 'SessionStart') {
  const notes = [];
  let blocks = [];
  try { blocks = git(main, ['worktree', 'list', '--porcelain']).split('\n\n'); } catch { /* fall through */ }
  for (const block of blocks) {
    try {
      const wt = (block.match(/^worktree (.+)$/m) || [])[1];
      if (!wt || !fs.existsSync(wt)) continue;
      const w = real(wt);
      if (same(w, main) || same(w, top)) continue;
      const br = ((block.match(/^branch refs\/heads\/(.+)$/m) || [])[1]) || '(detached)';
      const s = landing(w);
      const dirty = s.dirty ? s.dirty.split('\n').length : 0;
      const ahead = s.ahead();
      if (dirty || s.localOnly !== '0' || ahead !== '0') {
        notes.push(`- ${path.relative(main, w)} [${br}]: ${dirty} uncommitted file(s), ${s.localOnly} unpushed commit(s), ${ahead} not on origin/main`);
      }
    } catch { /* one unreadable worktree must not hide the rest */ }
  }
  try {
    const mainDirty = git(main, ['status', '--porcelain']).split('\n').filter(Boolean);
    if (mainDirty.length) notes.push(`- main checkout: ${mainDirty.length} uncommitted file(s), e.g. ${mainDirty.slice(0, 5).map((l) => l.slice(3)).join(', ')}`);
  } catch { /* skip */ }
  if (!notes.length) process.exit(0);
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
    'Unlanded git work on this machine (another session may still own it; leave it alone unless Brad asks, but '
    + 'mention it in your final message if it looks abandoned; docs/git-workflow.md):\n' + notes.join('\n') } });
}
process.exit(0);
