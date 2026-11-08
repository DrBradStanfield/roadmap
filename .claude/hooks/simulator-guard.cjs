#!/usr/bin/env node
// PreToolUse(Bash) guard for simulator load (US-71 AC6; Brad 2026-11-09: "this mac is really struggling").
//   1. Denies `xcodebuild test` / `test-without-building` without `-parallel-testing-enabled NO`
//      (parallel testing clones simulators and fills the disk).
//   2. Denies `simctl boot|create|clone` while MAX_BOOTED_SIMULATORS are already booted, unless the
//      command sets ALLOW_EXTRA_SIMULATOR=1. Fails open when the booted check errors or times out.
// A best-effort warning layer: plain spellings only, no bash parser (PRs 805/930). Commands run by a
// script (ios/scripts/*.sh) are not seen.
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

// The deny reason for a command, or null to allow. `lookup` returns the booted list or null.
function decide(cmd, lookup = bootedSimulators) {
  const segs = cmd.replace(/\\\n/g, ' ').split(/&&|\|\||[;&|\n]/);
  for (const seg of segs) {
    if (/\bxcodebuild\b/.test(seg) && /(^|\s)(test|test-without-building)(\s|$)/.test(seg)
      && !/-parallel-testing-enabled\s+NO\b/.test(cmd)) {
      return 'xcodebuild test without `-parallel-testing-enabled NO` clones simulators and has overloaded this Mac '
        + '(US-71 AC6). Add `-parallel-testing-enabled NO` and a time limit: '
        + "`perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild ...`.";
    }
  }
  if (!segs.some((s) => /\bsimctl\s+(boot|create|clone)\b/.test(s))) return null;
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
