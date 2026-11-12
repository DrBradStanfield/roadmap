// US-71 AC9: tools/mac-slot.sh, a machine-wide counted queue for Codex reviews and heavy test runs. Each test
// gets its own slot directory (MAC_SLOT_HOME) and a fake load reader (MAC_SLOT_LOAD_CMD reads $FAKE/loads, one
// line per call, staying on the last), so nothing depends on the real load. Holders wait on a release file, not
// a fixed sleep, so a busy Mac cannot end them early. macOS only (lockf): CI runs Linux, so these run locally:
//   npx vitest run tools/mac-slot.test.ts
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const t = Date.now();
    w.p.kill('SIGTERM');
    expect(await w.done).toBe(143);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(existsSync(join(home, `waiting.codex.${w.p.pid}`))).toBe(false);
    expect(started('b')).toBe(false);
  });

  it('honours MAC_SLOT_MAX_LOAD', async () => {
    setLoads('9.00');
    const r = bg('tests', ['true'], { MAC_SLOT_MAX_LOAD: '10' });
    expect(await r.done).toBe(0);
    expect(r.err()).not.toMatch(/waiting/);
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
