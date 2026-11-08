#!/usr/bin/env node
// PreToolUse(Bash) guard for simulator load (US-71 AC6; Brad 2026-11-09: "this mac is really struggling").
//   1. Denies `xcodebuild test` / `test-without-building` without `-parallel-testing-enabled NO`
//      (parallel testing clones simulators and fills the disk).
//   2. Denies `simctl boot|create|clone` while MAX_BOOTED_SIMULATORS are already booted, unless the
//      command sets ALLOW_EXTRA_SIMULATOR=1. Fails open when the booted check errors or times out.
// A best-effort warning layer, not a bash parser (PRs 805/930): one scan drops comments, heredoc bodies and
// quoted text, and the tool must be the command word of its segment (after VAR=1, env, timeout N,
// perl -e '...' N or xcrun). A malformed command is also checked as raw text, so it can only be denied.
// Commands run by a script (ios/scripts/*.sh) are not seen.
const { execFileSync } = require('child_process');

const MAX_BOOTED_SIMULATORS = 2;

// Booted devices as [{ name, udid }], or null when the check fails (fail open).
function bootedSimulators() {
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return Object.values(JSON.parse(out).devices || {}).flat()
      .filter((d) => d.state === 'Booted').map((d) => ({ name: d.name, udid: d.udid }));
  } catch { return null; }
}

// One left-to-right pass over the command: segments of words, split on unquoted && || ; & | newline ( ).
// Comments and heredoc bodies vanish; a quoted string becomes QUOTED unless it is a plain word ("NO").
// `clean` is false when the scan ends inside a quote or heredoc.
function scan(cmd) {
  const segs = [[]];
  let word = null, wq = false, state = 'normal', quoted = '', heredocs = [], i = 0;
  // wq: part of the word before its first '=' was quoted or escaped. Bash never reads such a word as VAR=value
  // (setsEscapeHatch); a quoted value after the '=' (FOO="bar") is still an assignment.
  const endWord = () => {
    if (word !== null) { const seg = segs[segs.length - 1]; if (wq) (seg.quoted ||= new Set()).add(seg.length); seg.push(word); }
    word = null; wq = false;
  };
  const endSeg = () => { endWord(); segs.push([]); };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (state === 'comment') { if (ch === '\n') state = 'normal'; else { i++; continue; } }
    if (state === 'single' || state === 'double') {
      // In double quotes bash drops a backslash only before $ ` " \ or a newline; elsewhere it stays.
      if (state === 'double' && ch === '\\' && i + 1 < cmd.length) { const n = cmd[i + 1]; quoted += '$`"\\\n'.includes(n) ? n : '\\' + n; i += 2; continue; }
      if (ch === (state === 'single' ? "'" : '"')) {
        if (!(word || '').includes('=')) wq = true;
        word = (word || '') + (/^[\w.:\/@+-]*$/.test(quoted) ? quoted : 'QUOTED');
        state = 'normal';
      } else quoted += ch;
      i++; continue;
    }
    if (ch === '\\' && cmd[i + 1] === '\n') { i += 2; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { if (!(word || '').includes('=')) wq = true; word = (word || '') + cmd[i + 1]; i += 2; continue; }
    if (ch === "'" || ch === '"') { state = ch === "'" ? 'single' : 'double'; quoted = ''; i++; continue; }
    if (ch === '#' && word === null) { state = 'comment'; i++; continue; }
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      endWord();
      i += 2;
      const strip = cmd[i] === '-';
      if (strip) i++;
      while (cmd[i] === ' ' || cmd[i] === '\t') i++;
      let delim = '';
      while (i < cmd.length && !/[\s;&|()<>]/.test(cmd[i])) delim += cmd[i++];
      heredocs.push({ delim: delim.replace(/['"\\]/g, ''), strip });
      continue;
    }
    if (ch === '\n') {
      endSeg();
      i++;
      for (const { delim, strip } of heredocs) {
        for (;;) {
          if (i >= cmd.length) return { segs, clean: false };
          const nl = cmd.indexOf('\n', i), end = nl < 0 ? cmd.length : nl;
          const line = cmd.slice(i, end);
          i = end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (ch === ' ' || ch === '\t') endWord();
    else if (';&|()'.includes(ch)) endSeg();
    else word = (word || '') + ch;
    i++;
  }
  endWord();
  return { segs, clean: (state === 'normal' || state === 'comment') && heredocs.length === 0 };
}

// Each segment's tool (xcodebuild or simctl) and its arguments, after the prefixes VAR=1, env,
// timeout [-flags] N, perl [-flags -e code] N and xcrun.
function invocation(w) {
  let i = 0;
  for (;;) {
    if (/^\w+=/.test(w[i]) || w[i] === 'env' || w[i] === 'xcrun') i++;
    else if (w[i] === 'timeout' || w[i] === 'perl') {
      i++;
      while (w[i] && w[i].startsWith('-')) i += w[i] === '-e' ? 2 : 1;
      if (/^\d+[smh]?$/.test(w[i] || '')) i++;
    } else break;
  }
  const tool = (w[i] || '').split('/').pop();
  return tool === 'xcodebuild' || tool === 'simctl' ? { tool, args: w.slice(i + 1) } : null;
}

// The deny reason for a command, or null to allow. `lookup` returns the booted list or null.
// A malformed command (unterminated quote or heredoc) is also checked as raw text, so it can only be denied.
function setsEscapeHatch(seg) {
  let i = seg[0] === 'export' ? 1 : 0;
  for (; i < seg.length && /^[A-Za-z_]\w*=/.test(seg[i]) && !seg.quoted?.has(i); i++) if (seg[i] === 'ALLOW_EXTRA_SIMULATOR=1') return true;
  return false;
}

function decide(cmd, lookup = bootedSimulators) {
  const { segs, clean } = scan(cmd);
  const words = clean ? segs : segs.concat(cmd.split(/&&|\|\||[;&|\n()]/).map((s) => s.trim().split(/\s+/)));
  const calls = words.map(invocation).filter(Boolean);
  for (const { tool, args } of calls) {
    if (tool !== 'xcodebuild' || !args.some((a) => a === 'test' || a === 'test-without-building')) continue;
    const flagged = args.some((a, j) => a === '-parallel-testing-enabled' && args[j + 1] === 'NO');
    if (!flagged) {
      return 'xcodebuild test without `-parallel-testing-enabled NO` clones simulators and has overloaded this Mac '
        + '(US-71 AC6). Add `-parallel-testing-enabled NO` and a time limit: '
        + "`perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild ...`.";
    }
  }
  const boots = calls.filter((c) => c.tool === 'simctl' && ['boot', 'create', 'clone'].includes(c.args[0]));
  if (!boots.length) return null;
  // The escape hatch counts only as a real, unquoted assignment: a leading VAR=value of a segment, or after `export`.
  if (segs.some(setsEscapeHatch)) return null;
  const booted = lookup();
  if (!booted || booted.length < MAX_BOOTED_SIMULATORS) return null;
  const list = booted.map((d) => `${d.name} (${d.udid})`).join(', ');
  return `${booted.length} simulators are already booted: ${list}. This Mac takes at most ${MAX_BOOTED_SIMULATORS} `
    + '(US-71 AC6). Reuse one with `-destination id=<udid>`, or shut one down first with '
    + '`xcrun simctl shutdown <udid>`. For a demo, prefix the command with ALLOW_EXTRA_SIMULATOR=1.';
}

module.exports = { decide, MAX_BOOTED_SIMULATORS };

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
