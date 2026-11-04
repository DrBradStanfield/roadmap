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

// What bash may still change in a word at run time (bits): EXPANDS, a `$` or backtick outside single quotes (inside
// them too when the text itself came from an expansion, `outer`); SPLITS, one outside any quotes or a "$@" (it may
// become several words, flags included; so does an unquoted brace list, `{a,b}` or `{1..3}`); GLOB, an unquoted * or [.
const EXPANDS = 1, SPLITS = 2, GLOB = 4, BRACE = 8;
const DYN_CHAR = /[$`]/;
// The bits of a character that ends a plain run (below) and is added to the word: `$`/backtick, or unquoted * [ {.
function charDyn(s, i, q) {
  if (s[i] === '{') return BRACE;
  if (!DYN_CHAR.test(s[i])) return GLOB;
  return q === '' || /^\$(@|\{[^}]*\[@\])/.test(s.slice(i, i + 64)) ? EXPANDS | SPLITS : EXPANDS;
}
const newSeg = () => Object.assign([], { dyn: [] });
function endWord(t) {
  if (t.word === null) return;
  const seg = t.segs[t.segs.length - 1];
  if (t.dyn & BRACE && /,|\.\./.test(t.word)) t.dyn |= SPLITS;
  seg.push(t.word);
  seg.dyn.push(t.dyn);
  t.word = null;
  t.dyn = 0;
}
const addText = (t, text) => { t.word = (t.word ?? '') + text; };
// Characters with no meaning in the current quoting, taken as one run (linear, and fast on a long heredoc). Returns
// the index of the run's last character, or -1 when s[i] is special.
const RUNS = { "'": /[^']+/y, '"': /[^"\\$`]+/y, '`': /[^`\\]+/y, '': /[^\s"'\\;&|()$`*[{]+/y };
function plainRun(t, s, i) {
  const re = RUNS[t.q];
  re.lastIndex = i;
  const m = re.exec(s);
  if (m === null) return -1;
  addText(t, m[0]);
  if (t.outer && DYN_CHAR.test(m[0])) t.dyn |= EXPANDS;
  return i + m[0].length - 1;
}
// A backslash escapes the next character; before a newline both are deleted (bash joins the lines). Returns the
// index of the last character used.
const escaped = (t, s, i) => { if (s[i + 1] !== '\n') addText(t, s[i + 1]); return i + 1; };
// A backtick substitution is one word, backticks kept (so an endpoint holding one stays unresolved); its body is
// read as a command later (wordCommands).
function quoted(t, s, i) {
  const ch = s[i];
  if (ch === t.q) { if (ch === '`') addText(t, ch); t.q = ''; }
  else if (ch === '\\' && i + 1 < s.length) return escaped(t, s, i);
  else { addText(t, ch); t.dyn |= charDyn(s, i, t.q); }
  return i;
}
function openQuote(t, ch) {
  t.q = ch;
  addText(t, ch === '`' ? ch : '');
  if (ch === '`') t.dyn |= EXPANDS | SPLITS;
}
function unquoted(t, s, i) {
  const ch = s[i];
  if (ch === '"' || ch === "'" || ch === '`') { openQuote(t, ch); return i; }
  if (ch === '\\' && i + 1 < s.length) return escaped(t, s, i);
  if (/\s/.test(ch) && ch !== '\n') endWord(t);
  else if (';&|()\n'.includes(ch)) { endWord(t); t.segs.push(newSeg()); }
  else { addText(t, ch); t.dyn |= charDyn(s, i, ''); }
  return i;
}
// Shell-ish tokenizer: words with quotes removed; ; & | ( ) and newlines become separators. Each segment's `dyn`
// holds the run-time bits of each word.
function segments(s, outer = 0) {
  const t = { segs: [newSeg()], word: null, dyn: 0, q: '', outer };
  for (let i = 0; i < s.length; i++) {
    const r = plainRun(t, s, i);
    i = r >= 0 ? r : t.q ? quoted(t, s, i) : unquoted(t, s, i);
  }
  if (t.q) return null;
  endWord(t);
  return t.segs.filter((x) => x.length);
}

// Global options that take a separate value: `git -C dir push`, `git --git-dir x push`.
const VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const expand = (d) => d.replace(/^~(?=\/|$)/, process.env.HOME || '~');
// The word that runs `name`: its first appearance that is not followed by itself (`xargs -I gh gh api ...` runs the
// second one).
const isCmd = (t, name) => t === name || String(t).endsWith(`/${name}`);
function cmdAt(seg, name) {
  for (let k = 0; k < seg.length; k++) if (isCmd(seg[k], name) && !isCmd(seg[k + 1], name)) return k;
  return -1;
}
// The git subcommand, its args, the repo dir it acts on (from base, every -C composed,
// --git-dir) and its inline config (-c k=v; --config-env k=ENV recorded as "k=?").
function gitCall(seg, base) {
  const at = cmdAt(seg, 'git');
  if (at < 0) return null;
  const c = { dir: base, cfg: [] };
  let i = at + 1;
  while (i < seg.length && seg[i].startsWith('-')) {
    const [opt, inl] = splitLong(seg[i]);
    gitOption(c, opt, inl ?? seg[i + 1] ?? '');
    i += VALUE_OPTS.has(opt) && inl === null ? 2 : 1;
  }
  return { sub: seg[i], args: seg.slice(i + 1), dir: c.dir, cfg: c.cfg };
}
// `--opt=value` as [opt, value]; anything else as [t, null].
const splitLong = (t) => (t.startsWith('--') && t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, null]);
function gitOption(c, opt, val) {
  if (opt === '-C' || opt === '--git-dir') c.dir = path.resolve(c.dir, expand(val));
  if (opt === '-c') c.cfg.push(val);
  if (opt === '--config-env') c.cfg.push(val.replace(/=.*$/, '=?'));
}

