// US-71 AC9: tools/mac-slot.sh, a machine-wide counted queue for Codex reviews and heavy test runs. Each test
// gets its own slot directory (MAC_SLOT_HOME) and a fake load reader (MAC_SLOT_LOAD_CMD reads $FAKE/loads, one
// line per call, staying on the last), so nothing depends on the real load. Holders wait on a release file, not
// a fixed sleep, so a busy Mac cannot end them early. macOS only (lockf): CI runs Linux, so these run locally:
//   npx vitest run tools/mac-slot.test.ts
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, 'mac-slot.sh');
const LOAD = `#!/bin/sh
l=$(head -1 "$FAKE/loads")
[ "$(wc -l < "$FAKE/loads")" -gt 1 ] && sed -i '' 1d "$FAKE/loads"
echo "$l"
`;

let dir: string, fake: string, home: string;
const kids: ChildProcess[] = [];
const track = (p: ChildProcess) => {
  kids.push(p);
  return new Promise<number>((r) => p.on('exit', (c) => r(c ?? -1)));
};
const setLoads = (...l: string[]) => writeFileSync(join(fake, 'loads'), `${l.join('\n')}\n`);
const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete e.CI;
  return { ...e, FAKE: fake, MAC_SLOT_HOME: home, MAC_SLOT_LOAD_CMD: join(fake, 'load'), MAC_SLOT_POLL_SECONDS: '1',
    MAC_SLOT_CODEX_MAX: '2', MAC_SLOT_TESTS_MAX: '3', ...extra };
};
// A holder that runs until its release file appears, then exits with `code`.
const hold = (name: string, code = 0) =>
  ['sh', '-c', `echo started >> "${fake}/${name}.log"; while [ ! -f "${fake}/${name}.go" ]; do sleep 0.1; done; exit ${code}`];
const release = (name: string) => writeFileSync(join(fake, `${name}.go`), '');
const started = (name: string) => existsSync(join(fake, `${name}.log`));
// A waiter's queue marker: waiting.<kind>.<stamp>.<pid> (or the older waiting.<kind>.<pid>).
const marker = (pid?: number) => readdirSync(home).filter((f) => new RegExp(`^waiting\\.codex\\.(.*\\.)?${pid}$`).test(f));

