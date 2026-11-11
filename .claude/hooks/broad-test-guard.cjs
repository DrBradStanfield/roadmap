#!/usr/bin/env node
// PreToolUse(Bash) guard: CI runs the broad tests, the Mac does not (US-71 AC10; Brad 2026-11-12: several sessions
// share one Mac, and even a capped `vitest related` took the load to 19.7). Denies npm's whole-suite scripts
// (BROAD_SCRIPTS, whatever their arguments), `vitest related`, and vitest (run, watch or bare) or
// scripts/test-all-locked.mjs with no file argument. A leading ALLOW_BROAD_TESTS=<reason> lifts it. Off in CI and
// outside macOS.
// A seat belt like simulator-guard.cjs, whose scan it reuses: the tool must be the command word of its segment
// (past env prefixes, npx, npm exec, xargs and `[sh|bash|zsh] tools/mac-slot.sh tests --`); quoted text, comments
// and heredoc bodies are not commands; a `bash -c "..."` string is checked as a command. A vitest run whose every
// operand is a top-level folder (tests, app, src, widget-src, packages, .) counts as no file. Not seen: a command
// run by a script, inside "$(...)", by find -exec, or through a vitest option this file does not know takes a
// value (`--foo x` reads x as a file and passes); a deeper folder or a name filter (`app/lib`, `merge`) still
// passes, though it can run many files, as a false refusal is the worse failure.
const { scan, commandIndex, base } = require('./simulator-guard.cjs');

const BROAD_SCRIPTS = ['test', 'test:all', 'test:core', 'test:server', 'test:watch', 'mutation:clinical'];
const REASON = 'Broad test runs belong to CI, not this shared Mac (US-71 AC10): run only the test files you touched '
  + '(`npx vitest run <files>`), then push; CI runs the rest. For a flake hunt or a run Brad asked for, '
  + 'prefix `ALLOW_BROAD_TESTS=<reason>`.';
const NPM_VALUE = /^(-w|--workspace|--prefix|-C|--loglevel|--userconfig|-p|--package)$/;
// Top-level folders: a run naming only these is near-whole-suite ('' is ./).
const TOP_DIRS = ['', '.', 'tests', 'app', 'src', 'widget-src', 'packages'];
const VITEST_SUBS = ['run', 'watch', 'dev', 'related', 'bench', 'list'];
// vitest options that take a separate value, so the value is not read as a file.
const VITEST_VALUE = /^(-t|--testNamePattern|-c|--config|-r|--root|--dir|--project|--maxWorkers|--minWorkers|--reporter|--outputFile|--shard|--environment|--pool|--exclude|--testTimeout|--hookTimeout|--bail|--retry|--mode|--sequence\.seed|--changed)$/;

// The first word after index i that is not an option (skipping option values), or -1.
function operand(w, i, valued) {
  for (; i < w.length; i++) {
    if (w[i] === '--') return i + 1 < w.length ? i + 1 : -1;
    if (!w[i].startsWith('-')) return i;
    if (valued.test(w[i])) i++;
  }
  return -1;
}

// 'broad' or null for one segment's words.
function judge(seg) {
  let w = seg, stdin = false;
  for (;;) {
    w = w.slice(commandIndex(w));
    const b = base(w[0]);
    if (['sh', 'bash', 'zsh'].includes(b) && base(w[1]) === 'mac-slot.sh') { w = w.slice(1); continue; }
    if (b === 'mac-slot.sh' && w.includes('--')) { w = w.slice(w.indexOf('--') + 1); continue; }
    if (b === 'xargs') {
      let i = 1;
      while (w[i]?.startsWith('-')) i += /^-[IJLnPdsE]$/.test(w[i]) ? 2 : 1;
      w = w.slice(i); stdin = true; continue;
    }
    if (b === 'npx') { const i = operand(w, 1, NPM_VALUE); if (i < 0) return null; w = w.slice(i); continue; }
    if (b === 'npm') {
      const i = operand(w, 1, NPM_VALUE);
      if (i < 0) return null;
      if (['test', 't', 'tst'].includes(w[i])) return 'broad';
      if (['run', 'run-script', 'rum', 'urn'].includes(w[i])) {
        const s = operand(w, i + 1, NPM_VALUE);
        return s >= 0 && BROAD_SCRIPTS.includes(w[s]) ? 'broad' : null;
      }
      if (['exec', 'x'].includes(w[i])) { const j = operand(w, i + 1, NPM_VALUE); if (j < 0) return null; w = w.slice(j); continue; }
      return null;
    }
    if (b === 'node') { const i = operand(w, 1, /^(-r|--require|--import)$/); if (i < 0) return null; w = w.slice(i); }
    break;
  }
  const tool = base(w[0]);
  const lockScript = tool === 'test-all-locked.mjs';
  if (!lockScript && !/^vitest(@[\w.^~-]+|\.mjs)?$/.test(tool)) return null;
  let args = w.slice(1);
  if (!lockScript && VITEST_SUBS.includes(args[0])) {
    if (args[0] === 'related') return 'broad';
    args = args.slice(1);
  }
  if (args.some((a) => /^(-h|--help|-v|--version)$/.test(a))) return null;
  const files = [];
  for (let i = operand(args, 0, VITEST_VALUE); i >= 0; i = operand(args, i + 1, VITEST_VALUE)) files.push(args[i]);
  return stdin || files.some((f) => !TOP_DIRS.includes(f.replace(/^\.\/|\/+$/g, ''))) ? null : 'broad';
}

// The escape hatch counts only as a real, unquoted leading assignment with a reason (or after `export`).
function setsEscapeHatch(seg) {
  let i = seg[0] === 'export' ? 1 : 0;
  for (; i < seg.length && /^[A-Za-z_]\w*=/.test(seg[i]) && !seg.quoted?.has(i); i++) {
    if (/^ALLOW_BROAD_TESTS=./.test(seg[i])) return true;
  }
  return false;
}

// Same test as scripts/test-workers.mjs inCI.
const inCI = (env) => !!env.CI && env.CI !== 'false' && env.CI !== '0';

// The deny reason for a command, or null to allow. A malformed command is also checked as raw text.
// Off outside macOS: the rule guards the shared Mac, and cloud sessions do not load it.
function decide(cmd, env = process.env, platform = process.platform, depth = 0) {
  if (inCI(env) || platform !== 'darwin') return null;
  const { segs, clean } = scan(cmd);
  if (segs.some(setsEscapeHatch)) return null;
  const words = clean ? segs : segs.concat(cmd.split(/&&|\|\||[;&|\n()]/).map((s) => s.trim().split(/\s+/)));
  if (words.some(judge)) return REASON;
  if (depth < 3) {
    for (const seg of segs) {
      const i = commandIndex(seg);
      if (!['bash', 'sh', 'zsh', 'dash'].includes(base(seg[i])) || !/^-[a-z]*c[a-z]*$/.test(seg[i + 1] || '')) continue;
      const inner = decide(seg.raw?.[i + 2] ?? seg[i + 2] ?? '', env, platform, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

module.exports = { decide, BROAD_SCRIPTS };

if (require.main === module) {
  let input;
  try { input = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const reason = decide((input.tool_input && input.tool_input.command) || '');
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }));
  }
}
