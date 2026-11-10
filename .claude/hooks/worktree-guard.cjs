#!/usr/bin/env node
// Worktree + PR workflow guard (Brad 2026-10-31: worktrees are fine "so long as everything is properly
// committed, PRs, pushed"). One script, dispatched on the hook event:
//   PreToolUse Bash               in a session worktree: link in its own clone of each of the main checkout's
//                                 node_modules folders, so tools resolve their packages (nothing shared is written).
//   PreToolUse Edit|Write|...     deny edits to the main checkout's tracked (or new, trackable) files: every change
//                                 happens in the session's own worktree. Untracked gitignored outputs are allowed.
//                                 Bash writes (sed -i, >, cp) are NOT covered.
//   Stop                          in a linked worktree, block ending the turn (once) while work is uncommitted,
//                                 unpushed, or pushed with neither an open PR nor a merge into origin/main. While
//                                 a background subagent, teammate or workflow of this session runs, uncommitted
//                                 files are skipped.
//   SessionStart                  report local worktrees holding unlanded work, uncommitted files in the main
//                                 checkout, and merged worktrees not yet removed (with their worktree-done line,
//                                 or "in use" when used in the last day).
// Skipped in cloud sessions (CLAUDE_CODE_REMOTE=true: the loops commit to main from their own checkout, LOOP.md
// landing check) and when CLAUDE_MAIN_CHECKOUT_WRITES=1 (an unattended local job that commits to main itself; none
// in this repo today). Fails open on any git or gh error: the GitHub watches (stranded-branch-watch,
// stale-pr-watch) are the backstop. CommonJS (.cjs): the root package.json sets "type": "module" (see
// tests/git-push-guard.test.ts). Ported from claude_business's worktree-guard.js,
// which that repo deleted on 2026-11-04 (its commit 4e374249: main-only rule back), so this is the only copy.
// Workflow: docs/git-workflow.md.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Each worktree's package clones (linkPackages below), outside the repo: one folder per worktree, keyed by its
// full real path (lowercased: the Mac disk ignores case), so two checkouts with the same folder names never share
// or delete each other's clones. tools/worktree-new.sh and worktree-done.sh get the same folder from
// `--pkg-cache-dir <worktree>`. Off macOS (Linux CI runs the tests): $XDG_CACHE_HOME or ~/.cache.
const PKG_CACHE = path.join(process.platform === 'darwin' ? path.join(process.env.HOME || '/tmp', 'Library', 'Caches')
  : (process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '/tmp', '.cache')), 'claude-worktree-packages');
const pkgCacheDir = (wt) => path.join(PKG_CACHE, `${path.basename(wt)}-${require('crypto').createHash('sha1')
  .update(wt.toLowerCase()).digest('hex').slice(0, 12)}`);
// The package folders linkPackages clones. The one list: tools/worktree-done.sh reads it from `--package-dirs`.
const PACKAGE_DIRS = ['node_modules', 'widget-src/node_modules', 'packages/health-core/node_modules'];
if (process.argv[2] === '--package-dirs') {
  process.stdout.write(PACKAGE_DIRS.join('\n') + '\n');
  process.exit(0);
}
if (process.argv[2] === '--pkg-cache-dir') {
  if (!process.argv[3]) process.exit(1);
  process.stdout.write(pkgCacheDir(fs.realpathSync.native(process.argv[3])) + '\n');
  process.exit(0);
}

let input;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (process.env.CLAUDE_CODE_REMOTE === 'true' || process.env.CLAUDE_MAIN_CHECKOUT_WRITES === '1') process.exit(0);
const cwd = input.cwd || process.cwd();
const event = input.hook_event_name;
// Hot path: a Bash call in the main checkout (outside .claude/worktrees/) has nothing to link, so skip every git
// call. Only when this hook lives in the main checkout (its .git is a folder): a hook in an older ../roadmap-*
// worktree (a session started there) must still swap that worktree's links.
const HOME_CHECKOUT = path.resolve(__dirname, '..', '..');
let homeIsMain = false;
try { homeIsMain = fs.statSync(path.join(HOME_CHECKOUT, '.git')).isDirectory(); } catch { /* not a checkout */ }
if (event === 'PreToolUse' && input.tool_name === 'Bash' && homeIsMain && !/\/\.claude\/worktrees\//i.test(cwd + '/')
  && (cwd + '/').toLowerCase().startsWith(HOME_CHECKOUT.toLowerCase() + '/')) process.exit(0);