function bg(kind: string, cmd: string[], extra: Record<string, string> = {}) {
  const p = spawn('sh', [SCRIPT, kind, '--', ...cmd], { env: env(extra) });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const done = new Promise<number>((r) => p.on('exit', (c) => r(c ?? -1)));
  kids.push(p);
  return { p, done, err: () => err };
}
async function until(f: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mac-slot-test-'));
  fake = join(dir, 'fake');
  home = join(dir, 'home');
  mkdirSync(fake);
  writeFileSync(join(fake, 'load'), LOAD, { mode: 0o755 });
  setLoads('1.00');
});
afterEach(() => {
  for (const f of ['a', 'b', 'c', 'd', 'x']) writeFileSync(join(fake, `${f}.go`), '');
  for (const k of kids.splice(0)) k.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('US-71 AC9 mac-slot.sh (macOS: lockf)', () => {
  it('the N+1th codex caller waits, naming the holders, and starts when one ends', async () => {
    const a = bg('codex', hold('a'));
    const b = bg('codex', hold('b'));
    await until(() => started('a') && started('b'));
    const c = bg('codex', hold('c'));
    await until(() => /waiting for a codex slot/.test(c.err()));
    expect(c.err()).toMatch(new RegExp(`pid ${a.p.pid}\\b`));
    expect(c.err()).toMatch(new RegExp(`pid ${b.p.pid}\\b`));
    await new Promise((r) => setTimeout(r, 1500));
    expect(started('c')).toBe(false);
    release('a');
    expect(await a.done).toBe(0);
    await until(() => started('c'));
    expect(c.err()).toMatch(/starting codex slot/);
    release('b');
    release('c');
    expect(await c.done).toBe(0);
  });

  it('tests allows three holders at once', async () => {
    for (const n of ['a', 'b', 'c']) bg('tests', hold(n));
    await until(() => started('a') && started('b') && started('c'));
    const d = bg('tests', hold('d'));
    await until(() => /waiting for a tests slot/.test(d.err()));
    expect(started('d')).toBe(false);
  });

  it("passes the command's exit code through", async () => {
    const r = bg('tests', ['sh', '-c', 'exit 7']);
    expect(await r.done).toBe(7);
    const s = spawnSync('sh', [SCRIPT, 'codex', '--', 'true'], { env: env(), encoding: 'utf8' });
    expect(s.status).toBe(0);
  });

  it('status lists each holder with pid and command, and the load', async () => {
    const a = bg('codex', hold('a'));
    await until(() => started('a'));
    const s = spawnSync('sh', [SCRIPT, 'status'], { env: env(), encoding: 'utf8' });
    expect(s.status).toBe(0);
    expect(s.stdout).toMatch(/codex: 1\/2 held/);
    expect(s.stdout).toMatch(new RegExp(`pid ${a.p.pid} .*a\\.go`));
    expect(s.stdout).toMatch(/tests: 0\/3 held/);
    expect(s.stdout).toMatch(/1-minute load: 1\.00/);
  });

  it('status lists a waiter', async () => {
    bg('codex', hold('a'), { MAC_SLOT_CODEX_MAX: '1' });
    await until(() => started('a'));
    const w = bg('codex', hold('b'), { MAC_SLOT_CODEX_MAX: '1' });
    await until(() => /waiting for a codex slot/.test(w.err()));
    const s = spawnSync('sh', [SCRIPT, 'status'], { env: env({ MAC_SLOT_CODEX_MAX: '1' }), encoding: 'utf8' });
    expect(s.stdout).toMatch(/codex: 1\/1 held, 1 waiting/);
    expect(s.stdout).toMatch(new RegExp(`waiting: pid ${w.p.pid}\\b`));
  });

  it("a status probe's instant lock does not send a caller past the free slot (retried once)", () => {
    // Fd 8 locks slot 1 the way status probes it; the caller starts with fd 8 closed, and 0.05 s later the lock goes.
    mkdirSync(home, { recursive: true });
    const s = spawnSync('sh', ['-c', `( exec 8>>"${home}/codex.1"; lockf -s -t 0 8
      sh "${SCRIPT}" codex -- true 8>&- 2>"${fake}/err" & sleep 0.05; exec 8>&-; wait )`],
    { env: env({ MAC_SLOT_CODEX_MAX: '1' }), encoding: 'utf8' });
    expect(s.status).toBe(0);
    const err = readFileSync(join(fake, 'err'), 'utf8');
    expect(err).toMatch(/starting codex slot 1\/1/);
    expect(err).not.toMatch(/waiting/);
  });

  it('with a slot, waits while the load is 8 or more, then starts', async () => {
    setLoads('9.50', '8.00', '3.20');
    const r = bg('tests', hold('x'));
    await until(() => started('x'));
    expect(r.err()).toMatch(/waiting: 1-minute load 9\.50 is 8 or more/);
    expect(r.err()).toMatch(/starting tests slot .*load 3\.20/);
    release('x');
    expect(await r.done).toBe(0);
  });

  it('at the load-wait bound refuses with exit 75 and one line, never runs the command, and frees the slot', async () => {
    setLoads('12.00');
    const extra = { MAC_SLOT_LOAD_WAIT_SECONDS: '2', MAC_SLOT_CODEX_MAX: '1' };
    const r = bg('codex', ['sh', '-c', `touch "${fake}/ran"`], extra);
    expect(await r.done).toBe(75);
    expect(existsSync(join(fake, 'ran'))).toBe(false);
    const refused = r.err().split('\n').filter((l) => /refused/.test(l));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/the 1-minute load 12\.00 is still 8 or more after 2s; not starting sh -c touch \S+\. Try again when the Mac is quieter$/);
    expect(r.err()).not.toMatch(/starting codex slot/);
    // The slot is free at once: the next caller (load now low) starts without waiting for a slot.
    setLoads('1.00');
    const n = spawnSync('sh', [SCRIPT, 'codex', '--', 'true'], { env: env(extra), encoding: 'utf8', timeout: 5000 });
    expect(n.status).toBe(0);
    expect(n.stderr).not.toMatch(/waiting for a codex slot/);
  });

  it('an unreadable load after a high one keeps waiting and refuses at the bound (only the first read fails open)', async () => {
    setLoads('12.00', 'xx');
    const r = bg('tests', ['sh', '-c', `touch "${fake}/ran"`], { MAC_SLOT_LOAD_WAIT_SECONDS: '2' });
    expect(await r.done).toBe(75);
    expect(existsSync(join(fake, 'ran'))).toBe(false);
    expect(r.err()).toMatch(/^mac-slot: refused: /m);
    expect(r.err()).not.toMatch(/could not read the load|starting tests slot/);
  });

  // Lead T16: only a well-formed number (digits, optionally a dot and digits) is a load; "." read as 0 and
  // "1.2.3" as 1.2 used to start a run after a high reading.
  for (const bad of ['.', '1.2.3']) {
    it(`a malformed load "${bad}" after a high one keeps waiting and refuses at the bound (lead T16)`, async () => {
      setLoads('12.00', bad);
      const r = bg('tests', ['sh', '-c', `touch "${fake}/ran"`], { MAC_SLOT_LOAD_WAIT_SECONDS: '2' });
      expect(await r.done).toBe(75);
      expect(existsSync(join(fake, 'ran'))).toBe(false);
      expect(r.err()).toMatch(/^mac-slot: refused: /m);
    });
  }

  it('a malformed first load "." fails open as unreadable and starts (lead T16)', async () => {
    setLoads('.');
    const r = bg('tests', ['sh', '-c', `touch "${fake}/ran"`], { MAC_SLOT_LOAD_WAIT_SECONDS: '2' });
    expect(await r.done).toBe(0);
    expect(existsSync(join(fake, 'ran'))).toBe(true);
    expect(r.err()).toMatch(/could not read the load; not waiting/);
  });

  it('a 0-second bound refuses saying "after 0s" (lead T16)', async () => {
    setLoads('12.00');
    const r = bg('tests', ['sh', '-c', `touch "${fake}/ran"`], { MAC_SLOT_LOAD_WAIT_SECONDS: '0' });
    expect(await r.done).toBe(75);
    expect(r.err()).toMatch(/still 8 or more after 0s; not starting/);
  });

  it('a load that drops below the cap within the bound starts the command', async () => {
    setLoads('12.00', '12.00', '2.00');
    const r = bg('tests', ['sh', '-c', `touch "${fake}/ran"`], { MAC_SLOT_LOAD_WAIT_SECONDS: '10' });
    expect(await r.done).toBe(0);
    expect(existsSync(join(fake, 'ran'))).toBe(true);
    expect(r.err()).not.toMatch(/refused/);
  });

  it('a waiter killed during the load wait frees its slot at once (its sleep holds no slot fd)', async () => {
    setLoads('12.00');
    const extra = { MAC_SLOT_POLL_SECONDS: '30', MAC_SLOT_CODEX_MAX: '1' };
    const a = bg('codex', hold('a'), extra);
    await until(() => /waiting: 1-minute load/.test(a.err()));
    a.p.kill('SIGKILL');
    await a.done;
    const t = Date.now();
    await until(() => /codex: 0\/1 held/.test(
      spawnSync('sh', [SCRIPT, 'status'], { env: env(extra), encoding: 'utf8' }).stdout), 5000);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(started('a')).toBe(false);
  });

  it('TERM during the load wait exits promptly with 143', async () => {
    setLoads('12.00');
    const a = bg('codex', hold('a'), { MAC_SLOT_POLL_SECONDS: '30' });
    await until(() => /waiting: 1-minute load/.test(a.err()));
    const t = Date.now();
    a.p.kill('SIGTERM');
    expect(await a.done).toBe(143);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(started('a')).toBe(false);
  });

  it('TERM while waiting for a slot exits promptly with 143 and drops its waiting entry', async () => {
    const extra = { MAC_SLOT_POLL_SECONDS: '30', MAC_SLOT_CODEX_MAX: '1' };
    bg('codex', hold('a'), extra);
    await until(() => started('a'));
    const w = bg('codex', hold('b'), extra);
    await until(() => /waiting for a codex slot/.test(w.err()));
    expect(marker(w.p.pid)).toHaveLength(1);
    const t = Date.now();
    w.p.kill('SIGTERM');
    expect(await w.done).toBe(143);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(marker(w.p.pid)).toEqual([]);
    expect(started('b')).toBe(false);
  });

  // A queued waiter must not spin: macOS lockf in its fd form burns a full core while it blocks, so the slot wait
  // tries an instant lockf every 0.2 s. CPU over a 3 s wait = the live children's time from ps just before TERM
  // (a blocked lockf) plus /usr/bin/time's count after TERM (the shell and every child it reaped). A live child
  // the shell then reaps is counted twice, so the sum is an upper bound: the spinning script read 6.06 s, about
  // 3 s of it the one lockf. An exec drops a process's child counts on macOS, so the waiter is ended by TERM,
  // never by starting its command.
  it('a slot waiter uses almost no CPU while it waits', async () => {
    const extra = { MAC_SLOT_POLL_SECONDS: '30', MAC_SLOT_CODEX_MAX: '1' };
    bg('codex', hold('a'), extra);
    await until(() => started('a'));
    const p = spawn('/usr/bin/time', ['-p', 'sh', SCRIPT, 'codex', '--', 'true'], { env: env(extra) });
    kids.push(p);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const done = new Promise<number>((r) => p.on('exit', (c) => r(c ?? -1)));
    await until(() => /waiting for a codex slot/.test(err));
    await new Promise((r) => setTimeout(r, 3000));
    const sh = spawnSync('pgrep', ['-P', String(p.pid)], { encoding: 'utf8' }).stdout.trim();
    const live = spawnSync('pgrep', ['-P', sh], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    const ps = live.length ? spawnSync('ps', ['-o', 'time=', '-p', live.join(',')], { encoding: 'utf8' }).stdout : '';
    const liveCpu = ps.trim().split('\n').filter(Boolean)
      .reduce((t, l) => { const [m, sec] = l.trim().split(':'); return t + Number(m) * 60 + Number(sec); }, 0);
    process.kill(Number(sh), 'SIGTERM');
    expect(await done).toBe(143);
    const cpu = (k: string) => Number(new RegExp(`^${k} +([0-9.]+)$`, 'm').exec(err)?.[1]);
    const total = liveCpu + cpu('user') + cpu('sys');
    expect(Number.isNaN(total)).toBe(false);
    expect(total).toBeLessThan(0.3);
  }, 20000);

  it('INT while waiting for a slot exits promptly with 130 and drops its waiting entry', async () => {
    const extra = { MAC_SLOT_POLL_SECONDS: '30', MAC_SLOT_CODEX_MAX: '1' };
    bg('codex', hold('a'), extra);
    await until(() => started('a'));
    const w = bg('codex', hold('b'), extra);
    await until(() => /waiting for a codex slot/.test(w.err()));
    expect(marker(w.p.pid)).toHaveLength(1);
    const t = Date.now();
    w.p.kill('SIGINT');
    expect(await w.done).toBe(130);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(marker(w.p.pid)).toEqual([]);
    expect(started('b')).toBe(false);
  });

  // R1 (PR 1427 review): a caller that reruns straight after its own run scans within milliseconds of the slot
  // freeing. Waiters queue by marker and a newcomer defers to a live one, so the chain cannot starve them; the old
  // blocking lockf likewise handed a freed slot to a blocked waiter at once.
  const chain = (runs: number) => ['sh', '-c', `i=1; while [ $i -le ${runs} ]; do sh "${SCRIPT}" codex -- sh -c "echo C$i >> '${fake}/order'; sleep 0.5"; i=$((i + 1)); done`];
  const queued = (name: string) => ['sh', '-c', `echo ${name} >> "${fake}/order"; sleep 0.3`];
  const order = () => (existsSync(join(fake, 'order')) ? readFileSync(join(fake, 'order'), 'utf8').trim().split('\n') : []);
  it('a waiter runs before a chain of back-to-back runs ends (no starvation)', async () => {
    const extra = { MAC_SLOT_CODEX_MAX: '1' };
    const ch = spawn(chain(6)[0], chain(6).slice(1), { env: env(extra) });
    kids.push(ch);
    const chDone = new Promise<number>((r) => ch.on('exit', (x) => r(x ?? -1)));
    await until(() => order().includes('C1'));
    const w = bg('codex', queued('W'), extra);
    expect(await chDone).toBe(0);
    expect(await w.done).toBe(0);
    const o = order();
    expect(o.indexOf('W')).toBeGreaterThan(-1);
    expect(o.indexOf('W')).toBeLessThan(o.indexOf('C6'));
  }, 30000);

  it('two waiters run in arrival order, before a chain of back-to-back runs ends', async () => {
    const extra = { MAC_SLOT_CODEX_MAX: '1' };
    const ch = spawn(chain(6)[0], chain(6).slice(1), { env: env(extra) });
    kids.push(ch);
    const chDone = new Promise<number>((r) => ch.on('exit', (x) => r(x ?? -1)));
    await until(() => order().includes('C1'));
    const w1 = bg('codex', queued('W1'), extra);
    await until(() => /waiting for a codex slot/.test(w1.err()));
    const w2 = bg('codex', queued('W2'), extra);
    expect(await chDone).toBe(0);
    expect(await w1.done).toBe(0);
    expect(await w2.done).toBe(0);
    const o = order();
    expect(o.indexOf('W1')).toBeGreaterThan(-1);
    expect(o.indexOf('W1')).toBeLessThan(o.indexOf('W2'));
    expect(o.indexOf('W2')).toBeLessThan(o.indexOf('C6'));
  }, 30000);

  // R2: a waiter tries every slot on each retry, so a slot freeing while another stays held is taken within ~0.2 s.
  // The slot released is the one the old code's waiter did not watch (pid mod N + 1), so the pin is deterministic.
  it('with 2 slots, a waiter takes a freed slot within 1 s while the other stays held', async () => {
    const extra = { MAC_SLOT_POLL_SECONDS: '30', MAC_SLOT_CODEX_MAX: '2' };
    bg('codex', hold('a'), extra);
    await until(() => started('a'));
    bg('codex', hold('b'), extra);
    await until(() => started('b'));
    const w = bg('codex', hold('c'), extra);
    await until(() => /waiting for a codex slot/.test(w.err()));
    const watched = ((w.p.pid ?? 0) % 2) + 1;
    release(watched === 1 ? 'b' : 'a'); // a holds slot 1, b slot 2
    const t = Date.now();
    await until(() => started('c'), 5000);
    expect(Date.now() - t).toBeLessThan(1000);
  }, 20000);

  // Lead T17: under a decimal-comma locale sysctl prints "6,44", which read as unreadable and failed open. This
  // runs the real sysctl path (no injected reader) under de_DE with a cap of 0, so a read load always waits and a
  // 0-second bound refuses; a fake sysctl would only test our guess of its locale behaviour.
  const commaLocale = process.platform === 'darwin'
    && /,/.test(spawnSync('sysctl', ['-n', 'vm.loadavg'], { env: { ...process.env, LC_ALL: 'de_DE.UTF-8' }, encoding: 'utf8' }).stdout ?? '');
  it.skipIf(!commaLocale)('reads the real load under a decimal-comma locale (lead T17)', async () => {
    const r = bg('tests', ['sh', '-c', `touch "${fake}/ran"`],
      { LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', MAC_SLOT_LOAD_CMD: '', MAC_SLOT_MAX_LOAD: '0', MAC_SLOT_LOAD_WAIT_SECONDS: '0' });
    expect(await r.done).toBe(75);
    expect(existsSync(join(fake, 'ran'))).toBe(false);
    expect(r.err()).toMatch(/refused: the 1-minute load [0-9]+\.[0-9]+ is still 0 or more after 0s/);
    expect(r.err()).not.toMatch(/could not read the load/);
  });

  // R4 (PR 1427 review): a marker is live only while its waiter holds the kernel lock on it (fd 7). A pid can be
  // reused, and a marker left by a SIGKILL or a reboot names one; on 220c9803c ahead() judged by `kill -0`, so a
  // stale marker naming any live pid queued every caller of that kind behind it, with no limit.
  const sleeper = () => { const s = spawn('sleep', ['300']); kids.push(s); return s.pid ?? 0; };
  const waiting = (kind: string) => (existsSync(home) ? readdirSync(home).filter((f) => f.startsWith(`waiting.${kind}.`)) : []);
  it('a stale marker naming a live unrelated pid does not hold up a caller (R4)', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, `waiting.codex.${Date.now() - 60000}.${sleeper()}`), 'left behind\n');
    const t = Date.now();
    const s = spawnSync('sh', [SCRIPT, 'codex', '--', 'true'], { env: env(), encoding: 'utf8', timeout: 5000 });
    expect(s.status).toBe(0);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(s.stderr).not.toMatch(/waiting for a codex slot/);
    expect(waiting('codex')).toEqual([]);
  });

  it('a marker left from before a reboot (unlocked, naming a live pid) is cleared by status and blocks no one (R4)', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, `waiting.tests.1000000000000.${process.pid}`), 'before the reboot\n');
    const st = spawnSync('sh', [SCRIPT, 'status'], { env: env(), encoding: 'utf8' });
    expect(st.stdout).toMatch(/tests: 0\/3 held, 0 waiting/);
    expect(waiting('tests')).toEqual([]);
    writeFileSync(join(home, `waiting.tests.1000000000000.${process.pid}`), 'before the reboot\n');
    const s = spawnSync('sh', [SCRIPT, 'tests', '--', 'true'], { env: env(), encoding: 'utf8', timeout: 5000 });
    expect(s.status).toBe(0);
    expect(s.stderr).not.toMatch(/waiting for a tests slot/);
    expect(waiting('tests')).toEqual([]);
  });

  it('a waiter SIGKILLed mid-wait holds up no one, and leaves no marker once the next caller runs (R4)', async () => {
    const extra = { MAC_SLOT_CODEX_MAX: '1' };
    bg('codex', hold('a'), extra);
    await until(() => started('a'));
    const w = bg('codex', hold('b'), extra);
    await until(() => /waiting for a codex slot/.test(w.err()));
    w.p.kill('SIGKILL');
    await w.done;
    release('a');
    const t = Date.now();
    const s = spawnSync('sh', [SCRIPT, 'codex', '--', 'true'], { env: env(extra), encoding: 'utf8', timeout: 5000 });
    expect(s.status).toBe(0);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(started('b')).toBe(false);
    expect(waiting('codex')).toEqual([]);
  });

  it('the command does not inherit the queue marker descriptor (fd 7), only the slot (fd 9) (R4)', async () => {
    const extra = { MAC_SLOT_CODEX_MAX: '1' };
    bg('codex', hold('a'), extra);
    await until(() => started('a'));
    const w = bg('codex', ['sh', '-c', `ls /dev/fd > "${fake}/fds"`], extra);
    await until(() => /waiting for a codex slot/.test(w.err()));
    release('a');
    expect(await w.done).toBe(0);
    const fds = readFileSync(join(fake, 'fds'), 'utf8').trim().split('\n');
    expect(fds).toContain('9');
    expect(fds).not.toContain('7');
  });

  // R5: a caller writes and locks its marker before its first scan, so arrival order is start order. On 220c9803c
  // the marker came only after a failed `scan retry` (0.6 s with three slots held), and a later caller could slip in.
  it('a caller holds its marker before its first scan ends (R5)', async () => {
    for (const n of ['a', 'b', 'c']) bg('tests', hold(n));
    await until(() => started('a') && started('b') && started('c'));
    const d = bg('tests', hold('d'));
    await new Promise((r) => setTimeout(r, 300));
    expect(waiting('tests').filter((f) => f.endsWith(`.${d.p.pid}`))).toHaveLength(1);
  });

  it('two callers started 0.15 s apart while the slot is held run in that order, every time (R5)', async () => {
    const extra = { MAC_SLOT_CODEX_MAX: '1' };
    for (let round = 0; round < 3; round += 1) {
      const h = bg('codex', hold('x'), extra);
      await until(() => started('x'));
      const first = bg('codex', queued(`F${round}`), extra);
      await new Promise((r) => setTimeout(r, 150));
      const second = bg('codex', queued(`S${round}`), extra);
      await until(() => /waiting for a codex slot/.test(first.err()) && /waiting for a codex slot/.test(second.err()));
      release('x');
      expect(await h.done).toBe(0);
      expect(await first.done).toBe(0);
      expect(await second.done).toBe(0);
      rmSync(join(fake, 'x.go'));
      rmSync(join(fake, 'x.log'));
      expect(order().slice(-2)).toEqual([`F${round}`, `S${round}`]);
    }
  }, 30000);

  it('honours MAC_SLOT_MAX_LOAD', async () => {
    setLoads('9.00');
    const r = bg('tests', ['true'], { MAC_SLOT_MAX_LOAD: '10' });
    expect(await r.done).toBe(0);
    expect(r.err()).not.toMatch(/waiting/);
  });

  // Isolation from real slot runs on this Mac (US-71 AC11). Agents run these tests under a real `tests` slot,
  // with their own MAC_SLOT_* and PATH exported.
  it("a caller's MAC_SLOT_* and PATH change nothing, and a decoy MAC_SLOT_HOME stays empty", () => {
    const decoy = join(dir, 'decoy');
    mkdirSync(decoy);
    const saved = { ...process.env };
    Object.assign(process.env, { MAC_SLOT_MAX_LOAD: '1', MAC_SLOT_LOAD_WAIT_SECONDS: '0', MAC_SLOT_LOAD_WAIT_MIN: '0',
      MAC_SLOT_HOME: decoy, PATH: `${join(dir, 'node_modules', '.bin')}:${process.env.PATH}` });
    try {
      const s = spawnSync('sh', [SCRIPT, 'tests', '--', 'sh', '-c', 'echo "$PATH"'], { env: env(), encoding: 'utf8', timeout: 5000 });
      expect(s.status).toBe(0);
      expect(s.stderr).toMatch(/starting tests slot 1\/3 \(load 1\.00\)/);
      expect(s.stdout).not.toMatch(/node_modules/);
      expect(readdirSync(decoy)).toEqual([]);
      expect(readdirSync(home)).toContain('tests.1');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('a child a test spawns holds no fd 9 and no descriptor into the real slot folder', async () => {
    const r = bg('tests', ['true']);
    expect(await r.done).toBe(0);
    const p = spawn('sh', ['-c', 'ls /dev/fd; lsof -a -p $$ -Fn'], { env: env(), detached: true });
    const done = track(p);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    await done;
    expect(out.split('\n')).not.toContain('9');
    expect(out).toMatch(/^n/m);
    expect(out).not.toContain('health-roadmap-slots');
  });

  // Modelled on T22 in ios/scripts/sim-run.test.ts: the first test leaves a grandchild that names its folder
  // (a shell the command forked, outside afterEach's direct children), then fails; the second checks, after
  // afterEach, that nothing names that folder. vitest flips the first result after afterEach, so the check
  // lives in the next test.
  describe('a test that fails mid-run leaves nothing behind', () => {
    const left = { dir: '', ready: false };
    const named = () => spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout
      .split('\n').filter((l) => left.dir && l.includes(left.dir));
    it.fails('(fails on purpose) a test fails while a holder and its grandchild run', async () => {
      left.dir = dir;
      bg('tests', ['sh', '-c', `sh -c 'while :; do sleep 0.2; done; : ${dir}' & echo started > "${fake}/g.log"; wait`]);
      await until(() => started('g'));
      await until(() => named().length >= 2);
      left.ready = true;
      throw new Error('a test failing mid-run');
    });

    it('afterEach left no process naming its folder, a second later too', async () => {
      expect(left.ready).toBe(true);
      expect(named()).toEqual([]);
      await new Promise((r) => setTimeout(r, 1000));
      expect(named()).toEqual([]);
      expect(existsSync(left.dir)).toBe(false);
    });
  });

  it('refuses an unknown kind and a missing command with exit 64', () => {
    expect(spawnSync('sh', [SCRIPT, 'build', '--', 'true'], { env: env() }).status).toBe(64);
    expect(spawnSync('sh', [SCRIPT, 'codex', '--'], { env: env() }).status).toBe(64);
  });
});

describe('US-71 AC9 mac-slot.sh off a shared Mac (CI, Linux)', () => {
  it('in CI runs the command directly, no queue, exit code kept', () => {
    const s = spawnSync('sh', [SCRIPT, 'codex', '--', 'sh', '-c', 'echo ran; exit 3'],
      { env: env({ CI: 'true', MAC_SLOT_CODEX_MAX: '0' }), encoding: 'utf8' });
    expect(s.status).toBe(3);
    expect(s.stdout).toBe('ran\n');
    expect(existsSync(home)).toBe(false);
  });

  it('on Linux runs the command directly', () => {
    writeFileSync(join(fake, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
    const s = spawnSync('sh', [SCRIPT, 'tests', '--', 'sh', '-c', 'echo ran'],
      { env: env({ PATH: `${fake}:${process.env.PATH}`, MAC_SLOT_TESTS_MAX: '0' }), encoding: 'utf8' });
    expect(s.status).toBe(0);
    expect(s.stdout).toBe('ran\n');
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(join(fake, 'loads'), 'utf8')).toBe('1.00\n');
  });
});
