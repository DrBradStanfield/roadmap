// US-71 AC7: one shared simulator under a kernel lock (ios/scripts/sim-run.sh). Fake xcrun and
// xcodebuild on PATH, so nothing boots: the fakes keep the device's state in a file and log every call.
// Every test checks what a caller sees: who runs, who waits, exit codes, what reaches xcodebuild.
// macOS only (lockf, BSD stat and date): CI runs Linux, so these run locally:
//   npx vitest run ios/scripts/sim-run.test.ts
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
devset=""
[ "$1" = --set ] && { devset=$2; shift 2; }
case "$1" in
  list)
    if [ "$2" = runtimes ]; then
      echo "iOS 27.0 (27.0 - A) - com.apple.CoreSimulator.SimRuntime.iOS-27-0"
      echo "iOS 27.2 (27.2 - B) - com.apple.CoreSimulator.SimRuntime.iOS-27-2"
      echo "iOS 27.2 (27.2 - C) - com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4"
      exit 0
    fi
    echo "== Devices =="
    # $FAKE/hang-list: a booted-device list that hangs (a child keeps the pipe open, as a hung simctl would).
    [ "\${3:-}" = booted ] && [ -f "$FAKE/hang-list" ] && sleep 20
    # $FAKE/hang-default: the same, in the default set only. $FAKE/linger-list: the list exits at once but
    # leaves a child holding its output open (a stuck helper of a finished simctl).
    [ "\${3:-}" = booted ] && [ -z "$devset" ] && [ -f "$FAKE/hang-default" ] && sleep 20
    [ "\${3:-}" = booted ] && [ -f "$FAKE/linger-list" ] && { sleep 60 & echo $! >> "$FAKE/linger.pids"; exit 0; }
    # Other booted devices: $FAKE/booted (the default set) and $FAKE/booted-testing (--set testing).
    [ "$devset" = testing ] && { cat "$FAKE/booted-testing" 2>/dev/null; exit 0; }
    if [ -f "$FAKE/udid" ]; then
      st=$(cat "$FAKE/state")
      [ "\${3:-}" = booted ] && [ "$st" != Booted ] || echo "    HR Shared iPhone ($(cat "$FAKE/udid")) ($st) "
    fi
    cat "$FAKE/booted" 2>/dev/null || true;;
  create) echo ${UDID} > "$FAKE/udid"; echo Shutdown > "$FAKE/state"; echo ${UDID};;
  bootstatus) [ -f "$FAKE/hang-boot" ] && { echo $$ > "$FAKE/boot.pid"; exec sleep 60; }; echo Booted > "$FAKE/state";;
  shutdown) echo Shutdown > "$FAKE/state";;
esac
`;
const XCODEBUILD = '#!/bin/bash\necho "$*" >> "$FAKE/xcodebuild.log"\n';
// The load guard's inputs. sysctl reads $FAKE/loads, one 1-minute load per call, staying on the last
// line ("fail" exits 1); hw.ncpu prints $FAKE/ncpu (missing exits 1) and logs apart; ps prints $FAKE/ps.
// Every test starts at load 1 with no Codex review running, and env() pins HR_SIM_MAX_LOAD to 8.
const SYSCTL = `#!/bin/bash
if [ "$*" = "-n hw.ncpu" ]; then echo x >> "$FAKE/ncpu.log"; [ -f "$FAKE/ncpu" ] && cat "$FAKE/ncpu"; exit $?; fi
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
  '  105 node /x/node_modules/.bin/vitest related tools/codex-review.mjs --run',
  '  106 node --check tools/codex-review.mjs',
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
// Holders wait on a release file rather than a fixed sleep, so a loaded machine cannot end them early.
// Whatever a test leaves running (a failed assertion included) is released and stopped here.
// A waiter stops at once on SIGTERM (its 0.2 s sleep runs in the background), so cleanup never
// waits on one.
const live: { p: ChildProcess; done: Promise<unknown> }[] = [];
afterEach(async () => {
  writeFileSync(join(dir, 'release'), '');
  for (const { p, done } of live.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
    await done;
  }
  rmSync(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE: fake, HR_SIM_HOME: home, HR_SIM_LEASE: '',
  HR_SIM_IDLE_SECONDS: '0', HR_SIM_MAX_LOAD: '8', HR_SIM_ALLOW_SECOND: '', ALLOW_EXTRA_SIMULATOR: '', ...extra,
});
const run = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: env(extra), timeout: 30_000, cwd: work });
const start = (args: string[], extra: Record<string, string> = {}) => {
  const p = spawn('bash', [SCRIPT, ...args], { env: env(extra), cwd: work });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise<{ code: number | null; err: string }>((res) => p.on('exit', (code) => res({ code, err })));
  live.push({ p, done });
  return { p, done, err: () => err };
};
/** A command that runs until release() (or the test's end). */
const HOLD = ['sh', '-c', 'until [ -f "$0" ]; do sleep 0.1; done'];
const hold = () => [...HOLD, join(dir, 'release')];
const release = () => writeFileSync(join(dir, 'release'), '');
const log = (name: string) => (existsSync(join(fake, name)) ? readFileSync(join(fake, name), 'utf8') : '');
const info = (name: string) => readFileSync(join(home, 'holder'), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (check()) return;
  throw new Error('timed out waiting');
};
/** The queue's waiting.<start>.<pid> markers, in name order. */
const markers = () => (existsSync(home) ? readdirSync(home).filter((f) => f.startsWith('waiting.')).sort() : []);
const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0;
/** True while the lock is taken: lockf on the lock file cannot take it at once (75). Changes nothing. */
const busy = () => existsSync(join(home, 'lock'))
  && spawnSync('/bin/bash', ['-c', 'exec 9>>"$1"; lockf -s -t 0 9', '_', join(home, 'lock')]).status === 75;