// The indexes of a command's message values: the text of git commit/tag -m/--message/-F/--file, and of gh pr|issue
// create/comment/edit/merge --body/--title/--subject/-b/-t/-F (a `$(cat <<'EOF' ... EOF)` heredoc there too). Such
// text is data, so a commit message or PR body that mentions `gh pr merge --squash` is not a command.
function messageValues(seg) {
  const skip = new Set();
  const m = messageOpts(seg);
  if (m === null) return skip;
  for (let k = m.from; k < seg.length; k++) {
    if (m.opts.test(seg[k])) skip.add(++k);
    else if (m.inline.test(seg[k])) skip.add(k);
  }
  return skip;
}
// Where a command's message options start and how they are spelled, or null (gh pr|issue wins over git).
function messageOpts(seg) {
  const g = cmdAt(seg, 'git');
  const h = cmdAt(seg, 'gh');
  if (h >= 0 && /^(pr|issue)$/.test(String(seg[h + 1])) && /^(create|comment|edit|merge)$/.test(String(seg[h + 2]))) {
    return { from: h + 3, opts: /^(-b|-t|-F|--body|--title|--subject|--body-file)$/, inline: /^--(body|title|subject|body-file)=/ };
  }
  const c = g >= 0 ? gitCall(seg.slice(g), '.') : null;
  if (!c || (c.sub !== 'commit' && c.sub !== 'tag')) return null;
  return { from: seg.length - c.args.length, opts: /^(-m|--message|-F|--file)$/, inline: /^(-m.|--message=|-F.|--file=)/ };
}
// A quoted string that may hold a guarded command: `git` or `gh` with push, pull, merge, api or sync, read with its own
// quotes and backslashes dropped (`g''h a''pi` is `gh api` to the inner shell).
const plain = (t) => t.replace(/['"\\]/g, '');
const mayHoldCommand = (t) => /\s/.test(t) && /\b(git|gh)\b/.test(plain(t)) && /\b(push|pull|merge|api|sync)\b/.test(plain(t));
// Every simple command, recursing into each quoted string that may hold one (`bash -lc 'gh api ...'`,
// `python -c`, `node -e`, `watch`, `ssh host '...'`, a here-string), except message values (above) and data
// (below). A string nested deeper than 3 levels is not read: the command is refused as unparseable.
function allSegments(s, depth = 0, outer = 0) {
  const segs = segments(s, outer);
  if (segs === null) return null;
  const out = [];
  for (const seg of segs) {
    const inner = innerSegments(seg, depth);
    if (inner === null) return null;
    out.push(seg, ...inner);
  }
  return out;
}
function innerSegments(seg, depth) {
  if (isData(seg)) return [];
  const skip = messageValues(seg);
  const out = [];
  for (let k = 0; k < seg.length; k++) {
    if (skip.has(k) && literalMessage(seg[k], seg.dyn[k])) continue;
    const inner = wordCommands(seg[k], seg.dyn[k], depth);
    if (inner === null) return null;
    out.push(...inner);
  }
  return out;
}
// A message value is text unless bash runs something in it: a `$(...)` or backtick outside single quotes, other than
// one whole `$(cat <<'EOF' ... EOF)` heredoc (its quoted delimiter keeps the body literal).
const QUOTED_HEREDOC = /^\$\(cat <<-?[ \t]*(['"])(\w+)\1\n((?![ \t]*\2[ \t]*\n)[^\n]*\n)*[ \t]*\2\s*\)$/;
const literalMessage = (t, d) => !(d & EXPANDS) || !/`|\$\(/.test(t) || QUOTED_HEREDOC.test(t);
// The commands a word may run: each backtick substitution's body, and a quoted string holding a guarded command
// (substitutions there marked `$`). `CMD="..."` is read as the command it stores (for a later eval), `bash<<<'...'`
// as the here-string. ANSI-C `$'...'` text (escapes not decoded here), a string led by a variable, or nesting past
// 3 levels cannot be read: fail closed.
function wordCommands(t, d, depth) {
  const parts = d & EXPANDS ? t.split('`') : [t];
  const bodies = parts.filter((_, j) => j % 2);
  const text = parts.map((x, j) => (j % 2 ? '$' : x)).join('');
  if (mayHoldCommand(text)) bodies.push(text.replace(/^([^\s<]*<<<|[A-Za-z_]\w*=)/, ''));
  const out = [];
  for (const body of bodies) {
    const inner = depth >= 3 || body.startsWith('$') ? null : allSegments(body, depth + 1, d);
    if (inner === null) return null;
    out.push(...inner);
  }
  return out;
}
// echo text and grep/rg patterns are data, not commands, when nothing in the whole command runs output: no
// substitution (`$(...)`, a backtick, `<(...)`), no stdout redirect (a file a later command might run; stderr and
// /dev/null are fine) and every pipe feeding a reader.
const READERS = /^(head|tail|wc|sort|uniq|cut|grep|egrep|fgrep|rg|less|more|cat|nl|column)$/;
const stdoutRedirect = (c, i) => !'23456789'.includes(c[i - 1]) && !/^>(&[0-9]|\s*\/dev\/null)/.test(c.slice(i, i + 16));
function outputStaysData(c) {
  if (/\$\(|`|[<>]\(/.test(c) || [...c.matchAll(/>/g)].some((m) => stdoutRedirect(c, m.index))) return false;
  return [...c.matchAll(/\|&?\s*([^\s|;&()<>]*)/g)].every((m) => READERS.test(m[1].replace(/^.*\//, '')));
}
let dataOk = false; // set once the command is read
const isData = (seg) => dataOk && /^(echo|grep|egrep|fgrep|rg)$/.test(seg[0].replace(/^.*\//, ''));

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

// `gh api` arguments: the last explicit method (-X/--method), the -f/-F/--field/--raw-field values, --input, and the
// positionals (the endpoint). Short flags may be bundled or joined (`-iXPATCH`, `-X=PATCH`, `-fk=v`).
const API_LONG = /^--(method|field|raw-field|input|header|jq|template|preview|hostname|cache)$/;
const API_SHORT = 'XfFHpqt';
// One argument as [flag, value, whether the value is the next token]: flag '' for an option that takes no value
// the guard needs (and for `--`, which ends the options and is no endpoint); null for a positional.
function apiOption(t, next) {
  const long = t.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
  if (long) {
    if (!API_LONG.test(`--${long[1]}`)) return ['', '', false];
    return long[2] === undefined ? [long[1], next, true] : [long[1], long[2], false];
  }
  if (!t.startsWith('-')) return null;
  const at = [...t.slice(1)].findIndex((c) => API_SHORT.includes(c)) + 1;
  if (at === 0) return ['', '', false];
  const joined = t.slice(at + 1).replace(/^=/, '');
  return joined ? [t[at], joined, false] : [t[at], next, true];
}
function apiArgs(a, dyn) {
  const api = { method: null, fields: [], fieldDyn: [], input: false, positional: [], posDyn: [], posAt: [] };
  for (let k = 0; k < a.length; k++) {
    const opt = apiOption(a[k], a[k + 1] ?? '');
    if (opt === null) { api.positional.push(a[k]); api.posDyn.push(dyn[k]); api.posAt.push(k); continue; }
    const [flag, val, usedNext] = opt;
    if (usedNext) k++;
    if (flag === 'X' || flag === 'method') api.method = val;
    else if (/^(f|F|field|raw-field)$/.test(flag)) { api.fields.push(val); api.fieldDyn.push(dyn[k]); }
    else if (flag === 'input') api.input = true;
  }
  return api;
}
// xargs (or GNU parallel) ahead of gh appends its input to gh's arguments, or (-I R, -IR, -i, -J R, --replace) puts
// it in place of R inside them. Returns the arguments with R shown as `$` (unresolved) and whether the guard can
// read them.
const XARGS_REPL = /^(?:-[IJ]|--replace=?|-i)(.*)$/;
function viaXargs(seg, gh, args) {
  const x = seg.findIndex((t, k) => k < gh && /^(.*\/)?(xargs|parallel)$/.test(t));
  if (x < 0) return { args, unknown: false };
  const k = seg.findIndex((t, j) => j > x && j < gh && XARGS_REPL.test(t));
  if (k < 0) return { args, unknown: true };
  const repl = seg[k].match(XARGS_REPL)[1] || (/^-[IJ]$/.test(seg[k]) ? seg[k + 1] : '{}');
  return { args: args.map((t) => t.split(repl).join('$')), unknown: args.some((t) => t.includes(repl)) };
}
// Arguments bash may still change: a word that may become several (an unquoted `$`, backtick, glob or brace list,
// "$@"), a flag that expands (`"-$X"`), or a second positional that expands (gh takes one endpoint, so it may be a
// flag). Then the method, fields and query are unknown.
const unknownArgs = (args, dyn, api) => dyn.some((d) => d & (SPLITS | GLOB))
  || args.some((t, k) => t.startsWith('-') && dyn[k] & EXPANDS)
  || (api.positional.length > 1 && api.posDyn.some((d) => d & EXPANDS));
// A word that may become several before the first endpoint may add another endpoint (`--jq $J repos/...` with
// J='. graphql'), so the endpoint itself is unknown. One word cannot: `"-$X"` taking the endpoint as its value leaves
// any later endpoint on the command line.
const splitsBefore = (dyn, end) => dyn.slice(0, end).some((d) => d & (SPLITS | GLOB));
// Each %XX escape decoded on its own, so one bad escape does not hide the others.
const decode = (t) => t.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
// An endpoint as GitHub reads its path: decoded, an unquoted glob shown as unresolved, any ?query or #fragment dropped.
const pathOf = (p, d) => decode(d & GLOB ? p.replace(/[*[]/g, '$') : p).replace(/[?#][\s\S]*$/, '');
// The `gh api` call at seg[gh]: its arguments, what is unknown, and the endpoints' paths.
function readApi(seg, gh) {
  const dyn = seg.dyn.slice(gh + 2);
  const x = viaXargs(seg, gh, seg.slice(gh + 2));
  const api = apiArgs(x.args, dyn);
  api.args = x.args;
  api.unknown = x.unknown || unknownArgs(x.args, dyn, api);
  api.ends = api.positional.map((e, k) => pathOf(e, api.posDyn[k]));
  if (splitsBefore(dyn, api.posAt[0] ?? dyn.length)) api.ends.push('$');
  return api;
}
// A merge path (written with any method but GET/HEAD) or a mutation that writes a branch (main by default).
const API_MERGE = /pulls\/[^/\s]+\/merge\b|\/merges\b|\/merge-upstream\b/i;
const API_MUTATION = /mergePullRequest|mergeBranch|updateRef|deleteRef|createCommitOnBranch|enablePullRequestAutoMerge|enqueuePullRequest/i;
// Text the guard cannot resolve: a variable, a substitution, or a brace other than gh's {owner}/{repo} ({branch} is
// the current branch, which may be main; {} is an xargs or find slot). The literal text before it must already name
// a repo resource other than git/ (owner and repo literal: a variable there may hold a slash). A contents/ path is
// left to contentsToMain, which reads the branch.
const UNRESOLVED = /[$`]|\{(?!owner\}|repo\})/;
const SAFE_PREFIX = /^\/?(https?:\/\/[^/]+\/)?repos\/[^/]+\/[^/]+\/(?!git\/)[A-Za-z_-]+\//;
const hiddenEndpoint = (p) => UNRESOLVED.test(p) && !SAFE_PREFIX.test(p.slice(0, p.search(UNRESOLVED)));
// A contents write lands on the default branch (main) unless a literal `branch` field names another one.
function contentsToMain(api) {
  const branches = api.fields.filter((f) => f.startsWith('branch=')).map((f) => f.slice(7));
  return api.unknown || api.input || !branches.length || branches.some((b) => /^(refs\/)?(heads\/)?main$/.test(b) || /^[@{]|[$`]/.test(b));
}
// A GraphQL query the guard cannot read: unknown arguments, --input, a field whose key is not literal (`-f "$KV"`),
// or query text from a file or stdin (`query=@...`), a variable or a substitution (outside single quotes).
const hiddenField = (f, d) => !/^[^=$`]+=/.test(f) || (/^query=/.test(f) && (/^query=(@|\$)|\$\(|`/.test(f) || (d & EXPANDS) > 0));
const hiddenQuery = (api) => api.unknown || api.input || api.fields.some((f, k) => hiddenField(f, api.fieldDyn[k]));
// A write is any explicit method but GET/HEAD; with no method, a field or --input makes it a POST (gh's own rule).
const isWrite = (api) => api.unknown || (api.method !== null ? !/^(GET|HEAD)$/i.test(api.method) : api.fields.length > 0 || api.input);
// gh sends `graphql?x` and `graphql#x` in REST mode, and GitHub still runs the query.
const isGraphql = (p) => /(^|\/)graphql\/*$/i.test(p);
// A mutation name counts when an endpoint is, or may resolve to, graphql (with no endpoint, writeRefusal refuses).
const maybeGraphql = (api) => api.ends.some((e) => isGraphql(e) || UNRESOLVED.test(e));
// Why a write to these endpoints is refused, or null.
function writeRefusal(api, ends) {
  if (!ends.length) return 'the endpoint is not on the command line (xargs, stdin), so it cannot be checked';
  if (ends.some((p) => API_MERGE.test(p))) return 'it merges or writes a branch';
  if (ends.some((p) => /git\/refs\/heads\/main\b/.test(p))) return "it writes main's ref";
  if (ends.some(hiddenEndpoint)) return 'the endpoint holds a variable, substitution or glob, so it cannot be checked; write the path out';
  if (ends.some((p) => /\/contents(\/|$)/.test(p)) && contentsToMain(api)) return 'it writes a file on main (no literal branch other than main)';
  return null;
}
// Why a `gh api` call is refused, or null. Arguments the guard cannot read count as a write.
function apiRefusal(seg, gh) {
  const api = readApi(seg, gh);
  if (maybeGraphql(api) && api.args.some((t) => API_MUTATION.test(decode(t)))) return 'it merges or writes a branch';
  if (api.ends.some(isGraphql) && hiddenQuery(api)) return 'the GraphQL query is not inline, so it cannot be checked; write it as -f query=\'...\'';
  return isWrite(api) ? writeRefusal(api, api.ends) : null;
}
// `gh repo sync --force` hard-resets the destination branch (main by default) to the source.
const forcedSync = (seg, gh) => seg[gh + 1] === 'repo' && seg[gh + 2] === 'sync' && seg.some((t) => /^--force(=|$)/.test(t));
// Linear: the first `a` word, then `b` anywhere after it (a regex with [\s\S]* between them is quadratic).
const wordThen = (t, a, b) => { const i = t.search(a); return i >= 0 && b.test(t.slice(i)); };

dataOk = outputStaysData(cmd);
const segs = allSegments(cmd);
if (segs === null) {
  const why = 'Push guard could not parse this command (unbalanced quotes, or quoted commands nested more than 3 deep).';
  if (wordThen(plain(cmd), /\bgit\b/, /\bpush\b/)) deny(`${why} Run the git push on its own line.`);
  if (wordThen(plain(cmd), /\bgh\b/, /\b(api|sync)\b/)) deny(`${why} Run the gh api or gh repo sync call on its own line.`);
  process.exit(0);
}

let here = cwd; // follows `cd` through the command
let configChanged = false;
const synced = new Set(); // repos an earlier git pull/merge in this same command synced
for (const seg of segs) {
  if (seg[0] === 'cd' || seg[0] === 'pushd') { here = path.resolve(here, expand(seg[1] || process.env.HOME || '~')); continue; }
  // A PR merges only as a merge commit of the exact head that was reviewed (docs/git-workflow.md step 4; Brad
  // 2026-11-01): `gh pr merge <n> --merge --match-head-commit <sha>`, never --admin/--squash/--rebase/--auto.
  if (isData(seg)) continue;
  const gh = cmdAt(seg, 'gh');
  if (gh >= 0 && forcedSync(seg, gh)) deny('Refused `gh repo sync --force`: it hard-resets the branch (main by default) and can drop commits. Sync without --force.');
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
  // The same merge, or a write to main, through the REST or GraphQL API skips those checks (apiRefusal above). A
  // policy guard that reads text, not a wall: a gh alias, a command in a variable or another tool cannot be seen here.
  if (gh >= 0 && seg[gh + 1] === 'api') {
    const why = apiRefusal(seg, gh);
    if (why) {
      deny(`Refused \`gh api\` call: ${why}. Merge PRs only with \`gh pr merge <n> --merge --match-head-commit <reviewed sha>\`, `
        + 'never through `gh api`, and never write main through it (docs/git-workflow.md step 4).');
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
