/**
 * US-64 AC26: tools/wait-run.sh waits for a run or a PR's checks and exits by the verdict. A stub `gh` and `curl`
 * on PATH play GitHub and the live app: the first status poll answers "in progress", later ones "done". A stub
 * `sleep` and `date` share a fake clock, so the 60 s floor, the backoff and the rate-limit sleep run instantly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'wait-run.sh');
let S: string;

beforeAll(() => {
  S = mkdtempSync(join(tmpdir(), 'wait-run-'));
  // Each status poll bumps a counter: polls before DONE_AT (default 2) are pending, later ones finished. Every
  // call is logged, so a test can count gh calls per poll.
  writeFileSync(join(S, 'gh'), `#!/bin/sh
echo "$*" | tr "\\n" " " >> "$STATE.calls"; echo >> "$STATE.calls"
[ -n "\${GH_FAIL:-}" ] && exit 1
[ -n "\${GH_SLEEP:-}" ] && exec /bin/sleep "$GH_SLEEP" # one process, as the real gh is
n=$(cat "$STATE" 2>/dev/null || echo 0)
case "$*" in
  *rate_limit*) echo "\${RL_LEFT:-4000} \${RL_RESET:-0}" ;;
  *actions/runs/*) n=$((n+1)); echo $n > "$STATE"; [ $n -ge "\${DONE_AT:-2}" ] && echo done || echo in_progress ;;
  *"conclusion,headSha,jobs"*) [ -n "\${JOBS_FAIL:-}" ] && exit 1; echo "conclusion=$CONCLUSION"; echo "head=abc123"; echo "job deploy=$CONCLUSION" ;;
  *statusCheckRollup*) n=$((n+1)); echo $n > "$STATE"; [ $n -ge "\${DONE_AT:-2}" ] && echo done || echo pending ;;
  *"pass="*) [ -n "\${CHECKS_FAIL:-}" ] && exit 1; echo "pass=3 fail=$FAILS skipped=0 pending=0"; [ "$FAILS" = 0 ] || echo "failed: \${FAILNAME:-test}" ;;
  *headRefOid*) [ -n "\${VIEW_FAIL:-}" ] && exit 1; echo "head=abc123"; echo "state=OPEN mergeable=MERGEABLE mergeState=CLEAN" ;;
esac
`);
  // The fake clock starts at 1,000,000 s; each sleep logs its length and moves the clock on.
  writeFileSync(join(S, 'date'), `#!/bin/sh
[ "$1" = +%s ] || exec /bin/date "$@"
cat "$STATE.clock" 2>/dev/null || echo 1000000
`);
  writeFileSync(join(S, 'sleep'), `#!/bin/sh
echo "$1" >> "$STATE.sleeps"
t=$(cat "$STATE.clock" 2>/dev/null || echo 1000000); echo $((t + $1)) > "$STATE.clock"
`);
  chmodSync(join(S, 'date'), 0o755);
  chmodSync(join(S, 'sleep'), 0o755);
  writeFileSync(join(S, 'curl'), '#!/bin/sh\nprintf "%s" "$HEALTH"\n');
  chmodSync(join(S, 'gh'), 0o755);
  chmodSync(join(S, 'curl'), 0o755);
});
afterAll(() => rmSync(S, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const state = join(S, `state-${Math.random()}`);
  const base = { ...process.env };
  delete base.WAIT_RUN_INTERVAL;
  const r = spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...base, PATH: `${S}:${process.env.PATH}`, STATE: state,
      CONCLUSION: 'success', HEALTH: '200', FAILS: '0', ...env },
  });
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { ...r, sleeps: lines(`${state}.sleeps`).map(Number), calls: lines(`${state}.calls`) };
}

describe('wait-run.sh (US-64 AC26)', () => {
  it('deploy: waits past "in progress", prints the verdict and exits 0 on success with healthz 200', () => {
    const r = run(['deploy', '123']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('conclusion=success');
    expect(r.stdout).toContain('head=abc123');
    expect(r.stdout).toContain('job deploy=success');
    expect(r.stdout).toContain('healthz=200');
  });
  it('deploy: exits 1 on a failed run, and on a healthz that is not 200', () => {
    expect(run(['deploy', '123'], { CONCLUSION: 'failure' }).status).toBe(1);
    expect(run(['deploy', '123'], { HEALTH: '503' }).status).toBe(1);
  });
  it('pr: waits past pending checks, then prints counts, head and mergeability', () => {
    const r = run(['pr', '42']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pass=3 fail=0');
    expect(r.stdout).toContain('mergeable=MERGEABLE');
  });
  it('pr: exits 1 and names the failed check', () => {
    const r = run(['pr', '42'], { FAILS: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('failed: test');
  });
  it('gives up with exit 3 after 10 gh errors in a row, never hangs', () => {
    expect(run(['deploy', '123'], { GH_FAIL: '1' }).status).toBe(3);
    expect(run(['pr', '42'], { GH_FAIL: '1' }).status).toBe(3);
  });
  it('exits 1 when a final read fails, never a silent success', () => {
    expect(run(['deploy', '123'], { JOBS_FAIL: '1' }).status).toBe(1);
    expect(run(['pr', '42'], { VIEW_FAIL: '1' }).status).toBe(1);
  });
  it('a failing checks read after the wait still gives up at the time limit (Codex re-check R1)', () => {
    expect(run(['pr', '42'], { CHECKS_FAIL: '1', WAIT_RUN_MAX_MIN: '0' }).status).toBe(3);
  });
  it('a failed check named like a verdict cannot turn it into success (Codex re-check R2)', () => {
    expect(run(['pr', '42'], { FAILS: '1', FAILNAME: 'x fail=0 skipped=0 pending=0' }).status).toBe(1);
  });
  it('cuts off a gh call that hangs, so the time limit still holds', () => {
    const t = Date.now();
    expect(run(['deploy', '123'], { GH_SLEEP: '30', WAIT_RUN_GH_TIMEOUT: '1', WAIT_RUN_MAX_MIN: '0' }).status).toBe(3);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
  it('gives up with exit 3 at the time limit', () => {
    expect(run(['deploy', '123'], { WAIT_RUN_MAX_MIN: '0' }).status).toBe(3);
  });
  it('refuses a bad mode or id with exit 2', () => {
    expect(run(['deploy', 'abc']).status).toBe(2);
    expect(run(['watch', '1']).status).toBe(2);
    expect(run([]).status).toBe(2);
    expect(run(['deploy', '1'], { WAIT_RUN_INTERVAL: 'x' }).status).toBe(2);
  });
  it('polls every 60 s by default and never faster, whatever WAIT_RUN_INTERVAL asks', () => {
    expect(run(['deploy', '123']).sleeps).toEqual([60]);
    expect(run(['deploy', '123'], { WAIT_RUN_INTERVAL: '5' }).sleeps).toEqual([60]);
    expect(run(['pr', '42'], { WAIT_RUN_INTERVAL: '0' }).sleeps).toEqual([60]);
    expect(run(['deploy', '123'], { WAIT_RUN_INTERVAL: '90' }).sleeps).toEqual([90]);
  });
  it('backs off: 120 s after 10 min of waiting, 300 s after 30 min', () => {
    const r = run(['deploy', '123'], { DONE_AT: '25' });
    expect(r.status).toBe(0);
    expect(r.sleeps).toEqual([...Array(10).fill(60), ...Array(10).fill(120), ...Array(4).fill(300)]);
  });
  it('makes one gh call per poll in each mode, plus a free rate-limit read every 10th poll', () => {
    for (const mode of ['deploy', 'pr']) {
      const r = run([mode, '42'], { DONE_AT: '25' });
      const polls = r.calls.filter((c) => /actions\/runs\/|statusCheckRollup/.test(c));
      expect(polls.length).toBe(25);
      expect(r.calls.filter((c) => c.includes('rate_limit')).length).toBe(3);
      expect(r.calls.length).toBe(25 + 3 + (mode === 'deploy' ? 1 : 2)); // + the final reads
    }
  });
  it('sleeps until the reset when under 200 requests are left, saying so once', () => {
    const r = run(['deploy', '123'], { RL_LEFT: '50', RL_RESET: '1001000' });
    expect(r.status).toBe(0);
    expect(r.sleeps).toEqual([1005]);
    expect(r.stderr).toContain('GitHub rate limit low (50 left); sleeping 1005s until it resets');
    expect(r.stdout).toContain('conclusion=success');
  });
});
