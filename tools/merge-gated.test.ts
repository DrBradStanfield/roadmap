/**
 * US-64 AC32: tools/merge-gated.sh merges a PR only when its head is the reviewed sha, CI's own workflow and its
 * checks are green and no Deploy is running, and then only as `gh pr merge <pr> --merge --match-head-commit <sha>`.
 * A stub `gh` on PATH plays GitHub: it answers each read from fixture JSON run through the script's own --jq
 * filter (as gh does), and logs every call, so each test checks the exit code, the reason and whether (and how)
 * the merge ran. Fixtures follow the real shapes (PR 1339's rollup; PR 1322's head b0551915, whose ci.yml runs
 * were an old queued ghost, a failed dispatch run and a newer green one).
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
  // the argv that makes that call fail; GH_HANG one that makes it hang, ignoring ALRM and TERM. Deploy reads are
  // filtered by their --status and --limit, as the API does.
  writeFileSync(join(S, 'gh'), `#!/bin/sh
printf '%s\\t' "$@" >> "$LOG"; echo >> "$LOG"
case "$*" in *"\${GH_FAIL:-@@none@@}"*) echo "gh: HTTP 502" >&2; exit 1 ;; esac
case "$*" in *"\${GH_HANG:-@@none@@}"*) trap '' ALRM TERM; sleep 30; exit 0 ;; esac
jqf=; prev=; st=; lim=20
for a in "$@"; do [ "$prev" = --jq ] && jqf=$a; [ "$prev" = --status ] && st=$a; [ "$prev" = --limit ] && lim=$a; prev=$a; done
json() { printf '%s\\n' "$1" | jq -r "$jqf"; }
case "$*" in
  *"pr view"*state,headRefOid*) json "$PR" ;;
  *"pr view"*changedFiles*) json "$FILES" ;;
  *"pr view"*statusCheckRollup*) json "{\\"statusCheckRollup\\":$ROLLUP}" ;;
  *"run list"*ci.yml*) json "$CIRUNS" ;;
  *"run list"*deploy.yml*) json "$(printf '%s\\n' "$RUNS" | jq -c --arg s "$st" --argjson n "$lim" '[.[] | select(.status == $s)] | .[0:$n]')" ;;
  *"pr merge"*) echo "merged"; exit "\${MERGE_RC:-0}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(S, 'gh'), 0o755);
});
afterAll(() => rmSync(S, { recursive: true, force: true }));

const cr = (name: string, conclusion: string | null = 'SUCCESS', status = 'COMPLETED', workflowName = 'CI') =>
  ({ __typename: 'CheckRun', name, workflowName, status, conclusion });
// PR 1339's real rollup: Claude Review's two skipped `review` jobs, then CI's checks, 6 UTC shards and test.
const GREEN = [cr('review', 'SKIPPED', 'COMPLETED', 'Claude Review'), cr('review', 'SKIPPED', 'COMPLETED', 'Claude Review'),
  cr('checks'), ...[1, 2, 3, 4, 5, 6].map((n) => cr(`unit (${n}, UTC)`)), cr('test')];
const ciRun = (databaseId: number, createdAt: string, conclusion = 'success', status = 'completed', event = 'pull_request') =>
  ({ databaseId, status, conclusion, createdAt, event });
const CI_GREEN = [ciRun(43112784472, '2026-11-11T22:33:40Z')];
const FILES = { changedFiles: 2, files: [{ path: 'tools/wait-run.sh' }, { path: 'docs/git-workflow.md' }] };

function gate(args: string[], fx: Record<string, unknown> = {}, env: Record<string, string> = {}, stdin?: string) {
  const log = join(S, `log-${Math.random()}`);
  const argv = stdin === undefined ? [SCRIPT, ...args] : ['-s', '--', ...args];
  const r = spawnSync('sh', argv, {
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env, PATH: `${S}:${process.env.PATH}`, LOG: log,
      PR: JSON.stringify(fx.pr ?? { state: 'OPEN', headRefOid: SHA }),
      FILES: JSON.stringify(fx.files ?? FILES),
      ROLLUP: JSON.stringify(fx.rollup ?? GREEN),
      CIRUNS: JSON.stringify(fx.ci ?? CI_GREEN),
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
    expect(r.calls.some((c) => c.join(' ').includes(`run list --workflow ci.yml --commit ${SHA}`))).toBe(true);
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

  it('refuses a PR that is not open: MERGED, CLOSED', () => {
    for (const state of ['MERGED', 'CLOSED']) {
      const r = gate(['123', SHA], { pr: { state, headRefOid: SHA } });
      expect(r.status).toBe(5);
      expect(r.stderr).toMatch(new RegExp(state));
      expect(r.merges).toEqual([]);
    }
  });

  describe('a PR that changes tools/merge-gated.sh', () => {
    const self = { changedFiles: 2, files: [{ path: 'tools/merge-gated.sh' }, { path: 'tools/merge-gated.test.ts' }] };
    it('refuses it (16) and names the main-copy command', () => {
      const r = gate(['123', SHA], { files: self });
      expect(r.status).toBe(16);
      expect(r.stderr).toContain(`git show origin/main:tools/merge-gated.sh | sh -s -- 123 ${SHA}`);
      expect(r.stderr).toContain('git fetch origin main');
      expect(r.merges).toEqual([]);
    });
    it("main's copy run from stdin judges it on the other gates and merges", () => {
      const r = gate(['123', SHA], { files: self }, {}, readFileSync(SCRIPT, 'utf8'));
      expect(r.status).toBe(0);
      expect(r.merges).toEqual([MERGE_ARGV]);
    });
    it('refuses a PR whose file list gh truncated at 100 (17), or 16 if the part it sees holds the script', () => {
      const hundred = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.ts` }));
      expect(gate(['123', SHA], { files: { changedFiles: 183, files: hundred } }).status).toBe(17);
      expect(gate(['123', SHA], { files: { changedFiles: 183, files: [...hundred.slice(1), { path: 'tools/merge-gated.sh' }] } }).status).toBe(16);
    });
  });

  describe("CI's own workflow (ci.yml), in both modes", () => {
    for (const mode of [[], ['--commit-checks']]) {
      const m = mode.length ? '--commit-checks' : 'default';
      it(`${m}: merges when the newest run is green beside an older ghost and an older failure (PR 1322)`, () => {
        const ci = [ciRun(43106242286, '2026-11-11T21:48:09Z', 'success', 'completed', 'workflow_dispatch'),
          ciRun(43105067257, '2026-11-11T21:40:09Z', 'failure', 'completed', 'workflow_dispatch'),
          ciRun(43098358997, '2026-11-11T20:50:14Z', '', 'queued')];
        const r = gate(['123', SHA, ...mode], { ci });
        expect(r.status).toBe(0);
        expect(r.merges).toEqual([MERGE_ARGV]);
      });
      it(`${m}: refuses no ci.yml run (11)`, () => {
        expect(gate(['123', SHA, ...mode], { ci: [] }).status).toBe(11);
      });
      it(`${m}: refuses a newest run that is queued or in progress (14), naming it`, () => {
        for (const status of ['queued', 'in_progress', 'waiting']) {
          const r = gate(['123', SHA, ...mode], { ci: [...CI_GREEN, ciRun(99, '2026-11-12T01:00:00Z', '', status)] });
          expect(r.status).toBe(14);
          expect(r.stderr).toMatch(/99/);
          expect(r.merges).toEqual([]);
        }
      });
      it(`${m}: refuses a newest run that failed, was cancelled or skipped (15), whatever came before`, () => {
        for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out']) {
          const r = gate(['123', SHA, ...mode], { ci: [ciRun(99, '2026-11-12T01:00:00Z', conclusion), ...CI_GREEN] });
          expect(r.status).toBe(15);
          expect(r.stderr).toContain(conclusion);
          expect(r.merges).toEqual([]);
        }
      });
    }
    it('default: a `test` job from another workflow cannot stand in for CI', () => {
      const r = gate(['123', SHA], { ci: [], rollup: [cr('test', 'SUCCESS', 'COMPLETED', 'Other')] });
      expect(r.status).toBe(11);
      expect(r.merges).toEqual([]);
    });
    it("default: a draft PR (every check skipped, CI's run skipped) never passes", () => {
      const skipped = GREEN.map((c) => ({ ...c, conclusion: 'SKIPPED' }));
      expect(gate(['123', SHA], { rollup: skipped, ci: [ciRun(5, '2026-11-11T22:43:39Z', 'skipped')] }).status).toBe(15);
      expect(gate(['123', SHA], { rollup: skipped }).status).toBe(10);
    });
    it('--commit-checks: does not read the rollup', () => {
      const r = gate(['123', SHA, '--commit-checks'], { rollup: [] });
      expect(r.status).toBe(0);
      expect(r.calls.some((c) => c.includes('statusCheckRollup'))).toBe(false);
    });
  });

  describe('default mode: the rollup', () => {
    it('refuses an empty rollup', () => {
      const r = gate(['123', SHA], { rollup: [] });
      expect(r.status).toBe(7);
      expect(r.merges).toEqual([]);
    });

    it('refuses while one check is pending', () => {
      const r = gate(['123', SHA], { rollup: [...GREEN, cr('unit (2, UTC)', null, 'IN_PROGRESS')] });
      expect(r.status).toBe(8);
      expect(r.stderr).toMatch(/unit \(2, UTC\)/);
      expect(r.merges).toEqual([]);
    });

    it('refuses a pending or expected status context', () => {
      for (const state of ['PENDING', 'EXPECTED']) {
        expect(gate(['123', SHA], { rollup: [...GREEN, { __typename: 'StatusContext', context: 'ext', state }] }).status).toBe(8);
      }
    });

    it('refuses a status context in FAILURE or ERROR', () => {
      for (const state of ['FAILURE', 'ERROR']) {
        const r = gate(['123', SHA], { rollup: [...GREEN, { __typename: 'StatusContext', context: 'ext', state }] });
        expect(r.status).toBe(9);
        expect(r.stderr).toContain(`ext=${state}`);
      }
    });

    it('refuses every conclusion but SUCCESS and SKIPPED', () => {
      for (const c of ['FAILURE', 'NEUTRAL', 'CANCELLED', 'STALE', 'TIMED_OUT', 'ACTION_REQUIRED']) {
        const r = gate(['123', SHA], { rollup: [...GREEN, cr('checks', c)] });
        expect(r.status).toBe(9);
        expect(r.stderr).toContain(`checks=${c}`);
        expect(r.merges).toEqual([]);
      }
    });

    it('two entries of one name: any red one refuses, older or newer (every entry counts; re-run to replace it)', () => {
      const oldGreenNewRed = [...GREEN.filter((c) => c.name !== 'unit (3, UTC)'), cr('unit (3, UTC)'), cr('unit (3, UTC)', 'FAILURE')];
      const oldRedNewGreen = [...GREEN.filter((c) => c.name !== 'unit (3, UTC)'), cr('unit (3, UTC)', 'FAILURE'), cr('unit (3, UTC)')];
      expect(gate(['123', SHA], { rollup: oldGreenNewRed }).status).toBe(9);
      expect(gate(['123', SHA], { rollup: oldRedNewGreen }).status).toBe(9);
    });

    it('refuses when no check is named exactly test', () => {
      const r = gate(['123', SHA], { rollup: GREEN.filter((c) => c.name !== 'test').concat(cr('tests')) });
      expect(r.status).toBe(10);
      expect(r.merges).toEqual([]);
    });
  });

  describe('Deploy', () => {
    it('refuses while a Deploy run is in any unfinished status', () => {
      for (const status of ['in_progress', 'queued', 'pending', 'waiting', 'requested']) {
        const r = gate(['123', SHA], { runs: [{ databaseId: 77, status }, { databaseId: 1, status: 'completed' }] });
        expect(r.status).toBe(12);
        expect(r.stderr).toMatch(/77/);
        expect(r.merges).toEqual([]);
      }
    });

    it('finds an in-progress Deploy behind more than 20 newer finished runs', () => {
      const done = Array.from({ length: 25 }, (_, i) => ({ databaseId: 1000 - i, status: 'completed' }));
      const r = gate(['123', SHA], { runs: [...done, { databaseId: 77, status: 'in_progress' }] });
      expect(r.status).toBe(12);
      expect(r.stderr).toMatch(/77 in_progress/);
      expect(r.merges).toEqual([]);
    });
  });

  it('refuses on any gh failure, at every step', () => {
    for (const step of ['state,headRefOid', 'changedFiles', 'ci.yml', 'statusCheckRollup', 'deploy.yml']) {
      const r = gate(['123', SHA], {}, { GH_FAIL: step });
      expect(r.status).toBe(4);
      expect(r.merges).toEqual([]);
    }
  });

  it('refuses an unparsable answer', () => {
    const r = gate(['123', SHA], { pr: { state: 'OPEN' } });
    expect(r.status).toBe(4);
    expect(r.merges).toEqual([]);
  });

  it('a gh that ignores ALRM and TERM is killed at the timeout: refuses 4 in about a second, never merges', () => {
    const t = Date.now();
    const r = gate(['123', SHA], {}, { GH_HANG: 'state,headRefOid', MERGE_GATED_GH_TIMEOUT: '1' });
    expect(r.status).toBe(4);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.merges).toEqual([]);
  });

  it('a merge that hangs is killed at the timeout: exit 13, outcome unknown', () => {
    const t = Date.now();
    const r = gate(['123', SHA], {}, { GH_HANG: 'pr merge', MERGE_GATED_GH_TIMEOUT: '1' });
    expect(r.status).toBe(13);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.stderr).toMatch(/timed out.*outcome is unknown: check the PR/);
  });

  it('reports a failed merge call with its own exit code', () => {
    const r = gate(['123', SHA], {}, { MERGE_RC: '1' });
    expect(r.status).toBe(13);
    expect(r.merges).toEqual([MERGE_ARGV]);
  });
});
