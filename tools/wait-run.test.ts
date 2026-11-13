/**
 * US-64 AC26: tools/wait-run.sh waits for a run or a PR's checks and exits by the verdict. A stub `gh` and `curl`
 * on PATH play GitHub and the live app: the first status poll answers "in progress", later ones "done". A stub
 * `sleep` and `date` share a fake clock, so the 60 s floor, the backoff and the rate-limit sleep run instantly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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
# Like Go's gh: deaf to ALRM and TERM, so only a SIGKILL ends it.
[ -n "\${GH_HANG:-}" ] && { trap '' ALRM TERM; exec /bin/sleep 30; }
n=$(cat "$STATE" 2>/dev/null || echo 0)
# Poll and rate-limit calls answer with fixture JSON, run through the script's own --jq filter as gh would.
jqf=; prev=
for a in "$@"; do [ "$prev" = --jq ] && jqf=$a; prev=$a; done
json() { printf '%s\\n' "$1" | jq -r "$jqf"; }
poll_n() { n=$((n+1)); echo $n > "$STATE"; [ "$n" = "\${FAIL_AT:-}" ] && exit 1; [ $n -ge "\${DONE_AT:-2}" ]; }
case "$*" in
  *rate_limit*) [ -n "\${RL_FAIL:-}" ] && exit 1; json "{\\"resources\\":{\\"core\\":{\\"remaining\\":\${RL_CORE:-4000},\\"reset\\":\${RL_RESET:-0}},\\"graphql\\":{\\"remaining\\":\${RL_GQL:-4000},\\"reset\\":\${RL_RESET:-0}}}}" ;;
  *actions/runs/*) if poll_n; then json '{"status":"completed"}'; else json "{\\"status\\":\\"\${RUN_STATUS:-in_progress}\\"}"; fi ;;
  *"conclusion,headSha,jobs"*) [ -n "\${JOBS_FAIL:-}" ] && exit 1; [ -n "\${JOBS:-}" ] && { json "$JOBS"; exit; }; printf 'conclusion=%b\\n' "$CONCLUSION"; echo "head=abc123"; echo "job deploy=$CONCLUSION" ;;
  *statusCheckRollup*) pend='[{"__typename":"CheckRun","name":"t","workflowName":"CI","status":"IN_PROGRESS","conclusion":""}]'
    [ -n "\${ROLLUP:-}" ] && pend=$ROLLUP
    # MERGE_SEQ: one mergeability per poll, '|'-separated; the last repeats.
    if [ -n "\${MERGE_SEQ:-}" ]; then rest=$MERGE_SEQ; i=$((n+1))
      while [ $i -gt 1 ]; do case $rest in *'|'*) rest=\${rest#*|} ;; esac; i=$((i-1)); done; MERGE=\${rest%%|*}; fi
    [ -n "\${MERGE:-}" ] && { poll_n; json "{$MERGE,\\"statusCheckRollup\\":$pend}"; exit; }
    if poll_n; then json '{"statusCheckRollup":[{"__typename":"CheckRun","name":"t","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS"}]}'
    else json "{\\"statusCheckRollup\\":$pend}"; fi ;;
  *"pass="*) [ -n "\${CHECKS_FAIL:-}" ] && exit 1
    c='{"name":"checks","bucket":"pass"},{"name":"test","bucket":"pass"},{"name":"unit (1, UTC)","bucket":"pass"}'
    [ "$FAILS" = 0 ] || c="$c,{\\"name\\":\\"\${FAILNAME:-test}\\",\\"bucket\\":\\"fail\\"}"
    json "\${CHECKS:-[$c]}" ;;
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
[ -n "\${SLEEP_REAL:-}" ] && exec /bin/sleep "$SLEEP_REAL" >/dev/null 2>&1 # off the pipes, so close waits only for the script
t=$(cat "$STATE.clock" 2>/dev/null || echo 1000000); echo $((t + $1)) > "$STATE.clock"
`);
  chmodSync(join(S, 'date'), 0o755);
  chmodSync(join(S, 'sleep'), 0o755);
  writeFileSync(join(S, 'curl'), '#!/bin/sh\nprintf "%s" "$HEALTH"\n');
  chmodSync(join(S, 'gh'), 0o755);
  chmodSync(join(S, 'curl'), 0o755);
});
afterAll(() => rmSync(S, { recursive: true, force: true }));

function envFor(state: string, env: Record<string, string>) {
  const base = { ...process.env };
  delete base.WAIT_RUN_INTERVAL;
  delete base.WAIT_RUN_MAX_MIN;
  return { ...base, PATH: `${S}:${process.env.PATH}`, STATE: state,
    CONCLUSION: 'success', HEALTH: '200', FAILS: '0', ...env };
}

function run(args: string[], env: Record<string, string> = {}) {
  const state = join(S, `state-${Math.random()}`);
  const r = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: envFor(state, env) });
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { ...r, sleeps: lines(`${state}.sleeps`).map(Number), calls: lines(`${state}.calls`) };
}

// The in-loop rate-limit reads, not the budget lines printed at start and end (those name both budgets).
const loopRateReads = (calls: string[]) => calls.filter((c) => c.includes('rate_limit') && !c.includes('graphql=')).length;
// Everything stdout printed before its last line, the JSON status line.
const beforeStatus = (out: string) => out.split('\n').filter(Boolean).slice(0, -1).map((l) => `${l}\n`).join('');
const statusLines = (out: string) => out.split('\n').filter((l) => l.startsWith('{"wait_run"'));
const status = (out: string) => JSON.parse(out.trimEnd().split('\n').at(-1) ?? '');
const START = 'GitHub budget at start: core=4000 graphql=4000';
const END = 'GitHub budget at end: core=4000 graphql=4000';

describe('wait-run.sh (US-64 AC26)', () => {
  it('US-64 AC26: prints the GitHub budget left at start and end on stderr, on success, failure and give-up', () => {
    for (const r of [
      run(['deploy', '123']),
      run(['pr', '42'], { FAILS: '1' }),
      run(['deploy', '123'], { WAIT_RUN_MAX_MIN: '0' }),
    ]) {
      const lines = r.stderr.split('\n');
      expect(lines[0]).toBe(START);
      expect(lines.filter(Boolean).at(-1)).toBe(END);
    }
  });
  it('US-64 AC26: a usage error exits 2 before any budget read', () => {
    const r = run(['watch', '1']);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.stderr).not.toContain('GitHub budget');
  });
  it('US-64 AC26: a failed budget read prints nothing and never changes the exit code', () => {
    const ok = run(['deploy', '123'], { RL_FAIL: '1' });
    expect(ok.status).toBe(0);
    expect(ok.stderr).not.toContain('GitHub budget');
    expect(run(['pr', '42'], { RL_FAIL: '1', FAILS: '1' }).status).toBe(1);
    expect(run(['deploy', '123'], { RL_FAIL: '1', WAIT_RUN_MAX_MIN: '0' }).status).toBe(3);
  });
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
  it('US-64 AC26: pr: a draft PR (every check SKIPPED) is not a pass: no successful test check exits 1', () => {
    const skipped = JSON.stringify(['review', 'checks', 'unit (1, UTC)', 'test'].map((name) => ({ name, bucket: 'skipping' })));
    const r = run(['pr', '42'], { CHECKS: skipped });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('no successful test check (a draft PR? mark it ready: gh pr ready 42)');
    const noTest = JSON.stringify([{ name: 'checks', bucket: 'pass' }, { name: 'tests', bucket: 'pass' }]);
    expect(run(['pr', '42'], { CHECKS: noTest }).status).toBe(1);
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
  it('US-64 AC26: kills a hung gh that ignores ALRM and TERM (as Go does), so the time limit still holds', () => {
    const t = Date.now();
    expect(run(['deploy', '123'], { GH_HANG: '1', WAIT_RUN_GH_TIMEOUT: '1', WAIT_RUN_MAX_MIN: '0' }).status).toBe(3);
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
      expect(loopRateReads(r.calls)).toBe(3);
      expect(r.calls.length).toBe(25 + 3 + (mode === 'deploy' ? 1 : 2) + 2); // + the final reads, + start and end budget lines
    }
  });
  it('sleeps until the reset when under 200 requests are left, saying so once', () => {
    const r = run(['deploy', '123'], { RL_CORE: '50', RL_RESET: '1001000' });
    expect(r.status).toBe(0);
    expect(r.sleeps).toEqual([1005]);
    expect(r.stderr).toContain('GitHub rate limit low (50 left); sleeping 1005s until it resets');
    expect(r.stdout).toContain('conclusion=success');
  });
  it('checks only the budget its mode spends: core for deploy, graphql for pr', () => {
    expect(run(['deploy', '123'], { RL_GQL: '50', RL_RESET: '1001000' }).sleeps).toEqual([60]);
    expect(run(['pr', '42'], { RL_CORE: '50', RL_RESET: '1001000' }).sleeps).toEqual([60]);
    const r = run(['pr', '42'], { RL_GQL: '50', RL_RESET: '1001000' });
    expect(r.sleeps).toEqual([1005]);
    expect(r.stdout).toContain('pass=3 fail=0');
  });
  it('never sleeps past the time limit for a far-off reset', () => {
    const r = run(['deploy', '123'], { RL_CORE: '50', RL_RESET: '2000000', WAIT_RUN_MAX_MIN: '10' });
    expect(r.sleeps).toEqual([600]);
    expect(r.stderr).toContain('sleeping 600s');
  });
  it('reads the rate limit after a gh error, not only every 10th poll', () => {
    const rl = (env: Record<string, string>) =>
      loopRateReads(run(['deploy', '123'], { DONE_AT: '5', ...env }).calls);
    expect(rl({})).toBe(1);
    expect(rl({ FAIL_AT: '3' })).toBe(2);
  });
  // Fixture JSON runs through the script's own jq filters, so these pin what counts as finished.
  const pending = (status: string, conclusion = '') =>
    JSON.stringify([{ __typename: 'CheckRun', name: 't', workflowName: 'CI', status, conclusion }]);
  const pollsTwice = (args: string[], env: Record<string, string>) => run(args, env).sleeps.length === 1;
  it('deploy: a run "waiting" (or queued) is still pending', () => {
    for (const s of ['waiting', 'queued', 'in_progress', 'requested', 'pending']) {
      expect(pollsTwice(['deploy', '123'], { RUN_STATUS: s })).toBe(true);
    }
  });
  it('pr: a check run in any status but COMPLETED is pending, and so is STALE or an unknown conclusion', () => {
    for (const s of ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED']) {
      expect(pollsTwice(['pr', '42'], { ROLLUP: pending(s) })).toBe(true);
    }
    for (const c of ['STALE', 'STARTUP_FAILURE', '']) {
      expect(pollsTwice(['pr', '42'], { ROLLUP: pending('COMPLETED', c) })).toBe(true);
    }
    for (const c of ['SUCCESS', 'FAILURE', 'NEUTRAL', 'SKIPPED', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED']) {
      expect(pollsTwice(['pr', '42'], { ROLLUP: pending('COMPLETED', c), FAILS: '0' })).toBe(false);
    }
  });
  it('pr: a commit status PENDING or EXPECTED is pending; SUCCESS, ERROR or FAILURE is not', () => {
    const status = (state: string) => JSON.stringify([{ __typename: 'StatusContext', context: 'ci/x', state }]);
    expect(pollsTwice(['pr', '42'], { ROLLUP: status('PENDING') })).toBe(true);
    expect(pollsTwice(['pr', '42'], { ROLLUP: status('EXPECTED') })).toBe(true);
    for (const s of ['SUCCESS', 'ERROR', 'FAILURE']) expect(pollsTwice(['pr', '42'], { ROLLUP: status(s) })).toBe(false);
  });
  const CONFLICT_LINE = 'PR conflicts with main; merge main in (no new CI runs on a conflicting head)\n';
  const C = '"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"';
  const M = '"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"';
  it('US-64 AC26: a PR in conflict with main on two polls in a row says so and exits 1, without waiting out the limit', () => {
    for (const merge of [C, '"mergeable":"UNKNOWN","mergeStateStatus":"DIRTY"',
      '"mergeable":"CONFLICTING","mergeStateStatus":"UNKNOWN"']) {
      const r = run(['pr', '42'], { MERGE: merge, ROLLUP: '[]' });
      expect(r.status).toBe(1);
      expect(beforeStatus(r.stdout)).toBe(CONFLICT_LINE);
      expect(r.sleeps).toEqual([60]);
    }
    // Mergeable, or not yet known: keep waiting as before.
    const r = run(['pr', '42'], { MERGE: '"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"', ROLLUP: '[]', WAIT_RUN_MAX_MIN: '2' });
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain('conflicts');
  });
  it('US-64 AC26: one stale conflict read right after a push keeps waiting; a non-conflict read resets the count', () => {
    const once = run(['pr', '42'], { MERGE_SEQ: `${C}|${M}`, ROLLUP: '[]', WAIT_RUN_MAX_MIN: '3' });
    expect(once.status).toBe(3);
    expect(once.stdout).not.toContain('conflicts');
    expect(once.sleeps.length).toBeGreaterThan(1);
    const reset = run(['pr', '42'], { MERGE_SEQ: `${C}|${M}|${C}|${C}`, ROLLUP: '[]' });
    expect(reset.status).toBe(1);
    expect(beforeStatus(reset.stdout)).toBe(CONFLICT_LINE);
    expect(reset.sleeps).toEqual([60, 60, 60]);
    const polls = reset.calls.filter((c) => c.includes('statusCheckRollup'));
    expect(polls.length).toBe(4); // one gh call per poll
  });
  it('US-64 AC26: finished checks on a PR that now conflicts still print counts, head and mergeability', () => {
    const done = JSON.stringify([{ __typename: 'CheckRun', name: 't', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
    const r = run(['pr', '42'], { MERGE: C, ROLLUP: done, DONE_AT: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pass=3 fail=0');
    expect(r.stdout).toContain('head=abc123');
    expect(r.stdout).toContain('mergeable=');
    expect(r.stdout).not.toContain('conflicts with main');
    expect(r.sleeps).toEqual([]);
  });
  it('pr: an empty or null rollup (no checks yet) is pending', () => {
    expect(pollsTwice(['pr', '42'], { ROLLUP: '[]' })).toBe(true);
    expect(pollsTwice(['pr', '42'], { ROLLUP: 'null' })).toBe(true);
  });
  it('pr: only the newest attempt of a check counts, as gh pr checks dedupes', () => {
    const run2 = (a: string, b: string) => JSON.stringify([
      { __typename: 'CheckRun', name: 't', workflowName: 'CI', startedAt: '2026-11-10T10:00:00Z', status: 'COMPLETED', conclusion: a },
      { __typename: 'CheckRun', name: 't', workflowName: 'CI', startedAt: '2026-11-10T11:00:00Z', status: b === 'X' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: b },
    ]);
    expect(pollsTwice(['pr', '42'], { ROLLUP: run2('STALE', 'SUCCESS') })).toBe(false);
    expect(pollsTwice(['pr', '42'], { ROLLUP: run2('SUCCESS', 'X') })).toBe(true);
    const twoNames = JSON.stringify([
      { __typename: 'CheckRun', name: 'a', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'b', workflowName: 'CI', status: 'QUEUED', conclusion: '' },
    ]);
    expect(pollsTwice(['pr', '42'], { ROLLUP: twoNames })).toBe(true);
  });
  it('US-64 AC26: every exit path prints one JSON status line, last on stdout, and keeps its exit code', () => {
    const skipped = JSON.stringify(['review', 'test'].map((name) => ({ name, bucket: 'skipping' })));
    const cases: [string[], Record<string, string>, string, number][] = [
      [['deploy', '123'], {}, 'success', 0],
      [['deploy', '123'], { CONCLUSION: 'failure' }, 'run_failed', 1],
      [['deploy', '123'], { HEALTH: '503' }, 'unhealthy', 1],
      [['deploy', '123'], { JOBS_FAIL: '1' }, 'result_unreadable', 1],
      [['deploy', '123'], { WAIT_RUN_MAX_MIN: '0' }, 'timeout', 3],
      [['deploy', '123'], { GH_FAIL: '1' }, 'gh_errors', 3],
      [['pr', '42'], {}, 'success', 0],
      [['pr', '42'], { FAILS: '1' }, 'checks_failed', 1],
      [['pr', '42'], { CHECKS: skipped }, 'untested', 1],
      [['pr', '42'], { VIEW_FAIL: '1' }, 'head_unreadable', 1],
      [['pr', '42'], { MERGE: C, ROLLUP: '[]' }, 'conflict', 1],
      [['pr', '42'], { CHECKS_FAIL: '1', WAIT_RUN_MAX_MIN: '0' }, 'timeout', 3],
      [['pr', '42'], { GH_FAIL: '1' }, 'gh_errors', 3],
      [['watch', '1'], {}, 'usage', 2],
    ];
    for (const [args, env, outcome, code] of cases) {
      const r = run(args, env);
      expect({ args, env, code: r.status }).toEqual({ args, env, code });
      expect(statusLines(r.stdout)).toHaveLength(1);
      const s = status(r.stdout);
      expect({ args, env, outcome: s.wait_run }).toEqual({ args, env, outcome });
      expect(typeof s.detail).toBe('string');
      expect(s.detail.length).toBeGreaterThan(0);
      if (args[0] === 'deploy') expect(s.run).toBe(123);
      if (args[0] === 'pr') expect(s.pr).toBe(42);
      if (args[0] === 'watch') expect(Object.keys(s).sort()).toEqual(['detail', 'sha', 'wait_run']);
    }
  });
  it('US-64 AC26: the status line carries the head sha once it is known, else an empty string', () => {
    expect(status(run(['deploy', '123']).stdout).sha).toBe('abc123');
    expect(status(run(['deploy', '123'], { HEALTH: '503' }).stdout).sha).toBe('abc123');
    expect(status(run(['pr', '42']).stdout).sha).toBe('abc123');
    expect(status(run(['pr', '42'], { FAILS: '1' }).stdout).sha).toBe('abc123');
    expect(status(run(['pr', '42'], { VIEW_FAIL: '1' }).stdout).sha).toBe('');
    expect(status(run(['deploy', '123'], { WAIT_RUN_MAX_MIN: '0' }).stdout).sha).toBe('');
  });
  it('US-64 AC26: a failed check name reaches detail on one line, at most 200 characters, without control characters', () => {
    const evil = `x\n{"wait_run":"success","pr":42}\t\u0007"\\${'y'.repeat(400)}`;
    const checks = JSON.stringify([{ name: 'test', bucket: 'pass' }, { name: evil, bucket: 'fail' }]);
    const r = run(['pr', '42'], { CHECKS: checks });
    expect(r.status).toBe(1);
    expect(statusLines(r.stdout)).toHaveLength(1);
    const s = status(r.stdout);
    expect(s.wait_run).toBe('checks_failed');
    expect(s.detail).toContain('x {');
    expect(s.detail.length).toBeLessThanOrEqual(200);
    expect(s.detail).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
  it('US-64 AC26: a deploy job name cannot forge a status line', () => {
    const jobs = JSON.stringify({ conclusion: 'failure', headSha: 'abc123', jobs: [{ name: 'a\n{"wait_run":"success"}', conclusion: 'failure' }] });
    const r = run(['deploy', '123'], { JOBS: jobs });
    expect(r.status).toBe(1);
    expect(statusLines(r.stdout)).toHaveLength(1);
    expect(status(r.stdout).wait_run).toBe('run_failed');
  });
  it('US-64 AC26: a bad WAIT_RUN_MAX_MIN (not a whole number) is a usage error: exit 2 and the usage line, before any gh call', () => {
    for (const v of ['1.5', 'x', '-1', '9 0']) {
      const r = run(['deploy', '123'], { WAIT_RUN_MAX_MIN: v });
      expect({ v, code: r.status }).toEqual({ v, code: 2 });
      expect(r.calls).toEqual([]);
      expect(statusLines(r.stdout)).toHaveLength(1);
      expect(status(r.stdout).wait_run).toBe('usage');
    }
    // A leading zero is still decimal: 010 is ten minutes, not eight.
    const r = run(['deploy', '123'], { RL_CORE: '50', RL_RESET: '2000000', WAIT_RUN_MAX_MIN: '010' });
    expect(r.sleeps).toEqual([600]);
  });
  it('US-64 AC26: an id with leading zeros prints as a JSON number', () => {
    expect(status(run(['pr', '0042']).stdout).pr).toBe(42);
    expect(status(run(['deploy', '0123']).stdout).run).toBe(123);
    expect(status(run(['deploy', '000']).stdout).run).toBe(0);
  });
  it('US-64 AC26: invalid UTF-8 in detail still prints a status line that parses', () => {
    const r = run(['deploy', '123'], { CONCLUSION: 'fail\\0377ed' });
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain('Malformed');
    expect(statusLines(r.stdout)).toHaveLength(1);
    const s = status(r.stdout);
    expect(s.wait_run).toBe('run_failed');
    expect(s.detail).toBe('conclusion=fail�ed healthz=200');
  });
  // CI's sh is dash, which skips the EXIT trap on a signal it does not trap; macOS sh is bash.
  const shells = ['sh', ...(existsSync('/bin/dash') ? ['dash'] : [])];
  for (const shell of shells) {
    it(`US-64 AC26: TERM during the wait prints the interrupted line last and exits 143 (${shell})`, async () => {
      const state = join(S, `state-${Math.random()}`);
      const child = spawn(shell, [SCRIPT, 'deploy', '123'], { env: envFor(state, { SLEEP_REAL: '30' }) });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const done = new Promise<number | null>((res) => child.on('close', (code) => res(code)));
      const t = Date.now();
      while (!existsSync(`${state}.sleeps`)) {
        expect(Date.now() - t).toBeLessThan(10_000);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 100));
      const sent = Date.now();
      child.kill('SIGTERM');
      expect(await done).toBe(143);
      expect(Date.now() - sent).toBeLessThan(5_000); // not after the 30 s sleep
      expect(statusLines(out)).toHaveLength(1);
      const s = status(out);
      expect(s.wait_run).toBe('interrupted');
      expect(s.run).toBe(123);
    }, 20_000);
  }
});