// The Stop hook has 45 s (settings.json) for up to seven git calls, a fetch and a gh call: 3 s each, 8 s for the
// network calls, so it answers (or fails open) in time. Everything else keeps 10 s.
const GIT_TIMEOUT = event === 'Stop' ? 3000 : 10000;
const git = (dir, args, timeout = GIT_TIMEOUT) => execFileSync('git', ['-C', dir, ...args],
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

// Give this worktree its own copy of the main checkout's installed packages so tools resolve them. Each folder
// is a clone kept OUTSIDE the repo in PKG_CACHE (macOS: an APFS clone, `cp -c`, copy-on-write, almost no disk;
// elsewhere, as on Linux CI: `cp -a`, a reflink where the disk has them), and the worktree gets a link to its
// clone. Never a link to the main checkout's folder: `npm ci`, `rm -rf node_modules/` or any script run through
// such a link rewrote the main checkout's packages (2026-11-01), and no command filter catches every route. A
// worktree's install now touches only its clone. Only these folders: the tracked .gitignore rule `node_modules`
// (no trailing slash) matches a link too, so it never shows as untracked, and nothing shared (like
// .git/info/exclude) is written. Other gitignored inputs (.env, health-roadmap.json) are NOT mirrored: read them
// from the main checkout (docs/git-workflow.md). tools/worktree-done.sh deletes the worktree's clones.
// Same design as claude_business's worktree-guard.js (its PR 33). The folders: PACKAGE_DIRS, above.
// A clone's links, fixed after the copy. Each is read as it resolved in the main checkout: one into the copied
// folder itself is kept when relative (`.bin` entries) and dropped when absolute (main's stray
// `node_modules/node_modules` self-links, left by an old `ln -s`, would load a second React from the main
// checkout); one elsewhere in the main checkout (the npm workspace links @roadmap/health-core and
// health-tool-widget) is re-pointed at the same path in this worktree, so imports resolve to its own source.
function fixCloneLinks(tmp, src) {
  const links = execFileSync('find', [tmp, '-type', 'l', '-print0'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 })
    .split('\0').filter(Boolean);
  for (const l of links) {
    const to = fs.readlinkSync(l);
    const was = path.resolve(path.dirname(path.join(src, path.relative(tmp, l))), to);
    if (under(was, src)) { if (path.isAbsolute(to)) fs.unlinkSync(l); continue; }
    if (!under(was, main)) continue;
    fs.unlinkSync(l);
    fs.symlinkSync(path.join(top, was.slice(main.length + 1)), l);
  }
}
// `create`: give a missing folder a clone (session worktrees under .claude/worktrees/). Elsewhere (an older
// ../roadmap-* worktree) only an old link into the main checkout is swapped for a clone.
function linkPackages(create) {
  const mine = pkgCacheDir(top);
  for (const rel of PACKAGE_DIRS) {
    const src = path.join(main, rel), dst = path.join(top, rel), clone = path.join(mine, rel);
    let st = null;
    try { st = fs.lstatSync(dst); } catch { /* absent */ }
    if (st && !st.isSymbolicLink()) continue; // the worktree's own real folder
    if (!st && !create) continue;
    if (st) {
      let to;
      try { to = fs.readlinkSync(dst); } catch { continue; } // changed under us: leave it this call
      if (to === clone && fs.existsSync(clone)) continue;
      // Ours with the clone deleted (`rm -rf node_modules/`), or an old link into the main checkout: replace the
      // link only. Anyone else's link is left alone.
      if (!to.startsWith(PKG_CACHE + path.sep) && path.resolve(path.dirname(dst), to) !== src) continue;
      try { fs.unlinkSync(dst); } catch { continue; }
    }
    // Each hook clones into its own temp folder, then renames it into place: the rename is atomic and refuses a
    // folder already there, so parallel Bash calls (each fires this hook) never share or leave half a clone.
    const tmp = `${clone}.tmp-${process.pid}-${require('crypto').randomBytes(4).toString('hex')}`;
    try {
      if (!fs.existsSync(src) || !fs.existsSync(path.dirname(dst))) continue;
      if (!fs.existsSync(clone)) {
        fs.mkdirSync(path.dirname(clone), { recursive: true });
        // Owner record: SessionStart deletes a cache folder whose worktree is gone (removed without worktree-done).
        fs.writeFileSync(path.join(mine, '.owner'), top);
        const copy = (args) => execFileSync('cp', [...args, src, tmp], { stdio: 'ignore', timeout: 240000 });
        if (process.platform === 'darwin') copy(['-cR']);
        else try { copy(['-a', '--reflink=auto']); } catch { fs.rmSync(tmp, { recursive: true, force: true }); copy(['-a']); }
        fixCloneLinks(tmp, src);
        try { fs.renameSync(tmp, clone); } catch { /* raced: theirs wins */ }
      }
      fs.symlinkSync(clone, dst, 'dir');
    } catch { /* clone failed or raced: no link; tools fail to resolve until the next call */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nothing to remove */ }
  }
}

if (event === 'PreToolUse' && input.tool_name === 'Bash') {
  if (!inWorktree) process.exit(0);
  // Only a registered worktree of this repo (top is its own git top level by construction).
  let listed = [];
  try { listed = git(main, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9))); } catch { /* none */ }
  if (listed.some((w) => same(w, top))) linkPackages(under(top, path.join(main, '.claude', 'worktrees')));
  process.exit(0);
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

