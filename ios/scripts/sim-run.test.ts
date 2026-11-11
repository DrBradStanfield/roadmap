// US-71 AC7: one shared simulator under a kernel lock (ios/scripts/sim-run.sh). Fake xcrun and
// xcodebuild on PATH, so nothing boots: the fakes keep the device's state in a file and log every call.
// Every test checks what a caller sees: who runs, who waits, exit codes, what reaches xcodebuild.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// SIM_RUN_SCRIPT runs these tests against another copy (how the old lease was shown to fail them).
const SCRIPT = process.env.SIM_RUN_SCRIPT ?? join(__dirname, 'sim-run.sh');
const UDID = '11111111-2222-3333-4444-555555555555';
const OTHER = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const XCRUN = `#!/bin/bash
echo "$*" >> "$FAKE/xcrun.log"
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
  bootstatus) echo Booted > "$FAKE/state";;
  shutdown) echo Shutdown > "$FAKE/state";;
esac
`;
const XCODEBUILD = '#!/bin/bash\necho "$*" >> "$FAKE/xcodebuild.log"\n';

let dir: string, fake: string, home: string, work: string;
const keepers: number[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sim-run-test-'));
  fake = join(dir, 'fake');
  home = join(dir, 'home');
  work = join(dir, 'work');
  mkdirSync(fake);
  mkdirSync(work);
  writeFileSync(join(fake, 'xcrun'), XCRUN, { mode: 0o755 });
  writeFileSync(join(fake, 'xcodebuild'), XCODEBUILD, { mode: 0o755 });
});
afterEach(() => {
  // A test's hold keeper must not outlive it.
  for (const pid of keepers.splice(0)) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE: fake, HR_SIM_HOME: home, HR_SIM_LEASE: '',
  HR_SIM_IDLE_SECONDS: '0', ...extra,
});
const run = (args: string[], extra: Record<string, string> = {}, cwd = work) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: env(extra), timeout: 30_000, cwd });
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
const hold = (args: string[] = [], extra: Record<string, string> = {}, cwd = work) => {
  const r = run(['hold', ...args], extra, cwd);
  if (r.status === 0) keepers.push(Number(info('pid')));
  return r;
};

