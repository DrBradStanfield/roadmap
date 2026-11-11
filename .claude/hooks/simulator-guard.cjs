#!/usr/bin/env node
// PreToolUse(Bash) guard for simulator load (US-71 AC6; Brad 2026-11-09: "this mac is really struggling").
//   1. Denies `xcodebuild test` / `test-without-building` without `-parallel-testing-enabled NO`
//      (parallel testing clones simulators and fills the disk).
//   2. Denies `simctl boot|create|clone` while MAX_BOOTED_SIMULATORS are already booted, unless the
//      command sets ALLOW_EXTRA_SIMULATOR=other-device. Fails open when the booted check errors or times out.
//   3. Denies any other simulator use outside ios/scripts/sim-run.sh (US-71 AC7): a simulator
//      -destination (iOS Simulator, a simulator UUID, a bare name=, a $VAR), an xcodebuild test action with no
//      destination, and simctl's device commands (DOOR_SIMCTL). ALLOW_EXTRA_SIMULATOR=other-device lifts
//      it, for a demo on another simulator.
// A seat belt, not a wall: a best-effort warning layer, not a bash parser (PRs 805/930). One scan drops
// comments, heredoc bodies and quoted text, and the tool must be the command word of its segment (past
// commandIndex's prefixes); a `bash -c "..."` string is checked as a command. A malformed command is also
// checked as raw text, so it can only be denied. Commands run by a script (ios/scripts/*.sh) are not seen.
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
  let word = null, raw = '', wq = false, state = 'normal', quoted = '', heredocs = [], i = 0;
  // wq: part of the word before its first '=' was quoted or escaped. Bash never reads such a word as VAR=value
  // (setsEscapeHatch); a quoted value after the '=' (FOO="bar") is still an assignment.
  // raw: the word as bash reads it, quotes gone but quoted text kept (seg.raw), for `bash -c "..."`.
  const endWord = () => {
    if (word !== null) {
      const seg = segs[segs.length - 1];
      if (wq) (seg.quoted ||= new Set()).add(seg.length);
      (seg.raw ||= [])[seg.length] = raw;
      seg.push(word);
    }
    word = null; raw = ''; wq = false;
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
        raw += quoted;
        state = 'normal';
      } else quoted += ch;
      i++; continue;
    }
    if (ch === '\\' && cmd[i + 1] === '\n') { i += 2; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { if (!(word || '').includes('=')) wq = true; word = (word || '') + cmd[i + 1]; raw += cmd[i + 1]; i += 2; continue; }
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
    else { word = (word || '') + ch; raw += ch; }
    i++;
  }
  endWord();
  return { segs, clean: (state === 'normal' || state === 'comment') && heredocs.length === 0 };
}

// The index of a segment's real command word, past words that pass a command on: VAR=1, env (and its
// options), time, nohup, exec, command, nice [-n N], timeout [-flags] N, perl [-flags -e code] N and
// xcrun (and --sdk X). Paths are reduced to their last part (/usr/bin/xcrun).
const base = (w) => (w || '').split('/').pop();
function commandIndex(w) {
  let i = 0;
  for (;;) {
    const b = base(w[i]);
    if (/^\w+=/.test(w[i]) || ['nohup', 'exec', 'command'].includes(b)) i++;
    else if (b === 'env') { i++; while (w[i] && (w[i].startsWith('-') || /^\w+=/.test(w[i]))) i += /^-[uPS]$/.test(w[i]) ? 2 : 1; }
    else if (b === 'time') { i++; if (w[i] === '-p') i++; }
    else if (b === 'nice') { i++; if (w[i] === '-n') i += 2; else if (/^-\d+$/.test(w[i] || '')) i++; }
    else if (b === 'xcrun') {
      i++;
      while (w[i] && w[i].startsWith('-')) i += /^--?(sdk|toolchain)$/.test(w[i]) ? 2 : 1;
    } else if (b === 'timeout' || b === 'perl') {
      i++;
      while (w[i] && w[i].startsWith('-')) i += w[i] === '-e' ? 2 : 1;
      if (/^\d+[smh]?$/.test(w[i] || '')) i++;
    } else return i;
  }
}

// Each segment's tool (xcodebuild or simctl) and its arguments. simctl's leading options (--set X) are
// dropped, so args[0] is the subcommand.
function invocation(w) {
  const i = commandIndex(w);
  const tool = base(w[i]);
  if (tool === 'xcodebuild') return { tool, args: w.slice(i + 1), raws: (w.raw || w).slice(i + 1) };
  if (tool !== 'simctl') return null;
  let j = i + 1;
  while (w[j] && w[j].startsWith('-')) j += /^--(set|profiles)$/.test(w[j]) ? 2 : 1;
  return { tool, args: w.slice(j) };
}