// A background subagent, teammate or workflow of this session is still running (Claude Code's own `background_tasks`
// list in the Stop input, scoped to the session). An orchestrator's worker edits the same worktree, so its files
// are uncommitted when the main session ends a turn, and committing them would land half-written work (US-64
// AC25). Claude wakes the session when the task ends, and the next Stop checks again. No list (an older Claude
// Code, or the task registry unreachable) means none running: the check stays as before.
const WORKER_TYPES = new Set(['subagent', 'teammate', 'workflow']);
// The list holds in-flight tasks only, and the docs fix no status values, so any status counts except a plainly
// finished one (re-check N1: matching only "running" would silently bring the nag back on a new word).
const DONE_STATUS = new Set(['completed', 'failed', 'killed', 'cancelled', 'canceled', 'stopped', 'error']);
const workerRunning = () => Array.isArray(input.background_tasks) && input.background_tasks.some((t) =>
  t && WORKER_TYPES.has(t.type) && !DONE_STATUS.has(t.status));

if (event === 'Stop') {
  if (!inWorktree || input.stop_hook_active) process.exit(0);
  // Heartbeat: a session that ended a turn here is alive; SessionStart reads this file's mtime (a session idle
  // for a day writes no index, so the git dir alone would offer its worktree for removal).
  try { fs.writeFileSync(path.join(git(top, ['rev-parse', '--absolute-git-dir']), 'session-heartbeat'), ''); } catch { /* best effort */ }
  const problems = [];
  let branch = '';
  try {
    branch = git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const s = landing(top);
    if (s.dirty && !workerRunning()) problems.push(`uncommitted changes:\n${s.dirty.split('\n').slice(0, 15).join('\n')}`);
    if (s.localOnly !== '0') problems.push(`${s.localOnly} commit(s) on ${branch} are not pushed`);
    // Nothing ahead of the last-fetched origin/main means nothing to land; otherwise fetch (a GitHub-side merge).
    if (!problems.length && s.ahead() !== '0') {
      try { git(top, ['fetch', '-q', 'origin', 'main'], 8000); } catch { /* offline: count against the last fetch */ }
      const ahead = s.ahead();
      if (ahead !== '0') {
        const prs = execFileSync('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', 'length'],
          { cwd: top, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
  const merged = []; // landed worktrees nobody finished (56 on 2026-11-06), each with the line that finishes it
  let mainLine = null;
  let blocks = [];
  try { blocks = git(main, ['worktree', 'list', '--porcelain']).split('\n\n'); } catch { /* fall through */ }
  for (const block of blocks) {
    try {
      const wt = (block.match(/^worktree (.+)$/m) || [])[1];
      if (!wt || !fs.existsSync(wt)) continue;
      const w = real(wt);
      if (same(w, main) || same(w, top)) continue;
      const br = ((block.match(/^branch refs\/heads\/(.+)$/m) || [])[1]) || '(detached)';
      // Used in the last day: index, HEAD or the Stop hook's heartbeat in its git dir changed, worktree-done.sh's own test. Read before
      // landing(), whose `git status` may rewrite the index.
      const gd = git(w, ['rev-parse', '--absolute-git-dir']);
      const recent = ['index', 'HEAD', 'session-heartbeat'].some((f) => { try { return Date.now() - fs.statSync(path.join(gd, f)).mtimeMs < 864e5; } catch { return false; } });
      const s = landing(w);
      const dirty = s.dirty ? s.dirty.split('\n').length : 0;
      const ahead = s.ahead();
      if (dirty || s.localOnly !== '0' || ahead !== '0') {
        notes.push(`- ${path.relative(main, w)} [${br}]: ${dirty} uncommitted file(s), ${s.localOnly} unpushed commit(s), ${ahead} not on origin/main`);
      } else if (same(path.dirname(w), path.join(main, '.claude', 'worktrees'))) {
        // Landed: merged, unless HEAD is a commit of main's own line (a fresh worktree with nothing of its own yet).
        mainLine = mainLine || new Set(git(main, ['rev-list', '--first-parent', 'origin/main']).split('\n'));
        if (!mainLine.has(git(w, ['rev-parse', 'HEAD']))) {
          // A merged session may still be deploying or verifying there, and worktree-done by name skips the
          // lock and last-used checks: offer no removal line for a worktree in recent use.
          merged.push(`- ${path.relative(main, w)} [${br}]: ` + (recent ? 'merged, in use (changed in the last day); leave it'
            : `merged; if no session still uses it, bash tools/worktree-done.sh ${path.basename(w)}`));
        }
      }
    } catch { /* one unreadable worktree must not hide the rest */ }
  }
  // Delete package clones whose worktree is gone (removed by ExitWorktree, git worktree remove, agent isolation).
  // Each is first moved into PKG_CACHE/.tombstones/ (an atomic rename, so it never sits half-deleted under its own
  // name without its .owner), then deleted by a detached process, so a big tree never runs this hook past its
  // timeout. Only that folder is ever purged (an earlier run's leftovers too), never a live cache name.
  const TOMBS = path.join(PKG_CACHE, '.tombstones');
  const purge = () => { try { spawn('rm', ['-rf', TOMBS], { detached: true, stdio: 'ignore' }).unref(); } catch { /* next session */ } };
  try {
    let doomed = fs.existsSync(TOMBS);
    for (const d of fs.readdirSync(PKG_CACHE)) {
      if (d.startsWith('.')) continue;
      const dir = path.join(PKG_CACHE, d);
      let owner = null;
      try { owner = fs.readFileSync(path.join(dir, '.owner'), 'utf8').trim(); } catch { continue; } // mid-clone or not ours
      if (!owner || fs.existsSync(path.join(owner, '.git'))) continue;
      try { fs.mkdirSync(TOMBS, { recursive: true }); fs.renameSync(dir, path.join(TOMBS, `${d}-${process.pid}`)); doomed = true; } catch { /* raced */ }
    }
    if (doomed) purge();
  } catch { /* no cache yet */ }
  try {
    const mainDirty = git(main, ['status', '--porcelain']).split('\n').filter(Boolean);
    if (mainDirty.length) notes.push(`- main checkout: ${mainDirty.length} uncommitted file(s), e.g. ${mainDirty.slice(0, 5).map((l) => l.slice(3)).join(', ')}`);
  } catch { /* skip */ }
  if (!notes.length && !merged.length) process.exit(0);
  const parts = [];
  if (notes.length) {
    parts.push('Unlanded git work on this machine (another session may still own it; leave it alone unless Brad asks, but '
      + 'mention it in your final message if it looks abandoned; docs/git-workflow.md):\n' + notes.join('\n'));
  }
  if (merged.length) {
    parts.push('Merged worktrees not yet removed (worktree-done refuses anything not landed, but by name it removes a '
      + 'live session\'s worktree: run it from the main checkout only for those given a line, never one in use):\n'
      + merged.join('\n'));
  }
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } });
}
process.exit(0);
