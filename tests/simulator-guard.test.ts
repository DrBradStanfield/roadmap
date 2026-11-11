/**
 * US-71 AC6: the simulator guard (.claude/hooks/simulator-guard.cjs). On 2026-11-09 four booted simulators and
 * two parallel `xcodebuild test` runs pushed this 10-core 16 GB Mac to load 214 and 6 of 7 GB swap.
 *
 * Housekeeping (no user-facing behaviour). The booted-device lookup is injected, so no test calls simctl; the
 * settings.json wiring is run for real only with commands that never reach the lookup.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { decide, MAX_BOOTED_SIMULATORS } = createRequire(import.meta.url)(join(ROOT, '.claude/hooks/simulator-guard.cjs'));

const one = () => [{ name: 'iPhone 17 Pro', udid: 'AAAA-1111' }];
const two = () => [...one(), { name: 'iPhone SE', udid: 'BBBB-2222' }];
const never = () => { throw new Error('lookup must not run'); };

describe('US-71 AC6 rule 1: xcodebuild test needs -parallel-testing-enabled NO', () => {
  it.each([
    'xcodebuild test -scheme App -destination id=X',
    'xcodebuild -scheme App test-without-building',
    "perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild test -scheme App",
    'cd ios && xcodebuild test -scheme App | tee log',
    'xcodebuild -scheme App \\\n  test',
    'xcodebuild test -parallel-testing-enabled YES',
    'ALLOW_EXTRA_SIMULATOR=1 FOO=bar xcodebuild test -scheme App',
    'env DEVELOPER_DIR=/x timeout 1200 xcodebuild test -scheme App',
    'xcrun xcodebuild test -scheme App',
    // the flag must be on the same xcodebuild (review F2/R1)
    'xcodebuild test -scheme A # -parallel-testing-enabled NO',
    'xcodebuild test -scheme A && echo -parallel-testing-enabled NO',
    'xcodebuild test -scheme A -parallel-testing-enabled NO; xcodebuild test -scheme B',
    'xcodebuild test -scheme A "-parallel-testing-enabled NO"',
  ])('denies %s', (cmd) => {
    const reason = decide(cmd, never);
    expect(reason).toContain('-parallel-testing-enabled NO');
    expect(reason).toContain("perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild");
  });

  // With the flag, rule 1 passes them; outside the escape hatch rule 3 (AC7) then sends them to sim-run.sh.
  it.each([
    "perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild test -scheme App -parallel-testing-enabled NO",
    'xcodebuild -scheme App \\\n  -parallel-testing-enabled NO \\\n  test-without-building',
    'xcodebuild test -scheme App -parallel-testing-enabled "NO"',
    "(cd ios; perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild -scheme App test -parallel-testing-enabled NO) | tail",
  ])('rule 1 passes %s', (cmd) => {
    expect(decide(`ALLOW_EXTRA_SIMULATOR=1 ${cmd}`, never)).toBeNull();
    expect(decide(cmd, never)).toContain('US-71 AC7');
  });

  it.each([
    'xcodebuild build -scheme App',
    'pgrep -fl xcodebuild',
    'npm test && xcodebuild build -scheme App',
    'grep xcodebuild test.log',
    // text, not commands (review F1/R2)
    'git commit -m "Run xcodebuild test with the flag"',
    'git commit -F - <<EOF\nworkers run xcodebuild test -scheme App\nEOF',
    "git commit -F - <<'EOF'\nworkers run xcodebuild test\nEOF\ngit log",
    'gh pr create --body "denies xcodebuild test without flag"',
    'grep -rn "xcodebuild test " docs/',
    'echo xcodebuild test',
    'cat > notes.md <<EOF\nnever run xcodebuild test without it\nEOF',
  ])('allows %s', (cmd) => {
    expect(decide(cmd, never)).toBeNull();
  });
});

describe(`US-71 AC6 rule 2: no new simulator once ${MAX_BOOTED_SIMULATORS} are booted`, () => {
  it('caps at two', () => expect(MAX_BOOTED_SIMULATORS).toBe(2));

  it.each(['xcrun simctl boot AAAA', 'xcrun simctl create Demo iPhone-18-Pro', 'simctl clone AAAA Copy',
    'ls && xcrun simctl boot BBBB'])('denies %s with two booted, naming them', (cmd) => {
    const reason = decide(cmd, two);
    expect(reason).toContain('iPhone 17 Pro (AAAA-1111)');
    expect(reason).toContain('iPhone SE (BBBB-2222)');
    expect(reason).toContain('-destination id=<udid>');
    expect(reason).toContain('xcrun simctl shutdown <udid>');
  });

  it.each(['git commit -m "guard simctl boot"', 'echo xcrun simctl boot X', 'grep -n "simctl create" ios/scripts/*.sh',
    'cat <<EOF\nxcrun simctl clone A B\nEOF'])('treats %s as text, never asking simctl', (cmd) => {
    expect(decide(cmd, never)).toBeNull();
  });

  it('the cap passes a boot with one booted or none; rule 3 then sends it to sim-run.sh', () => {
    expect(decide('xcrun simctl boot BBBB', one)).toContain('US-71 AC7');
    expect(decide('xcrun simctl boot BBBB', () => [])).toContain('US-71 AC7');
    expect(decide('xcrun simctl create Demo iPhone-18-Pro', one)).toBeNull();
  });

  it('allows the escape hatch ALLOW_EXTRA_SIMULATOR=1 without asking simctl', () => {
    expect(decide('ALLOW_EXTRA_SIMULATOR=1 xcrun simctl boot CCCC', never)).toBeNull();
  });

  it('fails open when the booted check fails or times out', () => {
    expect(decide('xcrun simctl create Demo iPhone-18-Pro', () => null)).toBeNull();
  });

  it('never asks simctl for commands that do not boot, create or clone', () => {
    const lookup = vi.fn(two);
    for (const cmd of ['xcrun simctl list devices', 'xcrun simctl shutdown AAAA', 'xcrun simctl bootstatus AAAA -b', 'ls'])
      expect(decide(cmd, lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('the escape hatch does not lift rule 1', () => {
    expect(decide('ALLOW_EXTRA_SIMULATOR=1 xcodebuild test -scheme App', never)).toContain('-parallel-testing-enabled NO');
  });
});

describe('US-71 AC7 rule 3: the simulator only through ios/scripts/sim-run.sh', () => {
  it.each([
    'xcodebuild build-for-testing -scheme App',
    'xcodebuild build -scheme App -destination "platform=iOS Simulator,name=iPhone 18 Pro"',
    "cd ios && xcodebuild -scheme App -destination 'platform=iOS Simulator,id=AAAA' build",
    'xcodebuild build -scheme App -destination platform=iOS\\ Simulator,name=X',
    'xcrun simctl install AAAA build/App.app',
    'xcrun simctl launch AAAA com.drstanfield.healthroadmap',
    'xcrun simctl io AAAA screenshot shot.png',
    'xcrun simctl uninstall AAAA com.drstanfield.healthroadmap',
    'ls && simctl boot AAAA',
  ])('denies %s, naming the wrapper', (cmd) => {
    const reason = decide(cmd, () => []);
    expect(reason).toContain('US-71 AC7');
    expect(reason).toContain('ios/scripts/sim-run.sh -- xcodebuild test');
    expect(reason).toContain('ALLOW_EXTRA_SIMULATOR=1');
  });

  it.each([
    'ios/scripts/sim-run.sh -- xcodebuild test -project HealthRoadmap.xcodeproj -scheme HealthRoadmap',
    'cd ios && scripts/sim-run.sh --reset-app -- xcrun simctl launch {udid} com.drstanfield.healthroadmap',
    'ios/scripts/sim-run.sh -- xcrun simctl io {udid} screenshot shot.png',
    'ios/scripts/sim-run.sh status',
    'ios/scripts/test.sh',
    "xcodebuild archive -scheme App -destination 'generic/platform=iOS'",
    'xcodebuild build -scheme App -destination "generic/platform=iOS Simulator"',
    'xcrun simctl list devices booted',
    'xcrun simctl shutdown AAAA',
    'ALLOW_EXTRA_SIMULATOR=1 xcrun simctl launch AAAA com.x',
    'ALLOW_EXTRA_SIMULATOR=1 xcodebuild build-for-testing -destination "platform=iOS Simulator,name=iPad"',
  ])('allows %s', (cmd) => {
    expect(decide(cmd, () => [])).toBeNull();
  });

  it('a quoted or commented hatch does not lift it', () => {
    expect(decide('echo ALLOW_EXTRA_SIMULATOR=1; xcrun simctl launch AAAA com.x', () => [])).toContain('US-71 AC7');
    expect(decide('xcrun simctl launch AAAA com.x # ALLOW_EXTRA_SIMULATOR=1', () => [])).toContain('US-71 AC7');
  });
});

describe('US-71 AC6 scanner: comments, heredocs and quotes (Codex re-check R1/R2)', () => {
  it.each([
    "# don't overload this Mac\nxcodebuild test -scheme App\n# it's already busy",
    "xcodebuild test -scheme App # it's busy",
    "# it's\n# don't\nxcodebuild test -scheme App",
    "xcodebuild test -scheme App\n# don't",
    'a#b; xcodebuild test -scheme App',
    'echo "it\'s # not a comment"; xcodebuild test -scheme App',
    'echo "say \\"hi\\" # still quoted"; xcodebuild test -scheme App',
    "git commit -F - <<'COMMIT-MSG'\ntext\nCOMMIT-MSG\nxcodebuild test -scheme App",
  ])('denies the xcodebuild in %j', (cmd) => {
    expect(decide(cmd, never)).toContain('-parallel-testing-enabled NO');
  });

  it.each([
    "# don't overload this Mac\nxcrun simctl boot X\n# it's already busy",
    "xcrun simctl boot X # it's busy",
    "# it's\nxcrun simctl boot X",
    "cat <<\\EOF\nbody\nEOF\nxcrun simctl boot X",
  ])('applies the cap to the simctl boot in %j', (cmd) => {
    expect(decide(cmd, two)).toContain('already booted');
  });

  it.each([
    "git commit -F - <<'COMMIT-MSG'\nxcodebuild test\nCOMMIT-MSG",
    'cat <<"END-1"\nxcodebuild test\nxcrun simctl boot X\nEND-1',
    'cat <<\\EOF\nxcodebuild test\nEOF',
    'cat <<-EOF\n\txcodebuild test\n\tEOF',
    'cat <<END_1 | tee x\nxcodebuild test\nEND_1',
    "echo 'a # b' xcodebuild test",
    'echo "x \\" xcodebuild test"',
    "# xcodebuild test\nls",
    "# it's\nls # don't\n# xcrun simctl boot X",
    '# ALLOW_EXTRA_SIMULATOR=1 note\nls',
  ])('allows %j', (cmd) => {
    expect(decide(cmd, never)).toBeNull();
  });

  it('a comment cannot carry the escape hatch', () => {
    expect(decide('xcrun simctl boot X # ALLOW_EXTRA_SIMULATOR=1', two)).toContain('already booted');
    expect(decide('export ALLOW_EXTRA_SIMULATOR=1; xcrun simctl boot X', never)).toBeNull();
  });

  it.each([
    'echo "ALLOW_EXTRA_SIMULATOR=1"; xcrun simctl boot CCCC',
    "echo ALLOW_EXTRA_SIMULATOR=1; xcrun simctl boot CCCC",
    'FOO="ALLOW_EXTRA_SIMULATOR=1" xcrun simctl boot CCCC',
    'ALLOW_EXTRA_SIMULATOR="\\1" xcrun simctl boot CCCC',
    '"ALLOW_EXTRA_SIMULATOR"=1; xcrun simctl boot CCCC',
    "'ALLOW_EXTRA_SIMULATOR=1'; xcrun simctl boot CCCC",
    'ALLOW_EXTRA_SIMULATOR\\=1; xcrun simctl boot CCCC',
  ])('only a real leading assignment carries the escape hatch, not %j (Codex re-check R1)', (cmd) => {
    expect(decide(cmd, two)).toContain('already booted');
  });

  it('a leading assignment among others, or after export, still carries it', () => {
    expect(decide('FOO=1 ALLOW_EXTRA_SIMULATOR=1 xcrun simctl boot X', never)).toBeNull();
    expect(decide('export FOO=1 ALLOW_EXTRA_SIMULATOR=1 && xcrun simctl boot X', never)).toBeNull();
    expect(decide('FOO="bar" ALLOW_EXTRA_SIMULATOR=1 xcrun simctl boot X', never)).toBeNull();
    expect(decide('ALLOW_EXTRA_SIMULATOR="1" xcrun simctl boot X', never)).toBeNull();
  });

  it.each([
    'echo "unterminated; xcodebuild test -scheme App',
    "echo 'unterminated\nxcodebuild test -scheme App",
    'cat <<EOF\nxcodebuild test -scheme App',
  ])('a malformed command is also checked raw, so it denies: %j', (cmd) => {
    expect(decide(cmd, never)).toContain('-parallel-testing-enabled NO');
  });

  it('a malformed command never skips the cap', () => {
    expect(decide('cat <<EOF\nxcrun simctl boot X', two)).toContain('already booted');
  });
});

describe('US-71 AC6 wiring: the hook runs as settings.json calls it', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'));
  const command: string = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash')
    .hooks.find((h: { command: string }) => h.command.includes('simulator-guard.cjs')).command;
  const run = (cmd: string) => spawnSync('bash', ['-c', command], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });

  it('denies an xcodebuild test without the flag as JSON', () => {
    const r = run('xcodebuild test -scheme App');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('says nothing for an ordinary command', () => {
    const r = run('ls -la');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