// The deny reason for a command, or null to allow. `lookup` returns the booted list or null.
// A malformed command (unterminated quote or heredoc) is also checked as raw text, so it can only be denied.
// The escape hatch has one named purpose, a demo on another simulator (ios/CLAUDE.md); denials never name it.
const HATCH = 'ALLOW_EXTRA_SIMULATOR=other-device';
function setsEscapeHatch(seg) {
  let i = seg[0] === 'export' ? 1 : 0;
  for (; i < seg.length && /^[A-Za-z_]\w*=/.test(seg[i]) && !seg.quoted?.has(i); i++) if (seg[i] === HATCH) return true;
  return false;
}

function decide(cmd, lookup = bootedSimulators, depth = 0) {
  const { segs, clean } = scan(cmd);
  const words = clean ? segs : segs.concat(cmd.split(/&&|\|\||[;&|\n()]/).map((s) => s.trim().split(/\s+/)));
  const calls = words.map(invocation).filter(Boolean);
  for (const { tool, args } of calls) {
    if (tool !== 'xcodebuild' || !args.some((a) => a === 'test' || a === 'test-without-building')) continue;
    const flagged = args.some((a, j) => a === '-parallel-testing-enabled' && args[j + 1] === 'NO');
    if (!flagged) {
      return 'xcodebuild test without `-parallel-testing-enabled NO` clones simulators and has overloaded this Mac '
        + `(US-71 AC6). ${DOOR_HINT}`;
    }
  }
  // The escape hatch counts only as a real, unquoted assignment: a leading VAR=value of a segment, or after `export`.
  const hatch = segs.some(setsEscapeHatch);
  const boots = calls.filter((c) => c.tool === 'simctl' && ['boot', 'create', 'clone'].includes(c.args[0]));
  if (boots.length && !hatch) {
    const booted = lookup();
    if (booted && booted.length >= MAX_BOOTED_SIMULATORS) {
      const list = booted.map((d) => `${d.name} (${d.udid})`).join(', ');
      return `${booted.length} simulators are already booted: ${list}. This Mac takes at most ${MAX_BOOTED_SIMULATORS} `
        + `(US-71 AC6). ${DOOR_HINT}`;
    }
  }
  if (!hatch && calls.some(usesSimulator)) return `This runs on a simulator outside the shared one (US-71 AC7). ${DOOR_HINT}`;
  // A shell given a script string (bash -c "...", sh -lc '...'): the string is checked as a command.
  if (!hatch && depth < 3) {
    for (const seg of segs) {
      const i = commandIndex(seg);
      if (!['bash', 'sh', 'zsh', 'dash'].includes(base(seg[i])) || !/^-[a-z]*c[a-z]*$/.test(seg[i + 1] || '')) continue;
      const inner = decide(seg.raw?.[i + 2] ?? seg[i + 2] ?? '', lookup, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}

// US-71 AC7: the one door to the simulator is ios/scripts/sim-run.sh. A command run through it has the
// wrapper as its command word, so invocation() never sees the xcodebuild or simctl inside.
const DOOR_HINT = 'Run it through the shared simulator instead: `ios/scripts/sim-run.sh -- xcodebuild test ...` '
  + '(it adds the device and the test flags), or `ios/scripts/sim-run.sh -- xcrun simctl launch {udid} <bundle id>`. '
  + 'For the iOS Simulator MCP tool, use the demo device (ios/CLAUDE.md § xcodebuild and simulators).';
const DOOR_ACTIONS = ['test', 'test-without-building', 'build-for-testing'];
// shutdown stays allowed: it is the demo device's cleanup command.
const DOOR_SIMCTL = ['boot', 'bootstatus', 'install', 'uninstall', 'launch', 'terminate', 'io', 'erase', 'delete',
  'spawn', 'openurl', 'privacy', 'status_bar', 'keychain', 'addmedia'];

// A destination naming a simulator: "iOS Simulator" (not generic/, which boots nothing), a simulator's
// UUID id (a phone's id has another shape), or a bare name=. Read from the raw word, quotes removed.
const SIM_ID = /(^|,)id=[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;
function simDestination(a) {
  // A destination the guard cannot expand ($VAR, `cmd`) counts as a simulator.
  return !a.startsWith('generic/') && (/Simulator/.test(a) || SIM_ID.test(a) || /^name=/.test(a) || /[$`]/.test(a));
}

// simctl's device commands; xcodebuild with a simulator destination, or a test action with no destination
// (Xcode may pick a simulator). A physical device or generic/ destination boots nothing and passes.
function usesSimulator({ tool, args, raws }) {
  if (tool === 'simctl') return DOOR_SIMCTL.includes(args[0]);
  const dests = raws.filter((a, j) => args[j - 1] === '-destination');
  if (dests.some(simDestination)) return true;
  return args.some((a) => DOOR_ACTIONS.includes(a)) && dests.length === 0;
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