describe('US-71 AC7 lock: who runs and who waits', () => {
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

  it('a holder killed outright frees the lock: the next caller runs', async () => {
    const a = start(['--', 'sleep', '30']);
    await until(busy);
    a.p.kill('SIGKILL');
    await a.done;
    expect(run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '5' }).status).toBe(0);
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

  it('stops a run at the whole-run time limit with exit 124 and frees the lock', async () => {
    const t = Date.now();
    const r = run(['--', 'sleep', '20'], { HR_SIM_RUN_LIMIT_SECONDS: '1' });
    expect(r.status).toBe(124);
    expect(r.stderr).toContain('stopped at the time limit (1s');
    expect(Date.now() - t).toBeLessThan(8000);
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

describe('US-71 AC7 xcodebuild on the shared device', () => {
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

  it.each([
    [['-destination', 'platform=iOS Simulator,name=iPhone 17 Pro']],
    [['-destination', `id=${OTHER}`, '-destination', 'id={udid}']],
    [['-destination', 'id={udid}', '-destination', `platform=iOS Simulator,id=${OTHER}`]],
    [['-parallel-testing-enabled', 'YES']],
    [['-parallel-testing-enabled', 'NO', '-parallel-testing-enabled', 'YES']],
    [['-maximum-concurrent-test-simulator-destinations', '2']],
  ])('refuses %j without running xcodebuild', (flags) => {
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

describe('US-71 AC7 idle shutdown', () => {
  it('shuts the device down after the idle time with no holder, and the sleeper never holds the lock', async () => {
    run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '2' });
    expect(busy()).toBe(false);
    await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 6000);
  });

  it('leaves it booted when another run ended since', async () => {
    run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
    run(['--', 'true']);
    await sleep(2000);
    expect(log('xcrun.log')).not.toContain('shutdown');
  });

  it('leaves it booted while someone holds it', async () => {
    run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
    const a = start(['--', 'sleep', '3']);
    await sleep(2000);
    expect(log('xcrun.log')).not.toContain('shutdown');
    await a.done;
  });
});

describe('US-71 AC7 hold and release (the iOS Simulator MCP tool, demos)', () => {
  it('hold boots the device, prints the exports, makes others wait, lets its own token in, and release frees it', () => {
    const h = hold();
    expect(h.status).toBe(0);
    expect(h.stdout).toMatch(new RegExp(`^export HR_SIM_LEASE=\\S+\\nexport SIM_UDID=${UDID}\\n$`));
    expect(log('xcrun.log')).toContain(`simctl bootstatus ${UDID} -b`);
    const w = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '1' });
    expect(w.status).toBe(75);
    expect(w.stderr).toMatch(/held until \d\d:\d\d by a session in .*work/);
    const token = h.stdout.match(/HR_SIM_LEASE=(\S+)/)![1];
    const mine = run(['--', 'sh', '-c', 'echo under-hold'], { HR_SIM_LEASE: token, HR_SIM_WAIT_SECONDS: '1' });
    expect(mine.status).toBe(0);
    expect(mine.stdout).toContain('under-hold');
    expect(run(['release']).status).toBe(0);
    expect(busy()).toBe(false);
  });

  it('a keeper killed outright frees the lock: the next caller runs', async () => {
    hold();
    const keeper = Number(info('pid'));
    process.kill(keeper, 'SIGKILL');
    await until(() => !alive(keeper), 3000);
    expect(run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '5' }).status).toBe(0);
  });

  it('a forgotten hold frees itself after HR_SIM_HOLD_SECONDS', async () => {
    hold([], { HR_SIM_HOLD_SECONDS: '1' });
    expect(busy()).toBe(true);
    await until(() => !busy(), 6000);
  });

  it('hold again from the same folder renews it; from another folder it waits', async () => {
    hold([], { HR_SIM_HOLD_SECONDS: '2' });
    const first = Number(info('until'));
    await sleep(1100);
    const again = run(['hold'], { HR_SIM_HOLD_SECONDS: '2' });
    expect(again.status).toBe(0);
    expect(again.stderr).toContain('renewed');
    expect(Number(info('until'))).toBeGreaterThan(first);
    const other = join(dir, 'other');
    mkdirSync(other);
    expect(run(['hold'], { HR_SIM_WAIT_SECONDS: '1' }, other).status).toBe(75);
  });

  it('hold --demo makes others wait with "held for a demo until HH:MM", and status shows who and until when', () => {
    hold(['--demo']);
    const w = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '1' });
    expect(w.stderr).toMatch(/held for a demo until \d\d:\d\d \(.*work\)/);
    expect(w.stderr).not.toContain('--force');
    expect(run(['status']).stdout).toMatch(/Holder: held for a demo until \d\d:\d\d \(.*work\), pid \d+ \(running\)/);
  });

  it('release refuses a running command and another folder\'s hold, without naming --force', async () => {
    const a = start(['--', 'sleep', '3']);
    await until(busy);
    const r1 = run(['release']);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('it is freed when that command ends');
    await a.done;
    hold();
    const other = join(dir, 'other');
    mkdirSync(other);
    const r2 = run(['release'], {}, other);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('release it from there');
    expect(r2.stderr).not.toContain('--force');
    expect(busy()).toBe(true);
    expect(run(['release', '--force'], {}, other).status).toBe(0);
    expect(busy()).toBe(false);
  });

  it('release signals nothing when ps cannot confirm the keeper, and a failing ps never frees a holder', () => {
    hold();
    writeFileSync(join(fake, 'ps'), '#!/bin/bash\ncase "$*" in *lstart*) exit 1;; esac\nexec /bin/ps "$@"\n', { mode: 0o755 });
    const r = run(['release']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot confirm');
    expect(busy()).toBe(true);
    expect(run(['status']).stdout).toMatch(/pid \d+ \(running\)/);
  });

  it('release with nothing held says so and succeeds', () => {
    const r = run(['release']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('nothing holds the simulator');
  });
});

describe('US-71 AC7 status', () => {
  it('names the holder and kills nothing', async () => {
    const a = start(['--', 'sleep', '2']);
    await until(busy);
    const r = run(['status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Holder: in use by pid \d+ .*: sleep 2 , pid \d+ \(running\)/);
    expect(r.stdout).toContain('Simulator-runtime processes:');
    expect((await a.done).code).toBe(0);
  });
});
