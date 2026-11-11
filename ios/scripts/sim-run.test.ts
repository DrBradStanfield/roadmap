// US-71 AC7: one shared simulator under a kernel lock (ios/scripts/sim-run.sh). Fake xcrun and
// xcodebuild on PATH, so nothing boots: the fakes keep the device's state in a file and log every call.
// Every test checks what a caller sees: who runs, who waits, exit codes, what reaches xcodebuild.
// macOS only (lockf, BSD stat and date): CI runs Linux, so these run locally:
//   npx vitest run ios/scripts/sim-run.test.ts
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// SIM_RUN_SCRIPT runs these tests against another copy (how an older version was shown to fail them).
const SCRIPT = process.env.SIM_RUN_SCRIPT ?? join(__dirname, 'sim-run.sh');
const UDID = '11111111-2222-3333-4444-555555555555';
const OTHER = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const XCRUN = `#!/bin/bash
echo "$*" >> "$FAKE/xcrun.log"
while [ "\${1#-}" != "$1" ]; do case "$1" in --sdk|-sdk) shift 2;; *) shift;; esac; done
[ "$1" = xcodebuild ] && { shift; exec xcodebuild "$@"; }
[ "$1" = simctl ] || exit 0
shift
case "$1" in
  list)
    if [ "$2" = runtimes ]; then
      echo "iOS 27.0 (27.0 - A) - com.apple.CoreSimulator.SimRuntime.iOS-27-0"
      echo "iOS 27.2 (27.2 - B) - com.apple.CoreSimulator.SimRuntime.iOS-27-2"
      echo "iOS 27.2 (27.2 - C) - com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4"
      exit 0
    fi
    echo "== Devices =="
    if [ -f "$FAKE/udid" ]; then
      st=$(cat "$FAKE/state")
      [ "\${3:-}" = booted ] && [ "$st" != Booted ] || echo "    HR Shared iPhone ($(cat "$FAKE/udid")) ($st) "
    fi;;
  create) echo ${UDID} > "$FAKE/udid"; echo Shutdown > "$FAKE/state"; echo ${UDID};;
  bootstatus) [ -f "$FAKE/hang-boot" ] && { echo $$ > "$FAKE/boot.pid"; exec sleep 60; }; echo Booted > "$FAKE/state";;
  shutdown) echo Shutdown > "$FAKE/state";;
esac
`;
const XCODEBUILD = '#!/bin/bash\necho "$*" >> "$FAKE/xcodebuild.log"\n';
// The load guard's inputs. sysctl reads $FAKE/loads, one 1-minute load per call, staying on the last
// line ("fail" exits 1); ps prints $FAKE/ps. Every test starts at load 1 with no Codex review running.
const SYSCTL = `#!/bin/bash
echo "$*" >> "$FAKE/sysctl.log"
l=$(head -1 "$FAKE/loads")
[ "$(wc -l < "$FAKE/loads")" -gt 1 ] && sed -i '' 1d "$FAKE/loads"
[ "$l" = fail ] && exit 1
echo "{ $l 1.00 1.00 }"
`;
const PS = '#!/bin/bash\ncat "$FAKE/ps.txt"\n';