/** Another process holding the lock, not through sim-run, until release(). */
const holdLock = () => {
  mkdirSync(home, { recursive: true });
  const p = spawn('/bin/bash', ['-c', 'exec 9>>"$1"; lockf -s -t 0 9 || exit 1; until [ -f "$2" ]; do sleep 0.1; done',
    '_', join(home, 'lock'), join(dir, 'release')]);
  const done = new Promise((res) => p.on('exit', res));
  live.push({ p, done });
  return { p, done };
};
/** CPU seconds used by a process and its live descendants, exited children summed in (ps -S). The
 * real /bin/ps, not the fake on PATH. Measured live, since exec drops a process's accumulated child CPU. */
const treeCpu = (root: number) => {
  const rows = spawnSync('/bin/ps', ['-S', '-axo', 'pid=,ppid=,time='], { encoding: 'utf8' }).stdout
    .trim().split('\n').map((l) => l.trim().split(/\s+/));
  const secs = (t: string) => t.split(':').reduce((s, part) => s * 60 + Number(part), 0);
  const tree = new Set([String(root)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; }
  }
  return rows.filter(([pid]) => tree.has(pid)).reduce((s, [, , t]) => s + secs(t), 0);
};

describe.skipIf(process.platform !== 'darwin')('US-71 AC7 + AC8 sim-run.sh (macOS: lockf, load guard)', () => {
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
      const a = start(['--', ...hold()]);
      await until(busy);
      const b = start(['--', 'true']);
      await until(() => b.err().includes('waiting up to'));
      expect(b.p.exitCode).toBe(null);
      release();
      const rb = await b.done;
      expect(rb.code).toBe(0);
      expect(rb.err).toMatch(/in use by pid \d+ for \d+m\d+s \(.*\): sh -c until .*release/);
      expect((await a.done).code).toBe(0);
    });

    it('gives up after the wait limit with exit 75, naming the holder', async () => {
      const a = start(['--', ...hold()]);
      await until(busy);
      const r = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(75);
      expect(r.stderr).toMatch(/gave up after 1s: the simulator is still in use by pid \d+ .*: sh -c until .*release/);
      release();
      expect((await a.done).code).toBe(0);
    });

    // macOS lockf in its fd form spins a core while it waits (lockf -s -t 5 9 used 4.97 s of CPU in 5 s).
    it('a waiter barely uses the CPU: under 0.3 s over a 3 s wait', async () => {
      holdLock();
      await until(busy);
      const b = start(['--', 'true'], { HR_SIM_WAIT_SECONDS: '30' });
      await until(() => b.err().includes('waiting up to'));
      const before = treeCpu(b.p.pid!);
      await sleep(3000);
      const used = treeCpu(b.p.pid!) - before;
      expect(b.p.exitCode).toBe(null);
      expect(used).toBeLessThan(0.3);
    });

    it('a waiter takes the lock within about a second of it freeing', async () => {
      const h = holdLock();
      await until(busy);
      const b = start(['--', 'true'], { HR_SIM_WAIT_SECONDS: '30' });
      await until(() => b.err().includes('waiting up to'));
      await sleep(1500);
      release();
      await h.done;
      const freed = Date.now();
      await until(() => existsSync(join(home, 'holder')) && info('pid') === String(b.p.pid));
      expect(Date.now() - freed).toBeLessThan(1500);
      expect((await b.done).code).toBe(0);
    });

    it('a caller that reruns straight after its own run does not starve a waiter queued behind it', async () => {
      // Six back-to-back runs; the waiter queues during the first and must run before the sixth.
      const chain = spawn('bash', ['-c', 'for i in 1 2 3 4 5 6; do bash "$0" -- sh -c \'echo c >> "$FAKE/order"; sleep 0.5\'; done', SCRIPT],
        { env: env(), cwd: work });
      const chainDone = new Promise((res) => chain.on('exit', res));
      live.push({ p: chain, done: chainDone });
      await until(() => busy() && log('order') === 'c\n');
      const w = start(['--', 'sh', '-c', 'echo W >> "$FAKE/order"'], { HR_SIM_WAIT_SECONDS: '60' });
      await until(() => w.err().includes('waiting up to'));
      expect((await w.done).code).toBe(0);
      await chainDone;
      const order = log('order').trim().split('\n');
      expect(order.filter((x) => x === 'c')).toHaveLength(6);
      expect(order.indexOf('W')).toBeLessThan(order.length - 1);
    });

    it('a caller\'s marker is in the queue before its first try for the lock, so no later caller slips in', async () => {
      // A lockf on PATH that records, at each try for the lock (fd 9), the queue's markers, then runs the real one.
      const shim = join(dir, 'shim');
      mkdirSync(shim);
      writeFileSync(join(shim, 'lockf'), '#!/bin/bash\n[ "${!#}" = 9 ] && echo "$(cd "$HR_SIM_HOME" && echo waiting.*)" >> "$FAKE/tries"\nexec /usr/bin/lockf "$@"\n',
        { mode: 0o755 });
      const h = holdLock();
      await until(busy);
      const b = start(['--', 'true'], { HR_SIM_WAIT_SECONDS: '30', PATH: `${shim}:${fake}:${process.env.PATH}` });
      await until(() => b.err().includes('waiting up to'));
      expect(log('tries').split('\n')[0]).toMatch(new RegExp(`^waiting\\.\\d+\\.${b.p.pid}$`));
      release();
      await h.done;
      expect((await b.done).code).toBe(0);
      expect(markers()).toEqual([]);
    });

    // The queue's failure modes: a waiter is live only while it holds the kernel lock on its marker.
    it('a stale marker naming a live unrelated process does not hold up a run while the lock is free', () => {
      const other = spawn('sleep', ['300']);
      live.push({ p: other, done: new Promise((res) => other.on('exit', res)) });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, `waiting.1000000000.${other.pid}`), '');
      const r = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '2' });
      expect(r.status).toBe(0);
      expect(markers()).toEqual([]);
    });

    it('a waiter SIGKILLed mid-wait holds no one up: the next run proceeds at once and its marker goes', async () => {
      const h = holdLock();
      await until(busy);
      const b = start(['--', 'true'], { HR_SIM_WAIT_SECONDS: '30' });
      await until(() => b.err().includes('waiting up to'));
      expect(markers()).toHaveLength(1);
      b.p.kill('SIGKILL');
      await b.done;
      release();
      await h.done;
      const r = run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '2' });
      expect(r.status).toBe(0);
      expect(markers()).toEqual([]);
    });

    it('removes its marker when it gives up (75), and on TERM and INT', async () => {
      holdLock();
      await until(busy);
      expect(run(['--', 'true'], { HR_SIM_WAIT_SECONDS: '1' }).status).toBe(75);
      expect(markers()).toEqual([]);
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        const b = start(['--', 'true'], { HR_SIM_WAIT_SECONDS: '30' });
        await until(() => b.err().includes('waiting up to'));
        expect(markers()).toHaveLength(1);
        b.p.kill(sig);
        expect((await b.done).code).toBe(sig === 'SIGTERM' ? 143 : 130);
        expect(markers()).toEqual([]);
      }
    });

    it('a stale marker with the caller\'s own pid does not let it skip a live waiter queued earlier', async () => {
      mkdirSync(home, { recursive: true });
      // A live waiter: a process holding the lock on its own marker.
      const w = spawn('/bin/bash', ['-c', 'm="$1/waiting.1500000000.$$"; exec 7>>"$m"; lockf -s -t 0 7 || exit 1; touch "$1/w-ready"; until [ -f "$2" ]; do sleep 0.1; done',
        '_', home, join(dir, 'release')]);
      live.push({ p: w, done: new Promise((res) => w.on('exit', res)) });
      await until(() => existsSync(join(home, 'w-ready')));
      // The caller leaves a marker with its own pid that sorts first, then becomes sim-run (exec keeps the pid).
      const r = spawnSync('bash', ['-c', 'touch "$1/waiting.1000000000.$$"; exec bash "$0" -- sh -c \'echo ran > "$FAKE/ran"\'', SCRIPT, home],
        { encoding: 'utf8', env: env({ HR_SIM_WAIT_SECONDS: '2' }), timeout: 30_000, cwd: work });
      expect(r.status).toBe(75);
      expect(log('ran')).toBe('');
      expect(markers()).toEqual([`waiting.1500000000.${w.pid}`]);
    });

    it('a waiter\'s command gets neither the marker\'s descriptor (7) nor the lock\'s (9)', async () => {
      const h = holdLock();
      await until(busy);
      const b = start(['--', 'sh', '-c', '{ for f in 7 9; do [ -e /dev/fd/$f ] && echo "fd$f"; done; echo done; } >> "$FAKE/fds"'],
        { HR_SIM_WAIT_SECONDS: '30' });
      await until(() => b.err().includes('waiting up to'));
      release();
      await h.done;
      expect((await b.done).code).toBe(0);
      expect(log('fds')).toBe('done\n');
    });

    it('on SIGTERM keeps the lock until the command is gone, killing one that ignores TERM', async () => {
      const pidFile = join(dir, 'child.pid');
      const a = start(['--', 'sh', '-c', `trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 0.1; done`], { HR_SIM_KILL_SECONDS: '5' });
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
        { HR_SIM_KILL_SECONDS: '5', HR_SIM_IDLE_SECONDS: '1' });
      await until(() => existsSync(pidFile) && busy());
      const child = Number(readFileSync(pidFile, 'utf8'));
      a.p.kill('SIGKILL');
      await a.done;
      await sleep(1000);
      expect(alive(child)).toBe(true);
      expect(busy()).toBe(true);
      await until(() => !alive(child), 15_000);
      await until(() => !busy(), 10_000);
      // The shim arms the idle shutdown the dead wrapper could not.
      await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 15_000);
    });

    it('stops a run at the whole-run time limit with exit 124 and frees the lock', () => {
      const t = Date.now();
      const r = run(['--', 'sleep', '20'], { HR_SIM_RUN_LIMIT_SECONDS: '1' });
      expect(r.status).toBe(124);
      expect(r.stderr).toContain('stopped at the time limit (1s');
      expect(Date.now() - t).toBeLessThan(15_000);
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
      writeFileSync(script, `#!/bin/sh\n[ "\${HR_SIM_INNER:-}" = "$$" ] || exec bash ${SCRIPT} -- "$0"\necho ran >> ${dir}/count\nuntil [ -f ${dir}/release ]; do sleep 0.1; done\n`, { mode: 0o755 });
      const a = spawn(script, [], { env: env({ HR_SIM_INNER: '1' }), cwd: work });
      const done = new Promise((res) => a.on('exit', res));
      live.push({ p: a, done });
      await until(busy);
      release();
      await done;
      expect(readFileSync(join(dir, 'count'), 'utf8')).toBe('ran\n');
    });

    it('an old token from a finished run does not skip the lock', async () => {
      run(['--', 'true']);
      const old = info('token');
      const a = start(['--', ...hold()]);
      // The holder file names the new run a moment after the lock is taken.
      await until(() => busy() && info('token') !== old);
      expect(run(['--', 'true'], { HR_SIM_LEASE: old, HR_SIM_WAIT_SECONDS: '1' }).status).toBe(75);
      release();
      expect((await a.done).code).toBe(0);
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
      await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 15_000);
    });

    it('a probe holding the lock for a moment when the sleeper wakes does not cancel it', async () => {
      run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '1' });
      // The probe holds the lock from before the sleeper wakes (1 s) until 2 s; the sleeper waits it out.
      const probe = spawn('/bin/bash', ['-c', 'exec 9>>"$1"; lockf -s -t 0 9 && sleep 2', '_', join(home, 'lock')]);
      await until(busy);
      await until(() => log('xcrun.log').includes(`simctl shutdown ${UDID}`), 15_000);
      await new Promise((res) => (probe.exitCode !== null ? res(null) : probe.on('exit', res)));
    });

    it('leaves it booted when another run ended since', async () => {
      // The second run must end before the first one's sleeper wakes: 3 s leaves room for a slow start.
      run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '3' });
      run(['--', 'true']);
      await sleep(4500);
      expect(log('xcrun.log')).not.toContain('shutdown');
    });

    it('leaves it booted while a run holds it', async () => {
      // The holder must take the lock before the sleeper wakes (3 s); the sleeper then waits 5 s for it.
      run(['--', 'true'], { HR_SIM_IDLE_SECONDS: '3' });
      const a = start(['--', ...hold()]);
      await sleep(9000);
      expect(busy()).toBe(true);
      expect(log('xcrun.log')).not.toContain('shutdown');
      release();
      expect((await a.done).code).toBe(0);
    });
  });

  describe('load guard (US-71 AC8)', () => {
    // The poll floor is 1 second (a smaller setting is raised to it).
    const fast = { HR_SIM_GUARD_POLL_SECONDS: '1' };
    const tookLock = () => existsSync(join(home, 'holder'));

    it('at load 9 waits, then gives up with exit 75 in load-guard words, never taking the lock', () => {
      setLoads('9.00');
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '2' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('sim-run: waiting (load guard): 1-minute load 9.00 is over 8 (HR_SIM_IGNORE_LOAD=1 skips this)');
      expect(r.stderr).toMatch(/sim-run: gave up after 0m\d+s \(load guard, not the lock\): 1-minute load 9\.00 is over 8/);
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

    it('a bash -c line, a --codex fake, vitest related and node --check on the script do not count', () => {
      setLoads('7.00');
      setPs([CODEX, ...DECOYS]);
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('load guard');
    });

    it('counts node codex-review.mjs run from inside tools/, after node flags', () => {
      setLoads('7.00');
      setPs([CODEX, '  107 node --no-warnings codex-review.mjs --base main']);
      const r = run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('2 Codex reviews running');
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
      // The holder has read the load twice (before the lock and after it), so it cannot read the 9s below.
      await until(() => busy() && log('sysctl.log').trim().split('\n').length >= 2);
      // Trips at 0, 1 and 2 s, clears at 3 s; the lock then gets what is left of 4 s, not 4 s more.
      setLoads('9.00', '9.00', '9.00', '2.00');
      const t = Date.now();
      const r = run(['--', 'true'], { HR_SIM_GUARD_POLL_SECONDS: '1', HR_SIM_WAIT_SECONDS: '4' });
      const took = Date.now() - t;
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('waiting (load guard)');
      expect(r.stderr).toMatch(/gave up after 4s: the simulator is still in use/);
      expect(took).toBeGreaterThanOrEqual(3000);
      // A lock wait of 4 s more would take at least 3 + 4 = 7 s.
      expect(took).toBeLessThan(7000);
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

    it('by default the limit is 1.5 x the CPU count: with 10 CPUs, load 12 proceeds and load 16 waits', () => {
      writeFileSync(join(fake, 'ncpu'), '10\n');
      setLoads('12.00');
      const ok = run(['--', 'sh', '-c', 'echo ran'], { ...fast, HR_SIM_MAX_LOAD: '', HR_SIM_WAIT_SECONDS: '1' });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('ran');
      expect(ok.stderr).not.toContain('load guard');
      setLoads('16.00');
      const r = run(['--', 'true'], { ...fast, HR_SIM_MAX_LOAD: '', HR_SIM_WAIT_SECONDS: '1' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('1-minute load 16.00 is over 15');
      expect(log('ncpu.log').trim().split('\n')).toHaveLength(2);
    });

    it('when the CPU count cannot be read, falls back to 8 with one line, still checking the load', () => {
      setLoads('9.00');
      const r = run(['--', 'true'], { ...fast, HR_SIM_MAX_LOAD: '', HR_SIM_WAIT_SECONDS: '2' });
      expect(r.status).toBe(75);
      expect(r.stderr.match(/sim-run: load guard could not read the CPU count; using a load limit of 8/g)).toHaveLength(1);
      expect(r.stderr).toContain('1-minute load 9.00 is over 8');
    });

    it('a set HR_SIM_MAX_LOAD never reads the CPU count', () => {
      setLoads('9.00');
      run(['--', 'true'], { ...fast, HR_SIM_WAIT_SECONDS: '1' });
      expect(log('ncpu.log')).toBe('');
    });

    it('a non-numeric HR_SIM_MAX_LOAD skips only the load check, with one line on stderr', () => {
      setLoads('50.00');
      setPs([CODEX]);
      const r = run(['--', 'sh', '-c', 'echo ran'], { ...fast, HR_SIM_MAX_LOAD: 'eight', HR_SIM_WAIT_SECONDS: '2' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ran');
      expect(r.stderr.match(/sim-run: load guard: HR_SIM_MAX_LOAD=eight is not a number; checking Codex reviews only/g)).toHaveLength(1);
    });

    it('a non-numeric HR_SIM_MAX_LOAD with two real Codex reviews still waits', () => {
      setLoads('1.00');
      setPs([CODEX, CODEX2]);
      const r = run(['--', 'true'], { ...fast, HR_SIM_MAX_LOAD: 'eight', HR_SIM_WAIT_SECONDS: '2' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain('sim-run: waiting (load guard): 2 Codex reviews running');
      expect(r.stderr.match(/is not a number/g)).toHaveLength(1);
      expect(tookLock()).toBe(false);
    });

    it.each(['0', '0.2', 'soon'])('a poll setting of %s polls every second, not in a busy loop', (poll) => {
      setLoads('9.00');
      const r = run(['--', 'true'], { HR_SIM_GUARD_POLL_SECONDS: poll, HR_SIM_WAIT_SECONDS: '3' });
      expect(r.status).toBe(75);
      // About one load read a second over 3 seconds (a busy loop would make hundreds).
      const reads = log('sysctl.log').trim().split('\n').length;
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(reads).toBeLessThanOrEqual(5);
    });

    it('an unreadable sysctl fails open with one line on stderr', () => {
      setLoads('fail');
      const r = run(['--', 'sh', '-c', 'echo ran'], fast);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ran');
      expect(r.stderr.match(/sim-run: load guard could not read the load; not waiting/g)).toHaveLength(1);
    });
  });

  describe('one booted simulator (US-71 AC7)', () => {
    const IPAD = `    iPad Air 13-inch (M3) (${OTHER}) (Booted) `;
    const DEMO_LINE = `    HR Demo iPhone (${OTHER}) (Booted) `;
    const setBooted = (line: string, file = 'booted') => writeFileSync(join(fake, file), `${line}\n`);
    /** Live processes whose command line names this test's folder: the command, sim-run, its watchdog. */
    const leftovers = () => spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout
      .split('\n').filter((l) => l.includes(dir) && !l.includes('/bin/ps'));
    const ran = ['sh', '-c', 'echo ran >> "$FAKE/ran"'];

    it('refuses at once with 75 when another device is booted, naming it and its shutdown command; the command never runs', () => {
      run(['--', 'true']);
      setBooted(IPAD);
      const r = run(['--', ...ran], { HR_SIM_WAIT_SECONDS: '30' });
      expect(r.status).toBe(75);
      expect(r.stderr).toContain(`iPad Air 13-inch (M3) (${OTHER})`);
      expect(r.stderr).toContain(`xcrun simctl shutdown ${OTHER}`);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(log('ran')).toBe('');
      expect(busy()).toBe(false);
      expect(log('xcrun.log')).not.toContain(`shutdown ${OTHER}`);
    });

    it('refuses a booted parallel-test clone in the testing set, with the --set testing shutdown command', () => {
      setBooted(`    Clone 1 of HR Shared iPhone (${OTHER}) (Booted) `, 'booted-testing');
      const r = run(['--', ...ran]);
      expect(r.status).toBe(75);
      expect(r.stderr).toContain(`Clone 1 of HR Shared iPhone (${OTHER})`);
      expect(r.stderr).toContain(`xcrun simctl --set testing shutdown ${OTHER}`);
      expect(log('ran')).toBe('');
    });

    it('a booted demo device blocks a run, even with ALLOW_EXTRA_SIMULATOR; HR_SIM_ALLOW_SECOND=1 runs beside it', () => {
      setBooted(DEMO_LINE);
      expect(run(['--', ...ran]).status).toBe(75);
      expect(run(['--', ...ran], { ALLOW_EXTRA_SIMULATOR: 'other-device' }).status).toBe(75);
      expect(log('ran')).toBe('');
      const r = run(['--', ...ran], { HR_SIM_ALLOW_SECOND: '1' });
      expect(r.status).toBe(0);
      expect(log('ran')).toBe('ran\n');
    });

    it('the shared device booted alone does not block, and status still lists another booted device', () => {
      expect(run(['--', ...ran]).status).toBe(0);
      expect(run(['--', ...ran]).status).toBe(0);
      setBooted(IPAD);
      const s = run(['status']);
      expect(s.status).toBe(0);
      expect(s.stdout).toContain(OTHER);
    });

    it('a device booted mid-run ends the command with 76 and one line naming it, shuts nothing down, leaves no watchdog', async () => {
      const pidFile = join(dir, 'cmd.pid');
      // The command boots the second device itself (the fake reports it once the file exists), then waits.
      const a = start(['--', 'sh', '-c', `echo $$ > ${pidFile}; printf '%s\\n' "$1" > "$FAKE/booted"; until [ -f "$0" ]; do sleep 0.1; done`,
        join(dir, 'release'), IPAD], { HR_SIM_GUARD_SECONDS: '1' });
      const r = await a.done;
      expect(r.code).toBe(76);
      const line = r.err.split('\n').filter((l) => l.includes(OTHER));
      expect(line).toHaveLength(1);
      expect(line[0]).toContain('iPad Air 13-inch (M3)');
      expect(line[0]).toContain(`xcrun simctl shutdown ${OTHER}`);
      expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
      expect(log('xcrun.log')).not.toContain(`shutdown ${OTHER}`);
      expect(busy()).toBe(false);
      await sleep(1500);
      expect(leftovers()).toEqual([]);
    });

    it('the watchdog ends a command that boots a clone in the testing set', async () => {
      const a = start(['--', 'sh', '-c', 'printf "%s\\n" "$1" > "$FAKE/booted-testing"; until [ -f "$0" ]; do sleep 0.1; done',
        join(dir, 'release'), `    Clone 2 of HR Shared iPhone (${OTHER}) (Booted) `], { HR_SIM_GUARD_SECONDS: '1' });
      const r = await a.done;
      expect(r.code).toBe(76);
      expect(r.err).toContain(`xcrun simctl --set testing shutdown ${OTHER}`);
    });

    it('the watchdog spares the demo device under ALLOW_EXTRA_SIMULATOR=other-device, and stops when the command ends', async () => {
      const r = run(['--', 'sh', '-c', 'printf "%s\\n" "$1" > "$FAKE/booted"; sleep 3; echo "$0" > /dev/null', join(dir, 'x'), DEMO_LINE],
        { HR_SIM_GUARD_SECONDS: '1', ALLOW_EXTRA_SIMULATOR: 'other-device' });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain(OTHER);
      await sleep(1500);
      expect(leftovers()).toEqual([]);
    });

    it('HR_SIM_ALLOW_SECOND=1 turns the watchdog off too', () => {
      const r = run(['--', 'sh', '-c', 'printf "%s\\n" "$0" > "$FAKE/booted"; sleep 3', IPAD],
        { HR_SIM_GUARD_SECONDS: '1', HR_SIM_ALLOW_SECOND: '1' });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain(OTHER);
    });

    it('a run that fails, or is stopped by TERM or INT, leaves no watchdog behind', async () => {
      expect(run(['--', 'sh', '-c', 'sleep 2; exit 3', join(dir, 'x')], { HR_SIM_GUARD_SECONDS: '1' }).status).toBe(3);
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        const a = start(['--', ...hold()], { HR_SIM_GUARD_SECONDS: '1' });
        await until(busy);
        await sleep(1500);
        a.p.kill(sig);
        expect((await a.done).code).toBe(sig === 'SIGTERM' ? 143 : 130);
      }
      await sleep(1500);
      expect(leftovers()).toEqual([]);
    });

    // Review of PR 1435 (R1): a hung `simctl list devices booted` held the lock with no bound, 41 s at a 3 s limit.
    it('a hung booted-device list before the run ends within about the run limit, and the lock is free', async () => {
      run(['--', 'true']);
      writeFileSync(join(fake, 'hang-list'), '');
      const t0 = Date.now();
      const r = await start(['--', 'true'], { HR_SIM_RUN_LIMIT_SECONDS: '3', HR_SIM_GUARD_SECONDS: '1' }).done;
      const secs = (Date.now() - t0) / 1000;
      expect(r.code).toBe(0);
      expect(secs).toBeLessThan(11);
      expect(busy()).toBe(false);
    }, 60_000);

    it('a hung booted-device list mid-run ends within about the run limit, and the lock is free', async () => {
      const a = start(['--', 'sh', '-c', 'touch "$1"; until [ -f "$0" ]; do sleep 0.1; done', join(dir, 'release'), join(dir, 'started')],
        { HR_SIM_RUN_LIMIT_SECONDS: '3', HR_SIM_GUARD_SECONDS: '1' });
      // The lock is taken before the booted-device check, so wait for the command itself.
      await until(() => existsSync(join(dir, 'started')));
      const t0 = Date.now();
      writeFileSync(join(fake, 'hang-list'), '');
      const r = await a.done;
      const secs = (Date.now() - t0) / 1000;
      expect(r.code).toBe(124);
      expect(secs).toBeLessThan(7);
      expect(busy()).toBe(false);
    }, 60_000);

    // R5: a list whose own process exited while a child kept its output open held the lock with no bound.
    it('a list that exits leaving a child holding its output ends within about the run limit, lock free, child gone', async () => {
      run(['--', 'true']);
      writeFileSync(join(fake, 'linger-list'), '');
      const t0 = Date.now();
      const a = start(['--', 'true'], { HR_SIM_RUN_LIMIT_SECONDS: '3', HR_SIM_GUARD_SECONDS: '1' });
      const pids = () => log('linger.pids').trim().split('\n').filter(Boolean).map(Number);
      try {
        const r = await Promise.race([a.done, sleep(12_000).then(() => null)]);
        const secs = (Date.now() - t0) / 1000;
        expect(r?.code).toBe(0);
        expect(secs).toBeLessThan(8);
        expect(busy()).toBe(false);
        expect(pids().length).toBeGreaterThan(0);
        expect(pids().filter(alive)).toEqual([]);
      } finally {
        for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }, 30_000);

    // R6: the watchdog's list subshell outlived it, holding sim-run's stderr open well after the lock was free.
    it('with a hung list mid-run, a reader of sim-run\'s stderr gets EOF within a few seconds of the command ending', async () => {
      const p = spawn('bash', ['-c', 'bash "$0" "$@" 2>&1 | cat', SCRIPT, '--', 'sh', '-c', 'touch "$1"; until [ -f "$0" ]; do sleep 0.1; done',
        join(dir, 'release'), join(dir, 'started')], { env: env({ HR_SIM_GUARD_SECONDS: '1' }), cwd: work });
      const done = new Promise((res) => p.on('exit', res));
      live.push({ p, done });
      await until(() => existsSync(join(dir, 'started')));
      writeFileSync(join(fake, 'hang-list'), '');
      await sleep(2500);
      const t0 = Date.now();
      release();
      await done;
      expect((Date.now() - t0) / 1000).toBeLessThan(5);
    }, 60_000);

    // R8a: a list that timed out failed open without a word.
    const SKIPPED = 'sim-run: the booted-device list timed out; the one-simulator check is skipped this time';
    it('a pre-check whose lists both time out says so once, and runs', async () => {
      run(['--', 'true']);
      writeFileSync(join(fake, 'hang-list'), '');
      const r = await start(['--', 'true'], { HR_SIM_RUN_LIMIT_SECONDS: '2', HR_SIM_GUARD_SECONDS: '30' }).done;
      expect(r.code).toBe(0);
      expect(r.err.split('\n').filter((l) => l === SKIPPED)).toHaveLength(1);
    }, 30_000);

    it('a list that keeps timing out says so once for the pre-check and once for the watchdog, not every tick', async () => {
      run(['--', 'true']);
      writeFileSync(join(fake, 'hang-default'), '');
      // The command ignores TERM, so the run lasts the limit plus the grace: about three watchdog ticks.
      const r = await start(['--', 'sh', '-c', 'trap "" TERM; while :; do sleep 0.1; done'],
        { HR_SIM_RUN_LIMIT_SECONDS: '2', HR_SIM_KILL_SECONDS: '8', HR_SIM_GUARD_SECONDS: '1' }).done;
      expect(r.code).toBe(124);
      expect(log('xcrun.log').split('\n').filter((l) => /^simctl list devices booted$/.test(l)).length).toBeGreaterThanOrEqual(3);
      expect(r.err.split('\n').filter((l) => l === SKIPPED)).toHaveLength(2);
    }, 60_000);

    // R8b: a found-file left by an old run whose pid is reused reported a device that was never there.
    it('a stale found-file under sim-run\'s pid is cleared at the start, so it cannot report 76', () => {
      mkdirSync(home, { recursive: true });
      const r = spawnSync('bash', ['-c', 'echo "iPad (X)|xcrun simctl shutdown X" > "$HR_SIM_HOME/booted.$$"; exec bash "$0" -- true', SCRIPT],
        { encoding: 'utf8', env: env({ HR_SIM_GUARD_SECONDS: '1' }), cwd: work, timeout: 30_000 });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('another simulator');
    });

    // R2: kill -0 on sim-run's pid succeeds on an unreaped zombie, so the watchdog outlived it.
    it('a SIGKILLed sim-run under a parent that never reaps it leaves no watchdog after a tick', async () => {
      const p = spawn('perl', ['-e', '$| = 1; my $p = fork // die; if (!$p) { exec @ARGV } print "$p\\n"; sleep 60',
        'bash', SCRIPT, '--', 'sh', '-c', 'touch "$1"; until [ -f "$0" ]; do sleep 0.1; done', join(dir, 'release'), join(dir, 'started')],
        { env: env({ HR_SIM_GUARD_SECONDS: '1' }), cwd: work });
      live.push({ p, done: new Promise((res) => p.on('exit', res)) });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      // sim-run forks its watchdog before the command starts (the device setup runs first).
      await until(() => out.includes('\n') && existsSync(join(dir, 'started')));
      process.kill(Number(out.trim()), 'SIGKILL');
      await sleep(3000);
      expect(leftovers().filter((l) => !l.trim().startsWith(`${p.pid} `) && !l.includes('defunct'))).toEqual([]);
    }, 30_000);

    // R4: a command that had already ended was reported "stopped".
    it('a device found after the command ended exits 76 without claiming it stopped the command', async () => {
      const a = start(['--', 'sh', '-c', 'touch "$2"; until [ -f "$0" ]; do sleep 0.1; done; printf "%s\\n" "$1" > "$FAKE/booted"',
        join(dir, 'release'), IPAD, join(dir, 'started')], { HR_SIM_GUARD_SECONDS: '1' });
      await until(() => existsSync(join(dir, 'started')));
      // sim-run stopped: it cannot reap the shim or stop the watchdog, which finds the device after the command is gone.
      process.kill(a.p.pid!, 'SIGSTOP');
      release();
      await sleep(2500);
      process.kill(a.p.pid!, 'SIGCONT');
      const r = await a.done;
      expect(r.code).toBe(76);
      const line = r.err.split('\n').filter((l) => l.includes(OTHER));
      expect(line).toHaveLength(1);
      expect(line[0]).toContain(`xcrun simctl shutdown ${OTHER}`);
      expect(line[0]).not.toContain('stopped the command');
    }, 30_000);
  });

  describe('status', () => {
    it('names the holder and kills nothing', async () => {
      const a = start(['--', ...hold()]);
      await until(busy);
      const r = run(['status']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Holder: in use by pid \d+ .*: sh -c until .*release/);
      expect(r.stdout).toContain('Simulator-runtime processes:');
      expect(busy()).toBe(true);
      release();
      expect((await a.done).code).toBe(0);
    });

    it('lists the demo device, its age and the command to shut it down', () => {
      run(['--', 'true']);
      writeFileSync(join(fake, 'xcrun'), XCRUN.replace('echo "== Devices =="', `echo "== Devices =="; echo "    HR Demo iPhone (${OTHER}) (Booted) "`), { mode: 0o755 });
      const before = Math.floor(Date.now() / 1000);
      writeFileSync(join(home, 'demo-booted'), String(before - 125));
      const r = run(['status']);
      const after = Math.floor(Date.now() / 1000);
      // The script reads its own clock after several fake xcrun calls, so under load the age can run
      // past 125 s by up to the time status took.
      const m = r.stdout.match(new RegExp(`Demo device: HR Demo iPhone \\(${OTHER}\\) Booted for (\\d+)m(\\d+)s`));
      expect(m).not.toBeNull();
      const age = Number(m![1]) * 60 + Number(m![2]);
      expect(age).toBeGreaterThanOrEqual(125);
      expect(age).toBeLessThanOrEqual(125 + (after - before) + 1);
      expect(r.stdout).toContain(`xcrun simctl shutdown ${OTHER}`);
    });
  });
});
