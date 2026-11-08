#!/usr/bin/env node
// PreToolUse(Bash) guard for simulator load (US-71 AC6; Brad 2026-11-09: "this mac is really struggling").
//   1. Denies `xcodebuild test` / `test-without-building` without `-parallel-testing-enabled NO`
//      (parallel testing clones simulators and fills the disk).
//   2. Denies `simctl boot|create|clone` while MAX_BOOTED_SIMULATORS are already booted, unless the
//      command sets ALLOW_EXTRA_SIMULATOR=1. Fails open when the booted check errors or times out.
// A best-effort warning layer, no bash parser (PRs 805/930): the tool must be the command word of its segment
// (after VAR=1, env, timeout N, perl -e '...' N or xcrun); quoted text, heredocs and comments never count.
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

// Each segment's tool (xcodebuild or simctl) and its arguments, with heredoc bodies, quoted text and comments
// gone, so `git commit -m "xcodebuild test"` is not a command. A quoted plain word ("NO") keeps its text.
function invocations(cmd) {
  const plain = cmd.replace(/\\\n/g, ' ')
    .replace(/<<-?[\t ]*(['"]?)(\w+)\1([^\n]*)\n(?:[\s\S]*?\n)?[\t ]*\2[\t ]*(?=\n|$)/g, ' $3')
    .replace(/'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_, s, d) => {
      const text = s !== undefined ? s : d;
      return /^[\w.=:\/@+-]*$/.test(text) ? text : 'QUOTED';
    })
    .replace(/(^|\s)#[^\n]*/g, '$1');
  const found = [];
  for (const seg of plain.split(/&&|\|\||[;&|\n()]/)) {
    const w = seg.trim().split(/\s+/);
    let i = 0;
    // Prefixes: VAR=1, env, timeout [-flags] N, perl [-e code] N, xcrun.
    for (;;) {
      if (/^\w+=/.test(w[i]) || w[i] === 'env' || w[i] === 'xcrun') i++;
      else if (w[i] === 'timeout' || w[i] === 'perl') {
        i++;
        while (w[i] && w[i].startsWith('-')) i += w[i] === '-e' ? 2 : 1;
        if (/^\d+[smh]?$/.test(w[i] || '')) i++;
      } else break;
    }
    const tool = (w[i] || '').split('/').pop();
    if (tool === 'xcodebuild' || tool === 'simctl') found.push({ tool, args: w.slice(i + 1) });
  }
  return found;
}

// The deny reason for a command, or null to allow. `lookup` returns the booted list or null.
function decide(cmd, lookup = bootedSimulators) {
  const calls = invocations(cmd);
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
  if (/\bALLOW_EXTRA_SIMULATOR=1\b/.test(cmd)) return null;
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
