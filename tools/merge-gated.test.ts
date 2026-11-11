/**
 * US-64 AC32: tools/merge-gated.sh merges a PR only when its head is the reviewed sha, its checks are green and no
 * Deploy is running, and then only as `gh pr merge <pr> --merge --match-head-commit <sha>`. A stub `gh` on PATH
 * plays GitHub: it answers each read from fixture JSON run through the script's own --jq filter (as gh does), and
 * logs every call, so each test checks the exit code, the reason and whether (and how) the merge ran.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'merge-gated.sh');
const SHA = 'a'.repeat(40);
let S: string;

beforeAll(() => {
  S = mkdtempSync(join(tmpdir(), 'merge-gated-'));
  // Each call's argv goes on one line of $LOG, one argument per tab-separated field. GH_FAIL names a substring of
  // the argv that makes that call fail.
  writeFileSync(join(S, 'gh'), `#!/bin/sh
printf '%s\\t' "$@" >> "$LOG"; echo >> "$LOG"
case "$*" in *"\${GH_FAIL:-@@none@@}"*) echo "gh: HTTP 502" >&2; exit 1 ;; esac
jqf=; prev=
for a in "$@"; do [ "$prev" = --jq ] && jqf=$a; prev=$a; done
json() { printf '%s\\n' "$1" | jq -r "$jqf"; }
case "$*" in
  *"pr view"*state,headRefOid*) json "$PR" ;;
  *"pr view"*statusCheckRollup*) json "{\\"statusCheckRollup\\":$ROLLUP}" ;;
  *check-runs*) json "$CHECKRUNS" ;;
  *"run list"*) json "$RUNS" ;;
  *"pr merge"*) echo "merged"; exit "\${MERGE_RC:-0}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(S, 'gh'), 0o755);
});
afterAll(() => rmSync(S, { recursive: true, force: true }));

const cr = (name: string, conclusion: string | null = 'SUCCESS', status = 'COMPLETED') =>
  ({ __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion });
const GREEN = [cr('test'), cr('lint'), cr('Claude Review', 'SKIPPED')];
const run_ = (id: number, name: string, conclusion: string | null = 'success', status = 'completed') =>
  ({ id, name, status, conclusion });
// CI's own jobs: checks, the 6 UTC unit shards and test (the Los Angeles shards are extra).
const EIGHT = ['checks', ...[1, 2, 3, 4, 5, 6].map((n) => `unit (${n}, UTC)`), 'test'].map((n, i) => run_(10 + i, n));
const page = (runs: ReturnType<typeof run_>[]) => ({ total_count: runs.length, check_runs: runs });

function gate(args: string[], fx: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const log = join(S, `log-${Math.random()}`);
  const r = spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${S}:${process.env.PATH}`, LOG: log,
      PR: JSON.stringify(fx.pr ?? { state: 'OPEN', headRefOid: SHA }),
      ROLLUP: JSON.stringify(fx.rollup ?? GREEN),
      CHECKRUNS: JSON.stringify(fx.checkruns ?? { total_count: EIGHT.length, check_runs: EIGHT }),
      RUNS: JSON.stringify(fx.runs ?? [{ databaseId: 1, status: 'completed' }]),
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.replace(/\t$/, '').split('\t')) : [];
  const merges = calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');
  return { ...r, calls, merges };
}
const MERGE_ARGV = ['pr', 'merge', '123', '--merge', '--match-head-commit', SHA];

describe('US-64 AC32 merge-gated.sh', () => {
  it('merges a green PR with exactly the one allowed merge form', () => {
    const r = gate(['123', SHA]);
    expect(r.status).toBe(0);
    expect(r.merges).toEqual([MERGE_ARGV]);
    expect(r.calls.at(-1)).toEqual(MERGE_ARGV);
  });

  it('refuses a bad sha before calling gh', () => {
    for (const bad of ['abc123', 'g'.repeat(40), `${SHA}0`, '']) {
      const r = gate(['123', bad]);
      expect(r.status).toBe(3);
      expect(r.calls).toEqual([]);
    }
  });

  it('refuses usage errors with exit 2', () => {
    expect(gate(['12x', SHA]).status).toBe(2);
    expect(gate(['123', SHA, '--admin']).status).toBe(2);
  });

  it('refuses when the head moved', () => {
    const r = gate(['123', SHA], { pr: { state: 'OPEN', headRefOid: 'b'.repeat(40) } });
    expect(r.status).toBe(6);
    expect(r.stderr).toMatch(/head/);
    expect(r.merges).toEqual([]);
  });

  it('refuses a PR that is not open', () => {
    const r = gate(['123', SHA], { pr: { state: 'MERGED', headRefOid: SHA } });
    expect(r.status).toBe(5);
    expect(r.merges).toEqual([]);
  });

  it('refuses an empty rollup', () => {
    const r = gate(['123', SHA], { rollup: [] });
    expect(r.status).toBe(7);
    expect(r.merges).toEqual([]);
  });

  it('refuses while one check is pending', () => {
    const r = gate(['123', SHA], { rollup: [...GREEN, cr('shard 2', null, 'IN_PROGRESS')] });
    expect(r.status).toBe(8);
    expect(r.stderr).toMatch(/shard 2/);
    expect(r.merges).toEqual([]);
  });

  it('refuses a pending status context', () => {
    const r = gate(['123', SHA], { rollup: [...GREEN, { __typename: 'StatusContext', context: 'ext', state: 'PENDING' }] });
    expect(r.status).toBe(8);
  });

  it('refuses a failed check', () => {
    const r = gate(['123', SHA], { rollup: [...GREEN, cr('lint', 'FAILURE')] });
    expect(r.status).toBe(9);
    expect(r.merges).toEqual([]);
  });

  it('refuses when no check is named exactly test', () => {
    const r = gate(['123', SHA], { rollup: [cr('tests'), cr('lint')] });
    expect(r.status).toBe(10);
    expect(r.merges).toEqual([]);
  });

  it('refuses while a Deploy run is in progress or queued', () => {
    for (const status of ['in_progress', 'queued', 'pending', 'waiting']) {
      const r = gate(['123', SHA], { runs: [{ databaseId: 77, status }, { databaseId: 1, status: 'completed' }] });
      expect(r.status).toBe(12);
      expect(r.stderr).toMatch(/77/);
      expect(r.merges).toEqual([]);
    }
  });

  it('refuses on any gh failure, at every step', () => {
    for (const step of ['state,headRefOid', 'statusCheckRollup', 'run list']) {
      const r = gate(['123', SHA], {}, { GH_FAIL: step });
      expect(r.status).toBe(4);
      expect(r.merges).toEqual([]);
    }
    expect(gate(['123', SHA, '--commit-checks'], {}, { GH_FAIL: 'check-runs' }).status).toBe(4);
  });

  it('refuses an unparsable answer', () => {
    const r = gate(['123', SHA], { pr: { state: 'OPEN' } });
    expect(r.status).toBe(4);
    expect(r.merges).toEqual([]);
  });

  it('reports a failed merge call with its own exit code', () => {
    const r = gate(['123', SHA], {}, { MERGE_RC: '1' });
    expect(r.status).toBe(13);
    expect(r.merges).toEqual([MERGE_ARGV]);
  });

  describe('--commit-checks', () => {
    it('merges when an old failed run is superseded by a newer green one', () => {
      const runs = [run_(5, 'test', 'failure'), ...EIGHT];
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: { total_count: runs.length, check_runs: runs }, rollup: [] });
      expect(r.status).toBe(0);
      expect(r.merges).toEqual([MERGE_ARGV]);
      expect(r.calls.some((c) => c[0] === 'api' && c[1].includes(`commits/${SHA}/check-runs`))).toBe(true);
    });

    it('refuses when the newest run of a unit shard failed', () => {
      const runs = [...EIGHT, run_(99, 'unit (3, UTC)', 'failure')];
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: page(runs) });
      expect(r.status).toBe(9);
      expect(r.stderr).toMatch(/unit \(3, UTC\)=failure/);
      expect(r.merges).toEqual([]);
    });

    it('ignores another workflow\'s failed job on the same sha, and names it', () => {
      const runs = [...EIGHT, run_(99, 'verify', 'failure')];
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: page(runs) });
      expect(r.status).toBe(0);
      expect(r.merges).toEqual([MERGE_ARGV]);
      expect(r.stderr).toMatch(/verify=failure/);
      expect(r.stderr.split('\n').filter((l) => l.includes('verify')).length).toBe(1);
    });

    it('does not count unrelated green jobs toward the 8', () => {
      const runs = [...EIGHT.slice(0, 7).filter((x) => x.name !== 'unit (6, UTC)'), run_(30, 'test'),
        run_(31, 'verify'), run_(32, 'deploy'), run_(33, 'lint')];
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: page(runs) });
      expect(r.status).toBe(11);
      expect(r.stderr).not.toMatch(/verify|deploy|lint/);
      expect(r.merges).toEqual([]);
    });

    it('refuses while the newest test run is in progress', () => {
      const runs = [...EIGHT, run_(99, 'test', null, 'in_progress')];
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: { total_count: runs.length, check_runs: runs } });
      expect(r.status).toBe(10);
    });

    it('refuses while another check is queued', () => {
      const runs = [...EIGHT, run_(99, 'unit (2, America/Los_Angeles)', null, 'queued')];
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: { total_count: runs.length, check_runs: runs } });
      expect(r.status).toBe(8);
    });

    it('refuses fewer than 8 checks', () => {
      const runs = EIGHT.slice(1);
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: { total_count: 7, check_runs: runs } });
      expect(r.status).toBe(11);
    });

    it('refuses no check runs at all (a ghost run with no jobs makes none)', () => {
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: { total_count: 0, check_runs: [] } });
      expect(r.status).toBe(7);
    });

    it('refuses an answer with more runs than one page holds', () => {
      const r = gate(['123', SHA, '--commit-checks'], { checkruns: { total_count: 150, check_runs: EIGHT } });
      expect(r.status).toBe(4);
    });
  });
});
