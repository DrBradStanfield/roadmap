// US-71 AC7: one shared simulator under a lease (ios/scripts/sim-run.sh). Fake xcrun and xcodebuild
// on PATH, so nothing boots: the fakes keep the device's state in a file and log every call.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, 'sim-run.sh');
const UDID = '11111111-2222-3333-4444-555555555555';
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

let dir: string, fake: string, home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sim-run-test-'));
  fake = join(dir, 'fake');
  home = join(dir, 'home');
  mkdirSync(fake);
  writeFileSync(join(fake, 'xcrun'), XCRUN, { mode: 0o755 });
  writeFileSync(join(fake, 'xcodebuild'), XCODEBUILD, { mode: 0o755 });
});
afterEach(() => {
  // A test's hold keeper must not outlive it.
  const h = join(home, 'lease', 'holder');
  const pid = existsSync(h) && readFileSync(h, 'utf8').includes('command=hold') && readFileSync(h, 'utf8').match(/^pid=(\d+)/m)?.[1];
  if (pid) try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE: fake, HR_SIM_HOME: home, HR_SIM_LEASE: '',
  HR_SIM_POLL_SECONDS: '0.1', HR_SIM_IDLE_SECONDS: '0', ...extra,
});
const run = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: env(extra), timeout: 20_000 });
const start = (args: string[], extra: Record<string, string> = {}) => {
  const p = spawn('bash', [SCRIPT, ...args], { env: env(extra) });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise<{ code: number | null; err: string }>((res) => p.on('exit', (code) => res({ code, err })));
  return { p, done };
};
const log = (name: string) => (existsSync(join(fake, name)) ? readFileSync(join(fake, name), 'utf8') : '');
const lease = () => join(home, 'lease');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return;
  throw new Error('timed out waiting');
};
const holder = (pid: number) => {
  mkdirSync(lease(), { recursive: true });
  writeFileSync(join(lease(), 'holder'), `pid=${pid}\nlstart=\ntoken=${pid}-1\nstarted=${Math.floor(Date.now() / 1000)}\ncwd=/elsewhere\ncommand=xcodebuild test\n`);
};

describe('US-71 AC7 lease', () => {
  it('runs the command on the shared device, creating and booting it once, and frees the lease', () => {
    const r = run(['--', 'sh', '-c', 'echo "udid=$SIM_UDID"; test -d "$HR_SIM_HOME/lease"']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`udid=${UDID}`);
    expect(log('xcrun.log')).toContain('simctl create HR Shared iPhone com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-2\n');
    expect(log('xcrun.log')).toContain(`simctl bootstatus ${UDID} -b`);
    expect(existsSync(lease())).toBe(false);
    expect(readFileSync(join(home, 'udid'), 'utf8').trim()).toBe(UDID);
    // The second run reuses the booted device: no new create, no boot.
    writeFileSync(join(fake, 'xcrun.log'), '');
    expect(run(['--', 'true']).status).toBe(0);
    expect(log('xcrun.log')).not.toMatch(/create|bootstatus/);
  });

  it('frees the lease when the command fails, and returns its exit code', () => {
    const r = run(['--', 'sh', '-c', 'exit 3']);
    expect(r.status).toBe(3);
    expect(existsSync(lease())).toBe(false);
  });

  it('makes a second caller wait, naming the holder, then run', async () => {
    const a = start(['--', 'sleep', '1']);
    await until(() => existsSync(join(lease(), 'holder')));
    const b = start(['--', 'true']);
    const rb = await b.done;
    expect(rb.code).toBe(0);
    expect(rb.err).toMatch(/in use by pid \d+ for \d+m\d+s \(.*\): sleep 1/);
    expect((await a.done).code).toBe(0);
  });

  it('gives up after the wait limit with exit 75, naming the holder', async () => {
    const a = start(['--', 'sleep', '3']);
    await until(() => existsSync(join(lease(), 'holder')));
    const r = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '1' });
    expect(r.status).toBe(75);
    expect(r.stderr).toMatch(/gave up after 1s: the simulator is still held by pid \d+ .*: sleep 3/);
    a.p.kill('SIGTERM');
    await a.done;
  });

  it('takes over a lease whose holder has died', () => {
    holder(spawnSync('true').pid!);
    const r = run(['--', 'true']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('took over a stale lease');
    expect(existsSync(lease())).toBe(false);
  });

  it('takes over a lease whose pid now belongs to another process (start time differs)', () => {
    holder(process.pid);
    writeFileSync(join(lease(), 'holder'), readFileSync(join(lease(), 'holder'), 'utf8').replace('lstart=', 'lstart=Thu Jan  1 00:00:00 1970'));
    expect(run(['--', 'true']).stderr).toContain('took over a stale lease');
  });

  it('on SIGTERM stops the command and frees the lease', async () => {
    const pidFile = join(dir, 'child.pid');
    const a = start(['--', 'sh', '-c', `echo $$ > ${pidFile}; exec sleep 30`]);
    await until(() => existsSync(pidFile) && existsSync(join(lease(), 'holder')));
    a.p.kill('SIGTERM');
    expect((await a.done).code).toBe(143);
    expect(existsSync(lease())).toBe(false);
    const child = Number(readFileSync(pidFile, 'utf8'));
    await until(() => spawnSync('kill', ['-0', String(child)]).status !== 0, 3000);
  });

  it('a call from inside a run uses the lease it holds instead of waiting on itself', () => {
    const r = run(['--', 'bash', SCRIPT, '--', 'sh', '-c', 'echo inner'], { HR_SIM_WAIT_SECONDS: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('inner');
  });
});

describe('US-71 AC7 xcodebuild on the shared device', () => {
  it('adds the device, no parallel testing, one destination and a time limit to a test run', () => {
    expect(run(['--', 'xcodebuild', 'test', '-scheme', 'HealthRoadmap']).status).toBe(0);
    expect(log('xcodebuild.log').trim()).toBe(
      `test -scheme HealthRoadmap -destination id=${UDID} -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1`);
  });

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

  it.each([['-destination', 'platform=iOS Simulator,name=iPhone 17 Pro'], ['-parallel-testing-enabled', 'YES']])(
    'refuses %s %s without running xcodebuild', (flag, value) => {
      const r = run(['--', 'xcodebuild', 'test', flag, value]);
      expect(r.status).toBe(64);
      expect(log('xcodebuild.log')).toBe('');
    });

  it('build-for-testing does not boot the device', () => {
    run(['--', 'xcodebuild', 'build-for-testing', '-scheme', 'HealthRoadmap']);
    expect(log('xcrun.log')).not.toContain('bootstatus');
  });

  it('--reset-app uninstalls the app (bundle id from the project) before the command', () => {
    run(['--reset-app', '--', 'xcrun', 'simctl', 'launch', '{udid}', 'x']);
    expect(log('xcrun.log')).toMatch(new RegExp(`simctl uninstall ${UDID} com\\.drstanfield\\.healthroadmap\\n.*simctl launch ${UDID} x`, 's'));
  });
});

describe('US-71 AC7 idle shutdown', () => {
  it('shuts the device down after the idle time with no lease', async () => {
    run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
    await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 5000);
    // The sleeper holds the lease while it shuts the device down, then frees it.
    await until(() => !existsSync(lease()), 3000);
  });

  it('leaves it booted when another run released since', async () => {
    run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
    run(['--', 'true']);
    await sleep(2000);
    expect(log('xcrun.log')).not.toContain('shutdown');
  });

  it('leaves it booted while a run holds the lease', async () => {
    run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
    holder(process.pid);
    await sleep(2000);
    expect(log('xcrun.log')).not.toContain('shutdown');
    expect(readFileSync(join(lease(), 'holder'), 'utf8')).toContain(`pid=${process.pid}`);
  });
});

