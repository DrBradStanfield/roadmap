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
[ -n "\${GH_PARENT:-}" ] && ps -o args= -p "$PPID" >> "$GH_PARENT"
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
  *"run list"*deploy.yml*) runs=$RUNS
    # FLIP=<id>:<k>: in the status-filtered reads, run <id> is pending for the first k and in_progress after.
    if [ -n "$st" ] && [ -n "\${FLIP:-}" ]; then n=$(( $(cat "$LOG.flip" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$LOG.flip"
      to=pending; [ "$n" -gt "\${FLIP#*:}" ] && to=in_progress
      runs=$(printf '%s\\n' "$RUNS" | jq -c --argjson id "\${FLIP%%:*}" --arg to "$to" 'map(if .databaseId == $id then .status = $to else . end)'); fi
    json "$(printf '%s\\n' "$runs" | jq -c --arg s "$st" --argjson n "$lim" '[.[] | select($s == "" or .status == $s)] | .[0:$n]')" ;;
  *"pr merge"*) echo "merged"; exit "\${MERGE_RC:-0}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(S, 'gh'), 0o755);
  // git plays origin/main: `show` prints $MAIN_COPY (main's merge-gated.sh) or fails as git does when main has none,
  // and prints the real tools/generated-files.json (US-64 AC34). Step 6 (AC34) finds the PR head, a merge base and a
  // diff that lists no generated file, so it never refuses here.
  writeFileSync(join(S, 'git'), `#!/bin/sh
printf 'git\\t%s\\t' "$@" >> "$LOG"; echo >> "$LOG"
case "$1" in
  fetch) [ -z "\${GIT_FETCH_FAIL:-}" ] || { echo "fatal: unable to access origin" >&2; exit 128; } ;;
  show) [ "$2" = origin/main:tools/generated-files.json ] && { cat "${join(dirname(SCRIPT), 'generated-files.json')}"; exit; }
    [ "$2" = origin/main:tools/merge-gated.sh ] && [ -f "\${MAIN_COPY:-/nonexistent}" ] || { echo "fatal: path does not exist in origin/main" >&2; exit 128; }
    cat "$MAIN_COPY" ;;
  cat-file) ;;
  merge-base) echo ${'b'.repeat(40)} ;;
  diff) echo tools/wait-run.sh ;;
  *) echo "unexpected git call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(S, 'git'), 0o755);
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

function gate(args: string[], fx: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const log = join(S, `log-${Math.random()}`);
  const r = spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
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
  const gits = calls.filter((c) => c[0] === 'git');
  return { ...r, calls, merges, gits };
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

  describe("a PR that changes a gate file (tools/merge-gated.sh or .github/workflows/ci.yml) is judged by main's copy", () => {
    const self = { changedFiles: 2, files: [{ path: 'tools/merge-gated.sh' }, { path: 'tools/merge-gated.test.ts' }] };
    const ciPr = { changedFiles: 2, files: [{ path: '.github/workflows/ci.yml' }, { path: 'docs/x.md' }] };
    const NOTE = /changes \.github\/workflows\/ci\.yml, so its own CI result came from the PR's workflow/g;
    const fakeMain = (code: number) => {
      const f = join(S, `main-${Math.random()}.sh`);
      writeFileSync(f, `echo "main copy: marker=$MERGE_GATED_FROM_MAIN args=$*" >&2; exit ${code}\n`);
      return f;
    };
    it("a plain PR never shows main's copy; step 6 fetches main by an explicit refspec and the PR head", () => {
      const r = gate(['123', SHA]);
      expect(r.status).toBe(0);
      expect(r.gits.map((c) => c[1])).toEqual(['fetch', 'cat-file', 'merge-base', 'diff']);
      // The stub logs `git` before each argument.
      expect(r.gits[0].filter((_, i) => i % 2)).toEqual(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main', 'refs/pull/123/head']);
    });
    it("fetches main, runs main's copy with the marker and the same arguments, and exits with its code", () => {
      for (const code of [0, 9]) {
        const r = gate(['123', SHA, '--commit-checks'], { files: self }, { MAIN_COPY: fakeMain(code) });
        expect(r.status).toBe(code);
        expect(r.stderr).toContain(`main copy: marker=1 args=123 ${SHA} --commit-checks`);
        expect(r.gits.map((c) => c[1])).toEqual(['fetch', 'show', 'show']);
        expect(r.merges).toEqual([]);
      }
    });
    it("main's real copy judges it on the other gates: merges when green, refuses when CI failed", () => {
      const ok = gate(['123', SHA], { files: self }, { MAIN_COPY: SCRIPT });
      expect(ok.status).toBe(0);
      expect(ok.merges).toEqual([MERGE_ARGV]);
      const red = gate(['123', SHA], { files: self, ci: [ciRun(9, '2026-11-12T01:00:00Z', 'failure')] }, { MAIN_COPY: SCRIPT });
      expect(red.status).toBe(15);
      expect(red.merges).toEqual([]);
    });
    it('refuses 16 when main has no copy, the copy is empty, or the fetch fails; never merges', () => {
      const empty = join(S, 'empty.sh');
      writeFileSync(empty, '');
      for (const env of [{}, { MAIN_COPY: empty }, { MAIN_COPY: SCRIPT, GIT_FETCH_FAIL: '1' }]) {
        const r = gate(['123', SHA], { files: self }, env);
        expect(r.status).toBe(16);
        expect(r.stderr).toMatch(/the owner merges this PR by hand/);
        expect(r.merges).toEqual([]);
      }
    });
    it("a ci.yml PR is gated by main's copy too, which notes once that its CI ran the PR's own workflow", () => {
      const r = gate(['123', SHA], { files: ciPr }, { MAIN_COPY: SCRIPT });
      expect(r.status).toBe(0);
      expect(r.stderr.match(NOTE)).toHaveLength(1);
      expect(r.merges).toEqual([MERGE_ARGV]);
      expect(gate(['123', SHA], { files: ciPr }).status).toBe(16);
      expect(gate(['123', SHA], { files: { changedFiles: 1, files: [{ path: 'tools/generated-files.json' }] } }).status).toBe(16);
      expect(gate(['123', SHA]).stderr).not.toMatch(NOTE);
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

    describe('advisory check ios-compile (Brad 2026-11-13: warns, never blocks)', () => {
      const ios = (c: string | null, s = 'COMPLETED') => cr('ios-compile', c, s, 'iOS compile');
      it('merges and warns when ios-compile failed', () => {
        const r = gate(['123', SHA], { rollup: [...GREEN, ios('FAILURE')] });
        expect(r.status).toBe(0);
        expect(r.merges).toEqual([MERGE_ARGV]);
        expect(r.stderr).toContain('merge-gated: note: advisory check ios-compile is FAILURE; not blocking');
      });
      it('merges and warns while ios-compile is pending', () => {
        const r = gate(['123', SHA], { rollup: [...GREEN, ios(null, 'IN_PROGRESS')] });
        expect(r.status).toBe(0);
        expect(r.merges).toEqual([MERGE_ARGV]);
        expect(r.stderr).toContain('advisory check ios-compile is IN_PROGRESS; not blocking');
      });
      it('says nothing when ios-compile is green', () => {
        const r = gate(['123', SHA], { rollup: [...GREEN, ios('SUCCESS')] });
        expect(r.status).toBe(0);
        expect(r.merges).toEqual([MERGE_ARGV]);
        expect(r.stderr).not.toMatch(/advisory/);
      });
      it('a non-advisory failure still refuses beside a green ios-compile', () => {
        const r = gate(['123', SHA], { rollup: [...GREEN, ios('SUCCESS'), cr('checks', 'FAILURE')] });
        expect(r.status).toBe(9);
        expect(r.stderr).toContain('checks=FAILURE');
        expect(r.merges).toEqual([]);
      });
      it('only the exact name is advisory: a name that merely contains it still counts', () => {
        for (const name of ['ios-compile-extra', 'x ios-compile', 'iOS-compile', 'ios-compile ']) {
          const red = gate(['123', SHA], { rollup: [...GREEN, cr(name, 'FAILURE')] });
          expect(red.status).toBe(9);
          expect(red.merges).toEqual([]);
          expect(gate(['123', SHA], { rollup: [...GREEN, cr(name, null, 'IN_PROGRESS')] }).status).toBe(8);
        }
      });
      it('a check name with a newline cannot forge a note or a verdict line (R4)', () => {
        const forged = cr('evil\nadvisory check ios-compile is FAILURE; not blocking\r\nok', 'FAILURE');
        const r = gate(['123', SHA], { rollup: [...GREEN, forged] });
        expect(r.status).toBe(9);
        expect(r.merges).toEqual([]);
        expect(r.stderr).not.toMatch(/^merge-gated: note:/m);
      });
      it('an ios-compile alone is not a check: an otherwise empty rollup still refuses', () => {
        expect(gate(['123', SHA], { rollup: [ios('SUCCESS')] }).status).toBe(7);
      });
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

    it('a Deploy run that moves on between the status reads is still caught (Codex re-check)', () => {
      // Pending in the first status-filtered reads, in_progress after: the old per-status order missed it.
      for (const k of [1, 2, 3, 4, 5]) {
        const r = gate(['123', SHA], { runs: [{ databaseId: 77, status: 'pending' }, { databaseId: 1, status: 'completed' }] }, { FLIP: `77:${k}` });
        expect(r.status).toBe(12);
        expect(r.merges).toEqual([]);
      }
    });

    it('one unfiltered snapshot of the newest 100 Deploy runs comes first', () => {
      const r = gate(['123', SHA], { runs: [{ databaseId: 77, status: 'in_progress' }] });
      expect(r.status).toBe(12);
      const first = r.calls.find((c) => c.includes('deploy.yml'));
      expect(first).not.toContain('--status');
      expect(first?.join(' ')).toContain('--limit 100');
    });

    it('a flipping Deploy run older than the newest 100 is caught by the per-status reads, run twice', () => {
      const done = Array.from({ length: 100 }, (_, i) => ({ databaseId: 1000 - i, status: 'completed' }));
      for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const r = gate(['123', SHA], { runs: [...done, { databaseId: 77, status: 'pending' }] }, { FLIP: `77:${k}` });
        expect(r.status).toBe(12);
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

  it('a zero, empty or non-numeric MERGE_GATED_GH_TIMEOUT falls back to 60 s, never disables the limit', () => {
    for (const [v, want] of [['abc', '60'], ['0', '60'], ['', '60'], ['-5', '60'], ['1x', '60'], ['5', '5']]) {
      const parent = join(S, `parent-${Math.random()}`);
      expect(gate(['123', SHA], {}, { MERGE_GATED_GH_TIMEOUT: v, GH_PARENT: parent }).status).toBe(0);
      expect(readFileSync(parent, 'utf8')).toMatch(new RegExp(` ${want} gh pr view 123 `));
    }
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