let dir: string, fake: string, home: string, work: string;
const setLoads = (...loads: string[]) => writeFileSync(join(fake, 'loads'), `${loads.join('\n')}\n`);
const setPs = (lines: string[]) => writeFileSync(join(fake, 'ps.txt'), ['    1 /sbin/launchd', ...lines].join('\n') + '\n');
const CODEX = '  101 /opt/homebrew/bin/node /Users/x/repo/tools/codex-review.mjs --base main';
const CODEX2 = '  102 node tools/codex-review.mjs';
const DECOYS = [
  "  103 /bin/bash -c cd /x && node tools/codex-review.mjs --base main",
  '  104 node /x/tools/codex-review.mjs --codex /tmp/fake-codex',
];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sim-run-test-'));
  fake = join(dir, 'fake');
  home = join(dir, 'home');
  work = join(dir, 'work');
  mkdirSync(fake);
  mkdirSync(work);
  writeFileSync(join(fake, 'xcrun'), XCRUN, { mode: 0o755 });
  writeFileSync(join(fake, 'xcodebuild'), XCODEBUILD, { mode: 0o755 });
  writeFileSync(join(fake, 'sysctl'), SYSCTL, { mode: 0o755 });
  writeFileSync(join(fake, 'ps'), PS, { mode: 0o755 });
  writeFileSync(join(fake, 'loads'), '1.00\n');
  setPs([]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE: fake, HR_SIM_HOME: home, HR_SIM_LEASE: '',
  HR_SIM_IDLE_SECONDS: '0', ...extra,
});
const run = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: env(extra), timeout: 30_000, cwd: work });
const start = (args: string[], extra: Record<string, string> = {}) => {
  const p = spawn('bash', [SCRIPT, ...args], { env: env(extra), cwd: work });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise<{ code: number | null; err: string }>((res) => p.on('exit', (code) => res({ code, err })));
  return { p, done };
};
const log = (name: string) => (existsSync(join(fake, name)) ? readFileSync(join(fake, name), 'utf8') : '');
const info = (name: string) => readFileSync(join(home, 'holder'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return;
  throw new Error('timed out waiting');
};
const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0;
/** True while the lock is taken: lockf on the lock file cannot take it at once (75). Changes nothing. */
const busy = () => existsSync(join(home, 'lock'))
  && spawnSync('/bin/bash', ['-c', 'exec 9>>"$1"; lockf -s -t 0 9', '_', join(home, 'lock')]).status === 75;

describe.skipIf(process.platform !== 'darwin')('US-71 AC7 sim-run.sh (macOS: lockf)', () => {
  describe('lock: who runs and who waits', () => {
    it('runs the command on the shared device, creating and booting it once, and frees the lock', () => {
      const r = run(['--', 'sh', '-c', 'echo "udid=$SIM_UDID"']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`udid=${UDID}`);
      expect(log('xcrun.log')).toContain('simctl create HR Shared iPhone com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-2\n');
      expect(log('xcrun.log')).toContain(`simctl bootstatus ${UDID} -b`);
      expect(busy()).toBe(false);
      writeFileSync(join(fake, 'xcrun.log'), '');
      expect(run(['--', 'true']).status).toBe(0);
      expect(log('xcrun.log')).not.toMatch(/create|bootstatus/);
    });

    it('returns the command\'s exit code, 75 included, and frees the lock when it fails', () => {
      expect(run(['--', 'sh', '-c', 'exit 3']).status).toBe(3);
      const r = run(['--', 'sh', '-c', 'exit 75']);
      expect(r.status).toBe(75);
      expect(r.stderr).not.toContain('gave up');
      expect(busy()).toBe(false);
    });

    it('makes a second caller wait, naming the holder, then run', async () => {
      const a = start(['--', 'sleep', '1']);
      await until(busy);
      const b = start(['--', 'true']);
      const rb = await b.done;
      expect(rb.code).toBe(0);
      expect(rb.err).toMatch(/in use by pid \d+ for \d+m\d+s \(.*\): sleep 1/);
      expect((await a.done).code).toBe(0);
    });

    it('gives up after the wait limit with exit 75, naming the holder', async () => {
      const a = start(['--', 'sleep', '5']);
      await until(busy);
      const r = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(75);
      expect(r.stderr).toMatch(/gave up after 1s: the simulator is still in use by pid \d+ .*: sleep 5/);
      a.p.kill('SIGTERM');
      await a.done;
    });

    it('on SIGTERM keeps the lock until the command is gone, killing one that ignores TERM', async () => {
      const pidFile = join(dir, 'child.pid');
      const a = start(['--', 'sh', '-c', `trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 0.1; done`], { HR_SIM_KILL_SECONDS: '2' });
      await until(() => existsSync(pidFile) && busy());
      const child = Number(readFileSync(pidFile, 'utf8'));
      a.p.kill('SIGTERM');
      await sleep(1000);
      expect(alive(child)).toBe(true);
      expect(busy()).toBe(true);
      expect((await a.done).code).toBe(143);
      expect(alive(child)).toBe(false);
      expect(busy()).toBe(false);
    });

    it('when the wrapper is killed outright (SIGKILL), the command is stopped first, and only then is the lock free', async () => {
      const pidFile = join(dir, 'child.pid');
      const a = start(['--', 'sh', '-c', `trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 0.1; done`],
        { HR_SIM_KILL_SECONDS: '2', HR_SIM_IDLE_SECONDS: '1' });
      await until(() => existsSync(pidFile) && busy());
      const child = Number(readFileSync(pidFile, 'utf8'));
      a.p.kill('SIGKILL');
      await a.done;
      await sleep(1000);
      expect(alive(child)).toBe(true);
      expect(busy()).toBe(true);
      await until(() => !alive(child), 6000);
      await until(() => !busy(), 3000);
      // The shim arms the idle shutdown the dead wrapper could not.
      await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 8000);
    });

    it('stops a run at the whole-run time limit with exit 124 and frees the lock', () => {
      const t = Date.now();
      const r = run(['--', 'sleep', '20'], { HR_SIM_RUN_LIMIT_SECONDS: '1' });
      expect(r.status).toBe(124);
      expect(r.stderr).toContain('stopped at the time limit (1s');
      expect(Date.now() - t).toBeLessThan(8000);
      expect(busy()).toBe(false);
    });

    it('the time limit also stops a hung boot, before the command starts', async () => {
      run(['--', 'true']);
      writeFileSync(join(fake, 'state'), 'Shutdown');
      writeFileSync(join(fake, 'hang-boot'), '');
      const r = run(['--', 'xcodebuild', 'test'], { HR_SIM_RUN_LIMIT_SECONDS: '1', HR_SIM_KILL_SECONDS: '1' });
      expect(r.status).toBe(124);
      const boot = Number(readFileSync(join(fake, 'boot.pid'), 'utf8'));
      expect(alive(boot)).toBe(false);
      expect(log('xcodebuild.log')).toBe('');
      expect(busy()).toBe(false);
    });

    it('a call from inside a run uses the lock it is under instead of waiting on itself', () => {
      const r = run(['--', 'bash', SCRIPT, '--', 'sh', '-c', 'echo inner'], { HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('inner');
    });

    it('a script that re-runs itself through sim-run (ui-test.sh\'s first line) runs once, under the lock', async () => {
      const script = join(dir, 'self.sh');
      writeFileSync(script, `#!/bin/sh\n[ "\${HR_SIM_INNER:-}" = "$$" ] || exec bash ${SCRIPT} -- "$0"\necho ran >> ${dir}/count\nsleep 1\n`, { mode: 0o755 });
      const a = spawn(script, [], { env: env({ HR_SIM_INNER: '1' }), cwd: work });
      const done = new Promise((res) => a.on('exit', res));
      await until(busy);
      await done;
      expect(readFileSync(join(dir, 'count'), 'utf8')).toBe('ran\n');
    });

    it('an old token from a finished run does not skip the lock', async () => {
      run(['--', 'true']);
      const old = info('token');
      const a = start(['--', 'sleep', '3']);
      await until(busy);
      expect(run(['--', 'true'], { HR_SIM_LEASE: old, HR_SIM_WAIT_SECONDS: '1' }).status).toBe(75);
      a.p.kill('SIGTERM');
      await a.done;
    });
  });

  describe('xcodebuild on the shared device', () => {
    it('pins the command line test.sh gets: -parallel-testing-enabled NO and -maximum-concurrent-test-simulator-destinations 1, once each', () => {
      run(['--', 'xcodebuild', 'test', '-project', 'HealthRoadmap.xcodeproj', '-scheme', 'HealthRoadmap',
        '-skip-testing:HealthRoadmapUITests', '-derivedDataPath', '/tmp/dd']);
      run(['--', 'xcodebuild', 'test-without-building', '-scheme', 'HealthRoadmap', '-maximum-concurrent-test-simulator-destinations', '1']);
      expect(log('xcodebuild.log').trim().split('\n')).toEqual([
        'test -project HealthRoadmap.xcodeproj -scheme HealthRoadmap -skip-testing:HealthRoadmapUITests -derivedDataPath /tmp/dd '
          + `-destination id=${UDID} -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1`,
        'test-without-building -scheme HealthRoadmap -maximum-concurrent-test-simulator-destinations 1 '
          + `-destination id=${UDID} -parallel-testing-enabled NO`,
      ]);
    });

    it('keeps the flags it is given and replaces {udid}', () => {
      run(['--', 'xcodebuild', 'test-without-building', '-destination', 'id={udid}', '-parallel-testing-enabled', 'NO']);
      expect(log('xcodebuild.log').trim()).toBe(
        `test-without-building -destination id=${UDID} -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1`);
    });

    // review R4: only id=<the shared UDID>, generic/..., or a physical device (platform=iOS,id=...).
    it.each([
      ['id={udid}', true],
      ['generic/platform=iOS Simulator', true],
      ['generic/platform=iOS', true],
      ['platform=iOS,id=00008110-001A2B3C4D5E801E', true],
      ['name=iPhone 18 Pro', false],
      ['platform=iOS Simulator,name=iPhone 17 Pro', false],
      ['platform=iOS Simulator,id={udid}', true],
      ['platform=iOS,name=Brad iPhone', false],
      ['platform=iOS,id=00008110-001A2B3C4D5E801E,name=X', false],
      [`id=${OTHER}`, false],
      ['platform=macOS', false],
    ])('-destination %s: allowed %s', (dest, allowed) => {
      const r = run(['--', 'xcodebuild', 'build', '-destination', dest]);
      expect(r.status).toBe(allowed ? 0 : 64);
      expect(log('xcodebuild.log') !== '').toBe(allowed);
    });

    it.each([
      [['-destination', `id=${OTHER}`, '-destination', 'id={udid}']],
      [['-destination', 'id={udid}', '-destination', 'name=iPhone']],
      [['-parallel-testing-enabled', 'YES']],
      [['-parallel-testing-enabled', 'NO', '-parallel-testing-enabled', 'YES']],
      [['-maximum-concurrent-test-simulator-destinations', '2']],
    ])('refuses %j anywhere on the line without running xcodebuild', (flags) => {
      const r = run(['--', 'xcodebuild', 'test', ...flags]);
      expect(r.status).toBe(64);
      expect(log('xcodebuild.log')).toBe('');
    });

    it('leaves a physical device or generic destination alone, and does not boot for it', () => {
      run(['--', 'xcodebuild', 'build-for-testing', '-destination', 'platform=iOS,id=00008110-001A2B3C4D5E801E']);
      run(['--', 'xcodebuild', 'build-for-testing', '-destination', 'generic/platform=iOS Simulator']);
      expect(log('xcodebuild.log').trim().split('\n')).toEqual([
        'build-for-testing -destination platform=iOS,id=00008110-001A2B3C4D5E801E -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1',
        'build-for-testing -destination generic/platform=iOS Simulator -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1',
      ]);
      expect(log('xcrun.log')).not.toContain('bootstatus');
    });

    // review A5: xcodebuild behind words that pass a command on still gets the device and the flags.
    it.each([
      [['env', 'FOO=1', 'xcodebuild', 'test']],
      [['FOO=1', 'BAR=2', 'xcodebuild', 'test']],
      [['/usr/bin/env', '-u', 'BAR', 'xcodebuild', 'test']],
      [['time', '-p', 'xcodebuild', 'test']],
      [['nohup', 'xcodebuild', 'test']],
      [['exec', 'xcodebuild', 'test']],
      [['command', 'xcodebuild', 'test']],
      [['nice', '-n', '5', 'xcodebuild', 'test']],
      [['xcrun', '--sdk', 'iphonesimulator', 'xcodebuild', 'test']],
      [['FAKE_XCRUN', 'xcodebuild', 'test']],
    ])('sees xcodebuild through %j', (cmd) => {
      const line = cmd.map((w) => (w === 'FAKE_XCRUN' ? join(fake, 'xcrun') : w));
      const r = run(['--', ...line]);
      expect(r.status).toBe(0);
      expect(log('xcodebuild.log').trim()).toBe(
        `test -destination id=${UDID} -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1`);
    });

    it('refuses xcodebuild inside a shell string, where it cannot add its flags', () => {
      const r = run(['--', 'bash', '-c', 'xcodebuild test -scheme App']);
      expect(r.status).toBe(64);
      expect(r.stderr).toContain('run xcodebuild directly through sim-run');
      expect(log('xcodebuild.log')).toBe('');
    });

    it('build-for-testing on the shared device does not boot it', () => {
      run(['--', 'xcodebuild', 'build-for-testing', '-scheme', 'HealthRoadmap']);
      expect(log('xcrun.log')).not.toContain('bootstatus');
    });

    it('--reset-app uninstalls the app and clears its simulator settings before the command', () => {
      run(['--reset-app', '--', 'xcrun', 'simctl', 'launch', '{udid}', 'x']);
      expect(log('xcrun.log')).toMatch(new RegExp(
        `simctl uninstall ${UDID} com\\.drstanfield\\.healthroadmap\\nsimctl spawn ${UDID} defaults delete com\\.drstanfield\\.healthroadmap\\n.*simctl launch ${UDID} x`, 's'));
    });
  });

  describe('idle shutdown', () => {
    it('shuts the device down after the idle time with no holder, and the sleeper never holds the lock', async () => {
      run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '2' });
      expect(busy()).toBe(false);
      await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 6000);
    });

    it('a probe holding the lock for a moment when the sleeper wakes does not cancel it', async () => {
      run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
      // The probe holds the lock from before the sleeper wakes (1 s) until 2 s; the sleeper waits it out.
      const probe = spawn('/bin/bash', ['-c', 'exec 9>>"$1"; lockf -s -t 0 9 && sleep 2', '_', join(home, 'lock')]);
      await until(busy);
      await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 7000);
      await new Promise((res) => (probe.exitCode !== null ? res(null) : probe.on('exit', res)));
    });

    it('leaves it booted when another run ended since', async () => {
      run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
      run(['--', 'true']);
      await sleep(2000);
      expect(log('xcrun.log')).not.toContain('shutdown');
    });

    it('leaves it booted while a run holds it', async () => {
      run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
      const a = start(['--', 'sleep', '8']);
      await sleep(7000);
      expect(log('xcrun.log')).not.toContain('shutdown');
      a.p.kill('SIGTERM');
      await a.done;
    });
  });

  describe('load guard', () => {
    const fast = { HR_SIM_GUARD_POLL_SECONDS: '0.2' };
    const tookLock = () => existsSync(join(home, 'holder'));

    it('at load 9 waits, then gives up with exit 75 in load-guard words, never taking the lock', () => {
      setLoads('9.00');
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '2' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('sim-run: waiting (load guard): 1-minute load 9.00 is over 8 (HR_SIM_IGNORE_LOAD=1 skips this)');
      expect(r.stderr).toMatch(/sim-run: gave up after 0m[23]s \(load guard, not the lock\): 1-minute load 9\.00 is over 8/);
      expect(r.stderr.match(/waiting \(load guard\)/g)).toHaveLength(1);
      expect(tookLock()).toBe(false);
      expect(log('xcrun.log')).toBe('');
    });

    it('takes HR_SIM_MAX_LOAD as a decimal', () => {
      setLoads('7.60');
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '1', HR_SIM_MAX_LOAD: '7.5' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('1-minute load 7.60 is over 7.5');
    });

    it('at load 7 with two real Codex reviews waits and names them', () => {
      setLoads('7.00');
      setPs([CODEX, CODEX2]);
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('sim-run: waiting (load guard): 2 Codex reviews running (HR_SIM_IGNORE_LOAD=1 skips this)');
      expect(tookLock()).toBe(false);
    });

    it('names both causes when both trip', () => {
      setLoads('12.40');
      setPs([CODEX, CODEX2]);
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(r.stderr).toContain('waiting (load guard): 1-minute load 12.40 is over 8; 2 Codex reviews running');
    });

    it('a bash -c line naming tools/codex-review.mjs and a --codex fake do not count', () => {
      setLoads('7.00');
      setPs([CODEX, ...DECOYS]);
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('load guard');
    });

    it('at load 7 with one Codex review proceeds', () => {
      setLoads('7.00');
      setPs([CODEX]);
      const r = run(['--', 'sh', '-c', 'echo ran'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ran');
    });

    it('proceeds when the guard clears mid-wait', () => {
      setLoads('9.00', '9.00', '9.00', '2.00');
      const r = run(['--', 'sh', '-c', 'echo ran'], { ...fast, HR_SIM_WAIT_SECONDS: '10' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ran');
      expect(r.stderr).toContain('waiting (load guard)');
    });

    it('when it trips again after taking the lock, lets the lock go (another caller can take it) and waits again', async () => {
      // Call 1 (before the lock) is clear; call 2 (after taking it) trips; it stays tripped until we clear it.
      setLoads('2.00', '9.00');
      const a = start(['--', 'sh', '-c', 'echo ran >> "$FAKE/ran"'], { ...fast, HR_SIM_WAIT_SECONDS: '20' });
      await until(() => log('sysctl.log').split('\n').length > 4);
      expect(busy()).toBe(false);
      expect(log('ran')).toBe('');
      // Another caller, skipping the guard, takes the device while the first one waits.
      expect(run(['--', 'sh', '-c', 'echo other >> "$FAKE/ran"'], { HR_SIM_IGNORE_LOAD: '1' }).status).toBe(0);
      setLoads('2.00');
      const ra = await a.done;
      expect(ra.code).toBe(0);
      expect(ra.err).toContain('waiting (load guard): 1-minute load 9.00 is over 8');
      expect(log('ran')).toBe('other\nran\n');
    });

    it('caps the guard wait plus the lock wait at the wait limit', async () => {
      const a = start(['--', 'sleep', '15']);
      await until(busy);
      // Trips at 0, 1 and 2 s, clears at 3 s; the lock then gets what is left of 4 s, not 4 s more.
      setLoads('9.00', '9.00', '9.00', '2.00');
      const t = Date.now();
      const r = run(['--', 'true'], { HR_SIM_GUARD_POLL_SECONDS: '1', HR_SIM_WAIT_SECONDS: '4' });
      const took = Date.now() - t;
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('waiting (load guard)');
      expect(r.stderr).toMatch(/gave up after 4s: the simulator is still in use/);
      expect(took).toBeGreaterThanOrEqual(3000);
      expect(took).toBeLessThan(6000);
      a.p.kill('SIGTERM');
      await a.done;
    });

    it('HR_SIM_IGNORE_LOAD=1 proceeds at any load', () => {
      setLoads('50.00');
      setPs([CODEX, CODEX2]);
      const r = run(['--', 'true'], { HR_SIM_IGNORE_LOAD: '1', HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('load guard');
      expect(log('sysctl.log')).toBe('');
    });

    it('status and a lease call skip it', () => {
      setLoads('9.00');
      const s = run(['status']);
      expect(s.status).toBe(0);
      expect(s.stderr).not.toContain('load guard');
      expect(log('sysctl.log')).toBe('');
      // The outer run reads the load twice (clear, clear); the inner lease call never reads it.
      setLoads('2.00', '2.00', '9.00');
      const r = run(['--', 'bash', SCRIPT, '--', 'sh', '-c', 'echo inner'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('inner');
      expect(log('sysctl.log').trim().split('\n')).toHaveLength(2);
    });

    it('an unreadable sysctl fails open with one line on stderr', () => {
      setLoads('fail');
      const r = run(['--', 'sh', '-c', 'echo ran'], fast);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ran');
      expect(r.stderr.match(/sim-run: load guard could not read the load; not waiting/g)).toHaveLength(1);
    });
  });

  describe('status', () => {
    it('names the holder and kills nothing', async () => {
      const a = start(['--', 'sleep', '2']);
      await until(busy);
      const r = run(['status']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Holder: in use by pid \d+ .*: sleep 2/);
      expect(r.stdout).toContain('Simulator-runtime processes:');
      expect((await a.done).code).toBe(0);
    });

    it('lists the demo device, its age and the command to shut it down', () => {
      run(['--', 'true']);
      writeFileSync(join(fake, 'xcrun'), XCRUN.replace('echo "== Devices =="', `echo "== Devices =="; echo "    HR Demo iPhone (${OTHER}) (Booted) "`), { mode: 0o755 });
      writeFileSync(join(home, 'demo-booted'), String(Math.floor(Date.now() / 1000) - 125));
      const r = run(['status']);
      expect(r.stdout).toContain(`Demo device: HR Demo iPhone (${OTHER}) Booted for 2m5s`);
      expect(r.stdout).toContain(`xcrun simctl shutdown ${OTHER}`);
    });
  });
});