describe('US-71 AC7 hold and release (for the iOS Simulator MCP tool)', () => {
  const field = (name: string) => readFileSync(join(lease(), 'holder'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1];
  const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0;

  it('hold boots the device, prints its UDID and leaves a live keeper holding the lease; others wait; release frees it', async () => {
    const h = run(['hold']);
    expect(h.status).toBe(0);
    expect(h.stdout.trim()).toBe(UDID);
    expect(log('xcrun.log')).toContain(`simctl bootstatus ${UDID} -b`);
    const keeper = Number(field('pid'));
    expect(keeper).not.toBe(h.pid);
    expect(alive(keeper)).toBe(true);
    expect(field('command')).toMatch(/^hold/);
    const w = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '1' });
    expect(w.status).toBe(75);
    expect(w.stderr).toMatch(new RegExp(`held by pid ${keeper} .*: hold`));
    const r = run(['release']);
    expect(r.status).toBe(0);
    expect(existsSync(lease())).toBe(false);
    await until(() => !alive(keeper), 3000);
  });

  it('a keeper killed without releasing is taken over like any dead holder', async () => {
    run(['hold']);
    const keeper = Number(field('pid'));
    process.kill(keeper, 'SIGKILL');
    await until(() => !alive(keeper), 3000);
    const r = run(['--', 'true']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`took over a stale lease (pid ${keeper} is gone)`);
  });

  it('a forgotten hold frees itself after HR_SIM_HOLD_SECONDS', async () => {
    run(['hold'], { HR_SIM_HOLD_SECONDS: '1' });
    expect(existsSync(lease())).toBe(true);
    await until(() => !existsSync(lease()), 5000);
  });

  it('release refuses a running command\'s lease and another folder\'s hold (unless --force)', () => {
    holder(process.pid);
    expect(run(['release']).stderr).toContain('it frees itself when that ends');
    expect(existsSync(lease())).toBe(true);
    rmSync(lease(), { recursive: true });
    run(['hold']);
    const elsewhere = spawnSync('bash', [SCRIPT, 'release'], { encoding: 'utf8', env: env(), cwd: dir });
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toContain('release it there, or add --force');
    expect(spawnSync('bash', [SCRIPT, 'release', '--force'], { encoding: 'utf8', env: env(), cwd: dir }).status).toBe(0);
    expect(existsSync(lease())).toBe(false);
  });

  it('release with nothing held says so and succeeds', () => {
    const r = run(['release']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no lease is held');
  });
});

describe('US-71 AC7 demo (fresh-sim.sh)', () => {
  it('frees the lease, keeps the device booted with no idle shutdown, and status says so; the next lease clears it', async () => {
    const r = run(['--', 'true'], { HR_SIM_DEMO: '1', HR_SIM_IDLE_SECONDS: '1' });
    expect(r.status).toBe(0);
    expect(existsSync(lease())).toBe(false);
    expect(run(['status']).stdout).toContain('kept booted for a demo');
    await sleep(2000);
    expect(log('xcrun.log')).not.toContain('shutdown');
    run(['--', 'true']);
    expect(existsSync(join(home, 'demo'))).toBe(false);
    expect(run(['status']).stdout).not.toContain('kept booted for a demo');
  });
});

describe('US-71 AC7 status', () => {
  it('names the holder and kills nothing', () => {
    holder(process.pid);
    const r = run(['status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Lease: held by pid ${process.pid} (running)`);
    expect(r.stdout).toContain('/elsewhere: xcodebuild test');
    expect(r.stdout).toContain('Simulator-runtime processes:');
    expect(existsSync(lease())).toBe(true);
  });
});
