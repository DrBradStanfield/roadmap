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
  ])('denies %s', (cmd) => {
    const reason = decide(cmd, never);
    expect(reason).toContain('-parallel-testing-enabled NO');
    expect(reason).toContain("perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild");
  });

  it.each([
    "perl -e 'alarm shift; exec @ARGV' 1200 xcodebuild test -scheme App -parallel-testing-enabled NO",
    'xcodebuild -scheme App \\\n  -parallel-testing-enabled NO \\\n  test-without-building',
    'xcodebuild build -scheme App',
    'xcodebuild build-for-testing -scheme App',
    'pgrep -fl xcodebuild',
    'npm test && xcodebuild build -scheme App',
    'grep xcodebuild test.log',
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

  it('allows a boot with one booted or none', () => {
    expect(decide('xcrun simctl boot BBBB', one)).toBeNull();
    expect(decide('xcrun simctl boot BBBB', () => [])).toBeNull();
  });

  it('allows the escape hatch ALLOW_EXTRA_SIMULATOR=1 without asking simctl', () => {
    expect(decide('ALLOW_EXTRA_SIMULATOR=1 xcrun simctl boot CCCC', never)).toBeNull();
  });

  it('fails open when the booted check fails or times out', () => {
    expect(decide('xcrun simctl boot CCCC', () => null)).toBeNull();
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
